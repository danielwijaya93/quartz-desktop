import type { BufferedRun } from "@/lib/acp/run-buffer";
import {
  convertReplayedUpdatesToMessages,
  extractAcpToolOutput,
} from "@/lib/acp/replay";
export { convertReplayedUpdatesToMessages, extractAcpToolOutput };
import type {
  AcpAgentId,
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
} from "@/lib/acp/types";
import { isSyntheticTitleSession } from "@/lib/acp/thread-title";
import { resolveAcpAdditionalDirs, resolveWorkspaceDir } from "@/lib/acp/workspace";
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
  agent: AcpAgentId;
  openuiEnabled: boolean;
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
  activeRun?: BufferedRun;
  activeUpdateListener?: UpdateListener;
  activeCustomListener?: CustomListener;
  replayCollector?: acp.SessionUpdate[];
}

export interface GetOrCreateSessionOptions {
  threadId: string;
  agent?: AcpAgentId;
  openuiEnabled?: boolean;
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

function disposeConnection(
  child: ChildProcessWithoutNullStreams,
  connection: acp.ClientConnection,
): void {
  try {
    connection.close();
  } catch {
    // ignore close errors during teardown
  }
  try {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  } catch {
    // ignore kill errors
  }
}

function disposeEntry(entry: AcpSessionEntry): void {
  for (const [reqId, pending] of entry.pendingPermissions) {
    pending.resolve({ outcome: { outcome: "cancelled" } });
    PERMISSION_INDEX.delete(reqId);
  }
  entry.pendingPermissions.clear();
  disposeConnection(entry.child, entry.connection);
}

function bindChildExitCleanup(
  threadId: string,
  child: ChildProcessWithoutNullStreams,
): void {
  child.once("exit", () => {
    const existing = SESSIONS.get(threadId);
    if (existing && existing.child === child) {
      for (const reqId of existing.pendingPermissions.keys()) {
        PERMISSION_INDEX.delete(reqId);
      }
      SESSIONS.delete(threadId);
    }
  });
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

function buildSessionMeta(
  agent: AcpAgentId,
  openuiEnabled: boolean,
): Record<string, unknown> | undefined {
  if (!openuiEnabled) return undefined;
  const systemPromptAppend = getOpenUISystemPrompt();
  if (agent === "quartz") {
    return {
      systemPrompt: { append: systemPromptAppend },
    };
  }
  return {
    antigravity: {
      systemPrompt: { append: systemPromptAppend },
    },
  };
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
    agent: entry.agent,
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

/** Builds the CLI command and arguments for spawning an ACP coding agent process. */
export function buildAgentSpawnSpec(params: {
  agent: AcpAgentId;
  additionalDirectories: string[];
  appDataDir?: AcpAppDataDir;
}): { command: string; args: string[] } {
  if (params.agent === "quartz") {
    return { command: "quartz", args: ["acp"] };
  }
  const args = ["acp", "--disable-telemetry"];
  if (params.appDataDir && params.appDataDir !== "antigravity-cli") {
    args.push("--app-data-dir", params.appDataDir);
  }
  for (const dir of params.additionalDirectories) {
    args.push("--add-dir", dir);
  }
  return { command: "agy", args };
}

function spawnAcpConnection(params: {
  agent: AcpAgentId;
  cwd: string;
  additionalDirectories: string[];
  appDataDir?: AcpAppDataDir;
  onSessionUpdate: (update: acp.SessionUpdate) => void;
  onPermissionRequest: (req: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;
}): {
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientConnection;
} {
  const { command, args } = buildAgentSpawnSpec({
    agent: params.agent,
    additionalDirectories: params.additionalDirectories,
    appDataDir: params.appDataDir,
  });

  const child = spawn(command, args, {
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

  const agent: AcpAgentId = options.agent === "quartz" ? "quartz" : "agy";
  const cwd = resolveWorkspaceDir(options.cwd);
  const additionalDirectories =
    agent === "agy" ? resolveAcpAdditionalDirs(options.additionalDirectories) : [];
  const mcpServers = agent === "agy" ? (options.mcpServers ?? []) : [];
  const appDataDir = detectSessionAppDataDir(options.acpSessionId, options.appDataDir);

  let entryRef: AcpSessionEntry | undefined;

  const { child, connection } = spawnAcpConnection({
    agent,
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

  bindChildExitCleanup(options.threadId, child);

  try {
    await connection.agent.request(acp.AGENT_METHODS.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "antigravity-gen-ui", version: "0.1.0" },
    });

    const openuiEnabled = options.openuiEnabled ?? true;
    const sessionMeta = buildSessionMeta(agent, openuiEnabled);
    const acpMcpServers = mapMcpServersToAcp(mcpServers);
    const replayUpdates: acp.SessionUpdate[] = [];

    const entry: AcpSessionEntry = {
      threadId: options.threadId,
      sessionId: "",
      agent,
      openuiEnabled,
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

    const newSessionParams: acp.NewSessionRequest =
      agent === "quartz"
        ? {
            cwd,
            mcpServers: [],
            ...(sessionMeta ? { _meta: sessionMeta } : {}),
          }
        : {
            cwd,
            additionalDirectories,
            mcpServers: acpMcpServers,
            ...(sessionMeta ? { _meta: sessionMeta } : {}),
          };

    let sessionResp: acp.NewSessionResponse | acp.LoadSessionResponse | acp.ResumeSessionResponse;
    if (options.acpSessionId) {
      try {
        const loadSessionParams: acp.LoadSessionRequest =
          agent === "quartz"
            ? {
                sessionId: options.acpSessionId,
                cwd,
                mcpServers: [],
                ...(sessionMeta ? { _meta: sessionMeta } : {}),
              }
            : {
                sessionId: options.acpSessionId,
                cwd,
                additionalDirectories,
                mcpServers: acpMcpServers,
                ...(sessionMeta ? { _meta: sessionMeta } : {}),
              };
        sessionResp = await connection.agent.request(
          acp.AGENT_METHODS.session_load,
          loadSessionParams,
        );
        entry.sessionId = options.acpSessionId;
      } catch {
        const created = await connection.agent.request(
          acp.AGENT_METHODS.session_new,
          newSessionParams,
        );
        entry.sessionId = created.sessionId;
        sessionResp = created;
      }
    } else {
      const created = await connection.agent.request(
        acp.AGENT_METHODS.session_new,
        newSessionParams,
      );
      entry.sessionId = created.sessionId;
      sessionResp = created;
    }
    entry.replayCollector = undefined;
    applySessionResponseMetadata(entry, sessionResp as SessionResponseWithModels);

    if (agent === "agy") {
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
    }

    SESSIONS.set(options.threadId, entry);
    return entry;
  } catch (err) {
    disposeConnection(child, connection);
    throw err;
  }
}

export async function getOrCreateAcpSession(
  options: GetOrCreateSessionOptions,
): Promise<AcpSessionEntry> {
  const now = Date.now();
  evictIdle(now);

  const requestedOpenUI = options.openuiEnabled ?? true;
  const existing = SESSIONS.get(options.threadId);
  if (existing && !existing.child.killed) {
    if (options.agent && existing.agent !== options.agent) {
      if (existing.isStreaming) {
        await cancelAcpTurn(options.threadId).catch(() => {});
      }
      disposeEntry(existing);
      SESSIONS.delete(options.threadId);
    } else if (existing.openuiEnabled !== requestedOpenUI && !existing.isStreaming) {
      const resumeSessionId = options.acpSessionId ?? (existing.sessionId || undefined);
      disposeEntry(existing);
      SESSIONS.delete(options.threadId);
      options = { ...options, acpSessionId: resumeSessionId };
    } else {
      existing.lastUsed = now;
      return existing;
    }
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
    agent: "agy",
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
    agent: "agy",
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
      agent: "agy",
      openuiEnabled: true,
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
    disposeConnection(child, connection);
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
}): Promise<{ snapshot: AcpSessionSnapshot; messages: import("@/lib/acp/types").ReplayedTranscriptMessage[] }> {
  evictIdle(Date.now());
  evictOldestIfFull();

  const existing = SESSIONS.get(params.threadId);
  if (existing) {
    disposeEntry(existing);
    SESSIONS.delete(params.threadId);
  }

  const cwd = resolveWorkspaceDir(params.cwd);
  const additionalDirectories = resolveAcpAdditionalDirs(params.additionalDirectories);
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

  bindChildExitCleanup(params.threadId, chosen.entry.child);

  SESSIONS.set(params.threadId, chosen.entry);

  const messages = convertReplayedUpdatesToMessages(chosen.replayed);
  return {
    snapshot: buildSessionSnapshot(chosen.entry),
    messages,
  };
}
