import {
  classifyAttachmentKind,
  extractInlineAttachmentsFromText,
  inferMimeType,
} from "@/lib/acp/attachments";
import type {
  AcpAppDataDir,
  AcpCommand,
  AcpConfigOption,
  AcpCustomEventPayload,
  AcpModeInfo,
  AcpModelInfo,
  AcpPermissionOption,
  AcpPlanEntry,
  AcpSessionMcpServer,
  AcpSessionSnapshot,
  AcpTierInfo,
  AcpUsageInfo,
  HistoricalAcpSession,
  PendingPermissionRequest,
  ReplayedTranscriptMessage,
  UserMessageAttachmentMeta,
} from "@/lib/acp/types";
import { isSyntheticTitleSession } from "@/lib/acp/thread-title";
import { resolveAdditionalDirs, resolveWorkspaceDir } from "@/lib/acp/workspace";
import { getOpenUISystemPrompt } from "@/lib/openui/prompt";
import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

const BUILTIN_CLI_COMMANDS = new Set([
  "goal",
  "compact",
  "schedule",
  "browser",
  "plan",
  "grill-me",
  "teamwork",
  "learn",
  "boost",
]);

const IDLE_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 25;

type UpdateListener = (update: acp.SessionUpdate) => void;
type CustomListener = (payload: AcpCustomEventPayload) => void;

interface PendingPermissionEntry {
  request: PendingPermissionRequest;
  resolve: (resp: acp.RequestPermissionResponse) => void;
}

export interface AcpSessionEntry {
  threadId: string;
  sessionId: string;
  appDataDir: AcpAppDataDir;
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientConnection;
  cwd: string;
  additionalDirectories: string[];
  mcpServers: AcpSessionMcpServer[];
  title?: string;
  commands: AcpCommand[];
  configOptions: AcpConfigOption[];
  models?: {
    currentModelId: string;
    availableModels: AcpModelInfo[];
  };
  modes?: {
    currentModeId: string;
    availableModes: AcpModeInfo[];
  };
  usage?: AcpUsageInfo;
  tier?: AcpTierInfo;
  plan: AcpPlanEntry[];
  pendingPermissions: Map<string, PendingPermissionEntry>;
  isStreaming: boolean;
  lastUsed: number;
  activeUpdateListener?: UpdateListener;
  activeCustomListener?: CustomListener;
  replayCollector?: acp.SessionUpdate[];
}

export interface GetOrCreateSessionOptions {
  threadId: string;
  acpSessionId?: string;
  appDataDir?: AcpAppDataDir;
  cwd?: string;
  additionalDirectories?: string[];
  mcpServers?: AcpSessionMcpServer[];
  mode?: string;
  model?: string;
  thoughtLevel?: string;
}

const globalStore = globalThis as unknown as {
  __agyOpenuiSessions?: Map<string, AcpSessionEntry>;
  __agyOpenuiCreating?: Map<string, Promise<AcpSessionEntry>>;
  __agyOpenuiPermissions?: Map<string, { threadId: string; entry: AcpSessionEntry }>;
  __agyOpenuiCleanupRegistered?: boolean;
};

const SESSIONS = (globalStore.__agyOpenuiSessions ??= new Map<string, AcpSessionEntry>());
const CREATING = (globalStore.__agyOpenuiCreating ??= new Map<string, Promise<AcpSessionEntry>>());
const PERMISSION_INDEX = (globalStore.__agyOpenuiPermissions ??= new Map<
  string,
  { threadId: string; entry: AcpSessionEntry }
>());

if (!globalStore.__agyOpenuiCleanupRegistered) {
  globalStore.__agyOpenuiCleanupRegistered = true;
  const disposeAll = () => {
    for (const entry of SESSIONS.values()) {
      disposeEntry(entry);
    }
    SESSIONS.clear();
  };
  process.once("SIGTERM", disposeAll);
  process.once("SIGINT", disposeAll);
}

function disposeEntry(entry: AcpSessionEntry): void {
  for (const [reqId, pending] of entry.pendingPermissions) {
    pending.resolve({ outcome: { outcome: "cancelled" } });
    PERMISSION_INDEX.delete(reqId);
  }
  entry.pendingPermissions.clear();
  try {
    entry.connection.close();
  } catch {
    // ignore close errors during teardown
  }
  try {
    if (!entry.child.killed) {
      entry.child.kill("SIGTERM");
    }
  } catch {
    // ignore kill errors
  }
}

function evictIdle(now: number): void {
  for (const [threadId, entry] of SESSIONS) {
    if (
      now - entry.lastUsed > IDLE_TTL_MS &&
      !entry.isStreaming &&
      entry.pendingPermissions.size === 0
    ) {
      disposeEntry(entry);
      SESSIONS.delete(threadId);
    }
  }
}

function evictOldestIfFull(): void {
  if (SESSIONS.size < MAX_SESSIONS) return;
  let oldestId: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [id, entry] of SESSIONS) {
    if (entry.isStreaming || entry.pendingPermissions.size > 0) continue;
    if (entry.lastUsed < oldestAt) {
      oldestAt = entry.lastUsed;
      oldestId = id;
    }
  }
  if (oldestId) {
    const entry = SESSIONS.get(oldestId);
    if (entry) disposeEntry(entry);
    SESSIONS.delete(oldestId);
  }
}

