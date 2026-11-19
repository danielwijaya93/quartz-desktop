"use client";

import type { AcpBackgroundTask, AcpPlanEntry, PendingPermissionRequest } from "@/lib/acp/types";
import { Check, Loader2, ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";

function formatElapsed(startedAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

/** Renders active background tasks (e.g. long-running commands/subagents) above the composer. */
export function BackgroundTasksStrip({ tasks }: { tasks: AcpBackgroundTask[] }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (tasks.length === 0) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [tasks.length]);

  if (tasks.length === 0) return null;

  return (
    <div className="mx-auto w-full max-w-[760px] px-4">
      <div
        role="status"
        aria-live="polite"
        className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs"
      >
        <div className="mb-1 flex items-center justify-between font-medium opacity-85">
          <span className="flex items-center gap-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" aria-hidden="true" />
            <span>{tasks.length === 1 ? "Background Task Running" : "Background Tasks Running"}</span>
          </span>
          <span className="tabular-nums opacity-65">{tasks.length}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {tasks.map((task) => (
            <span
              key={task.id}
              title={task.label}
              className="inline-flex items-center gap-1.5 rounded-md border border-black/10 dark:border-white/10 bg-white/60 dark:bg-zinc-900/60 px-2 py-0.5"
            >
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500 motion-safe:animate-pulse"
              />
              <span className="max-w-[260px] truncate font-mono text-[11px]">{task.label}</span>
              <span className="shrink-0 tabular-nums text-[10px] opacity-55">
                {formatElapsed(task.startedAt, now)}
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Renders the live ACP execution plan progress strip above the composer. */
export function PlanProgressStrip({ planEntries }: { planEntries: AcpPlanEntry[] }) {
  if (planEntries.length === 0) return null;

  return (
    <div className="mx-auto w-full max-w-[760px] px-4">
      <div className="rounded-xl border border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.04] px-3 py-2 text-xs">
        <div className="mb-1 flex items-center justify-between font-medium opacity-80">
          <span>Execution Plan</span>
          <span>
            {planEntries.filter((p) => p.status === "completed").length}/{planEntries.length}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {planEntries.map((entry, idx) => (
            <span
              key={`${entry.content}-${idx}`}
              className="inline-flex items-center gap-1 rounded-md border border-black/10 dark:border-white/10 px-2 py-0.5"
            >
              <span
                aria-hidden="true"
                className={
                  entry.status === "completed"
                    ? "text-emerald-500"
                    : entry.status === "in_progress"
                      ? "text-amber-500 motion-safe:animate-pulse"
                      : "opacity-50"
                }
              >
                {entry.status === "completed"
                  ? "✓"
                  : entry.status === "in_progress"
                    ? "●"
                    : "○"}
              </span>
              <span className="max-w-[240px] truncate">{entry.content}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Renders pending ACP tool permission approval cards above the composer. */
export function PendingPermissionsBanner({
  pendingPermissions,
  resolvingPermId,
  onDecision,
}: {
  pendingPermissions: PendingPermissionRequest[];
  resolvingPermId: string | null;
  onDecision: (perm: PendingPermissionRequest, optionId: string | null) => void;
}) {
  if (pendingPermissions.length === 0) return null;

  return (
    <>
      {pendingPermissions.map((perm) => (
        <div key={perm.requestId} className="mx-auto w-full max-w-[760px] px-4">
          <div
            role="region"
            aria-label="Tool Permission Request"
            className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3.5 py-2.5 text-sm shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2 min-w-0">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
                <div className="min-w-0">
                  <div className="font-semibold">
                    Permission Required:{" "}
                    {perm.toolCall.name ?? perm.toolCall.title ?? "Tool Action"}
                  </div>
                  {perm.toolCall.title && (
                    <div className="truncate text-xs opacity-80 font-mono">
                      {perm.toolCall.title}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                {perm.options.map((opt) => {
                  const isReject = opt.kind.startsWith("reject");
                  return (
                    <button
                      key={opt.optionId}
                      type="button"
                      disabled={resolvingPermId === perm.requestId}
                      onClick={() => onDecision(perm, opt.optionId)}
                      className={
                        isReject
                          ? "inline-flex min-h-[30px] items-center gap-1 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 cursor-pointer disabled:opacity-50"
                          : "inline-flex min-h-[30px] items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 cursor-pointer disabled:opacity-50"
                      }
                    >
                      {isReject ? <X className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                      {opt.name}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
