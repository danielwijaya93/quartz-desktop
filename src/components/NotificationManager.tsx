"use client";

import {
  acpStore,
  useAcpStore,
  type ThreadActivityStatus,
} from "@/lib/client/acp-store";
import {
  getNotificationPermissionState,
  registerNotificationServiceWorker,
  requestNotificationPermission,
  sendThreadNotification,
  type NotificationPermissionState,
} from "@/lib/client/notifications";
import { useThreadList } from "@openuidev/react-headless";
import { Bell, BellOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Registers the PWA service worker, handles notification click deep-links,
 * and dispatches desktop/mobile web notifications on `needs_input` and background `unread` transitions.
 */
export function NotificationManager() {
  const threads = useThreadList((s) => s.threads);
  const selectThread = useThreadList((s) => s.selectThread);
  const threadStatus = useAcpStore((s) => s.threadStatus);
  const activeThreadId = useAcpStore((s) => s.activeThreadId);
  const notificationsEnabled = useAcpStore((s) => s.notificationsEnabled);

  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  const prevStatusRef = useRef<Record<string, ThreadActivityStatus>>({});

  const openThreadById = useCallback(
    (threadId: string) => {
      const folderId = acpStore.getState().threadFolderMap[threadId];
      if (folderId) {
        acpStore.selectFolder(folderId);
      }
      acpStore.markThreadViewed(threadId, { acknowledgeCurrent: true });
      selectThread(threadId);
    },
    [selectThread],
  );

  useEffect(() => {
    void registerNotificationServiceWorker();

    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const initialThreadId = params.get("threadId");
      if (initialThreadId) {
        openThreadById(initialThreadId);
        params.delete("threadId");
        const nextQuery = params.toString();
        const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`;
        window.history.replaceState(null, "", nextUrl);
      }
    }

    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as { type?: string; threadId?: string } | undefined;
      if (data?.type === "open-thread" && typeof data.threadId === "string" && data.threadId) {
        openThreadById(data.threadId);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, [openThreadById]);

  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = threadStatus;

    if (!notificationsEnabled || getNotificationPermissionState() !== "granted") {
      return;
    }

    for (const [threadId, status] of Object.entries(threadStatus)) {
      if (prev[threadId] === status) continue;
      if (status !== "needs_input" && status !== "unread") continue;

      const isHidden = typeof document !== "undefined" && document.hidden;
      const isDifferentThread = activeThreadIdRef.current !== threadId;
      if (status === "unread" && !isHidden && !isDifferentThread) continue;
      if (status === "needs_input" && !isHidden && !isDifferentThread) continue;

      const threadTitle =
        threadsRef.current.find((t) => t.id === threadId)?.title?.trim() || "Thread";

      void sendThreadNotification({
        threadId,
        title: status === "needs_input" ? "Input needed" : "Response ready",
        body:
          status === "needs_input"
            ? `${threadTitle} is waiting for your decision`
            : `${threadTitle} finished responding`,
        tag: `thread:${threadId}:${status}`,
        onSelectThread: openThreadById,
      });
    }
  }, [threadStatus, notificationsEnabled, openThreadById]);

  return null;
}

/** Compact bell toggle for enabling/muting desktop & mobile web notifications. */
export function NotificationBellButton({ className = "" }: { className?: string }) {
  const notificationsEnabled = useAcpStore((s) => s.notificationsEnabled);
  const [permission, setPermission] = useState<NotificationPermissionState>("default");

  useEffect(() => {
    setPermission(getNotificationPermissionState());
  }, []);

  if (permission === "unsupported") return null;

  const isActive = permission === "granted" && notificationsEnabled;
  const isDenied = permission === "denied";

  const title = isDenied
    ? "Notifications blocked in browser settings"
    : permission === "default"
      ? "Enable desktop & mobile notifications"
      : isActive
        ? "Notifications on (click to mute)"
        : "Notifications muted (click to enable)";

  const handleClick = async () => {
    if (isDenied) return;
    if (permission === "default") {
      const nextPerm = await requestNotificationPermission();
      setPermission(nextPerm);
      if (nextPerm === "granted") {
        acpStore.setPreferences({ notificationsEnabled: true });
      }
      return;
    }
    acpStore.setPreferences({ notificationsEnabled: !notificationsEnabled });
  };

  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      aria-pressed={isActive}
      onClick={() => void handleClick()}
      className={`relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/25 dark:focus-visible:ring-white/30 ${
        isDenied
          ? "opacity-35 cursor-not-allowed"
          : isActive
            ? "opacity-85 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] hover:opacity-100 cursor-pointer"
            : "opacity-55 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] hover:opacity-100 cursor-pointer"
      } ${className}`}
    >
      {isDenied || (permission === "granted" && !notificationsEnabled) ? (
        <BellOff className="h-4 w-4 shrink-0" aria-hidden="true" />
      ) : (
        <Bell className="h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      {isActive && (
        <span
          aria-hidden="true"
          className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-emerald-500"
        />
      )}
    </button>
  );
}
