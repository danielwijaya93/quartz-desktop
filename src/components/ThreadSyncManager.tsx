"use client";

import type { SyncChangeEvent } from "@/lib/acp/sync-store";
import { acpStore } from "@/lib/client/acp-store";
import {
  enqueueMessageWrite,
  listStoredThreads,
  readLocalMessages,
  writeStoredThreads,
} from "@/lib/client/local-storage";
import {
  fetchRemoteMessages,
  fetchRemoteSyncState,
  getSyncClientId,
  mergeLocalWithServerSync,
} from "@/lib/client/sync-client";
import { useThread, useThreadList, type Message } from "@openuidev/react-headless";
import { useEffect, useRef } from "react";

const SYNC_MIGRATED_KEY = "agy-openui:sync-migrated";

export function ThreadSyncManager() {
  const loadThreads = useThreadList((s) => s.loadThreads);
  const selectedThreadId = useThreadList((s) => s.selectedThreadId);
  const isRunning = useThread((s) => s.isRunning);
  const messages = useThread((s) => s.messages);
  const setMessages = useThread((s) => s.setMessages);

  const selectedThreadIdRef = useRef(selectedThreadId);
  selectedThreadIdRef.current = selectedThreadId;
  const isRunningRef = useRef(isRunning);
  isRunningRef.current = isRunning;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const lastVersionRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    const applyRemoteAndRefresh = async (changedThreadId?: string) => {
      const remote = await fetchRemoteSyncState();
      if (cancelled || !remote) return;

      lastVersionRef.current = remote.version;
      writeStoredThreads(remote.threads);
      acpStore.applySyncedWorkspaceState(remote);
      await loadThreads();

      const activeId = selectedThreadIdRef.current;
      if (
        activeId &&
        !isRunningRef.current &&
        (!changedThreadId || changedThreadId === activeId)
      ) {
        const remoteMsgs = await fetchRemoteMessages(activeId);
        if (cancelled || !remoteMsgs || isRunningRef.current) return;
        const currentMsgs = messagesRef.current;
        if (
          remoteMsgs.length !== currentMsgs.length ||
          JSON.stringify(remoteMsgs[remoteMsgs.length - 1]) !==
            JSON.stringify(currentMsgs[currentMsgs.length - 1])
        ) {
          await enqueueMessageWrite(activeId, remoteMsgs, { skipRemoteSync: true });
          setMessages(remoteMsgs as Message[]);
        }
      }
    };

    void (async () => {
      acpStore.hydrateFromStorage();
      const localThreads = listStoredThreads();
      const store = acpStore.getState();
      const alreadyMigrated =
        typeof window !== "undefined" && localStorage.getItem(SYNC_MIGRATED_KEY) === "1";

      const messagesByThread: Record<string, Message[]> = {};
      if (!alreadyMigrated && localThreads.length > 0) {
        await Promise.all(
          localThreads.map(async (t) => {
            const msgs = await readLocalMessages(t.id);
            if (msgs.length > 0) {
              messagesByThread[t.id] = msgs;
            }
          }),
        );
      }

      const merged = await mergeLocalWithServerSync({
        threads: localThreads,
        folders: store.folders,
        activeFolderId: store.activeFolderId,
        threadFolders: store.threadFolderMap,
        hiddenThreadIds: store.hiddenThreadIds,
        acpSessionIds: store.acpSessionIds,
        appDataDirs: store.appDataDirs,
        threadAgents: store.threadAgents,
        messagesByThread,
      });

      if (cancelled || !merged) return;

      if (typeof window !== "undefined") {
        localStorage.setItem(SYNC_MIGRATED_KEY, "1");
      }
      lastVersionRef.current = merged.version;
      writeStoredThreads(merged.threads);
      acpStore.applySyncedWorkspaceState(merged);
      await loadThreads();
    })();

    const myClientId = getSyncClientId();
    const es = new EventSource("/api/sync/events");
    es.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as SyncChangeEvent;
        if (event.clientId === myClientId) return;
        if (event.version <= lastVersionRef.current) return;
        void applyRemoteAndRefresh(event.threadId);
      } catch {
        // ignore malformed sync event
      }
    };

    const onWake = () => {
      if (document.visibilityState === "visible") {
        void applyRemoteAndRefresh(selectedThreadIdRef.current ?? undefined);
      }
    };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);

    return () => {
      cancelled = true;
      es.close();
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [loadThreads, setMessages]);

  return null;
}
