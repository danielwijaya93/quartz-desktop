"use client";

import type { AcpSessionSnapshot, ReplayedTranscriptMessage } from "@/lib/acp/types";
import { acpStore } from "@/lib/client/acp-store";
import { createAcpStreamAdapter } from "@/lib/client/acp-stream-adapter";
import { enqueueMessageWrite } from "@/lib/client/local-storage";
import {
  processStreamedMessage,
  useThread,
  useThreadList,
  type Message,
} from "@openuidev/react-headless";
import { useEffect, useRef } from "react";

/**
 * Recovers an in-progress or recently completed ACP turn after a mobile page refresh or
 * background tab suspension when the last persisted message is an unanswered user message.
 */
export function ThreadRunRecovery() {
  const selectedThreadId = useThreadList((s) => s.selectedThreadId);
  const messages = useThread((s) => s.messages);
  const isRunning = useThread((s) => s.isRunning);
  const isLoadingMessages = useThread((s) => s.isLoadingMessages);
  const setMessages = useThread((s) => s.setMessages);

  const attemptedKeysRef = useRef<Set<string>>(new Set());
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    if (!selectedThreadId || isLoadingMessages || isRunning) return;
    if (messages.length === 0) return;

    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== "user") return;

    const attemptKey = `${selectedThreadId}:${lastMsg.id}`;
    if (attemptedKeysRef.current.has(attemptKey)) return;
    attemptedKeysRef.current.add(attemptKey);

    const controller = new AbortController();

    void (async () => {
      try {
        const res = await fetch(
          `/api/chat?threadId=${encodeURIComponent(selectedThreadId)}`,
          { signal: controller.signal },
        );

        if (res.ok && res.body) {
          const baseMessages = messagesRef.current;
          const reply = new Map<string, Message>();
          const syncMessages = (message: Message) => {
            reply.set(message.id, message);
            setMessages([...baseMessages, ...reply.values()]);
          };

          await processStreamedMessage({
            response: res,
            createMessage: syncMessages,
            updateMessage: syncMessages,
            adapter: createAcpStreamAdapter(() => selectedThreadId),
          });

          if (reply.size > 0) {
            const finalMessages = [...baseMessages, ...reply.values()];
            setMessages(finalMessages);
            await enqueueMessageWrite(selectedThreadId, finalMessages);
          }
          return;
        }

        // Fallback if server restarted: reload from ACP's persisted session store
        const state = acpStore.getState();
        const acpSessionId = state.acpSessionIds[selectedThreadId];
        if (!acpSessionId) return;

        const loadRes = await fetch("/api/acp/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            action: "loadSession",
            threadId: selectedThreadId,
            acpSessionId,
            appDataDir: state.appDataDirs[selectedThreadId],
            cwd: state.cwd || undefined,
            additionalDirectories: state.additionalDirectories,
            mcpServers: state.sessionMcpServers,
          }),
        });
        if (!loadRes.ok) return;

        const data = (await loadRes.json()) as {
          snapshot?: AcpSessionSnapshot;
          messages?: ReplayedTranscriptMessage[];
        };
        if (data.snapshot) {
          acpStore.setSnapshot(selectedThreadId, data.snapshot);
        }
        if (data.messages && data.messages.length > messagesRef.current.length) {
          const recovered = data.messages as unknown as Message[];
          setMessages(recovered);
          await enqueueMessageWrite(selectedThreadId, recovered);
        }
      } catch {
        // ignore abort or transient failures
      }
    })();

    return () => {
      controller.abort();
    };
  }, [selectedThreadId, isLoadingMessages, isRunning, messages, setMessages]);

  return null;
}
