import type { AcpAppDataDir, WorkspaceFolder } from "@/lib/acp/types";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface SyncedThread {
  id: string;
  title: string;
  createdAt: string | number;
  isPending?: boolean;
  updatedAt?: number;
  acpSessionId?: string;
  appDataDir?: AcpAppDataDir;
  agent?: string;
  host?: string;
}

export interface SyncedState {
  version: number;
  updatedAt: number;
  threads: SyncedThread[];
  folders: WorkspaceFolder[];
  activeFolderId: string | null;
  threadFolders: Record<string, string>;
  hiddenThreadIds: string[];
  acpSessionIds: Record<string, string>;
  appDataDirs: Record<string, AcpAppDataDir>;
}

export interface SyncChangeEvent {
  type: "sync";
  version: number;
  updatedAt: number;
  threadId?: string;
  clientId?: string;
}

type SyncListener = (event: SyncChangeEvent) => void;

const globalSync = globalThis as unknown as {
  __genuiSyncListeners?: Set<SyncListener>;
  __genuiSyncLock?: Promise<void>;
};

const LISTENERS = (globalSync.__genuiSyncListeners ??= new Set<SyncListener>());

export function getSyncDataDir(): string {
  const override = process.env.GENUI_DATA_DIR?.trim();
  return override || join(homedir(), ".config", "antigravity-genui");
}

function getStateFilePath(dataDir = getSyncDataDir()): string {
  return join(dataDir, "state.json");
}

function sanitizeThreadId(threadId: string): string {
  const cleaned = threadId.trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error("Invalid threadId.");
  }
  return cleaned;
}

function getMessagesFilePath(threadId: string, dataDir = getSyncDataDir()): string {
  return join(dataDir, "messages", `${sanitizeThreadId(threadId)}.json`);
}

function toEpochMs(value: string | number | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function emptyState(): SyncedState {
  return {
    version: 0,
    updatedAt: 0,
    threads: [],
    folders: [],
    activeFolderId: null,
    threadFolders: {},
    hiddenThreadIds: [],
    acpSessionIds: {},
    appDataDirs: {},
  };
}

function atomicWriteJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

function readStateSync(dataDir = getSyncDataDir()): SyncedState {
  const filePath = getStateFilePath(dataDir);
  if (!existsSync(filePath)) return emptyState();
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SyncedState>;
    return {
      version: typeof parsed.version === "number" ? parsed.version : 0,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      threads: Array.isArray(parsed.threads) ? parsed.threads : [],
      folders: Array.isArray(parsed.folders) ? parsed.folders : [],
      activeFolderId:
        typeof parsed.activeFolderId === "string" || parsed.activeFolderId === null
          ? parsed.activeFolderId
          : null,
      threadFolders:
        parsed.threadFolders && typeof parsed.threadFolders === "object"
          ? parsed.threadFolders
          : {},
      hiddenThreadIds: Array.isArray(parsed.hiddenThreadIds) ? parsed.hiddenThreadIds : [],
      acpSessionIds:
        parsed.acpSessionIds && typeof parsed.acpSessionIds === "object"
          ? parsed.acpSessionIds
          : {},
      appDataDirs:
        parsed.appDataDirs && typeof parsed.appDataDirs === "object" ? parsed.appDataDirs : {},
    };
  } catch {
    return emptyState();
  }
}

function notifyListeners(event: SyncChangeEvent): void {
  for (const listener of LISTENERS) {
    try {
      listener(event);
    } catch {
      // ignore subscriber errors
    }
  }
}

export function subscribeSyncEvents(listener: SyncListener): () => void {
  LISTENERS.add(listener);
  return () => {
    LISTENERS.delete(listener);
  };
}

async function withSyncLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = globalSync.__genuiSyncLock ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalSync.__genuiSyncLock = prev.catch(() => {}).then(() => current);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

export function getSyncedState(dataDir = getSyncDataDir()): SyncedState {
  return readStateSync(dataDir);
}

