"use client";

import type { SyncedState, SyncedThread } from "@/lib/acp/sync-store";
import type { AcpAppDataDir, WorkspaceFolder } from "@/lib/acp/types";
import type { Message } from "@openuidev/react-headless";

let tabClientId: string | null = null;
let applyingRemoteSyncDepth = 0;

export function getSyncClientId(): string {
  if (!tabClientId) {
    tabClientId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `client-${Math.random().toString(36).slice(2)}`;
  }
  return tabClientId;
}

export function isApplyingRemoteSync(): boolean {
  return applyingRemoteSyncDepth > 0;
}

export function withRemoteSyncApplied(fn: () => void): void {
  applyingRemoteSyncDepth += 1;
  try {
    fn();
  } finally {
    applyingRemoteSyncDepth = Math.max(0, applyingRemoteSyncDepth - 1);
  }
}

async function postSync(body: Record<string, unknown>): Promise<SyncedState | null> {
  if (typeof window === "undefined") return null;
  try {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, clientId: getSyncClientId() }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { state?: SyncedState };
    return data.state ?? null;
  } catch {
    return null;
  }
}

export async function fetchRemoteSyncState(): Promise<SyncedState | null> {
  if (typeof window === "undefined") return null;
  try {
    const res = await fetch("/api/sync", { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { state?: SyncedState };
    return data.state ?? null;
  } catch {
    return null;
  }
}

export async function fetchRemoteMessages(threadId: string): Promise<Message[] | null> {
  if (typeof window === "undefined" || !threadId) return null;
  try {
    const res = await fetch(`/api/sync?threadId=${encodeURIComponent(threadId)}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { messages?: Message[] | null };
    return Array.isArray(data.messages) ? data.messages : null;
  } catch {
    return null;
  }
}

export async function pushSyncUpsertThread(thread: SyncedThread): Promise<SyncedState | null> {
  return postSync({ action: "upsertThread", thread });
}

export async function pushSyncSaveMessages(
  threadId: string,
  messages: Message[],
): Promise<SyncedState | null> {
  return postSync({ action: "saveMessages", threadId, messages });
}

export async function pushSyncWorkspaceState(patch: {
  folders?: WorkspaceFolder[];
  activeFolderId?: string | null;
  threadFolders?: Record<string, string>;
  hiddenThreadIds?: string[];
  acpSessionIds?: Record<string, string>;
  appDataDirs?: Record<string, AcpAppDataDir>;
}): Promise<SyncedState | null> {
  return postSync({ action: "updateWorkspaceState", patch });
}

export async function mergeLocalWithServerSync(incoming: {
  threads?: SyncedThread[];
  folders?: WorkspaceFolder[];
  activeFolderId?: string | null;
  threadFolders?: Record<string, string>;
  hiddenThreadIds?: string[];
  acpSessionIds?: Record<string, string>;
  appDataDirs?: Record<string, AcpAppDataDir>;
  messagesByThread?: Record<string, Message[]>;
}): Promise<SyncedState | null> {
  return postSync({ action: "merge", incoming });
}
