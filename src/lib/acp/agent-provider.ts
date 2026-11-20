import type { AgentProvider } from "@/lib/acp/types";

export type { AgentProvider };

/** Resolve the ACP agent backend for a request. Defaults to Antigravity (`agy acp`). */
export function resolveAgentProvider(provider: string | null | undefined): AgentProvider {
  return provider === "quartz" ? "quartz" : "antigravity";
}

/** Client identity used in the ACP `initialize` handshake for a provider. */
export function acpClientInfoName(provider: AgentProvider): string {
  return provider === "quartz" ? "quartz-gen-ui" : "antigravity-gen-ui";
}

/** Human-readable provider label for the UI. */
export function agentProviderLabel(provider: AgentProvider): string {
  return provider === "quartz" ? "Quartz" : "Antigravity";
}
