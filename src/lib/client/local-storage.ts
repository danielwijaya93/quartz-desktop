"use client";

import type { AcpSessionSnapshot, ReplayedTranscriptMessage } from "@/lib/acp/types";
import { acpStore, selectEffectiveAgent } from "@/lib/client/acp-store";
import { createAcpStreamAdapter } from "@/lib/client/acp-stream-adapter";
import {
  fetchRemoteMessages,
  fetchRemoteSyncState,
  pushSyncSaveMessages,
  pushSyncUpsertThread,
} from "@/lib/client/sync-client";
import {
  agUIAdapter,
  fetchLLM,
  processStreamedMessage,
  type ChatLLM,
  type ChatStorage,
  type Message,
  type Thread,
  type UserMessage,
} from "@openuidev/react-headless";

const THREADS_KEY = "agy-openui:threads";
const messagesKey = (threadId: string) => `agy-openui:messages:${threadId}`;

const IDB_NAME = "agy-openui-db";
const IDB_STORE = "messages";
const IDB_VERSION = 1;

let dbPromise: Promise<IDBDatabase | null> | null = null;
const writeQueues = new Map<string, Promise<void>>();

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore storage quota errors
  }
}

function openMessagesDb(): Promise<IDBDatabase | null> {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") {
    return Promise.resolve(null);
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function idbGetMessages(db: IDBDatabase, threadId: string): Promise<Message[] | undefined> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(threadId);
      req.onsuccess = () => {
        resolve(Array.isArray(req.result) ? (req.result as Message[]) : undefined);
      };
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

async function idbPutMessages(db: IDBDatabase, threadId: string, messages: Message[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(messages, threadId);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

async function readMessagesFromStore(threadId: string): Promise<Message[]> {
  const db = await openMessagesDb();
  if (db) {
    const idbMessages = await idbGetMessages(db, threadId);
    if (idbMessages !== undefined) {
      return idbMessages;
    }
  }

  // Migrate any legacy localStorage transcript into IndexedDB once
  const legacy = readJson<Message[]>(messagesKey(threadId), []);
  if (db && legacy.length > 0) {
    const ok = await idbPutMessages(db, threadId, legacy);
    if (ok) {
      try {
        localStorage.removeItem(messagesKey(threadId));
      } catch {
        // ignore cleanup failure
      }
    }
  }
  return legacy;
}

export function enqueueMessageWrite(
  threadId: string,
  messages: Message[],
  options?: { skipRemoteSync?: boolean },
): Promise<void> {
  const prev = writeQueues.get(threadId) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      const db = await openMessagesDb();
      if (db) {
        const ok = await idbPutMessages(db, threadId, messages);
        if (!ok) {
          writeJson(messagesKey(threadId), messages);
        }
      } else {
        writeJson(messagesKey(threadId), messages);
      }
      if (!options?.skipRemoteSync && messages.length > 0) {
        await pushSyncSaveMessages(threadId, messages);
      }
    });
  writeQueues.set(threadId, next);
  return next;
}

export function listStoredThreads(): Thread[] {
  return readJson<Thread[]>(THREADS_KEY, []);
}

export function writeStoredThreads(threads: Thread[]): void {
  writeJson(THREADS_KEY, threads);
}

export async function readLocalMessages(threadId: string): Promise<Message[]> {
  return readMessagesFromStore(threadId);
}

export async function importReplayedSessionToStorage(params: {
  threadId: string;
  title: string;
  snapshot: AcpSessionSnapshot;
  messages: ReplayedTranscriptMessage[];
}): Promise<Thread> {
  const threads = readJson<Thread[]>(THREADS_KEY, []);
  const thread: Thread = {
    id: params.threadId,
    title: params.title || "Resumed Session",
    createdAt: Date.now(),
  };
  const nextThreads = [thread, ...threads.filter((t) => t.id !== params.threadId)];
  writeJson(THREADS_KEY, nextThreads);
  await enqueueMessageWrite(params.threadId, params.messages as unknown as Message[]);
  if (params.snapshot.cwd) {
    const folder = acpStore.addFolder({ cwd: params.snapshot.cwd });
    acpStore.assignThreadToFolder(params.threadId, folder.id);
  }
  acpStore.setSnapshot(params.threadId, params.snapshot);
  void pushSyncUpsertThread({
    ...thread,
    acpSessionId: params.snapshot.sessionId,
    appDataDir: params.snapshot.appDataDir,
  });
  return thread;
}

function waitUntilVisibleOrDelay(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    if (typeof document === "undefined" || document.visibilityState === "visible") {
      const t = setTimeout(resolve, 400);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
      return;
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        document.removeEventListener("visibilitychange", onVisible);
        setTimeout(resolve, 250);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    signal?.addEventListener(
      "abort",
      () => {
        document.removeEventListener("visibilitychange", onVisible);
        resolve();
      },
      { once: true },
    );
  });
}