export function getSyncedMessages(threadId: string, dataDir = getSyncDataDir()): unknown[] | null {
  const filePath = getMessagesFilePath(threadId, dataDir);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveSyncedMessages(
  threadId: string,
  messages: unknown[],
  options?: { clientId?: string; dataDir?: string },
): Promise<SyncedState> {
  const dataDir = options?.dataDir ?? getSyncDataDir();
  return withSyncLock(() => {
    atomicWriteJson(getMessagesFilePath(threadId, dataDir), messages);
    const state = readStateSync(dataDir);
    const now = Date.now();
    const nextState: SyncedState = {
      ...state,
      version: state.version + 1,
      updatedAt: now,
      threads: state.threads.map((t) => (t.id === threadId ? { ...t, updatedAt: now } : t)),
    };
    atomicWriteJson(getStateFilePath(dataDir), nextState);
    notifyListeners({
      type: "sync",
      version: nextState.version,
      updatedAt: now,
      threadId,
      clientId: options?.clientId,
    });
    return nextState;
  });
}

export async function upsertSyncedThread(
  thread: SyncedThread,
  options?: { clientId?: string; dataDir?: string },
): Promise<SyncedState> {
  const dataDir = options?.dataDir ?? getSyncDataDir();
  return withSyncLock(() => {
    const state = readStateSync(dataDir);
    const now = Date.now();
    const existing = state.threads.find((t) => t.id === thread.id);
    const mergedThread: SyncedThread = {
      ...existing,
      ...thread,
      createdAt: existing?.createdAt ?? thread.createdAt ?? now,
      updatedAt: thread.updatedAt ?? now,
    };
    const nextThreads = existing
      ? state.threads.map((t) => (t.id === thread.id ? mergedThread : t))
      : [mergedThread, ...state.threads];

    const nextAcpSessionIds = { ...state.acpSessionIds };
    if (mergedThread.acpSessionId) {
      nextAcpSessionIds[mergedThread.id] = mergedThread.acpSessionId;
    }
    const nextAppDataDirs = { ...state.appDataDirs };
    if (mergedThread.appDataDir) {
      nextAppDataDirs[mergedThread.id] = mergedThread.appDataDir;
    }

    const nextState: SyncedState = {
      ...state,
      version: state.version + 1,
      updatedAt: now,
      threads: nextThreads,
      acpSessionIds: nextAcpSessionIds,
      appDataDirs: nextAppDataDirs,
    };
    atomicWriteJson(getStateFilePath(dataDir), nextState);
    notifyListeners({
      type: "sync",
      version: nextState.version,
      updatedAt: now,
      threadId: thread.id,
      clientId: options?.clientId,
    });
    return nextState;
  });
}

export async function updateSyncedWorkspaceState(
  patch: Partial<
    Pick<
      SyncedState,
      | "folders"
      | "activeFolderId"
      | "threadFolders"
      | "hiddenThreadIds"
      | "acpSessionIds"
      | "appDataDirs"
    >
  >,
  options?: { clientId?: string; dataDir?: string },
): Promise<SyncedState> {
  const dataDir = options?.dataDir ?? getSyncDataDir();
  return withSyncLock(() => {
    const state = readStateSync(dataDir);
    const now = Date.now();
    const nextState: SyncedState = {
      ...state,
      ...patch,
      version: state.version + 1,
      updatedAt: now,
    };
    atomicWriteJson(getStateFilePath(dataDir), nextState);
    notifyListeners({
      type: "sync",
      version: nextState.version,
      updatedAt: now,
      clientId: options?.clientId,
    });
    return nextState;
  });
}

export async function mergeSyncedState(
  incoming: {
    threads?: SyncedThread[];
    folders?: WorkspaceFolder[];
    activeFolderId?: string | null;
    threadFolders?: Record<string, string>;
    hiddenThreadIds?: string[];
    acpSessionIds?: Record<string, string>;
    appDataDirs?: Record<string, AcpAppDataDir>;
    messagesByThread?: Record<string, unknown[]>;
  },
  options?: { clientId?: string; dataDir?: string },
): Promise<SyncedState> {
  const dataDir = options?.dataDir ?? getSyncDataDir();
  return withSyncLock(() => {
    const state = readStateSync(dataDir);
    const now = Date.now();
    let changed = false;

    const threadMap = new Map<string, SyncedThread>();
    for (const t of state.threads) {
      threadMap.set(t.id, t);
    }
    for (const t of incoming.threads ?? []) {
      if (!t?.id) continue;
      const existing = threadMap.get(t.id);
      if (!existing) {
        threadMap.set(t.id, { ...t, updatedAt: t.updatedAt ?? (toEpochMs(t.createdAt) || now) });
        changed = true;
      } else {
        const existingTs = existing.updatedAt ?? toEpochMs(existing.createdAt);
        const incomingTs = t.updatedAt ?? toEpochMs(t.createdAt);
        if (incomingTs > existingTs) {
          threadMap.set(t.id, { ...existing, ...t });
          changed = true;
        }
      }
    }

    const folderMap = new Map<string, WorkspaceFolder>();
    for (const f of state.folders) {
      folderMap.set(f.cwd, f);
    }
    for (const f of incoming.folders ?? []) {
      if (!f?.id || !f?.cwd) continue;
      if (!folderMap.has(f.cwd)) {
        folderMap.set(f.cwd, f);
        changed = true;
      }
    }

    const mergedThreadFolders = { ...(incoming.threadFolders ?? {}), ...state.threadFolders };
    const mergedAcpSessionIds = { ...(incoming.acpSessionIds ?? {}), ...state.acpSessionIds };
    const mergedAppDataDirs = { ...(incoming.appDataDirs ?? {}), ...state.appDataDirs };
    const hiddenSet = new Set<string>([
      ...state.hiddenThreadIds,
      ...(incoming.hiddenThreadIds ?? []),
    ]);

    if (incoming.messagesByThread) {
      for (const [threadId, msgs] of Object.entries(incoming.messagesByThread)) {
        if (!Array.isArray(msgs) || msgs.length === 0) continue;
        const existingMsgs = getSyncedMessages(threadId, dataDir);
        if (!existingMsgs || existingMsgs.length < msgs.length) {
          atomicWriteJson(getMessagesFilePath(threadId, dataDir), msgs);
          changed = true;
        }
      }
    }

    const mergedThreads = Array.from(threadMap.values()).sort(
      (a, b) => toEpochMs(b.createdAt) - toEpochMs(a.createdAt),
    );
    const mergedFolders = Array.from(folderMap.values());
    const mergedHidden = Array.from(hiddenSet);
    const activeFolderId = state.activeFolderId ?? incoming.activeFolderId ?? mergedFolders[0]?.id ?? null;

    if (!changed && state.version > 0) {
      return state;
    }

    const nextState: SyncedState = {
      version: state.version + 1,
      updatedAt: now,
      threads: mergedThreads,
      folders: mergedFolders,
      activeFolderId,
      threadFolders: mergedThreadFolders,
      hiddenThreadIds: mergedHidden,
      acpSessionIds: mergedAcpSessionIds,
      appDataDirs: mergedAppDataDirs,
    };
    atomicWriteJson(getStateFilePath(dataDir), nextState);
    notifyListeners({
      type: "sync",
      version: nextState.version,
      updatedAt: now,
      clientId: options?.clientId,
    });
    return nextState;
  });
}
