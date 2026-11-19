"use client";

import {
  FALLBACK_MODELS,
  FALLBACK_MODES,
  FALLBACK_THOUGHT_LEVELS,
  findConfigOption,
  formatContextPercent,
  resolveChoiceName,
  updateAcpSessionConfig,
  useAcpSessionBootstrap,
  type AcpConfigKey,
} from "@/lib/client/acp-session-controls";
import {
  acpStore,
  getBootstrapThreadKey,
  selectEffectiveOpenUI,
  selectEffectiveSnapshot,
  useAcpStore,
} from "@/lib/client/acp-store";
import { useThreadList } from "@openuidev/react-headless";
import { Check, ChevronDown, Shield, Sparkles } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

interface ToggleEventLike extends Event {
  newState?: string;
}

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/25 dark:focus-visible:ring-white/30";

/**
 * Renders the OpenUI toggle, unified Model + Thinking Effort popover button, and Permission Mode
 * selector inside the chat composer bar, and keeps ACP session metadata pre-warmed.
 */
export function ComposerConfigControls() {
  const selectedThreadId = useThreadList((s) => s.selectedThreadId);
  const activeFolderId = useAcpStore((s) => s.activeFolderId);
  const effectiveThreadId = selectedThreadId || getBootstrapThreadKey(activeFolderId);

  const snapshot = useAcpStore((s) => selectEffectiveSnapshot(s, selectedThreadId));
  const openuiEnabled = useAcpStore((s) => selectEffectiveOpenUI(s, selectedThreadId));
  const hydrated = useAcpStore((s) => s.hydrated);
  const preferredModel = useAcpStore((s) => s.preferredModel);
  const preferredThoughtLevel = useAcpStore((s) => s.preferredThoughtLevel);
  const preferredMode = useAcpStore((s) => s.preferredMode);

  const [updatingConfig, setUpdatingConfig] = useState<AcpConfigKey | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);

  const panelId = useId();
  const modeSelectId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useAcpSessionBootstrap(effectiveThreadId, hydrated);

  const modelOption = findConfigOption(snapshot, "model");
  const thoughtOption = findConfigOption(snapshot, "thought_level");
  const modeOption = findConfigOption(snapshot, "mode");

  const modelChoices = useMemo(() => modelOption?.options ?? FALLBACK_MODELS, [modelOption]);
  const thoughtChoices = useMemo(
    () => thoughtOption?.options ?? FALLBACK_THOUGHT_LEVELS,
    [thoughtOption],
  );
  const modeChoices = useMemo(() => modeOption?.options ?? FALLBACK_MODES, [modeOption]);

  const activeModel = preferredModel || modelOption?.currentValue || "gemini-4-argon";
  const activeThought = preferredThoughtLevel || thoughtOption?.currentValue || "medium";
  const activeMode = preferredMode || modeOption?.currentValue || "auto";

  const activeModelName = resolveChoiceName(modelChoices, activeModel);
  const activeThoughtName = resolveChoiceName(thoughtChoices, activeThought);

  const updateFallbackAnchorCoords = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = popoverRef.current;
    if (!trigger || !panel) return;
    if (typeof CSS !== "undefined" && CSS.supports("position-area: block-start")) return;

    const rect = trigger.getBoundingClientRect();
    const panelWidth = Math.min(288, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - panelWidth - 12));
    const bottom = Math.max(12, window.innerHeight - rect.top + 8);
    panel.style.setProperty("--ag-popover-left", `${Math.round(left)}px`);
    panel.style.setProperty("--ag-popover-bottom", `${Math.round(bottom)}px`);
  }, []);

  useEffect(() => {
    if (!popoverOpen) return;
    updateFallbackAnchorCoords();
    window.addEventListener("resize", updateFallbackAnchorCoords);
    return () => {
      window.removeEventListener("resize", updateFallbackAnchorCoords);
    };
  }, [popoverOpen, updateFallbackAnchorCoords]);

  const handleConfigChange = async (configId: AcpConfigKey, value: string) => {
    setUpdatingConfig(configId);
    try {
      await updateAcpSessionConfig(effectiveThreadId, configId, value);
    } finally {
      setUpdatingConfig(null);
    }
  };

  const closePopover = () => {
    const panel = popoverRef.current;
    if (panel && typeof panel.hidePopover === "function" && popoverOpen) {
      panel.hidePopover();
    }
  };

  return (
    <>
      <button
        type="button"
        aria-pressed={openuiEnabled}
        aria-label={
          openuiEnabled
            ? "OpenUI generative UI enabled; click for plain Markdown"
            : "Plain Markdown mode; click to enable OpenUI generative UI"
        }
        title={
          openuiEnabled
            ? "OpenUI components enabled (click for plain Markdown)"
            : "Plain Markdown mode (click to enable OpenUI)"
        }
        onClick={() => acpStore.setThreadOpenUI(effectiveThreadId, !openuiEnabled)}
        className={`inline-flex min-h-[28px] shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium transition-colors cursor-pointer ${FOCUS_RING} ${
          openuiEnabled
            ? "bg-black/[0.06] dark:bg-white/[0.1] ring-1 ring-inset ring-black/[0.08] dark:ring-white/[0.12] opacity-95 hover:opacity-100"
            : "opacity-50 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] hover:opacity-85"
        }`}
      >
        <Sparkles className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span>OpenUI</span>
        {openuiEnabled && (
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
          />
        )}
      </button>

      <button
        ref={triggerRef}
        type="button"
        popoverTarget={panelId}
        aria-expanded={popoverOpen}
        aria-controls={panelId}
        aria-label={`Model: ${activeModelName}, Thinking effort: ${activeThoughtName}`}
        disabled={updatingConfig === "model" || updatingConfig === "thought_level"}
        className={`inline-flex min-h-[28px] max-w-[220px] shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium opacity-75 transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.08] hover:opacity-100 cursor-pointer disabled:opacity-50 ${FOCUS_RING}`}
      >
        <span className="truncate">{activeModelName}</span>
        <span className="opacity-45" aria-hidden="true">
          ·
        </span>
        <span className="shrink-0 opacity-75">{activeThoughtName}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
      </button>

      <div
        id={panelId}
        ref={popoverRef}
        popover="auto"
        data-composer-popover=""
        aria-label="Model and thinking effort"
        onToggle={(e) => {
          const isOpen = (e.nativeEvent as ToggleEventLike).newState === "open";
          if (isOpen) {
            updateFallbackAnchorCoords();
          }
          setPopoverOpen(isOpen);
        }}
        className="antigravity-model-popover w-72 max-w-[calc(100vw-24px)] rounded-xl border border-black/15 dark:border-white/15 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 p-2.5 shadow-xl text-xs"
      >
        <div className="flex flex-col gap-2.5">
          <div>
            <div className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wider opacity-60">
              Thinking effort
            </div>
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] p-1">
              {thoughtChoices.map((opt) => {
                const active = opt.value === activeThought;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => void handleConfigChange("thought_level", opt.value)}
                    className={`rounded-md px-2 py-1 text-center font-medium transition-colors cursor-pointer ${FOCUS_RING} ${
                      active
                        ? "bg-white dark:bg-zinc-800 shadow-xs text-zinc-950 dark:text-zinc-50"
                        : "opacity-75 hover:opacity-100 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                    }`}
                  >
                    {opt.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="h-px bg-black/10 dark:bg-white/10" />

          <div>
            <div className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wider opacity-60">
              Model
            </div>
            <div className="flex max-h-60 flex-col gap-0.5 overflow-y-auto">
              {modelChoices.map((opt) => {
                const active = opt.value === activeModel;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      void handleConfigChange("model", opt.value);
                      closePopover();
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors cursor-pointer ${FOCUS_RING} ${
                      active
                        ? "bg-black/10 dark:bg-white/15 font-medium"
                        : "hover:bg-black/5 dark:hover:bg-white/10"
                    }`}
                  >
                    <span className="truncate">{opt.name}</span>
                    {active && <Check className="h-3.5 w-3.5 shrink-0 opacity-85" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <label
        htmlFor={modeSelectId}
        className="relative inline-flex min-h-[28px] shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs opacity-75 transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.08] hover:opacity-100 focus-within:ring-2 focus-within:ring-black/25 dark:focus-within:ring-white/30 cursor-pointer"
      >
        <span className="sr-only">Permission mode</span>
        <Shield className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
        <select
          id={modeSelectId}
          name="permission-mode"
          aria-label="Permission mode"
          value={activeMode}
          disabled={updatingConfig === "mode"}
          onChange={(e) => void handleConfigChange("mode", e.target.value)}
          className="antigravity-mode-select appearance-none bg-transparent pr-3.5 font-medium outline-none cursor-pointer disabled:opacity-50"
        >
          {modeChoices.map((opt) => (
            <option key={opt.value} value={opt.value} className="bg-white dark:bg-zinc-900">
              {opt.name}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-1.5 h-3 w-3 shrink-0 opacity-60"
          aria-hidden="true"
        />
      </label>
    </>
  );
}

/** Displays current thread context window consumption as a progress ring + percentage inside the composer. */
export function ComposerContextUsageBadge() {
  const selectedThreadId = useThreadList((s) => s.selectedThreadId);
  const snapshot = useAcpStore((s) => selectEffectiveSnapshot(s, selectedThreadId));
  const contextUsage = formatContextPercent(snapshot?.usage);

  const radius = 4.5;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - contextUsage.percent / 100);

  const toneClass =
    contextUsage.percent >= 90
      ? "text-red-600 dark:text-red-400 opacity-95"
      : contextUsage.percent >= 70
        ? "text-amber-600 dark:text-amber-400 opacity-90"
        : "opacity-55";

  return (
    <span
      title={contextUsage.title}
      aria-label={contextUsage.title}
      className={`inline-flex min-h-[28px] shrink-0 items-center gap-1.5 px-1.5 py-1 text-[11px] font-medium tabular-nums transition-colors ${toneClass}`}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        className="-rotate-90 shrink-0"
        aria-hidden="true"
      >
        <circle
          cx="6"
          cy="6"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="opacity-20"
        />
        <circle
          cx="6"
          cy="6"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          className="transition-[stroke-dashoffset] duration-300"
        />
      </svg>
      <span>{contextUsage.label}</span>
    </span>
  );
}