function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (timeoutMs <= 0) {
    return reader.read();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      reject(new Error("SSE read inactivity timeout"));
    }, timeoutMs);
    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function isSseCommentFrame(frame: string): boolean {
  return frame.trimStart().startsWith(":");
}

export function createResilientSseStream(
  initialBody: ReadableStream<Uint8Array>,
  threadId: string,
  signal?: AbortSignal,
  options?: { inactivityTimeoutMs?: number; maxReattachAttempts?: number },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const inactivityTimeoutMs = options?.inactivityTimeoutMs ?? 25_000;
  const maxReattachAttempts = options?.maxReattachAttempts ?? 20;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let currentBody: ReadableStream<Uint8Array> | null = initialBody;
      let forwardedFrames = 0;
      let sawDone = false;
      let reattachAttempts = 0;

      while (currentBody && !sawDone && !signal?.aborted) {
        const reader = currentBody.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let framesInThisStream = 0;
        let streamError: unknown = null;

        try {
          while (true) {
            const { done, value } = await readWithTimeout(reader, inactivityTimeoutMs);
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let sepIdx = buffer.indexOf("\n\n");
            while (sepIdx !== -1) {
              const frame = buffer.slice(0, sepIdx + 2);
              buffer = buffer.slice(sepIdx + 2);

              if (!isSseCommentFrame(frame)) {
                framesInThisStream += 1;
                if (framesInThisStream > forwardedFrames) {
                  forwardedFrames = framesInThisStream;
                  controller.enqueue(encoder.encode(frame));
                  if (frame.startsWith("data: [DONE]")) {
                    sawDone = true;
                  }
                }
              }
              sepIdx = buffer.indexOf("\n\n");
            }
          }

          const tail = buffer + decoder.decode();
          if (tail.trim() && !isSseCommentFrame(tail)) {
            framesInThisStream += 1;
            if (framesInThisStream > forwardedFrames) {
              forwardedFrames = framesInThisStream;
              controller.enqueue(encoder.encode(tail));
              if (tail.includes("data: [DONE]")) {
                sawDone = true;
              }
            }
          }
        } catch (err) {
          streamError = err;
        }

        if (sawDone || signal?.aborted) {
          break;
        }

        if (reattachAttempts >= maxReattachAttempts) {
          if (streamError) {
            controller.error(streamError);
          } else {
            controller.close();
          }
          return;
        }

        reattachAttempts += 1;
        await waitUntilVisibleOrDelay(signal);
        if (signal?.aborted) {
          if (streamError) {
            controller.error(streamError);
          } else {
            controller.close();
          }
          return;
        }

        const resumeRes = await fetch(
          `/api/chat?threadId=${encodeURIComponent(threadId)}`,
          { signal },
        ).catch(() => null);

        if (!resumeRes?.ok || !resumeRes.body) {
          if (streamError) {
            controller.error(streamError);
          } else {
            controller.close();
          }
          return;
        }
        currentBody = resumeRes.body;
      }

      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  });
}

