"use client";

import type { AcpPlanEntry, PendingPermissionRequest } from "@/lib/acp/types";
import { Check, ShieldAlert, X } from "lucide-react";

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
                      ? "text-amber-500"
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
                          ? "inline-flex min-h-[30px] items-center gap-1 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-500/20"
                          : "inline-flex min-h-[30px] items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500"
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