function mapMcpServersToAcp(servers: AcpSessionMcpServer[]): acp.McpServer[] {
  return servers
    .filter((s) => s.name.trim().length > 0)
    .map((s) => {
      if (s.type === "http") {
        return {
          type: "http" as const,
          name: s.name.trim(),
          url: s.url?.trim() ?? "",
          headers: s.headers ?? [],
        };
      }
      if (s.type === "sse") {
        return {
          type: "sse" as const,
          name: s.name.trim(),
          url: s.url?.trim() ?? "",
          headers: s.headers ?? [],
        };
      }
      return {
        name: s.name.trim(),
        command: s.command?.trim() ?? "",
        args: s.args ?? [],
        env: s.env ?? [],
      };
    });
}

function normalizeConfigOptions(
  raw: acp.SessionConfigOption[] | null | undefined,
): AcpConfigOption[] {
  if (!raw) return [];
  return raw.map((opt) => {
    if (opt.type === "boolean") {
      return {
        id: opt.id,
        name: opt.name,
        category: opt.category ?? undefined,
        type: "boolean",
        currentValue: String(opt.currentValue),
      };
    }
    const flatOptions: Array<{ value: string; name: string; description?: string }> = [];
    for (const item of opt.options) {
      if ("options" in item && Array.isArray(item.options)) {
        for (const sub of item.options) {
          flatOptions.push({
            value: sub.value,
            name: sub.name,
            description: sub.description ?? undefined,
          });
        }
      } else if ("value" in item) {
        flatOptions.push({
          value: item.value,
          name: item.name,
          description: item.description ?? undefined,
        });
      }
    }
    return {
      id: opt.id,
      name: opt.name,
      category: opt.category ?? undefined,
      type: "select",
      currentValue: opt.currentValue,
      options: flatOptions,
    };
  });
}

function classifyCommands(commands: acp.AvailableCommand[]): AcpCommand[] {
  return commands.map((c) => ({
    name: c.name,
    description: c.description,
    inputHint: c.input?.hint ?? undefined,
    category: BUILTIN_CLI_COMMANDS.has(c.name) ? "cli" : "skill",
  }));
}

function extractTier(meta: Record<string, unknown> | null | undefined): AcpTierInfo | undefined {
  const agy = meta?.antigravity as Record<string, unknown> | undefined;
  const tier = agy?.tier as Record<string, unknown> | undefined;
  if (!tier || typeof tier.name !== "string" || typeof tier.id !== "string") return undefined;
  return {
    id: tier.id,
    name: tier.name,
    upgradeUri: typeof tier.upgradeUri === "string" ? tier.upgradeUri : undefined,
  };
}

interface SessionResponseWithModels {
  configOptions?: acp.SessionConfigOption[] | null;
  modes?: acp.SessionModeState | null;
  models?: {
    currentModelId: string;
    availableModels: Array<{ modelId: string; name: string; description?: string | null }>;
  } | null;
  _meta?: Record<string, unknown> | null;
}

function applySessionResponseMetadata(
  entry: AcpSessionEntry,
  resp: SessionResponseWithModels,
): void {
  entry.configOptions = normalizeConfigOptions(resp.configOptions);
  if (resp.models) {
    entry.models = {
      currentModelId: resp.models.currentModelId,
      availableModels: resp.models.availableModels.map((m) => ({
        modelId: m.modelId,
        name: m.name,
        description: m.description ?? undefined,
      })),
    };
  }
  if (resp.modes) {
    entry.modes = {
      currentModeId: resp.modes.currentModeId,
      availableModes: resp.modes.availableModes.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description ?? undefined,
      })),
    };
  }
  entry.tier = extractTier(resp._meta);
}

/** Resolves whether a historical ACP session lives in CLI (`antigravity-cli`) or App/IDE (`antigravity`) storage. */
export function detectSessionAppDataDir(
  sessionId?: string | null,
  preferred?: AcpAppDataDir,
  homeDir = homedir(),
): AcpAppDataDir {
  if (sessionId) {
    const cliDb = join(homeDir, ".gemini", "antigravity-cli", "conversations", `${sessionId}.db`);
    if (existsSync(cliDb)) return "antigravity-cli";

    const appDb = join(homeDir, ".gemini", "antigravity", "conversations", `${sessionId}.db`);
    if (existsSync(appDb)) return "antigravity";
  }
  return preferred ?? "antigravity-cli";
}

export function buildSessionSnapshot(entry: AcpSessionEntry): AcpSessionSnapshot {
  return {
    threadId: entry.threadId,
    sessionId: entry.sessionId,
    appDataDir: entry.appDataDir,
    cwd: entry.cwd,
    additionalDirectories: entry.additionalDirectories,
    title: entry.title,
    commands: entry.commands,
    configOptions: entry.configOptions,
    models: entry.models,
    modes: entry.modes,
    usage: entry.usage,
    tier: entry.tier,
    plan: entry.plan,
    pendingPermissions: Array.from(entry.pendingPermissions.values()).map((p) => p.request),
    isStreaming: entry.isStreaming,
  };
}