export function createAntigravityChatBindings(): {
  llm: ChatLLM;
  storage: ChatStorage;
} {
  let activeThreadId = "";
  const streamAdapter = createAcpStreamAdapter(() => activeThreadId);

  const baseLlm = fetchLLM({
    url: "/api/chat",
    streamAdapter,
    fetch: async (input, init) => {
      const state = acpStore.getState();
      const attachments = acpStore.consumeAttachments();
      let mergedBody: string | BodyInit | null | undefined = init?.body;
      let requestThreadId = activeThreadId;

      if (typeof init?.body === "string") {
        try {
          const parsed = JSON.parse(init.body) as Record<string, unknown>;
          const threadId = typeof parsed.threadId === "string" ? parsed.threadId : "";
          activeThreadId = threadId;
          requestThreadId = threadId;
          mergedBody = JSON.stringify({
            ...parsed,
            agent: selectEffectiveAgent(state, threadId),
            acpSessionId: state.acpSessionIds[threadId],
            appDataDir: state.appDataDirs[threadId],
            cwd: state.cwd || undefined,
            additionalDirectories: state.additionalDirectories,
            mcpServers: state.sessionMcpServers,
            mode: state.preferredMode || "auto",
            model: state.preferredModel || undefined,
            thoughtLevel: state.preferredThoughtLevel || undefined,
            attachments: attachments.map((a) => ({
              name: a.name,
              mimeType: a.mimeType,
              size: a.size,
              kind: a.kind,
              data: a.data,
              text: a.text,
            })),
          });
        } catch {
          // keep original body
        }
      }

      const res = await fetch(input, { ...init, body: mergedBody });
      if (res.ok && res.body && requestThreadId) {
        return new Response(
          createResilientSseStream(res.body, requestThreadId, init?.signal ?? undefined),
          {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          },
        );
      }
      return res;
    },
  });

  const send: ChatLLM["send"] = async (params) => {
    activeThreadId = params.threadId;
    void enqueueMessageWrite(params.threadId, params.messages);

    const response = await baseLlm.send(params);
    if (!response.ok || !response.body) return response;

    const [forChat, forStorage] = response.body.tee();
    const reply = new Map<string, Message>();
    const keep = (message: Message) => reply.set(message.id, message);

    processStreamedMessage({
      response: new Response(forStorage, response),
      createMessage: keep,
      updateMessage: keep,
      adapter: agUIAdapter(),
    })
      .catch(() => {})
      .finally(() => {
        if (reply.size > 0) {
          void enqueueMessageWrite(params.threadId, [...params.messages, ...reply.values()]);
        }
      });

    return new Response(forChat, response);
  };

  return {
    llm: { ...baseLlm, send },
    storage: {
      thread: {
        async listThreads() {
          const remote = await fetchRemoteSyncState();
          if (remote) {
            writeJson(THREADS_KEY, remote.threads);
            acpStore.applySyncedWorkspaceState(remote);
            return { threads: remote.threads };
          }
          return { threads: readJson<Thread[]>(THREADS_KEY, []) };
        },
        async createThread(firstMessage: UserMessage) {
          const raw = typeof firstMessage.content === "string" ? firstMessage.content.trim() : "";
          const thread: Thread = {
            id: crypto.randomUUID(),
            title: raw.slice(0, 60) || "New Antigravity chat",
            createdAt: Date.now(),
          };
          const prev = readJson<Thread[]>(THREADS_KEY, []);
          writeJson(THREADS_KEY, [thread, ...prev]);
          acpStore.assignThreadToFolder(thread.id);
          acpStore.markPendingAutoTitle(thread.id);
          void pushSyncUpsertThread(thread);
          return thread;
        },
        async getMessages(threadId: string) {
          const remoteMsgs = await fetchRemoteMessages(threadId);
          if (remoteMsgs && remoteMsgs.length > 0) {
            await enqueueMessageWrite(threadId, remoteMsgs, { skipRemoteSync: true });
            return remoteMsgs;
          }
          return readMessagesFromStore(threadId);
        },
        async updateThread(thread: Thread) {
          const prev = readJson<Thread[]>(THREADS_KEY, []);
          writeJson(
            THREADS_KEY,
            prev.map((t) => (t.id === thread.id ? thread : t)),
          );
          if (!acpStore.isApplyingAutoTitle()) {
            acpStore.markThreadManuallyRenamed(thread.id);
          }
          void pushSyncUpsertThread({ ...thread, updatedAt: Date.now() });
          return thread;
        },
        async deleteThread(id: string) {
          // Sidebar deletion hides the thread without erasing saved transcripts or session history.
          acpStore.hideThreadFromSidebar(id);
        },
      },
    },
  };
}
