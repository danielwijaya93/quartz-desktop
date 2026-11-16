"use client";

import type { AcpConfigOption, AcpSessionSnapshot } from "@/lib/acp/types";
import {
  acpStore,
  getBootstrapThreadKey,
  selectEffectiveSnapshot,
  useAcpStore,
} from "@/lib/client/acp-store";
import { useThreadList } from "@openuidev/react-headless";
import { History, Plug, Shield } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const FALLBACK_MODELS = [
  { value: "gemini-4-argon", name: "Gemini 4 Argon" },
  { value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
  { value: "gemini-pro-orchestrator-g1-pro", name: "Orchestrator (Argon)" },
  { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  { value: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { value: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
];

const FALLBACK_THOUGHT_LEVELS = [
  { value: "low", name: "Low" },
  { value: "medium", name: "Medium" },
  { value: "high", name: "High" },
];

const FALLBACK_MODES = [
  { value: "auto", name: "Auto" },
  { value: "default", name: "Default" },
  { value: "accept-edits", name: "Accept edits" },
  { value: "plan", name: "Plan" },
];

function findOption(snapshot: AcpSessionSnapshot | undefined, id: string): AcpConfigOption | undefined {
  return snapshot?.configOptions.find((c) => c.id === id);
}

export function AntigravityHeaderControls() {
  const selectedThreadId = useThreadList((s) => s.selectedThreadId);
  const activeFolderId = useAcpStore((s) => s.activeFolderId);
  const effectiveThreadId = selectedThreadId || getBootstrapThreadKey(activeFolderId);

  const snapshot = useAcpStore((s) => selectEffectiveSnapshot(s, selectedThreadId));
  const hydrated = useAcpStore((s) => s.hydrated);
  const preferredModel = useAcpStore((s) => s.preferredModel);
  const preferredThoughtLevel = useAcpStore((s) => s.preferredThoughtLevel);
  const preferredMode = useAcpStore((s) => s.preferredMode);
  const [updatingConfig, setUpdatingConfig] = useState<string | null>(null);

  // Pre-warm ACP metadata (slash commands, skills, models, modes, tier) after storage hydration
  useEffect(() => {
    if (!hydrated) {
      acpStore.hydrateFromStorage();
      return;
    }

    let cancelled = false;
    const state = acpStore.getState();
    const existingSnapshot = state.snapshots[effectiveThreadId];
    if (existingSnapshot) return;

    fetch("/api/acp/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "init",
        threadId: effectiveThreadId,
        acpSessionId: state.acpSessionIds[effectiveThreadId],
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

  const modelOption = findOption(snapshot, "model");
  const thoughtOption = findOption(snapshot, "thought_level");
  const modeOption = findOption(snapshot, "mode");

  const activeModel = preferredModel || modelOption?.currentValue || "gemini-4-argon";
  const activeThought = preferredThoughtLevel || thoughtOption?.currentValue || "medium";
  const activeMode = preferredMode || modeOption?.currentValue || "auto";

  const modelChoices = useMemo(
    () => modelOption?.options ?? FALLBACK_MODELS,
    [modelOption],
  );
  const thoughtChoices = useMemo(
    () => thoughtOption?.options ?? FALLBACK_THOUGHT_LEVELS,
    [thoughtOption],
  );
  const modeChoices = useMemo(
    () => modeOption?.options ?? FALLBACK_MODES,
    [modeOption],
  );

  const handleConfigChange = async (configId: "model" | "thought_level" | "mode", value: string) => {
    if (configId === "model") acpStore.setPreferences({ preferredModel: value });
    if (configId === "thought_level") acpStore.setPreferences({ preferredThoughtLevel: value });
    if (configId === "mode") acpStore.setPreferences({ preferredMode: value });

    setUpdatingConfig(configId);
    try {
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
    } finally {
      setUpdatingConfig(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <label className="inline-flex items-center gap-1 rounded-lg border border-black/10 dark:border-white/15 bg-black/[0.03] dark:bg-white/[0.04] px-2 py-1">
        <span className="sr-only">Model</span>
        <select
          aria-label="Model"
          value={activeModel}
          disabled={updatingConfig === "model"}
          onChange={(e) => handleConfigChange("model", e.target.value)}
          className="bg-transparent font-medium outline-none cursor-pointer"
        >
          {modelChoices.map((opt) => (
            <option key={opt.value} value={opt.value} className="bg-white dark:bg-zinc-900">
              {opt.name}
            </option>
          ))}
        </select>
      </label>

      <label className="inline-flex items-center gap-1 rounded-lg border border-black/10 dark:border-white/15 bg-black/[0.03] dark:bg-white/[0.04] px-2 py-1">
        <span className="opacity-60">Think:</span>
        <select
          aria-label="Thinking Level"
          value={activeThought}
          disabled={updatingConfig === "thought_level"}
          onChange={(e) => handleConfigChange("thought_level", e.target.value)}
          className="bg-transparent font-medium outline-none cursor-pointer"
        >
          {thoughtChoices.map((opt) => (
            <option key={opt.value} value={opt.value} className="bg-white dark:bg-zinc-900">
              {opt.name}
            </option>
          ))}
        </select>
      </label>

      <label className="inline-flex items-center gap-1 rounded-lg border border-black/10 dark:border-white/15 bg-black/[0.03] dark:bg-white/[0.04] px-2 py-1">
        <Shield className="h-3 w-3 opacity-70" aria-hidden="true" />
        <select
          aria-label="Execution Mode"
          value={activeMode}
          disabled={updatingConfig === "mode"}
          onChange={(e) => handleConfigChange("mode", e.target.value)}
          className="bg-transparent font-medium outline-none cursor-pointer"
        >
          {modeChoices.map((opt) => (
            <option key={opt.value} value={opt.value} className="bg-white dark:bg-zinc-900">
              {opt.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function AntigravityHeaderActions() {
  const selectedThreadId = useThreadList((s) => s.selectedThreadId);

  const snapshot = useAcpStore((s) => selectEffectiveSnapshot(s, selectedThreadId));
  const [mcpCount, setMcpCount] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/mcp")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { servers?: Array<{ status: string }> } | null) => {
        if (data?.servers) {
          setMcpCount(data.servers.filter((s) => s.status === "enabled").length);
        }
      })
      .catch(() => {});
  }, []);

  const usage = snapshot?.usage;
  const usageLabel = usage
    ? `${Math.round(usage.used / 1000)}k / ${Math.round(usage.size / 1000)}k`
    : null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <button
        type="button"
        onClick={() => acpStore.setActiveModal("mcp")}
        className="inline-flex min-h-[26px] items-center gap-1 rounded-lg border border-black/10 dark:border-white/15 px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10"
      >
        <Plug className="h-3.5 w-3.5 opacity-75" aria-hidden="true" />
        <span>MCP{mcpCount !== null ? ` (${mcpCount})` : ""}</span>
      </button>

      <button
        type="button"
        onClick={() => acpStore.setActiveModal("sessions")}
        className="inline-flex min-h-[26px] items-center gap-1 rounded-lg border border-black/10 dark:border-white/15 px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10"
      >
        <History className="h-3.5 w-3.5 opacity-75" aria-hidden="true" />
        <span>Sessions</span>
      </button>

      {usageLabel && (
        <span className="rounded-lg border border-black/10 dark:border-white/15 px-2 py-1 tabular-nums text-[11px] opacity-75">
          {usageLabel}
        </span>
      )}
    </div>
  );
}
