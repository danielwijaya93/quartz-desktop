"use client";

import type { AcpAgentId, AcpConfigOption, AcpSessionSnapshot, AcpUsageInfo } from "@/lib/acp/types";
import { acpStore, selectEffectiveAgent, selectEffectiveOpenUI } from "@/lib/client/acp-store";
import { useEffect } from "react";

export const FALLBACK_MODELS = [
  { value: "gemini-4-argon", name: "Gemini 4 Argon" },
  { value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
  { value: "gemini-pro-orchestrator-g1-pro", name: "Orchestrator (Argon)" },
  { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  { value: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { value: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
];

export const FALLBACK_THOUGHT_LEVELS = [
  { value: "low", name: "Low" },
  { value: "medium", name: "Medium" },
  { value: "high", name: "High" },
];

export const FALLBACK_MODES = [
  { value: "auto", name: "Auto" },
  { value: "default", name: "Default" },
  { value: "accept-edits", name: "Accept edits" },
  { value: "plan", name: "Plan" },
];

export type AcpConfigKey = "model" | "thought_level" | "mode";

/** Looks up an ACP config option (e.g. `model`, `thought_level`, `mode`) on a session snapshot. */
export function findConfigOption(
  snapshot: AcpSessionSnapshot | undefined,
  id: string,
): AcpConfigOption | undefined {
  return snapshot?.configOptions.find((c) => c.id === id);
}

/** Resolves a display label for a config option value, falling back to the raw value. */
export function resolveChoiceName(
  options: Array<{ value: string; name: string }>,
  value: string,
): string {
  return options.find((opt) => opt.value === value)?.name ?? value;
}

export interface ContextPercentInfo {
  percent: number;
  label: string;
  title: string;
}

/** Converts ACP token usage `{ used, size }` into a clamped percentage and accessible tooltip. */
export function formatContextPercent(usage: AcpUsageInfo | undefined): ContextPercentInfo {
  if (!usage || !Number.isFinite(usage.size) || usage.size <= 0) {
    return {
      percent: 0,
      label: "0%",
      title: "Context window usage: 0%",
    };
  }

  const used = Math.max(0, Number.isFinite(usage.used) ? usage.used : 0);
  const percent = Math.min(100, Math.max(0, Math.round((used / usage.size) * 100)));
  const usedK = Math.round(used / 1000);
  const sizeK = Math.round(usage.size / 1000);

  return {
    percent,
    label: `${percent}%`,
    title: `Context window usage: ${usedK}k / ${sizeK}k tokens (${percent}%)`,
  };
}

/** Pre-warms ACP metadata (slash commands, skills, models, modes) after storage hydration. */
export function useAcpSessionBootstrap(effectiveThreadId: string, hydrated: boolean): void {
  useEffect(() => {
    if (!hydrated) {
      acpStore.hydrateFromStorage();
      return;
    }

    let cancelled = false;
    const state = acpStore.getState();
    if (state.snapshots[effectiveThreadId]) return;

    fetch("/api/acp/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "init",
        threadId: effectiveThreadId,
        agent: selectEffectiveAgent(state, effectiveThreadId),
        openuiEnabled: selectEffectiveOpenUI(state, effectiveThreadId),
        acpSessionId: state.acpSessionIds[effectiveThreadId],
        appDataDir: state.appDataDirs[effectiveThreadId],
        cwd: state.cwd || undefined,
        additionalDirectories: [],
        mcpServers: state.sessionMcpServers,
        mode: state.preferredMode || "auto",
        model: state.preferredModel || undefined,
        thoughtLevel: state.preferredThoughtLevel || undefined,
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { snapshot?: AcpSessionSnapshot } | null) => {
        if (!cancelled && data?.snapshot) {
          acpStore.setSnapshot(effectiveThreadId, data.snapshot);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [effectiveThreadId, hydrated]);
}

/** Persists a Model, Thinking Effort, or Execution Mode preference locally and on the active ACP session. */
export async function updateAcpSessionConfig(
  effectiveThreadId: string,
  configId: AcpConfigKey,
  value: string,
): Promise<void> {
  if (configId === "model") acpStore.setPreferences({ preferredModel: value });
  if (configId === "thought_level") acpStore.setPreferences({ preferredThoughtLevel: value });
  if (configId === "mode") acpStore.setPreferences({ preferredMode: value });

  const res = await fetch("/api/acp/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "setConfig",
      threadId: effectiveThreadId,
      configId,
      value,
    }),
  });
  if (res.ok) {
    const data = (await res.json()) as { snapshot?: AcpSessionSnapshot };
    if (data.snapshot) {
      acpStore.setSnapshot(effectiveThreadId, data.snapshot);
    }
  }
}

/** Switches the active coding agent (`agy` or `quartz`) for a thread and resets its ACP session. */
export async function switchAcpSessionAgent(
  effectiveThreadId: string,
  agent: AcpAgentId,
): Promise<void> {
  acpStore.setThreadAgent(effectiveThreadId, agent);
  const state = acpStore.getState();

  const res = await fetch("/api/acp/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "switchAgent",
      threadId: effectiveThreadId,
      agent,
      cwd: state.cwd || undefined,
      additionalDirectories: [],
      mcpServers: state.sessionMcpServers,
      mode: state.preferredMode || "auto",
      model: state.preferredModel || undefined,
      thoughtLevel: state.preferredThoughtLevel || undefined,
    }),
  });
  if (res.ok) {
    const data = (await res.json()) as { snapshot?: AcpSessionSnapshot };
    if (data.snapshot) {
      acpStore.setSnapshot(effectiveThreadId, data.snapshot);
    }
  }
}
