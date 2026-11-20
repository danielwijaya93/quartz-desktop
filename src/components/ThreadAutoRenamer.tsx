"use client";

import { acpStore, useAcpStore } from "@/lib/client/acp-store";
import { useThread, useThreadList, type Message } from "@openuidev/react-headless";
import { useEffect, useRef } from "react";

function extractMessageText(msg: Message | undefined): string {
  if (!msg || !("content" in msg) || !msg.content) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Automatically renames newly created threads once a turn finishes:
 * 1. Uses Antigravity ACP's native `session_info_update` title immediately when emitted.
 * 2. Falls back to `POST /api/thread-title` (`gemini-3.8-flash`) if ACP didn't emit a title
 *    (e.g. `!shell` or `/usage`), never overwriting manual user renames.
 */
export function ThreadAutoRenamer() {
  const selectedThreadId = useThreadList((s) => s.selectedThreadId);
  const threads = useThreadList((s) => s.threads);
  const updateThread = useThreadList((s) => s.updateThread);
  const messages = useThread((s) => s.messages);
  const isRunning = useThread((s) => s.isRunning);

  const pendingAutoTitleIds = useAcpStore((s) => s.pendingAutoTitleIds);
  const manuallyRenamedThreadIds = useAcpStore((s) => s.manuallyRenamedThreadIds);
  const snapshots = useAcpStore((s) => s.snapshots);
  const cwd = useAcpStore((s) => s.cwd);

  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  const inFlightRef = useRef<Set<string>>(new Set());

  // Path 1: Sync ACP native `session_info_update` titles cleanly across pending threads
  useEffect(() => {
    const manualSet = new Set(manuallyRenamedThreadIds);
    for (const threadId of pendingAutoTitleIds) {
      if (manualSet.has(threadId)) continue;
      const acpTitle = snapshots[threadId]?.title?.trim();
      if (!acpTitle) continue;
      const thread = threadsRef.current.find((t) => t.id === threadId);
      if (!thread) continue;

      if (thread.title !== acpTitle) {
        acpStore.runAsAutoTitle(() => {
          updateThread({ ...thread, title: acpTitle });
        });
      }
      acpStore.markThreadAutoTitled(threadId);
    }
  }, [pendingAutoTitleIds, manuallyRenamedThreadIds, snapshots, updateThread]);

  // Path 2: Fallback LLM rename after the first turn completes without an ACP title
  useEffect(() => {
    if (!selectedThreadId || isRunning) return;
    if (!pendingAutoTitleIds.includes(selectedThreadId)) return;
    if (manuallyRenamedThreadIds.includes(selectedThreadId)) return;
    if (snapshots[selectedThreadId]?.title?.trim()) return;
    if (inFlightRef.current.has(selectedThreadId)) return;

    const firstUser = messages.find((m) => m.role === "user");
    const lastAssistant = [...messages].reverse().find(
      (m) => m.role === "assistant" && extractMessageText(m).trim().length > 0,
    );
    const userText = extractMessageText(firstUser).trim();
    const assistantText = extractMessageText(lastAssistant).trim();
    if (!userText || !assistantText) return;

    const threadId = selectedThreadId;
    let cancelled = false;

    const timer = setTimeout(async () => {
      if (cancelled) return;
      const latest = acpStore.getState();
      if (
        !latest.pendingAutoTitleIds.includes(threadId) ||
        latest.manuallyRenamedThreadIds.includes(threadId) ||
        latest.snapshots[threadId]?.title?.trim() ||
        inFlightRef.current.has(threadId)
      ) {
        return;
      }

      inFlightRef.current.add(threadId);
      try {
        const res = await fetch("/api/thread-title", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userMessage: userText,
            assistantPreview: assistantText,
            cwd: latest.snapshots[threadId]?.cwd || cwd || undefined,
          provider: latest.preferredProvider ?? "antigravity",
          }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { title?: string | null };
        const nextTitle = data.title?.trim();
        if (!nextTitle) return;

        const afterState = acpStore.getState();
        if (
          afterState.manuallyRenamedThreadIds.includes(threadId) ||
          afterState.autoTitledThreadIds.includes(threadId)
        ) {
          return;
        }
        const currentThread = threadsRef.current.find((t) => t.id === threadId);
        if (!currentThread) return;

        acpStore.runAsAutoTitle(() => {
          updateThread({ ...currentThread, title: nextTitle });
        });
        acpStore.markThreadAutoTitled(threadId);
      } catch {
        // Non-fatal fallback: keep truncated prompt title if LLM call fails
      } finally {
        inFlightRef.current.delete(threadId);
      }
    }, 900);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    selectedThreadId,
    isRunning,
    messages,
    pendingAutoTitleIds,
    manuallyRenamedThreadIds,
    snapshots,
    cwd,
    updateThread,
  ]);

  return null;
}
