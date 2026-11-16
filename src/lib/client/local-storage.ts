"use client";

import type { AcpSessionSnapshot, ReplayedTranscriptMessage } from "@/lib/acp/types";
import { acpStore } from "@/lib/client/acp-store";
import { createAcpStreamAdapter } from "@/lib/client/acp-stream-adapter";
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
    // ignore storage errors
  }
}

export function listStoredThreads(): Thread[] {
  return readJson<Thread[]>(THREADS_KEY, []);
}

export function importReplayedSessionToStorage(params: {
  threadId: string;
  title: string;
  snapshot: AcpSessionSnapshot;
  messages: ReplayedTranscriptMessage[];
}): Thread {
  const threads = readJson<Thread[]>(THREADS_KEY, []);
  const thread: Thread = {
    id: params.threadId,
    title: params.title || "Resumed Session",
    createdAt: Date.now(),
  };
  const nextThreads = [thread, ...threads.filter((t) => t.id !== params.threadId)];
  writeJson(THREADS_KEY, nextThreads);
  writeJson(messagesKey(params.threadId), params.messages);
  if (params.snapshot.cwd) {
    const folder = acpStore.addFolder({ cwd: params.snapshot.cwd });
    acpStore.assignThreadToFolder(params.threadId, folder.id);
  }
  acpStore.setSnapshot(params.threadId, params.snapshot);
  return thread;
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

      if (typeof init?.body === "string") {
        try {
          const parsed = JSON.parse(init.body) as Record<string, unknown>;
          const threadId = typeof parsed.threadId === "string" ? parsed.threadId : "";
          activeThreadId = threadId;
          mergedBody = JSON.stringify({
            ...parsed,
            acpSessionId: state.acpSessionIds[threadId],
            cwd: state.cwd || undefined,
            additionalDirectories: state.additionalDirectories,
            mcpServers: state.sessionMcpServers,
            mode: state.preferredMode || "auto",
            model: state.preferredModel || undefined,
            thoughtLevel: state.preferredThoughtLevel || undefined,
            attachments: attachments.map((a) => ({
              name: a.name,
              mimeType: a.mimeType,
              data: a.data,
            })),
          });
        } catch {
          // keep original body
        }
      }

      return fetch(input, { ...init, body: mergedBody });
    },
  });

  const send: ChatLLM["send"] = async (params) => {
    activeThreadId = params.threadId;
    writeJson(messagesKey(params.threadId), params.messages);

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
          writeJson(messagesKey(params.threadId), [...params.messages, ...reply.values()]);
        }
      });

    return new Response(forChat, response);
  };

  return {
    llm: { ...baseLlm, send },
    storage: {
      thread: {
        async listThreads() {
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
          return thread;
        },
        async getMessages(threadId: string) {
          return readJson<Message[]>(messagesKey(threadId), []);
        },
        async updateThread(thread: Thread) {
          const prev = readJson<Thread[]>(THREADS_KEY, []);
          writeJson(
            THREADS_KEY,
            prev.map((t) => (t.id === thread.id ? thread : t)),
          );
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
