"use client";

import type {
  AcpCommand,
  AcpCustomEventPayload,
  AcpSessionMcpServer,
  AcpSessionSnapshot,
  PendingPermissionRequest,
} from "@/lib/acp/types";
import { useSyncExternalStore } from "react";

export interface ImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  data: string;
}

export type ActiveModalKind = null | "mcp" | "add-folder" | "sessions";

export interface WorkspaceFolder {
  id: string;
  name: string;
  cwd: string;
  collapsed?: boolean;
}

export const APP_SLASH_COMMANDS: AcpCommand[] = [
  {
    name: "usage",
    description: "Display current session context token usage, model, mode, and tier as a dashboard.",
    category: "app",
  },
  {
    name: "mcp",
    description: "Open the MCP Server Manager to view, toggle, add, or remove MCP servers.",
    category: "app",
  },
  {
    name: "sessions",
    description: "Browse and resume historical Antigravity CLI/ACP sessions.",
    category: "app",
  },
  {
    name: "workspace",
    description: "Add or switch a workspace folder in the sidebar.",
    category: "app",
  },
  {
    name: "clear",
    description: "Start a fresh conversation thread.",
    category: "app",
  },
];

export const DEFAULT_CLI_COMMANDS: AcpCommand[] = [
  { name: "goal", description: "Run until the specified goal is completely finished.", category: "cli" },
  { name: "compact", description: "Compact the conversation now to free context window.", category: "cli" },
  { name: "schedule", description: "Run an instruction on a recurring schedule or timer.", category: "cli" },
  { name: "browser", description: "Invoke a browser agent for web tasks.", category: "cli" },
  { name: "plan", description: "Plan carefully before executing a task.", category: "cli" },
  { name: "grill-me", description: "Interview me to align on a plan.", category: "cli" },
  { name: "teamwork", description: "Invoke a team of agents for large projects.", category: "cli" },
  { name: "learn", description: "Reflect on successes or corrections to capture skills/rules.", category: "cli" },
  { name: "boost", description: "Invoke the Boost multi-agent orchestrator for complex tasks.", category: "cli" },
];

export interface AcpClientState {
  hydrated: boolean;
  cwd: string;
  additionalDirectories: string[];
  folders: WorkspaceFolder[];
  activeFolderId: string | null;
  threadFolderMap: Record<string, string>;
  hiddenThreadIds: string[];
  hasInitializedDefaultFolder: boolean;
  sessionMcpServers: AcpSessionMcpServer[];
  preferredMode: string;
  preferredModel: string;
  preferredThoughtLevel: string;
  snapshots: Record<string, AcpSessionSnapshot>;
  acpSessionIds: Record<string, string>;
  attachments: ImageAttachment[];
  activeModal: ActiveModalKind;
  lastError: string | null;
}

const PREFS_KEY = "agy-openui:workspace-prefs";
const ACP_MAP_KEY = "agy-openui:thread-session-map";

function normalizeFolderCwd(cwd: string): string {
  const trimmed = cwd.trim();
  if (!trimmed) return "";
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

function defaultFolderName(cwd: string): string {
  const normalized = normalizeFolderCwd(cwd);
  if (!normalized || normalized === "/") return normalized || "workspace";
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

function sanitizeFolders(raw: unknown): WorkspaceFolder[] {
  if (!Array.isArray(raw)) return [];
  const seenCwd = new Set<string>();
  const folders: WorkspaceFolder[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Partial<WorkspaceFolder>;
    const cwd = typeof rec.cwd === "string" ? normalizeFolderCwd(rec.cwd) : "";
    const id = typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : "";
    if (!cwd || !id || seenCwd.has(cwd)) continue;
    seenCwd.add(cwd);
    folders.push({
      id,
      name: typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : defaultFolderName(cwd),
      cwd,
      collapsed: Boolean(rec.collapsed),
    });
  }
  return folders;
}

function sanitizeStringRecord(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k === "string" && typeof v === "string" && k && v) {
      out[k] = v;
    }
  }
  return out;
}