function spawnAcpConnection(params: {
  cwd: string;
  additionalDirectories: string[];
  appDataDir?: AcpAppDataDir;
  onSessionUpdate: (update: acp.SessionUpdate) => void;
  onPermissionRequest: (req: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;
}): {
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientConnection;
} {
  const args = ["acp", "--disable-telemetry"];
  if (params.appDataDir && params.appDataDir !== "antigravity-cli") {
    args.push("--app-data-dir", params.appDataDir);
  }
  for (const dir of params.additionalDirectories) {
    args.push("--add-dir", dir);
  }

  const child = spawn("agy", args, {
    cwd: params.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );

  const app = acp
    .client({ name: "antigravity-gen-ui" })
    .onRequest(acp.CLIENT_METHODS.session_request_permission, async ({ params: req }) =>
      params.onPermissionRequest(req),
    )
    .onRequest(acp.CLIENT_METHODS.elicitation_create, async () => ({
      action: "cancel",
    }))
    .onNotification(acp.CLIENT_METHODS.session_update, async ({ params: notif }) => {
      params.onSessionUpdate(notif.update);
    });

  const connection = app.connect(stream);
  return { child, connection };
}

function applySessionUpdateToEntry(entry: AcpSessionEntry, update: acp.SessionUpdate): void {
  switch (update.sessionUpdate) {
    case "available_commands_update":
      entry.commands = classifyCommands(update.availableCommands);
      entry.activeCustomListener?.({ type: "commands", commands: entry.commands });
      break;
    case "config_option_update":
      entry.configOptions = normalizeConfigOptions(update.configOptions);
      entry.activeCustomListener?.({ type: "config_options", configOptions: entry.configOptions });
      break;
    case "current_mode_update":
      if (entry.modes) {
        entry.modes = { ...entry.modes, currentModeId: update.currentModeId };
      }
      entry.activeCustomListener?.({ type: "mode", currentModeId: update.currentModeId });
      break;
    case "usage_update":
      entry.usage = {
        used: update.used,
        size: update.size,
        cost: update.cost ?? null,
      };
      entry.activeCustomListener?.({ type: "usage", usage: entry.usage });
      break;
    case "session_info_update":
      if (typeof update.title === "string") {
        entry.title = update.title;
      }
      entry.activeCustomListener?.({ type: "session_info", title: update.title });
      break;
    case "plan":
      entry.plan = update.entries.map((e) => ({
        content: e.content,
        priority: e.priority,
        status: e.status,
      }));
      entry.activeCustomListener?.({ type: "plan", entries: entry.plan });
      break;
    default:
      break;
  }

  entry.replayCollector?.push(update);
  entry.activeUpdateListener?.(update);
}

function createPermissionHandler(
  getEntry: () => AcpSessionEntry | undefined,
  autoApproveUnbound: boolean,
): (req: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse> {
  return async (req) => {
    const entryRef = getEntry();
    if (!entryRef) {
      if (!autoApproveUnbound) {
        return { outcome: { outcome: "cancelled" } };
      }
      const fallback = req.options.find((o) => o.kind === "allow_once") ?? req.options[0];
      return fallback
        ? { outcome: { outcome: "selected", optionId: fallback.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }

    const requestId = crypto.randomUUID();
    const permission: PendingPermissionRequest = {
      requestId,
      threadId: entryRef.threadId,
      sessionId: entryRef.sessionId,
      toolCall: {
        toolCallId: req.toolCall.toolCallId,
        title: req.toolCall.title,
        name:
          typeof (req.toolCall as { name?: unknown }).name === "string"
            ? (req.toolCall as { name?: string }).name
            : undefined,
        kind: req.toolCall.kind,
        rawInput: req.toolCall.rawInput,
      },
      options: req.options.map((o) => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind,
      })) as AcpPermissionOption[],
      createdAt: Date.now(),
    };

    return new Promise<acp.RequestPermissionResponse>((resolvePromise) => {
      const currentEntry = getEntry();
      if (!currentEntry) {
        resolvePromise({ outcome: { outcome: "cancelled" } });
        return;
      }
      currentEntry.pendingPermissions.set(requestId, {
        request: permission,
        resolve: resolvePromise,
      });
      PERMISSION_INDEX.set(requestId, { threadId: currentEntry.threadId, entry: currentEntry });
      currentEntry.activeCustomListener?.({ type: "permission_request", permission });
    });
  };
}

async function applyConfigSafely(
  entry: AcpSessionEntry,
  configId: string,
  value: string,
): Promise<void> {
  try {
    const res = await entry.connection.agent.request(acp.AGENT_METHODS.session_set_config_option, {
      sessionId: entry.sessionId,
      configId,
      value,
    });
    if (res.configOptions) {
      entry.configOptions = normalizeConfigOptions(res.configOptions);
    }
    if (configId === "mode" && entry.modes) {
      entry.modes = { ...entry.modes, currentModeId: value };
    }
  } catch {
    // Non-fatal: some legacy or restricted sessions may not expose every config option
  }
}

async function createSessionEntry(options: GetOrCreateSessionOptions): Promise<AcpSessionEntry> {
  evictOldestIfFull();

  const cwd = resolveWorkspaceDir(options.cwd);
  const additionalDirectories = resolveAdditionalDirs(options.additionalDirectories);
  const mcpServers = options.mcpServers ?? [];
  const appDataDir = detectSessionAppDataDir(options.acpSessionId, options.appDataDir);

  let entryRef: AcpSessionEntry | undefined;

  const { child, connection } = spawnAcpConnection({
    cwd,
    additionalDirectories,
    appDataDir,
    onSessionUpdate: (update) => {
      if (entryRef) {
        applySessionUpdateToEntry(entryRef, update);
      }
    },
    onPermissionRequest: createPermissionHandler(() => entryRef, true),
  });

  child.once("exit", () => {
    const existing = SESSIONS.get(options.threadId);
    if (existing && existing.child === child) {
      for (const reqId of existing.pendingPermissions.keys()) {
        PERMISSION_INDEX.delete(reqId);
      }
      SESSIONS.delete(options.threadId);
    }
  });

  try {
    await connection.agent.request(acp.AGENT_METHODS.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "antigravity-gen-ui", version: "0.1.0" },
    });

    const systemPromptAppend = getOpenUISystemPrompt();
    const acpMcpServers = mapMcpServersToAcp(mcpServers);
    const replayUpdates: acp.SessionUpdate[] = [];

    const entry: AcpSessionEntry = {
      threadId: options.threadId,
      sessionId: "",
      appDataDir,
      child,
      connection,
      cwd,
      additionalDirectories,
      mcpServers,
      commands: [],
      configOptions: [],
      plan: [],
      pendingPermissions: new Map(),
      isStreaming: false,
      lastUsed: Date.now(),
      replayCollector: replayUpdates,
    };
    entryRef = entry;

    let sessionResp: acp.NewSessionResponse | acp.LoadSessionResponse | acp.ResumeSessionResponse;
    if (options.acpSessionId) {
      try {
        sessionResp = await connection.agent.request(acp.AGENT_METHODS.session_load, {
          sessionId: options.acpSessionId,
          cwd,
          additionalDirectories,
          mcpServers: acpMcpServers,
          _meta: {
            antigravity: {
              systemPrompt: { append: systemPromptAppend },
            },
          },
        });
        entry.sessionId = options.acpSessionId;
      } catch {
        const created = await connection.agent.request(acp.AGENT_METHODS.session_new, {
          cwd,
          additionalDirectories,
          mcpServers: acpMcpServers,
          _meta: {
            antigravity: {
              systemPrompt: { append: systemPromptAppend },
            },
          },
        });
        entry.sessionId = created.sessionId;
        sessionResp = created;
      }
    } else {
      const created = await connection.agent.request(acp.AGENT_METHODS.session_new, {
        cwd,
        additionalDirectories,
        mcpServers: acpMcpServers,
        _meta: {
          antigravity: {
            systemPrompt: { append: systemPromptAppend },
          },
        },
      });
      entry.sessionId = created.sessionId;
      sessionResp = created;
    }
    entry.replayCollector = undefined;
    applySessionResponseMetadata(entry, sessionResp as SessionResponseWithModels);

    // Default to `auto` mode per configuration unless explicitly overridden
    const targetMode = options.mode ?? "auto";
    if (targetMode && entry.modes?.currentModeId !== targetMode) {
      await applyConfigSafely(entry, "mode", targetMode);
    }
    if (options.model) {
      await applyConfigSafely(entry, "model", options.model);
    }
    if (options.thoughtLevel) {
      await applyConfigSafely(entry, "thought_level", options.thoughtLevel);
    }

    // Give initial session/update notifications (e.g. available_commands_update) a tick to settle
    if (entry.commands.length === 0) {
      await new Promise((r) => setTimeout(r, 150));
    }

    SESSIONS.set(options.threadId, entry);
    return entry;
  } catch (err) {
    disposeEntry({
      threadId: options.threadId,
      sessionId: "",
      appDataDir,
      child,
      connection,
      cwd,
      additionalDirectories,
      mcpServers,
      commands: [],
      configOptions: [],
      plan: [],
      pendingPermissions: new Map(),
      isStreaming: false,
      lastUsed: Date.now(),
    });
    throw err;
  }
}

export async function getOrCreateAcpSession(
  options: GetOrCreateSessionOptions,
): Promise<AcpSessionEntry> {
  const now = Date.now();
  evictIdle(now);

  const existing = SESSIONS.get(options.threadId);
  if (existing && !existing.child.killed) {
    existing.lastUsed = now;
    return existing;
  }

  let pending = CREATING.get(options.threadId);
  if (!pending) {
    pending = createSessionEntry(options).finally(() => {
      CREATING.delete(options.threadId);
    });
    CREATING.set(options.threadId, pending);
  }
  return pending;
}

export function getExistingAcpSession(threadId: string): AcpSessionEntry | undefined {
  return SESSIONS.get(threadId);
}

export async function resetAcpSession(options: GetOrCreateSessionOptions): Promise<AcpSessionEntry> {
  const existing = SESSIONS.get(options.threadId);
  if (existing) {
    disposeEntry(existing);
    SESSIONS.delete(options.threadId);
  }
  return getOrCreateAcpSession(options);
}

export async function setAcpConfigOption(
  threadId: string,
  configId: string,
  value: string,
): Promise<AcpSessionSnapshot> {
  const entry = await getOrCreateAcpSession({ threadId });
  const res = await entry.connection.agent.request(
    acp.AGENT_METHODS.session_set_config_option,
    {
      sessionId: entry.sessionId,
      configId,
      value,
    },
  );
  if (res.configOptions) {
    entry.configOptions = normalizeConfigOptions(res.configOptions);
  }
  if (configId === "mode" && entry.modes) {
    entry.modes = { ...entry.modes, currentModeId: value };
  }
  entry.lastUsed = Date.now();
  return buildSessionSnapshot(entry);
}

export async function cancelAcpTurn(threadId: string): Promise<void> {
  const entry = SESSIONS.get(threadId);
  if (!entry) return;
  for (const [reqId, pending] of entry.pendingPermissions) {
    pending.resolve({ outcome: { outcome: "cancelled" } });
    entry.pendingPermissions.delete(reqId);
    PERMISSION_INDEX.delete(reqId);
    entry.activeCustomListener?.({ type: "permission_resolved", requestId: reqId });
  }
  await entry.connection.agent.notify(acp.AGENT_METHODS.session_cancel, {
    sessionId: entry.sessionId,
  });
}

export function resolveAcpPermission(
  requestId: string,
  optionId: string | null,
): boolean {
  const located = PERMISSION_INDEX.get(requestId);
  if (!located) return false;
  const { entry } = located;
  const pending = entry.pendingPermissions.get(requestId);
  if (!pending) {
    PERMISSION_INDEX.delete(requestId);
    return false;
  }

  entry.pendingPermissions.delete(requestId);
  PERMISSION_INDEX.delete(requestId);

  if (optionId) {
    pending.resolve({ outcome: { outcome: "selected", optionId } });
  } else {
    pending.resolve({ outcome: { outcome: "cancelled" } });
  }
  entry.activeCustomListener?.({ type: "permission_resolved", requestId });
  return true;
}

async function listSessionsFromStore(
  resolvedCwd: string,
  appDataDir: AcpAppDataDir,
): Promise<HistoricalAcpSession[]> {
  const { child, connection } = spawnAcpConnection({
    cwd: resolvedCwd,
    additionalDirectories: [],
    appDataDir,
    onSessionUpdate: () => {},
    onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }),
  });

  try {
    await connection.agent.request(acp.AGENT_METHODS.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "antigravity-gen-ui-list", version: "0.1.0" },
    });

    const resp = await connection.agent.request(acp.AGENT_METHODS.session_list, {
      cwd: resolvedCwd,
    });
    return resp.sessions.map((s) => ({
      sessionId: s.sessionId,
      appDataDir: detectSessionAppDataDir(s.sessionId, appDataDir),
      cwd: s.cwd,
      additionalDirectories: s.additionalDirectories ?? undefined,
      title: s.title ?? undefined,
      updatedAt: s.updatedAt ?? undefined,
    }));
  } finally {
    try {
      connection.close();
    } catch {
      // ignore
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

/** Lists recent Antigravity sessions across CLI (`antigravity-cli`) and App (`antigravity`) stores. */
export async function listHistoricalAcpSessions(cwd?: string): Promise<HistoricalAcpSession[]> {
  const resolvedCwd = resolveWorkspaceDir(cwd);
  const [cliResult, appResult] = await Promise.allSettled([
    listSessionsFromStore(resolvedCwd, "antigravity-cli"),
    listSessionsFromStore(resolvedCwd, "antigravity"),
  ]);

  const byId = new Map<string, HistoricalAcpSession>();
  const addItems = (items: HistoricalAcpSession[]) => {
    for (const s of items) {
      if (isSyntheticTitleSession(s.title)) continue;
      const existing = byId.get(s.sessionId);
      if (!existing) {
        byId.set(s.sessionId, s);
      } else {
        byId.set(s.sessionId, {
          ...existing,
          ...s,
          appDataDir: detectSessionAppDataDir(s.sessionId, s.appDataDir ?? existing.appDataDir),
          title: s.title || existing.title,
        });
      }
    }
  };

  if (appResult.status === "fulfilled") addItems(appResult.value);
  if (cliResult.status === "fulfilled") addItems(cliResult.value);

  if (byId.size === 0 && cliResult.status === "rejected" && appResult.status === "rejected") {
    throw cliResult.reason;
  }

  return Array.from(byId.values()).sort((a, b) => {
    const tA = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const tB = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return (Number.isFinite(tB) ? tB : 0) - (Number.isFinite(tA) ? tA : 0);
  });
}

function hasConversationUpdates(updates: acp.SessionUpdate[]): boolean {
  return updates.some(
    (u) =>
      u.sessionUpdate === "user_message_chunk" ||
      u.sessionUpdate === "agent_message_chunk" ||
      u.sessionUpdate === "tool_call" ||
      u.sessionUpdate === "tool_call_update",
  );
}

async function attemptLoadHistoricalSession(params: {
  threadId: string;
  acpSessionId: string;
  appDataDir: AcpAppDataDir;
  cwd: string;
  additionalDirectories: string[];
  mcpServers: AcpSessionMcpServer[];
}): Promise<{ entry: AcpSessionEntry; replayed: acp.SessionUpdate[] }> {
  const replayed: acp.SessionUpdate[] = [];
  let entryRef: AcpSessionEntry | undefined;

  const { child, connection } = spawnAcpConnection({
    cwd: params.cwd,
    additionalDirectories: params.additionalDirectories,
    appDataDir: params.appDataDir,
    onSessionUpdate: (update) => {
      replayed.push(update);
      if (entryRef) {
        applySessionUpdateToEntry(entryRef, update);
      }
    },
    onPermissionRequest: createPermissionHandler(() => entryRef, false),
  });

  try {
    await connection.agent.request(acp.AGENT_METHODS.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "antigravity-gen-ui", version: "0.1.0" },
    });

    const entry: AcpSessionEntry = {
      threadId: params.threadId,
      sessionId: params.acpSessionId,
      appDataDir: params.appDataDir,
      child,
      connection,
      cwd: params.cwd,
      additionalDirectories: params.additionalDirectories,
      mcpServers: params.mcpServers,
      commands: [],
      configOptions: [],
      plan: [],
      pendingPermissions: new Map(),
      isStreaming: false,
      lastUsed: Date.now(),
    };
    entryRef = entry;

    let loaded: acp.LoadSessionResponse;
    try {
      loaded = await connection.agent.request(acp.AGENT_METHODS.session_load, {
        sessionId: params.acpSessionId,
        cwd: params.cwd,
        additionalDirectories: params.additionalDirectories,
        mcpServers: mapMcpServersToAcp(params.mcpServers),
        _meta: {
          antigravity: {
            systemPrompt: { append: getOpenUISystemPrompt() },
          },
        },
      });
    } catch (loadErr) {
      if (params.mcpServers.length > 0) {
        // Retry without custom MCP servers if one failed startup during session_load
        loaded = await connection.agent.request(acp.AGENT_METHODS.session_load, {
          sessionId: params.acpSessionId,
          cwd: params.cwd,
          additionalDirectories: params.additionalDirectories,
          mcpServers: [],
          _meta: {
            antigravity: {
              systemPrompt: { append: getOpenUISystemPrompt() },
            },
          },
        });
      } else {
        throw loadErr;
      }
    }

    // Allow trailing session/update replay frames to settle cleanly
    await new Promise((r) => setTimeout(r, 100));

    applySessionResponseMetadata(entry, loaded as SessionResponseWithModels);
    await applyConfigSafely(entry, "mode", "auto");

    return { entry, replayed };
  } catch (err) {
    disposeEntry({
      threadId: params.threadId,
      sessionId: params.acpSessionId,
      appDataDir: params.appDataDir,
      child,
      connection,
      cwd: params.cwd,
      additionalDirectories: params.additionalDirectories,
      mcpServers: params.mcpServers,
      commands: [],
      configOptions: [],
      plan: [],
      pendingPermissions: new Map(),
      isStreaming: false,
      lastUsed: Date.now(),
    });
    throw err;
  }
}

