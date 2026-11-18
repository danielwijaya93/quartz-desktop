"use client";

import type { DirectoryInspection } from "@/lib/acp/folders";
import type {
  AcpSessionMcpServer,
  AcpSessionSnapshot,
  GlobalMcpServerInfo,
  HistoricalAcpSession,
  ReplayedTranscriptMessage,
} from "@/lib/acp/types";
import {
  acpStore,
  getBootstrapThreadKey,
  selectEffectiveAgent,
  selectEffectiveOpenUI,
  useAcpStore,
} from "@/lib/client/acp-store";
import { importReplayedSessionToStorage, listStoredThreads } from "@/lib/client/local-storage";
import { useThreadList, type Thread } from "@openuidev/react-headless";
import { FolderPlus, Plus, Power, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

function ModalDialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const pressedOutsideRef = useRef(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Progressive enhancement fallback for browsers lacking native dialog `closedby="any"`
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || "closedBy" in HTMLDialogElement.prototype) return;

    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      );
    };

    const onDown = (e: PointerEvent) => {
      pressedOutsideRef.current = isOutside(e);
    };
    const onUp = (e: PointerEvent) => {
      if (pressedOutsideRef.current && isOutside(e)) {
        dialog.close();
      }
      pressedOutsideRef.current = false;
    };

    dialog.addEventListener("pointerdown", onDown);
    dialog.addEventListener("pointerup", onUp);
    return () => {
      dialog.removeEventListener("pointerdown", onDown);
      dialog.removeEventListener("pointerup", onUp);
    };
  }, []);

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      {...({ closedby: "any" } as Record<string, string>)}
      onClose={onClose}
      className="m-auto w-[min(92vw,680px)] max-h-[85vh] rounded-2xl border border-black/15 dark:border-white/15 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 p-0 shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-xs"
    >
      <div className="flex items-center justify-between border-b border-black/10 dark:border-white/10 px-5 py-3.5">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        <button
          type="button"
          onClick={() => ref.current?.close()}
          aria-label={`Close ${title}`}
          className="inline-flex min-h-[28px] min-w-[28px] items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/10"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="max-h-[calc(85vh-60px)] overflow-y-auto p-5">{children}</div>
    </dialog>
  );
}

export function AntigravityDialogs() {
  const activeModal = useAcpStore((s) => s.activeModal);
  const close = () => acpStore.setActiveModal(null);

  return (
    <>
      <McpManagerDialog open={activeModal === "mcp"} onClose={close} />
      <AddFolderDialog open={activeModal === "add-folder"} onClose={close} />
      <SessionHistoryDialog open={activeModal === "sessions"} onClose={close} />
    </>
  );
}

function McpManagerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const selectedThreadId = useThreadList((s) => s.selectedThreadId);
  const sessionMcpServers = useAcpStore((s) => s.sessionMcpServers);
  const [globalServers, setGlobalServers] = useState<GlobalMcpServerInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [type, setType] = useState<"stdio" | "http">("stdio");
  const [target, setTarget] = useState("");
  const [argsText, setArgsText] = useState("");
  const [scope, setScope] = useState<"global" | "session">("global");

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/mcp");
      const data = (await res.json()) as { servers?: GlobalMcpServerInfo[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to load MCP servers");
      setGlobalServers(data.servers ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load MCP servers");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  const handleGlobalAction = async (
    action: "enable" | "disable" | "remove",
    serverName: string,
  ) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, name: serverName }),
      });
      const data = (await res.json()) as { servers?: GlobalMcpServerInfo[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "MCP action failed");
      setGlobalServers(data.servers ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "MCP action failed");
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !target.trim()) return;
    setError(null);
    const parsedArgs = argsText
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (scope === "session") {
      const nextServer: AcpSessionMcpServer =
        type === "http"
          ? { name: name.trim(), type: "http", url: target.trim(), headers: [] }
          : { name: name.trim(), type: "stdio", command: target.trim(), args: parsedArgs, env: [] };
      const nextList = [
        ...sessionMcpServers.filter((s) => s.name !== nextServer.name),
        nextServer,
      ];
      acpStore.setPreferences({ sessionMcpServers: nextList });

      const currentState = acpStore.getState();
      const threadKey = selectedThreadId || getBootstrapThreadKey(currentState.activeFolderId);
      await fetch("/api/acp/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "updateWorkspace",
          threadId: threadKey,
          agent: selectEffectiveAgent(currentState, selectedThreadId),
          openuiEnabled: selectEffectiveOpenUI(currentState, selectedThreadId),
          cwd: currentState.cwd || undefined,
          additionalDirectories: currentState.additionalDirectories,
          mcpServers: nextList,
          mode: currentState.preferredMode || "auto",
        }),
      });
      setName("");
      setTarget("");
      setArgsText("");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add",
          name: name.trim(),
          type,
          commandOrUrl: target.trim(),
          args: parsedArgs,
        }),
      });
      const data = (await res.json()) as { servers?: GlobalMcpServerInfo[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to add MCP server");
      setGlobalServers(data.servers ?? []);
      setName("");
      setTarget("");
      setArgsText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add MCP server");
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalDialog open={open} title="MCP Servers (Antigravity CLI + Session)" onClose={onClose}>
      <div className="space-y-5 text-sm">
        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-semibold">Global `agy mcp` Servers</h3>
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              className="rounded-md border border-black/10 dark:border-white/15 px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
            >
              {loading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
          {globalServers.length === 0 ? (
            <p className="text-xs opacity-70">No global MCP servers configured.</p>
          ) : (
            <ul className="space-y-2">
              {globalServers.map((srv) => (
                <li
                  key={srv.name}
                  className="flex items-center justify-between gap-3 rounded-xl border border-black/10 dark:border-white/10 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-semibold">{srv.name}</span>
                      <span className="rounded bg-black/10 dark:bg-white/10 px-1.5 py-0.5 text-[10px] uppercase">
                        {srv.type}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${
                          srv.status === "enabled"
                            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                            : "bg-zinc-500/15 opacity-70"
                        }`}
                      >
                        {srv.status}
                      </span>
                    </div>
                    <div className="truncate font-mono text-xs opacity-70">{srv.target}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        handleGlobalAction(
                          srv.status === "enabled" ? "disable" : "enable",
                          srv.name,
                        )
                      }
                      aria-label={`${srv.status === "enabled" ? "Disable" : "Enable"} ${srv.name}`}
                      className="inline-flex min-h-[28px] min-w-[28px] items-center justify-center rounded-lg border border-black/10 dark:border-white/15 px-2 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                    >
                      <Power className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleGlobalAction("remove", srv.name)}
                      aria-label={`Remove ${srv.name}`}
                      className="inline-flex min-h-[28px] min-w-[28px] items-center justify-center rounded-lg border border-red-500/30 px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-500/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {sessionMcpServers.length > 0 && (
          <div>
            <h3 className="mb-2 font-semibold">Per-Session Injected MCP Servers</h3>
            <ul className="space-y-1.5">
              {sessionMcpServers.map((srv) => (
                <li
                  key={srv.name}
                  className="flex items-center justify-between rounded-xl border border-black/10 dark:border-white/10 px-3 py-2 text-xs"
                >
                  <div>
                    <span className="font-mono font-semibold">{srv.name}</span>{" "}
                    <span className="opacity-70">
                      ({srv.type}: {srv.url ?? `${srv.command} ${(srv.args ?? []).join(" ")}`})
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      acpStore.setPreferences({
                        sessionMcpServers: sessionMcpServers.filter((s) => s.name !== srv.name),
                      })
                    }
                    className="rounded border border-red-500/30 px-2 py-0.5 text-red-500"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <form onSubmit={handleAdd} className="space-y-3 border-t border-black/10 dark:border-white/10 pt-4">
          <h3 className="font-semibold">Add MCP Server</h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Server name (e.g. sqlite)"
              aria-label="MCP server name"
              className="rounded-lg border border-black/15 dark:border-white/15 bg-transparent px-2.5 py-1.5 text-xs"
            />
            <select
              value={type}
              onChange={(e) => setType(e.target.value === "http" ? "http" : "stdio")}
              aria-label="Transport type"
              className="rounded-lg border border-black/15 dark:border-white/15 bg-transparent px-2.5 py-1.5 text-xs"
            >
              <option value="stdio" className="bg-white dark:bg-zinc-900">stdio</option>
              <option value="http" className="bg-white dark:bg-zinc-900">http</option>
            </select>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value === "session" ? "session" : "global")}
              aria-label="Configuration scope"
              className="rounded-lg border border-black/15 dark:border-white/15 bg-transparent px-2.5 py-1.5 text-xs"
            >
              <option value="global" className="bg-white dark:bg-zinc-900">Global (agy mcp)</option>
              <option value="session" className="bg-white dark:bg-zinc-900">Session-only (ACP)</option>
            </select>
          </div>
          <input
            type="text"
            required
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={type === "http" ? "https://example.com/mcp" : "Command (e.g. npx)"}
            aria-label="Command or URL"
            className="w-full rounded-lg border border-black/15 dark:border-white/15 bg-transparent px-2.5 py-1.5 text-xs font-mono"
          />
          {type === "stdio" && (
            <input
              type="text"
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder="Space-separated arguments (e.g. -y @modelcontextprotocol/server-filesystem /work)"
              aria-label="Command arguments"
              className="w-full rounded-lg border border-black/15 dark:border-white/15 bg-transparent px-2.5 py-1.5 text-xs font-mono"
            />
          )}
          <button
            type="submit"
            disabled={loading}
            className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg bg-black px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add MCP Server
          </button>
        </form>
      </div>
    </ModalDialog>
  );
}

function AddFolderDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const existingFolders = useAcpStore((s) => s.folders);

  const [pathInput, setPathInput] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [trustedWorkspaces, setTrustedWorkspaces] = useState<string[]>([]);
  const [inspection, setInspection] = useState<DirectoryInspection | null>(null);
  const [trustInCli, setTrustInCli] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const pathId = useId();
  const helpId = useId();
  const errorId = useId();
  const labelId = useId();
  const trustId = useId();
  const pathRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setPathInput("");
    setLabelInput("");
    setInspection(null);
    setTrustInCli(true);
    setError(null);

    const ctrl = new AbortController();
    fetch("/api/folders", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { trustedWorkspaces?: string[] } | null) => {
        if (data?.trustedWorkspaces) {
          setTrustedWorkspaces(data.trustedWorkspaces);
        }
      })
      .catch(() => {});

    return () => ctrl.abort();
  }, [open]);

  const inspectPath = async (candidate: string, surfaceInvalid = false) => {
    const trimmed = candidate.trim();
    if (!trimmed) {
      setInspection(null);
      if (surfaceInvalid) {
        setError("Please enter a directory path.");
      }
      return;
    }

    try {
      const qs = new URLSearchParams({ path: trimmed });
      const res = await fetch(`/api/folders?${qs.toString()}`);
      if (!res.ok) return;
      const data = (await res.json()) as { inspection?: DirectoryInspection };
      if (data.inspection) {
        setInspection(data.inspection);
        if (data.inspection.valid) {
          setError(null);
        } else if (surfaceInvalid) {
          setError(data.inspection.error ?? "Directory not found.");
        }
      }
    } catch {
      // ignore aborted/transient inspect
    }
  };

  useEffect(() => {
    if (!open) return;
    const trimmed = pathInput.trim();
    if (!trimmed) {
      setInspection(null);
      return;
    }
    const timer = setTimeout(() => {
      void inspectPath(trimmed, false);
    }, 180);
    return () => clearTimeout(timer);
  }, [open, pathInput]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = pathInput.trim();
    if (!trimmed) {
      setError("Please enter a directory path.");
      pathRef.current?.focus();
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add",
          path: trimmed,
          trustInCli,
        }),
      });
      const data = (await res.json()) as {
        folder?: { cwd: string; name: string };
        inspection?: DirectoryInspection;
        error?: string;
      };
      if (!res.ok || !data.folder) {
        if (data.inspection) setInspection(data.inspection);
        setError(data.error ?? "Failed to add folder.");
        pathRef.current?.focus();
        return;
      }

      acpStore.addFolder({
        cwd: data.folder.cwd,
        name: labelInput.trim() || data.folder.name,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add folder.");
      pathRef.current?.focus();
    } finally {
      setSaving(false);
    }
  };

  const existingCwds = new Set(existingFolders.map((f) => f.cwd));

  return (
    <ModalDialog open={open} title="Add Workspace Folder" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4 text-sm" noValidate>
        <div>
          <label htmlFor={pathId} className="mb-1 block text-xs font-semibold">
            Directory Path
          </label>
          <p id={helpId} className="mb-1.5 text-[11px] opacity-70">
            Enter an existing local folder path (supports <code className="font-mono">~/...</code>).
            Removing a folder only removes it from the sidebar and never deletes files on disk.
          </p>
          <input
            ref={pathRef}
            id={pathId}
            name="folderPath"
            type="text"
            value={pathInput}
            onChange={(e) => {
              setPathInput(e.target.value);
              if (error) setError(null);
            }}
            onBlur={() => {
              if (pathInput.trim()) void inspectPath(pathInput, true);
            }}
            aria-describedby={error ? `${helpId} ${errorId}` : helpId}
            aria-invalid={error ? "true" : undefined}
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="done"
            required
            placeholder="/home/danielwijaya/my-project"
            className="w-full rounded-lg border border-black/15 dark:border-white/15 bg-transparent px-3 py-2 font-mono text-xs"
          />
          {error && (
            <div
              id={errorId}
              role="alert"
              className="mt-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-600 dark:text-red-400"
            >
              {error}
            </div>
          )}
        </div>

        <div>
          <label htmlFor={labelId} className="mb-1 block text-xs font-semibold">
            Sidebar Label (optional)
          </label>
          <input
            id={labelId}
            name="folderLabel"
            type="text"
            value={labelInput}
            onChange={(e) => setLabelInput(e.target.value)}
            placeholder={inspection?.defaultName || "Defaults to folder name"}
            className="w-full rounded-lg border border-black/15 dark:border-white/15 bg-transparent px-3 py-2 text-xs"
          />
        </div>

        {inspection?.valid && !inspection.inTrustedWorkspaces && (
          <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2.5">
            <input
              id={trustId}
              type="checkbox"
              checked={trustInCli}
              onChange={(e) => setTrustInCli(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-black dark:accent-white"
            />
            <label htmlFor={trustId} className="text-xs leading-relaxed">
              <span className="font-medium">
                Also add to Antigravity CLI <code className="font-mono">trustedWorkspaces</code>
              </span>
              <span className="mt-0.5 block opacity-75">
                This folder is not in <code className="font-mono">trustedWorkspaces</code> yet.
                Adding it avoids repeated trust prompts if you open it in <code className="font-mono">agy</code> CLI later.
              </span>
            </label>
          </div>
        )}

        {trustedWorkspaces.length > 0 && (
          <div>
            <div className="mb-1.5 text-xs font-semibold opacity-80">
              Trusted Antigravity Folders
            </div>
            <div className="flex flex-wrap gap-1.5">
              {trustedWorkspaces.map((dir) => {
                const alreadyAdded = existingCwds.has(dir);
                return (
                  <button
                    key={dir}
                    type="button"
                    onClick={() => {
                      setPathInput(dir);
                      setError(null);
                      void inspectPath(dir, true);
                    }}
                    className={`inline-flex min-h-[28px] max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1 text-left font-mono text-[11px] transition-colors ${
                      alreadyAdded
                        ? "border-black/10 dark:border-white/10 opacity-60 hover:opacity-100"
                        : "border-black/15 dark:border-white/15 hover:bg-black/5 dark:hover:bg-white/10"
                    }`}
                  >
                    <FolderPlus className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
                    <span className="truncate">{dir}</span>
                    {alreadyAdded && <span className="shrink-0 opacity-60">(added)</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[32px] rounded-lg border border-black/15 dark:border-white/15 px-3 py-1.5 text-xs"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="min-h-[32px] rounded-lg bg-black px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black disabled:opacity-50"
          >
            {saving ? "Adding..." : "Add Folder"}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

function SessionHistoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cwd = useAcpStore((s) => s.cwd);
  const hiddenThreadIds = useAcpStore((s) => s.hiddenThreadIds);
  const selectThread = useThreadList((s) => s.selectThread);
  const loadThreads = useThreadList((s) => s.loadThreads);

  const [sessions, setSessions] = useState<HistoricalAcpSession[]>([]);
  const [hiddenLocalThreads, setHiddenLocalThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(false);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    const hiddenSet = new Set(hiddenThreadIds);
    setHiddenLocalThreads(listStoredThreads().filter((t) => hiddenSet.has(t.id)));

    const qs = new URLSearchParams({ action: "list", ...(cwd ? { cwd } : {}) });
    fetch(`/api/acp/session?${qs.toString()}`)
      .then((r) => r.json())
      .then((data: { sessions?: HistoricalAcpSession[]; error?: string }) => {
        if (data.error) setError(data.error);
        setSessions(data.sessions ?? []);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load sessions"))
      .finally(() => setLoading(false));
  }, [open, cwd, hiddenThreadIds]);

  const handleRestoreHidden = (thread: Thread) => {
    acpStore.restoreHiddenThread(thread.id);
    selectThread(thread.id);
    onClose();
  };

  const handleResume = async (s: HistoricalAcpSession) => {
    setResumingId(s.sessionId);
    setError(null);
    try {
      const threadId = crypto.randomUUID();
      const res = await fetch("/api/acp/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "loadSession",
          threadId,
          acpSessionId: s.sessionId,
          appDataDir: s.appDataDir,
          cwd: s.cwd,
          additionalDirectories: s.additionalDirectories,
          mcpServers: acpStore.getState().sessionMcpServers,
        }),
      });
      const data = (await res.json()) as {
        snapshot?: AcpSessionSnapshot;
        messages?: ReplayedTranscriptMessage[];
        error?: string;
      };
      if (!res.ok || !data.snapshot) {
        throw new Error(data.error ?? "Failed to resume session");
      }
      await importReplayedSessionToStorage({
        threadId,
        title: s.title ?? "Resumed Session",
        snapshot: data.snapshot,
        messages: data.messages ?? [],
      });
      await loadThreads();
      selectThread(threadId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resume session");
    } finally {
      setResumingId(null);
    }
  };

  return (
    <ModalDialog open={open} title="Antigravity CLI & ACP Sessions" onClose={onClose}>
      <div className="space-y-4 text-sm">
        {hiddenLocalThreads.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-semibold opacity-75">
              Removed from Sidebar (Preserved Local History)
            </h3>
            <ul className="space-y-1.5">
              {hiddenLocalThreads.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-black/10 dark:border-white/10 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium">{t.title}</div>
                    <div className="truncate font-mono text-[11px] opacity-60">
                      {new Date(t.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRestoreHidden(t)}
                    className="inline-flex min-h-[28px] shrink-0 items-center gap-1 rounded-lg border border-black/15 dark:border-white/15 px-2.5 py-1 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/10"
                  >
                    <RotateCcw className="h-3 w-3" aria-hidden="true" />
                    <span>Restore</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-3">
          {error && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
          {loading ? (
            <p className="text-xs opacity-70">Loading Antigravity sessions...</p>
          ) : sessions.length === 0 ? (
            <p className="text-xs opacity-70">No sessions found for this workspace.</p>
          ) : (
            <ul className="space-y-2">
              {sessions.map((s) => (
                <li
                  key={s.sessionId}
                  className="flex items-center justify-between gap-3 rounded-xl border border-black/10 dark:border-white/10 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="truncate font-medium">{s.title || "Untitled Session"}</span>
                      {s.appDataDir && (
                        <span className="shrink-0 rounded border border-black/10 dark:border-white/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wider opacity-70">
                          {s.appDataDir === "antigravity" ? "App" : "CLI"}
                        </span>
                      )}
                    </div>
                    <div className="truncate font-mono text-[11px] opacity-65">
                      {s.cwd} • {s.updatedAt ? new Date(s.updatedAt).toLocaleString() : s.sessionId}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={resumingId === s.sessionId}
                    onClick={() => handleResume(s)}
                    className="shrink-0 rounded-lg bg-black px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black"
                  >
                    {resumingId === s.sessionId ? "Loading..." : "Resume"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </ModalDialog>
  );
}
