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

export type ActiveModalKind = null | "mcp" | "workspace" | "sessions";

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
    description: "Configure working directory (cwd) and additional workspace roots (--add-dir).",
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
  cwd: string;
  additionalDirectories: string[];
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

function loadInitialPrefs(): Partial<AcpClientState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<AcpClientState>) : {};
    const mapRaw = localStorage.getItem(ACP_MAP_KEY);
    const acpSessionIds = mapRaw ? (JSON.parse(mapRaw) as Record<string, string>) : {};
    return {
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
      additionalDirectories: Array.isArray(parsed.additionalDirectories)
        ? parsed.additionalDirectories
        : [],
      sessionMcpServers: Array.isArray(parsed.sessionMcpServers) ? parsed.sessionMcpServers : [],
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

let state: AcpClientState = {
  cwd: "",
  additionalDirectories: [],
  sessionMcpServers: [],
  preferredMode: "auto",
  preferredModel: "",
  preferredThoughtLevel: "",
  snapshots: {},
  acpSessionIds: {},
  attachments: [],
  activeModal: null,
  lastError: null,
  ...loadInitialPrefs(),
};

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

  setSnapshot(threadId: string, snapshot: AcpSessionSnapshot): void {
    const nextMap = { ...state.acpSessionIds, [threadId]: snapshot.sessionId };
    state = {
      ...state,
      cwd: state.cwd || snapshot.cwd,
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
    () => selector(acpStore.getState()),
  );
}

export function selectEffectiveSnapshot(
  state: AcpClientState,
  selectedThreadId: string | null | undefined,
): AcpSessionSnapshot | undefined {
  if (selectedThreadId && state.snapshots[selectedThreadId]) {
    return state.snapshots[selectedThreadId];
  }
  return state.snapshots.bootstrap;
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