/**
 * Loads an existing ACP session into `threadId` and converts replayed history
 * into OpenUI-compatible AG-UI transcript messages.
 */
export async function loadHistoricalAcpSession(params: {
  threadId: string;
  acpSessionId: string;
  appDataDir?: AcpAppDataDir;
  cwd?: string;
  additionalDirectories?: string[];
  mcpServers?: AcpSessionMcpServer[];
}): Promise<{ snapshot: AcpSessionSnapshot; messages: ReplayedTranscriptMessage[] }> {
  const existing = SESSIONS.get(params.threadId);
  if (existing) {
    disposeEntry(existing);
    SESSIONS.delete(params.threadId);
  }

  const cwd = resolveWorkspaceDir(params.cwd);
  const additionalDirectories = resolveAdditionalDirs(params.additionalDirectories);
  const mcpServers = params.mcpServers ?? [];
  const primaryStore = detectSessionAppDataDir(params.acpSessionId, params.appDataDir);

  let chosen = await attemptLoadHistoricalSession({
    threadId: params.threadId,
    acpSessionId: params.acpSessionId,
    appDataDir: primaryStore,
    cwd,
    additionalDirectories,
    mcpServers,
  });

  // Fallback across the alternate store if primary replayed 0 conversation messages
  if (!hasConversationUpdates(chosen.replayed)) {
    const alternateStore: AcpAppDataDir =
      primaryStore === "antigravity-cli" ? "antigravity" : "antigravity-cli";
    try {
      const alt = await attemptLoadHistoricalSession({
        threadId: params.threadId,
        acpSessionId: params.acpSessionId,
        appDataDir: alternateStore,
        cwd,
        additionalDirectories,
        mcpServers,
      });
      if (hasConversationUpdates(alt.replayed)) {
        disposeEntry(chosen.entry);
        chosen = alt;
      } else {
        disposeEntry(alt.entry);
      }
    } catch {
      // Keep original attempt if alternate store fails
    }
  }

  chosen.entry.child.once("exit", () => {
    const active = SESSIONS.get(params.threadId);
    if (active && active.child === chosen.entry.child) {
      for (const reqId of active.pendingPermissions.keys()) {
        PERMISSION_INDEX.delete(reqId);
      }
      SESSIONS.delete(params.threadId);
    }
  });

  SESSIONS.set(params.threadId, chosen.entry);

  const messages = convertReplayedUpdatesToMessages(chosen.replayed);
  return {
    snapshot: buildSessionSnapshot(chosen.entry),
    messages,
  };
}

