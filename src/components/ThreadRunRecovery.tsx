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
 * Recovers an in-progress or recently completed ACP turn after a thread switch,
 * mobile page refresh, background tab suspension, or stalled stream.
 */
export function ThreadRunRecovery() {
  const selectedThreadId = useThreadList((s) => s.selectedThreadId);
  const messages = useThread((s) => s.messages);
  const isRunning = useThread((s) => s.isRunning);
  const isLoadingMessages = useThread((s) => s.isLoadingMessages);
  const setMessages = useThread((s) => s.setMessages);

  const recoveredRunsRef = useRef<Set<string>>(new Set());
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    if (!selectedThreadId || isLoadingMessages || isRunning) return;
    const currentMsgs = messagesRef.current;
    if (currentMsgs.length === 0) return;

    const lastMsg = currentMsgs[currentMsgs.length - 1];
    if (!lastMsg) return;

    const lastUserIdx = currentMsgs.findLastIndex((m) => m.role === "user");
    if (lastUserIdx === -1) return;

    const controller = new AbortController();

    void (async () => {
      try {
        const metaRes = await fetch(
          `/api/chat?threadId=${encodeURIComponent(selectedThreadId)}&meta=1`,
          { signal: controller.signal, cache: "no-store" },
        );

        let shouldAttachRun = lastMsg.role === "user";
        let activeRunKey: string | null = null;

        if (metaRes.ok) {
          const meta = (await metaRes.json()) as {
            runId?: string;
            done?: boolean;
            finishedAt?: number | null;
          };
          if (meta.done === false) {
            shouldAttachRun = true;
            acpStore.setThreadStatus(selectedThreadId, "working");
          } else if (meta.finishedAt && meta.runId) {
            const runKey = `${selectedThreadId}:run:${meta.runId}`;
            if (!recoveredRunsRef.current.has(runKey)) {
              activeRunKey = runKey;
              shouldAttachRun = true;
            }
          }
        }

        if (shouldAttachRun) {
          const res = await fetch(
            `/api/chat?threadId=${encodeURIComponent(selectedThreadId)}`,
            { signal: controller.signal },
          );

          if (res.ok && res.body) {
            const current = messagesRef.current;
            const cutIdx = current.findLastIndex((m) => m.role === "user");
            const baseMessages = cutIdx >= 0 ? current.slice(0, cutIdx + 1) : current;
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

            if (activeRunKey) {
              recoveredRunsRef.current.add(activeRunKey);
            }
            if (reply.size > 0) {
              const finalMessages = [...baseMessages, ...reply.values()];
              setMessages(finalMessages);
              await enqueueMessageWrite(selectedThreadId, finalMessages);
            }
            return;
          }
        }

        const latestMsgs = messagesRef.current;
        const latestUserIdx = latestMsgs.findLastIndex((m) => m.role === "user");
        const hasPendingBgTaskInTurn =
          latestUserIdx !== -1 &&
          latestMsgs
            .slice(latestUserIdx + 1)
            .some(
              (m) =>
                m.role === "tool" &&
                typeof m.content === "string" &&
                (m.content.includes("Tool is running as a background task") ||
                  m.content.trimStart().startsWith('{"CommandLine":')),
            );

        const latestLastMsg = latestMsgs[latestMsgs.length - 1];
        const hasFinalAssistantText =
          latestLastMsg?.role === "assistant" &&
          typeof latestLastMsg.content === "string" &&
          latestLastMsg.content.trim().length > 0;

        if (hasFinalAssistantText && !hasPendingBgTaskInTurn) return;

        // Fallback if server restarted: reload from ACP's persisted session store
        const state = acpStore.getState();
        const acpSessionId = state.acpSessionIds[selectedThreadId];
        if (!acpSessionId) return;

        const fallbackKey = `${selectedThreadId}:load:${lastMsg.id}:${latestMsgs.length}`;
        if (recoveredRunsRef.current.has(fallbackKey)) return;
        recoveredRunsRef.current.add(fallbackKey);

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
  }, [selectedThreadId, isLoadingMessages, isRunning, setMessages]);

  return null;
}