function loadInitialPrefs(): Partial<AcpClientState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const mapRaw = localStorage.getItem(ACP_MAP_KEY);
    const acpSessionIds = mapRaw ? (JSON.parse(mapRaw) as Record<string, string>) : {};

    let folders = sanitizeFolders(parsed.folders);
    const rawCwd = typeof parsed.cwd === "string" ? normalizeFolderCwd(parsed.cwd) : "";
    let hasInitializedDefaultFolder = Boolean(parsed.hasInitializedDefaultFolder);
    let activeFolderId =
      typeof parsed.activeFolderId === "string" && parsed.activeFolderId
        ? parsed.activeFolderId
        : null;

    // Migrate pre-folder single-cwd preference seamlessly once
    if (!Array.isArray(parsed.folders) && rawCwd) {
      const migratedId = "default";
      folders = [
        {
          id: migratedId,
          name: defaultFolderName(rawCwd),
          cwd: rawCwd,
          collapsed: false,
        },
      ];
      activeFolderId = migratedId;
      hasInitializedDefaultFolder = true;
    }

    if (activeFolderId && !folders.some((f) => f.id === activeFolderId)) {
      activeFolderId = folders[0]?.id ?? null;
    } else if (!activeFolderId && folders.length > 0) {
      activeFolderId = folders[0]!.id;
    }

    const activeFolder = folders.find((f) => f.id === activeFolderId);
    const cwd = activeFolder?.cwd ?? (folders.length === 0 ? rawCwd : "");
    const hiddenThreadIds = Array.isArray(parsed.hiddenThreadIds)
      ? parsed.hiddenThreadIds.filter((x): x is string => typeof x === "string" && x.length > 0)
      : [];

    return {
      cwd,
      additionalDirectories: [],
      folders,
      activeFolderId,
      threadFolderMap: sanitizeStringRecord(parsed.threadFolderMap),
      hiddenThreadIds: Array.from(new Set(hiddenThreadIds)),
      hasInitializedDefaultFolder,
      sessionMcpServers: Array.isArray(parsed.sessionMcpServers)
        ? (parsed.sessionMcpServers as AcpSessionMcpServer[])
        : [],
      preferredMode: typeof parsed.preferredMode === "string" ? parsed.preferredMode : "auto",
      preferredModel: typeof parsed.preferredModel === "string" ? parsed.preferredModel : "",
      preferredThoughtLevel:
        typeof parsed.preferredThoughtLevel === "string" ? parsed.preferredThoughtLevel : "",
      acpSessionIds,
    };
  } catch {
    return {};
  }
}

// Keep initial state identical on SSR and initial client render to avoid hydration mismatches;
// persisted localStorage prefs are loaded post-mount via acpStore.hydrateFromStorage().
const INITIAL_STATE: AcpClientState = {
  hydrated: false,
  cwd: "",
  additionalDirectories: [],
  folders: [],
  activeFolderId: null,
  threadFolderMap: {},
  hiddenThreadIds: [],
  hasInitializedDefaultFolder: false,
  sessionMcpServers: [],
  preferredMode: "auto",
  preferredModel: "",
  preferredThoughtLevel: "",
  snapshots: {},
  acpSessionIds: {},
  attachments: [],
  activeModal: null,
  lastError: null,
};

let state: AcpClientState = INITIAL_STATE;

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function persistPrefs(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        cwd: state.cwd,
        additionalDirectories: state.additionalDirectories,
        folders: state.folders,
        activeFolderId: state.activeFolderId,
        threadFolderMap: state.threadFolderMap,
        hiddenThreadIds: state.hiddenThreadIds,
        hasInitializedDefaultFolder: state.hasInitializedDefaultFolder,
        sessionMcpServers: state.sessionMcpServers,
        preferredMode: state.preferredMode,
        preferredModel: state.preferredModel,
        preferredThoughtLevel: state.preferredThoughtLevel,
      }),
    );
    localStorage.setItem(ACP_MAP_KEY, JSON.stringify(state.acpSessionIds));
  } catch {
    // ignore storage quota errors
  }
}

