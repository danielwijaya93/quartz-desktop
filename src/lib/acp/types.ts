export interface WorkspaceFolder {
  id: string;
  name: string;
  cwd: string;
  collapsed?: boolean;
}

export interface AcpCommand {
  name: string;
  description: string;
  inputHint?: string;
  category?: "cli" | "skill" | "app";
}

export interface AcpConfigSelectOption {
  value: string;
  name: string;
  description?: string;
}

export interface AcpConfigOption {
  id: string;
  name: string;
  category?: string;
  type: "select" | "boolean";
  currentValue: string;
  options?: AcpConfigSelectOption[];
}

export interface AcpModelInfo {
  modelId: string;
  name: string;
  description?: string;
}

export interface AcpModeInfo {
  id: string;
  name: string;
  description?: string;
}

export interface AcpUsageInfo {
  used: number;
  size: number;
  cost?: {
    amount: number;
    currency: string;
  } | null;
}

export interface AcpTierInfo {
  id: string;
  name: string;
  upgradeUri?: string;
}

export interface AcpPlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface PendingPermissionRequest {
  requestId: string;
  threadId: string;
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title?: string | null;
    name?: string | null;
    kind?: string | null;
    rawInput?: unknown;
  };
  options: AcpPermissionOption[];
  createdAt: number;
}

export interface AcpSessionMcpServer {
  name: string;
  type: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  url?: string;
  headers?: Array<{ name: string; value: string }>;
}

export type AcpAppDataDir = "antigravity-cli" | "antigravity";

export interface AcpBackgroundTask {
  id: string;
  name: string;
  label: string;
  startedAt: number;
}

export interface AcpSessionSnapshot {
  threadId: string;
  sessionId: string;
  appDataDir?: AcpAppDataDir;
  cwd: string;
  additionalDirectories: string[];
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
  pendingPermissions: PendingPermissionRequest[];
  backgroundTasks?: AcpBackgroundTask[];
  isStreaming: boolean;
}

export interface HistoricalAcpSession {
  sessionId: string;
  appDataDir?: AcpAppDataDir;
  cwd: string;
  additionalDirectories?: string[];
  title?: string | null;
  updatedAt?: string | null;
}

export interface GlobalMcpServerInfo {
  name: string;
  type: "stdio" | "http" | "sse" | string;
  status: "enabled" | "disabled" | string;
  target: string;
}

import type { AttachmentKind } from "@/lib/acp/attachments";

export interface UserMessageAttachmentMeta {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  kind: AttachmentKind;
  data?: string;
}

export interface AskQuestionEntry {
  question: string;
  options: string[];
  is_multi_select?: boolean;
}

export interface ReplayedTranscriptMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  attachments?: UserMessageAttachmentMeta[];
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  error?: string;
}

export type AcpCustomEventPayload =
  | { type: "session_snapshot"; snapshot: AcpSessionSnapshot }
  | { type: "commands"; commands: AcpCommand[] }
  | { type: "config_options"; configOptions: AcpConfigOption[] }
  | { type: "mode"; currentModeId: string }
  | { type: "usage"; usage: AcpUsageInfo }
  | { type: "session_info"; title?: string | null }
  | { type: "plan"; entries: AcpPlanEntry[] }
  | { type: "permission_request"; permission: PendingPermissionRequest }
  | { type: "permission_resolved"; requestId: string }
  | { type: "background_tasks"; tasks: AcpBackgroundTask[] };