function extractContentBlockText(block: acp.ContentBlock | undefined | null): string {
  if (!block) return "";
  switch (block.type) {
    case "text":
      return block.text;
    case "resource_link":
      return `[${block.name || block.uri}](${block.uri})`;
    case "resource":
      if ("text" in block.resource && typeof block.resource.text === "string") {
        return block.resource.text;
      }
      return `[Resource: ${block.resource.uri}]`;
    case "image":
      return "[Image attachment]";
    case "audio":
      return "[Audio attachment]";
    default:
      return "";
  }
}

function extractUserAttachmentFromBlock(
  block: acp.ContentBlock | undefined | null,
): UserMessageAttachmentMeta | null {
  if (!block) return null;
  if (block.type === "image") {
    return {
      id: crypto.randomUUID(),
      name: "Attached image",
      mimeType: block.mimeType,
      kind: "image",
      data: block.data,
    };
  }
  if (block.type === "resource_link") {
    const rawName = block.name || decodeURIComponent(block.uri.split("/").pop() || "file");
    const mimeType = inferMimeType(rawName, block.mimeType ?? undefined);
    return {
      id: crypto.randomUUID(),
      name: rawName,
      mimeType,
      size: typeof block.size === "number" ? block.size : undefined,
      kind: classifyAttachmentKind(rawName, mimeType),
    };
  }
  if (block.type === "resource") {
    const rawUri = block.resource.uri || "";
    const decoded = decodeURIComponent(
      rawUri.replace(/^attachment:\/\/\//, "").split("/").pop() || "file",
    );
    const mimeType = inferMimeType(decoded, block.resource.mimeType ?? undefined);
    const size =
      "text" in block.resource && typeof block.resource.text === "string"
        ? Buffer.byteLength(block.resource.text, "utf8")
        : "blob" in block.resource && typeof block.resource.blob === "string"
          ? Math.floor((block.resource.blob.length * 3) / 4)
          : undefined;
    return {
      id: crypto.randomUUID(),
      name: decoded,
      mimeType,
      size,
      kind: classifyAttachmentKind(decoded, mimeType),
    };
  }
  return null;
}

export function convertReplayedUpdatesToMessages(
  updates: acp.SessionUpdate[],
): ReplayedTranscriptMessage[] {
  const messages: ReplayedTranscriptMessage[] = [];
  let currentUser: ReplayedTranscriptMessage | null = null;
  let currentAssistant: ReplayedTranscriptMessage | null = null;
  let turnHasTrailingAssistantProse = false;
  let lastTurnProse = "";
  let pendingToolEntries = new Map<
    string,
    { tc: NonNullable<ReplayedTranscriptMessage["toolCalls"]>[number]; completed: boolean }
  >();

  const flushUser = () => {
    if (!currentUser) return;
    const { cleanText, attachments: inlineAttachments } = extractInlineAttachmentsFromText(
      currentUser.content,
    );
    if (inlineAttachments.length > 0) {
      const existing = currentUser.attachments ?? [];
      const seenNames = new Set(existing.map((a) => a.name));
      const merged = [
        ...existing,
        ...inlineAttachments.filter((a) => !seenNames.has(a.name)),
      ];
      currentUser = {
        ...currentUser,
        content: cleanText,
        attachments: merged,
      };
    }
    if (currentUser.content || currentUser.attachments?.length) {
      messages.push(currentUser);
    }
    currentUser = null;
  };

  const flushAssistant = () => {
    if (currentAssistant && (currentAssistant.content || currentAssistant.toolCalls?.length)) {
      messages.push(currentAssistant);
    }
    currentAssistant = null;
  };

  const emitToolResult = (
    toolCallId: string,
    status: string | undefined | null,
    outputText: string,
  ) => {
    const capped =
      outputText.length > 24_000
        ? `${outputText.slice(0, 24_000)}\n... [truncated ${outputText.length - 24_000} chars]`
        : outputText;
    messages.push({
      id: crypto.randomUUID(),
      role: "tool",
      toolCallId,
      content: capped,
      ...(status === "failed" ? { error: capped || "Tool failed" } : {}),
    });
  };

  const finalizeAssistantTurn = () => {
    flushAssistant();
    for (const [toolCallId, entry] of pendingToolEntries) {
      if (!entry.completed) {
        entry.completed = true;
        emitToolResult(toolCallId, "completed", "Completed or interrupted before output was recorded.");
      }
    }
    // OpenUI's InterleavedTurn renders only the final assistant segment's text as the turn answer.
    // If prose appeared only before tool calls with no trailing prose after the last tool, surface it at the end.
    if (lastTurnProse.trim() && !turnHasTrailingAssistantProse && messages.at(-1)?.role === "tool") {
      messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        content: lastTurnProse,
        toolCalls: [],
      });
    }
    pendingToolEntries = new Map();
    lastTurnProse = "";
    turnHasTrailingAssistantProse = false;
  };

  for (const update of updates) {
    if (update.sessionUpdate === "user_message_chunk") {
      finalizeAssistantTurn();
      if (!currentUser) {
        currentUser = { id: crypto.randomUUID(), role: "user", content: "" };
      }
      const att = extractUserAttachmentFromBlock(update.content);
      if (att) {
        currentUser.attachments = [...(currentUser.attachments ?? []), att];
      } else {
        currentUser.content += extractContentBlockText(update.content);
      }
    } else if (update.sessionUpdate === "agent_message_chunk") {
      flushUser();
      const text = extractContentBlockText(update.content);
      if (!currentAssistant) {
        currentAssistant = { id: crypto.randomUUID(), role: "assistant", content: "", toolCalls: [] };
      }
      currentAssistant.content += text;
      if (currentAssistant.content.trim()) {
        lastTurnProse = currentAssistant.content;
        turnHasTrailingAssistantProse = true;
      }
    } else if (update.sessionUpdate === "tool_call") {
      flushUser();
      if (!currentAssistant) {
        currentAssistant = { id: crypto.randomUUID(), role: "assistant", content: "", toolCalls: [] };
      }
      turnHasTrailingAssistantProse = false;
      const tcName =
        typeof (update as { name?: unknown }).name === "string"
          ? (update as { name: string }).name
          : update.title;
      const tc = {
        id: update.toolCallId,
        type: "function" as const,
        function: {
          name: tcName || "tool",
          arguments: JSON.stringify(update.rawInput ?? {}),
        },
      };
      currentAssistant.toolCalls?.push(tc);
      const entry = { tc, completed: false };
      pendingToolEntries.set(update.toolCallId, entry);

      if (update.status === "completed" || update.status === "failed") {
        entry.completed = true;
        flushAssistant();
        emitToolResult(update.toolCallId, update.status, extractAcpToolOutput(update));
      }
    } else if (update.sessionUpdate === "tool_call_update") {
      flushUser();
      turnHasTrailingAssistantProse = false;
      let entry = pendingToolEntries.get(update.toolCallId);
      if (!entry) {
        if (!currentAssistant) {
          currentAssistant = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            toolCalls: [],
          };
        }
        const tc = {
          id: update.toolCallId,
          type: "function" as const,
          function: {
            name: update.title || "tool",
            arguments: JSON.stringify(update.rawInput ?? {}),
          },
        };
        currentAssistant.toolCalls?.push(tc);
        entry = { tc, completed: false };
        pendingToolEntries.set(update.toolCallId, entry);
      } else {
        if (update.title && entry.tc.function.name === "tool") {
          entry.tc.function.name = update.title;
        }
        if (update.rawInput !== undefined && entry.tc.function.arguments === "{}") {
          entry.tc.function.arguments = JSON.stringify(update.rawInput ?? {});
        }
      }

      if ((update.status === "completed" || update.status === "failed") && !entry.completed) {
        entry.completed = true;
        flushAssistant();
        emitToolResult(update.toolCallId, update.status, extractAcpToolOutput(update));
      }
    }
  }
  flushUser();
  finalizeAssistantTurn();
  return messages;
}

export function extractAcpToolOutput(
  update: acp.ToolCall | acp.ToolCallUpdate,
): string {
  if (Array.isArray(update.content) && update.content.length > 0) {
    const parts: string[] = [];
    for (const item of update.content) {
      if (item.type === "content" && item.content.type === "text") {
        parts.push(item.content.text);
      } else if (item.type === "diff") {
        parts.push(`Diff (${item.path}):\n${item.newText ?? ""}`);
      } else if (item.type === "terminal") {
        parts.push(`Terminal: ${item.terminalId}`);
      }
    }
    if (parts.length > 0) return parts.join("\n\n");
  }
  if (update.rawOutput !== undefined && update.rawOutput !== null) {
    return typeof update.rawOutput === "string"
      ? update.rawOutput
      : JSON.stringify(update.rawOutput, null, 2);
  }
  return update.status === "failed" ? "Tool execution failed." : "Completed.";
}
