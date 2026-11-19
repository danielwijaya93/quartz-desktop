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
import { Check, ChevronDown, Shield } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

interface ToggleEventLike extends Event {
  newState?: string;
}

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/25 dark:focus-visible:ring-white/30";

function updateFallbackAnchorPosition(
  trigger: HTMLButtonElement | null,
  panel: HTMLDivElement | null,
  maxWidth: number,
) {
  if (!trigger || !panel) return;
  if (typeof CSS !== "undefined" && CSS.supports("position-area: block-start")) return;

  const rect = trigger.getBoundingClientRect();
  const panelWidth = Math.min(maxWidth, window.innerWidth - 24);
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - panelWidth - 12));
  const bottom = Math.max(12, window.innerHeight - rect.top + 8);
  panel.style.setProperty("--ag-popover-left", `${Math.round(left)}px`);
  panel.style.setProperty("--ag-popover-bottom", `${Math.round(bottom)}px`);
}

/**
 * Renders the OpenUI toggle, unified Model + Thinking Effort popover button, and Permission Mode
 * popover pill inside the chat composer bar, and keeps ACP session metadata pre-warmed.
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
  const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
  const [modePopoverOpen, setModePopoverOpen] = useState(false);

  const modelPanelId = useId();
  const modePanelId = useId();
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelPopoverRef = useRef<HTMLDivElement>(null);
  const modeTriggerRef = useRef<HTMLButtonElement>(null);
  const modePopoverRef = useRef<HTMLDivElement>(null);

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
  const activeModeName = resolveChoiceName(modeChoices, activeMode);

  const syncModelAnchor = useCallback(() => {
    updateFallbackAnchorPosition(modelTriggerRef.current, modelPopoverRef.current, 288);
  }, []);

  const syncModeAnchor = useCallback(() => {
    updateFallbackAnchorPosition(modeTriggerRef.current, modePopoverRef.current, 192);
  }, []);

  useEffect(() => {
    if (!modelPopoverOpen) return;
    syncModelAnchor();
    window.addEventListener("resize", syncModelAnchor);
    return () => window.removeEventListener("resize", syncModelAnchor);
  }, [modelPopoverOpen, syncModelAnchor]);

  useEffect(() => {
    if (!modePopoverOpen) return;
    syncModeAnchor();
    window.addEventListener("resize", syncModeAnchor);
    return () => window.removeEventListener("resize", syncModeAnchor);
  }, [modePopoverOpen, syncModeAnchor]);

  const handleConfigChange = async (configId: AcpConfigKey, value: string) => {
    setUpdatingConfig(configId);
    try {
      await updateAcpSessionConfig(effectiveThreadId, configId, value);
    } finally {
      setUpdatingConfig(null);
    }
  };

  const closePopover = (ref: React.RefObject<HTMLDivElement | null>, isOpen: boolean) => {
    const panel = ref.current;
    if (panel && typeof panel.hidePopover === "function" && isOpen) {
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
        className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-1.5 sm:px-2 text-xs font-medium transition-colors cursor-pointer ${FOCUS_RING} ${
          openuiEnabled
            ? "opacity-85 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] hover:opacity-100"
            : "opacity-50 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] hover:opacity-85"
        }`}
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors ${
            openuiEnabled ? "bg-emerald-500" : "ring-1 ring-inset ring-current opacity-60"
          }`}
        />
        <span>OpenUI</span>
      </button>

      <button
        ref={modelTriggerRef}
        type="button"
        popoverTarget={modelPanelId}
        aria-expanded={modelPopoverOpen}
        aria-controls={modelPanelId}
        aria-label={`Model: ${activeModelName}, Thinking effort: ${activeThoughtName}`}
        disabled={updatingConfig === "model" || updatingConfig === "thought_level"}
        className={`inline-flex h-7 max-w-[130px] sm:max-w-[220px] shrink-0 items-center gap-1 rounded-lg px-1.5 sm:px-2 text-xs font-medium opacity-75 transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.08] hover:opacity-100 cursor-pointer disabled:opacity-50 ${FOCUS_RING}`}
      >
        <span className="truncate">{activeModelName}</span>
        <span className="opacity-45" aria-hidden="true">
          ·
        </span>
        <span className="shrink-0 opacity-75">{activeThoughtName}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
      </button>

      <div
        id={modelPanelId}
        ref={modelPopoverRef}
        popover="auto"
        data-composer-popover=""
        aria-label="Model and thinking effort"
        onToggle={(e) => {
          const isOpen = (e.nativeEvent as ToggleEventLike).newState === "open";
          if (isOpen) syncModelAnchor();
          setModelPopoverOpen(isOpen);
        }}
        className="antigravity-composer-popover w-72 max-w-[calc(100vw-24px)] rounded-xl border border-black/15 dark:border-white/15 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 p-2.5 shadow-xl text-xs"
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
                      closePopover(modelPopoverRef, modelPopoverOpen);
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

      <button
        ref={modeTriggerRef}
        type="button"
        popoverTarget={modePanelId}
        aria-expanded={modePopoverOpen}
        aria-controls={modePanelId}
        aria-label={`Permission mode: ${activeModeName}`}
        disabled={updatingConfig === "mode"}
        className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-1.5 sm:px-2 text-xs font-medium opacity-75 transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.08] hover:opacity-100 cursor-pointer disabled:opacity-50 ${FOCUS_RING}`}
      >
        <Shield className="h-3 w-3 shrink-0 opacity-65" aria-hidden="true" />
        <span>{activeModeName}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
      </button>

      <div
        id={modePanelId}
        ref={modePopoverRef}
        popover="auto"
        data-composer-popover=""
        aria-label="Permission mode"
        onToggle={(e) => {
          const isOpen = (e.nativeEvent as ToggleEventLike).newState === "open";
          if (isOpen) syncModeAnchor();
          setModePopoverOpen(isOpen);
        }}
        className="antigravity-composer-popover w-44 max-w-[calc(100vw-24px)] rounded-xl border border-black/15 dark:border-white/15 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 p-2 shadow-xl text-xs"
      >
        <div className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wider opacity-60">
          Permission mode
        </div>
        <div className="flex flex-col gap-0.5">
          {modeChoices.map((opt) => {
            const active = opt.value === activeMode;
            return (
              <button
                key={opt.value}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  void handleConfigChange("mode", opt.value);
                  closePopover(modePopoverRef, modePopoverOpen);
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
    </>
  );
}

/** Displays current thread context window consumption once tokens are used. */
export function ComposerContextUsageBadge() {
  const selectedThreadId = useThreadList((s) => s.selectedThreadId);
  const snapshot = useAcpStore((s) => selectEffectiveSnapshot(s, selectedThreadId));
  const contextUsage = formatContextPercent(snapshot?.usage);

  if (contextUsage.percent <= 0) return null;

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
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 px-1.5 text-[11px] font-medium tabular-nums transition-colors ${toneClass}`}
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