export const acpStore = {
  getState(): AcpClientState {
    return state;
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  hydrateFromStorage(): void {
    if (state.hydrated || typeof window === "undefined") return;
    const prefs = loadInitialPrefs();
    state = {
      ...state,
      ...prefs,
      hydrated: true,
      acpSessionIds: { ...prefs.acpSessionIds, ...state.acpSessionIds },
    };
    emit();
  },

  setSnapshot(threadId: string, snapshot: AcpSessionSnapshot): void {
    const nextMap = { ...state.acpSessionIds, [threadId]: snapshot.sessionId };
    let folders = state.folders;
    let activeFolderId = state.activeFolderId;
    let hasInitializedDefaultFolder = state.hasInitializedDefaultFolder;
    const normalizedSnapCwd = normalizeFolderCwd(snapshot.cwd);

    if (!hasInitializedDefaultFolder && folders.length === 0 && normalizedSnapCwd) {
      const folder: WorkspaceFolder = {
        id: "default",
        name: defaultFolderName(normalizedSnapCwd),
        cwd: normalizedSnapCwd,
        collapsed: false,
      };
      folders = [folder];
      activeFolderId = folder.id;
      hasInitializedDefaultFolder = true;
    }

    state = {
      ...state,
      cwd: state.cwd || normalizedSnapCwd,
      folders,
      activeFolderId,
      hasInitializedDefaultFolder,
      snapshots: { ...state.snapshots, [threadId]: snapshot },
      acpSessionIds: nextMap,
    };
    persistPrefs();
    emit();
  },

  applyCustomEvent(threadId: string, payload: AcpCustomEventPayload): void {
    if (payload.type === "session_snapshot") {
      this.setSnapshot(threadId, payload.snapshot);
      return;
    }

    const prev = state.snapshots[threadId];
    if (!prev) return;

    let next: AcpSessionSnapshot = prev;
    switch (payload.type) {
      case "commands":
        next = { ...prev, commands: payload.commands };
        break;
      case "config_options":
        next = { ...prev, configOptions: payload.configOptions };
        break;
      case "mode":
        next = {
          ...prev,
          modes: prev.modes ? { ...prev.modes, currentModeId: payload.currentModeId } : prev.modes,
        };
        break;
      case "usage":
        next = { ...prev, usage: payload.usage };
        break;
      case "session_info":
        next = { ...prev, title: payload.title ?? prev.title };
        break;
      case "plan":
        next = { ...prev, plan: payload.entries };
        break;
      case "permission_request": {
        const exists = prev.pendingPermissions.some(
          (p) => p.requestId === payload.permission.requestId,
        );
        if (!exists) {
          next = {
            ...prev,
            pendingPermissions: [...prev.pendingPermissions, payload.permission],
          };
        }
        break;
      }
      case "permission_resolved":
        next = {
          ...prev,
          pendingPermissions: prev.pendingPermissions.filter(
            (p) => p.requestId !== payload.requestId,
          ),
        };
        break;
    }

    state = {
      ...state,
      snapshots: { ...state.snapshots, [threadId]: next },
    };
    emit();
  },

  removePendingPermission(threadId: string, requestId: string): void {
    const prev = state.snapshots[threadId];
    if (!prev) return;
    state = {
      ...state,
      snapshots: {
        ...state.snapshots,
        [threadId]: {
          ...prev,
          pendingPermissions: prev.pendingPermissions.filter((p) => p.requestId !== requestId),
        },
      },
    };
    emit();
  },

  setPreferences(patch: {
    cwd?: string;
    additionalDirectories?: string[];
    sessionMcpServers?: AcpSessionMcpServer[];
    preferredMode?: string;
    preferredModel?: string;
    preferredThoughtLevel?: string;
  }): void {
    state = { ...state, ...patch };
    persistPrefs();
    emit();
  },

  addFolder(input: { cwd: string; name?: string }): WorkspaceFolder {
    const normalizedCwd = normalizeFolderCwd(input.cwd);
    const existing = state.folders.find((f) => f.cwd === normalizedCwd);
    if (existing) {
      const nextName = input.name?.trim();
      const updated = nextName ? { ...existing, name: nextName, collapsed: false } : { ...existing, collapsed: false };
      state = {
        ...state,
        cwd: updated.cwd,
        additionalDirectories: [],
        activeFolderId: updated.id,
        hasInitializedDefaultFolder: true,
        folders: state.folders.map((f) => (f.id === updated.id ? updated : f)),
      };
      persistPrefs();
      emit();
      return updated;
    }

    const id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `folder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const folder: WorkspaceFolder = {
      id,
      name: input.name?.trim() || defaultFolderName(normalizedCwd),
      cwd: normalizedCwd,
      collapsed: false,
    };

    state = {
      ...state,
      cwd: folder.cwd,
      additionalDirectories: [],
      folders: [...state.folders, folder],
      activeFolderId: folder.id,
      hasInitializedDefaultFolder: true,
    };
    persistPrefs();
    emit();
    return folder;
  },

  selectFolder(folderId: string, options?: { expand?: boolean }): void {
    const folder = state.folders.find((f) => f.id === folderId);
    if (!folder) return;
    const folders =
      options?.expand && folder.collapsed
        ? state.folders.map((f) => (f.id === folderId ? { ...f, collapsed: false } : f))
        : state.folders;

    state = {
      ...state,
      cwd: folder.cwd,
      additionalDirectories: [],
      activeFolderId: folder.id,
      folders,
    };
    persistPrefs();
    emit();
  },

  toggleFolderCollapsed(folderId: string): void {
    state = {
      ...state,
      folders: state.folders.map((f) =>
        f.id === folderId ? { ...f, collapsed: !f.collapsed } : f,
      ),
    };
    persistPrefs();
    emit();
  },

  /** Non-destructive sidebar removal: hides folder's threads while preserving history and files on disk. */
  removeFolder(folderId: string, memberThreadIds: string[] = []): void {
    const nextFolders = state.folders.filter((f) => f.id !== folderId);
    const hiddenSet = new Set(state.hiddenThreadIds);
    const nextMap: Record<string, string> = {};

    for (const [tid, fid] of Object.entries(state.threadFolderMap)) {
      if (fid === folderId) {
        hiddenSet.add(tid);
      } else {
        nextMap[tid] = fid;
      }
    }
    for (const tid of memberThreadIds) {
      if (tid) hiddenSet.add(tid);
      delete nextMap[tid];
    }

    const nextActive =
      state.activeFolderId === folderId
        ? nextFolders[0] ?? null
        : nextFolders.find((f) => f.id === state.activeFolderId) ?? nextFolders[0] ?? null;

    state = {
      ...state,
      folders: nextFolders,
      activeFolderId: nextActive?.id ?? null,
      cwd: nextActive?.cwd ?? "",
      additionalDirectories: [],
      threadFolderMap: nextMap,
      hiddenThreadIds: Array.from(hiddenSet),
      hasInitializedDefaultFolder: true,
    };
    persistPrefs();
    emit();
  },

  assignThreadToFolder(threadId: string, folderId?: string | null): void {
    const targetFolderId =
      (folderId && state.folders.some((f) => f.id === folderId) ? folderId : null) ??
      (state.activeFolderId && state.folders.some((f) => f.id === state.activeFolderId)
        ? state.activeFolderId
        : null) ??
      state.folders[0]?.id ??
      null;

    if (!threadId || !targetFolderId) return;

    state = {
      ...state,
      threadFolderMap: { ...state.threadFolderMap, [threadId]: targetFolderId },
      hiddenThreadIds: state.hiddenThreadIds.filter((id) => id !== threadId),
      folders: state.folders.map((f) =>
        f.id === targetFolderId && f.collapsed ? { ...f, collapsed: false } : f,
      ),
    };
    persistPrefs();
    emit();
  },

  /** Removes a thread from the sidebar only; preserves saved messages and ACP session history. */
  hideThreadFromSidebar(threadId: string): void {
    if (!threadId || state.hiddenThreadIds.includes(threadId)) return;
    state = {
      ...state,
      hiddenThreadIds: [...state.hiddenThreadIds, threadId],
    };
    persistPrefs();
    emit();
  },

  restoreHiddenThread(threadId: string, folderId?: string | null): void {
    if (!threadId) return;
    const mapped = state.threadFolderMap[threadId];
    const validMapped = mapped && state.folders.some((f) => f.id === mapped) ? mapped : null;
    const targetFolderId =
      (folderId && state.folders.some((f) => f.id === folderId) ? folderId : null) ??
      validMapped ??
      (state.activeFolderId && state.folders.some((f) => f.id === state.activeFolderId)
        ? state.activeFolderId
        : null) ??
      state.folders[0]?.id ??
      null;

    const nextMap = { ...state.threadFolderMap };
    if (targetFolderId) {
      nextMap[threadId] = targetFolderId;
    }

    state = {
      ...state,
      threadFolderMap: nextMap,
      hiddenThreadIds: state.hiddenThreadIds.filter((id) => id !== threadId),
      folders: state.folders.map((f) =>
        f.id === targetFolderId && f.collapsed ? { ...f, collapsed: false } : f,
      ),
    };
    persistPrefs();
    emit();
  },

  addAttachment(att: ImageAttachment): void {
    state = { ...state, attachments: [...state.attachments, att] };
    emit();
  },

  removeAttachment(id: string): void {
    state = { ...state, attachments: state.attachments.filter((a) => a.id !== id) };
    emit();
  },

  consumeAttachments(): ImageAttachment[] {
    const current = state.attachments;
    if (current.length > 0) {
      state = { ...state, attachments: [] };
      emit();
    }
    return current;
  },

  setActiveModal(modal: ActiveModalKind): void {
    state = { ...state, activeModal: modal };
    emit();
  },

  setError(error: string | null): void {
    state = { ...state, lastError: error };
    emit();
  },
};

export function useAcpStore<T>(selector: (s: AcpClientState) => T): T {
  return useSyncExternalStore(
    acpStore.subscribe,
    () => selector(acpStore.getState()),
    () => selector(INITIAL_STATE),
  );
}

export function getBootstrapThreadKey(folderId: string | null | undefined): string {
  return folderId ? `bootstrap:${folderId}` : "bootstrap";
}

export function selectEffectiveSnapshot(
  state: AcpClientState,
  selectedThreadId: string | null | undefined,
): AcpSessionSnapshot | undefined {
  if (selectedThreadId && state.snapshots[selectedThreadId]) {
    return state.snapshots[selectedThreadId];
  }
  const folderBootstrap = getBootstrapThreadKey(state.activeFolderId);
  return state.snapshots[folderBootstrap] ?? state.snapshots.bootstrap;
}

export function partitionThreadsByFolder<T extends { id: string }>(params: {
  threads: T[];
  folders: WorkspaceFolder[];
  threadFolderMap: Record<string, string>;
  hiddenThreadIds: string[];
  activeFolderId: string | null;
}): {
  byFolder: Record<string, T[]>;
  hiddenThreads: T[];
} {
  const hiddenSet = new Set(params.hiddenThreadIds);
  const folderSet = new Set(params.folders.map((f) => f.id));
  const fallbackFolderId =
    (params.activeFolderId && folderSet.has(params.activeFolderId)
      ? params.activeFolderId
      : params.folders[0]?.id) ?? null;

  const byFolder: Record<string, T[]> = {};
  for (const folder of params.folders) {
    byFolder[folder.id] = [];
  }
  const hiddenThreads: T[] = [];

  for (const thread of params.threads) {
    if (hiddenSet.has(thread.id)) {
      hiddenThreads.push(thread);
      continue;
    }
    const mapped = params.threadFolderMap[thread.id];
    const targetFolderId = mapped && folderSet.has(mapped) ? mapped : fallbackFolderId;
    if (targetFolderId && byFolder[targetFolderId]) {
      byFolder[targetFolderId].push(thread);
    }
  }

  return { byFolder, hiddenThreads };
}

export function getMergedSlashCommands(snapshot?: AcpSessionSnapshot): AcpCommand[] {
  const byName = new Map<string, AcpCommand>();
  for (const cmd of DEFAULT_CLI_COMMANDS) {
    byName.set(cmd.name, cmd);
  }
  for (const cmd of snapshot?.commands ?? []) {
    byName.set(cmd.name, cmd);
  }
  for (const cmd of APP_SLASH_COMMANDS) {
    byName.set(cmd.name, cmd);
  }
  return Array.from(byName.values());
}

export function getActivePendingPermissions(
  snapshot?: AcpSessionSnapshot,
): PendingPermissionRequest[] {
  return snapshot?.pendingPermissions ?? [];
}
