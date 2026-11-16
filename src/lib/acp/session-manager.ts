import type {
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
  WorkspaceConfig,
} from "@/lib/acp/types";
import { resolveAdditionalDirs, resolveWorkspaceDir } from "@/lib/acp/workspace";
import { getOpenUISystemPrompt } from "@/lib/openui/prompt";
import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

export function buildSessionSnapshot(entry: AcpSessionEntry): AcpSessionSnapshot {
  return {
    threadId: entry.threadId,
    sessionId: entry.sessionId,
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
  onSessionUpdate: (update: acp.SessionUpdate) => void;
  onPermissionRequest: (req: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;
}): {
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientConnection;
} {
  const args = ["acp", "--disable-telemetry"];
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

async function createSessionEntry(options: GetOrCreateSessionOptions): Promise<AcpSessionEntry> {
  evictOldestIfFull();

  const cwd = resolveWorkspaceDir(options.cwd);
  const additionalDirectories = resolveAdditionalDirs(options.additionalDirectories);
  const mcpServers = options.mcpServers ?? [];

  let entryRef: AcpSessionEntry | undefined;

  const { child, connection } = spawnAcpConnection({
    cwd,
    additionalDirectories,
    onSessionUpdate: (update) => {
      if (entryRef) {
        applySessionUpdateToEntry(entryRef, update);
      }
    },
    onPermissionRequest: async (req) => {
      if (!entryRef) {
        const fallback =
          req.options.find((o) => o.kind === "allow_once") ?? req.options[0];
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
          name: typeof (req.toolCall as { name?: unknown }).name === "string"
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
        if (!entryRef) {
          resolvePromise({ outcome: { outcome: "cancelled" } });
          return;
        }
        entryRef.pendingPermissions.set(requestId, {
          request: permission,
          resolve: resolvePromise,
        });
        PERMISSION_INDEX.set(requestId, { threadId: entryRef.threadId, entry: entryRef });
        entryRef.activeCustomListener?.({ type: "permission_request", permission });
      });
    },
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
      const modeRes = await connection.agent.request(
        acp.AGENT_METHODS.session_set_config_option,
        {
          sessionId: entry.sessionId,
          configId: "mode",
          value: targetMode,
        },
      );
      if (modeRes.configOptions) {
        entry.configOptions = normalizeConfigOptions(modeRes.configOptions);
      }
      if (entry.modes) {
        entry.modes = { ...entry.modes, currentModeId: targetMode };
      }
    }

    if (options.model) {
      const modelRes = await connection.agent.request(
        acp.AGENT_METHODS.session_set_config_option,
        {
          sessionId: entry.sessionId,
          configId: "model",
          value: options.model,
        },
      );
      if (modelRes.configOptions) {
        entry.configOptions = normalizeConfigOptions(modelRes.configOptions);
      }
    }

    if (options.thoughtLevel) {
      const thoughtRes = await connection.agent.request(
        acp.AGENT_METHODS.session_set_config_option,
        {
          sessionId: entry.sessionId,
          configId: "thought_level",
          value: options.thoughtLevel,
        },
      );
      if (thoughtRes.configOptions) {
        entry.configOptions = normalizeConfigOptions(thoughtRes.configOptions);
      }
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

/** Lists recent Antigravity sessions via a short-lived ACP control process. */
export async function listHistoricalAcpSessions(cwd?: string): Promise<HistoricalAcpSession[]> {
  const resolvedCwd = resolveWorkspaceDir(cwd);
  const { child, connection } = spawnAcpConnection({
    cwd: resolvedCwd,
    additionalDirectories: [],
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

/**
 * Loads an existing ACP session into `threadId` and converts replayed history
 * into OpenUI-compatible AG-UI transcript messages.
 */
export async function loadHistoricalAcpSession(params: {
  threadId: string;
  acpSessionId: string;
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
  const replayed: acp.SessionUpdate[] = [];
  let entryRef: AcpSessionEntry | undefined;

  const { child, connection } = spawnAcpConnection({
    cwd,
    additionalDirectories,
    onSessionUpdate: (update) => {
      replayed.push(update);
      if (entryRef) {
        applySessionUpdateToEntry(entryRef, update);
      }
    },
    onPermissionRequest: async (req) => {
      if (!entryRef) return { outcome: { outcome: "cancelled" } };
      const requestId = crypto.randomUUID();
      const permission: PendingPermissionRequest = {
        requestId,
        threadId: entryRef.threadId,
        sessionId: entryRef.sessionId,
        toolCall: {
          toolCallId: req.toolCall.toolCallId,
          title: req.toolCall.title,
          name: typeof (req.toolCall as { name?: unknown }).name === "string"
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
      return new Promise((resolvePromise) => {
        if (!entryRef) {
          resolvePromise({ outcome: { outcome: "cancelled" } });
          return;
        }
        entryRef.pendingPermissions.set(requestId, { request: permission, resolve: resolvePromise });
        PERMISSION_INDEX.set(requestId, { threadId: entryRef.threadId, entry: entryRef });
        entryRef.activeCustomListener?.({ type: "permission_request", permission });
      });
    },
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
    };
    entryRef = entry;

    const loaded = await connection.agent.request(acp.AGENT_METHODS.session_load, {
      sessionId: params.acpSessionId,
      cwd,
      additionalDirectories,
      mcpServers: mapMcpServersToAcp(mcpServers),
      _meta: {
        antigravity: {
          systemPrompt: { append: getOpenUISystemPrompt() },
        },
      },
    });

    applySessionResponseMetadata(entry, loaded as SessionResponseWithModels);

    // Ensure auto mode by default if loaded session was default
    const modeRes = await connection.agent.request(
      acp.AGENT_METHODS.session_set_config_option,
      {
        sessionId: entry.sessionId,
        configId: "mode",
        value: "auto",
      },
    );
    if (modeRes.configOptions) {
      entry.configOptions = normalizeConfigOptions(modeRes.configOptions);
    }
    if (entry.modes) {
      entry.modes = { ...entry.modes, currentModeId: "auto" };
    }

    SESSIONS.set(params.threadId, entry);

    const messages = convertReplayedUpdatesToMessages(replayed);
    return {
      snapshot: buildSessionSnapshot(entry),
      messages,
    };
  } catch (err) {
    disposeEntry({
      threadId: params.threadId,
      sessionId: params.acpSessionId,
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

export function convertReplayedUpdatesToMessages(
  updates: acp.SessionUpdate[],
): ReplayedTranscriptMessage[] {
  const messages: ReplayedTranscriptMessage[] = [];
  let currentUser: ReplayedTranscriptMessage | null = null;
  let currentAssistant: ReplayedTranscriptMessage | null = null;

  const flushUser = () => {
    if (currentUser && currentUser.content) {
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

  for (const update of updates) {
    if (update.sessionUpdate === "user_message_chunk") {
      flushAssistant();
      const text = update.content.type === "text" ? update.content.text : "";
      if (!currentUser) {
        currentUser = { id: crypto.randomUUID(), role: "user", content: "" };
      }
      currentUser.content += text;
    } else if (update.sessionUpdate === "agent_message_chunk") {
      flushUser();
      const text = update.content.type === "text" ? update.content.text : "";
      if (!currentAssistant) {
        currentAssistant = { id: crypto.randomUUID(), role: "assistant", content: "", toolCalls: [] };
      }
      currentAssistant.content += text;
    } else if (update.sessionUpdate === "tool_call") {
      flushUser();
      if (!currentAssistant) {
        currentAssistant = { id: crypto.randomUUID(), role: "assistant", content: "", toolCalls: [] };
      }
      const tcName =
        typeof (update as { name?: unknown }).name === "string"
          ? (update as { name: string }).name
          : update.title;
      currentAssistant.toolCalls?.push({
        id: update.toolCallId,
        type: "function",
        function: {
          name: tcName || "tool",
          arguments: JSON.stringify(update.rawInput ?? {}),
        },
      });
      if (update.status === "completed" || update.status === "failed") {
        flushAssistant();
        messages.push({
          id: crypto.randomUUID(),
          role: "tool",
          toolCallId: update.toolCallId,
          content: JSON.stringify(update.rawOutput ?? {}),
          ...(update.status === "failed" ? { error: "Tool failed" } : {}),
        });
      }
    }
  }
  flushUser();
  flushAssistant();
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
