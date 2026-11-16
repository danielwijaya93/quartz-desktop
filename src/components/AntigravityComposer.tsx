"use client";

import type { AcpCommand, PendingPermissionRequest } from "@/lib/acp/types";
import type { WorkspaceFileEntry } from "@/lib/acp/workspace";
import {
  acpStore,
  getActivePendingPermissions,
  getMergedSlashCommands,
  selectEffectiveSnapshot,
  useAcpStore,
} from "@/lib/client/acp-store";
import { useThread, useThreadList } from "@openuidev/react-headless";
import {
  ArrowUp,
  Check,
  FileCode2,
  ImagePlus,
  ShieldAlert,
  Slash,
  Sparkles,
  Square,
  Terminal,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";

interface AcpComposerProps {
  placeholder?: string;
}

type AutocompleteMode =
  | { kind: "slash"; query: string }
  | { kind: "file"; query: string; startIndex: number; endIndex: number }
  | null;

function detectAutocomplete(value: string, caret: number): AutocompleteMode {
  const before = value.slice(0, caret);

  // `/` command autocomplete at start of composer
  const slashMatch = /^\/([^\s]*)$/.exec(before);
  if (slashMatch) {
    return { kind: "slash", query: slashMatch[1] ?? "" };
  }

  // `@file` autocomplete anywhere after whitespace or start
  const fileMatch = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (fileMatch) {
    const query = fileMatch[1] ?? "";
    const startIndex = before.lastIndexOf("@");
    return { kind: "file", query, startIndex, endIndex: caret };
  }

  return null;
}

export function AntigravityComposer({
  placeholder = "Ask anything, type / for commands & skills, @ for files, or ! for shell...",
}: AcpComposerProps) {
  const [textContent, setTextContent] = useState("");
  const processMessage = useThread((s) => s.processMessage);
  const cancelMessage = useThread((s) => s.cancelMessage);
  const isRunning = useThread((s) => s.isRunning);
  const isLoadingMessages = useThread((s) => s.isLoadingMessages);
  const selectedThreadId = useThreadList((s) => s.selectedThreadId);
  const switchToNewThread = useThreadList((s) => s.switchToNewThread);

  const snapshot = useAcpStore((s) => selectEffectiveSnapshot(s, selectedThreadId));
  const cwd = useAcpStore((s) => s.cwd);
  const additionalDirectories = useAcpStore((s) => s.additionalDirectories);
  const attachments = useAcpStore((s) => s.attachments);

  const commands = useMemo(() => getMergedSlashCommands(snapshot), [snapshot]);
  const pendingPermissions = useMemo(
    () => getActivePendingPermissions(snapshot),
    [snapshot],
  );
  const planEntries = snapshot?.plan ?? [];

  const [caret, setCaret] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [commandFilter, setCommandFilter] = useState<"all" | "skill" | "commands">("all");
  const [dismissedAtText, setDismissedAtText] = useState<string | null>(null);
  const [fileResults, setFileResults] = useState<WorkspaceFileEntry[]>([]);
  const [resolvingPermId, setResolvingPermId] = useState<string | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  const autocomplete = useMemo(() => {
    if (dismissedAtText === textContent) return null;
    return detectAutocomplete(textContent, caret);
  }, [textContent, caret, dismissedAtText]);

  const skillCount = useMemo(
    () => commands.filter((c) => (c.category ?? "skill") === "skill").length,
    [commands],
  );

  const filteredCommands = useMemo(() => {
    if (autocomplete?.kind !== "slash") return [];
    const q = autocomplete.query.toLowerCase();
    return commands.filter((c) => {
      const cat = c.category ?? "skill";
      if (commandFilter === "skill" && cat !== "skill") return false;
      if (commandFilter === "commands" && cat === "skill") return false;
      return (
        !q ||
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        cat.toLowerCase().includes(q)
      );
    });
  }, [autocomplete, commands, commandFilter]);

  useEffect(() => {
    if (autocomplete?.kind !== "file") {
      setFileResults([]);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      const qs = new URLSearchParams({
        q: autocomplete.query,
        ...(cwd ? { cwd } : {}),
        ...(additionalDirectories.length ? { dirs: additionalDirectories.join(",") } : {}),
      });
      fetch(`/api/files?${qs.toString()}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : { files: [] }))
        .then((data: { files?: WorkspaceFileEntry[] }) => {
          setFileResults((data.files ?? []).slice(0, 12));
        })
        .catch(() => {});
    }, 90);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [autocomplete, cwd, additionalDirectories]);

  const activeItems =
    autocomplete?.kind === "slash"
      ? filteredCommands
      : autocomplete?.kind === "file"
        ? fileResults
        : [];

  useEffect(() => {
    setSelectedIndex(0);
  }, [autocomplete?.kind, autocomplete?.query, commandFilter]);

  const openSlashMenu = useCallback(
    (filter: "all" | "skill" | "commands") => {
      if (autocomplete?.kind === "slash" && commandFilter === filter) {
        setTextContent(textContent === "/" ? "" : textContent);
        setDismissedAtText(textContent);
        setCommandFilter("all");
        return;
      }
      setCommandFilter(filter);
      setDismissedAtText(null);
      const nextText = textContent.startsWith("/") ? textContent : "/";
      if (nextText !== textContent) {
        setTextContent(nextText);
      }
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        setCaret(nextText.length);
      });
    },
    [autocomplete?.kind, commandFilter, textContent],
  );

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.max(el.scrollHeight, 32)}px`;
  }, [textContent]);

  const executeLocalAppCommand = useCallback(
    (trimmed: string): boolean => {
      if (trimmed === "/clear" || trimmed === "/new") {
        switchToNewThread();
        setTextContent("");
        return true;
      }
      if (trimmed === "/mcp") {
        acpStore.setActiveModal("mcp");
        setTextContent("");
        return true;
      }
      if (trimmed === "/sessions" || trimmed === "/resume") {
        acpStore.setActiveModal("sessions");
        setTextContent("");
        return true;
      }
      if (trimmed === "/workspace" || trimmed === "/dir") {
        acpStore.setActiveModal("add-folder");
        setTextContent("");
        return true;
      }
      return false;
    },
    [switchToNewThread, setTextContent],
  );

  const handleSelectCommand = useCallback(
    (cmd: AcpCommand) => {
      if (cmd.category === "app" && cmd.name !== "usage") {
        executeLocalAppCommand(`/${cmd.name}`);
        return;
      }
      const next = `/${cmd.name} `;
      setTextContent(next);
      setDismissedAtText(next);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(next.length, next.length);
        setCaret(next.length);
      });
    },
    [executeLocalAppCommand, setTextContent],
  );

  const handleSelectFile = useCallback(
    (file: WorkspaceFileEntry) => {
      if (autocomplete?.kind !== "file") return;
      const before = textContent.slice(0, autocomplete.startIndex);
      const after = textContent.slice(autocomplete.endIndex);
      const inserted = `@${file.label} `;
      const next = `${before}${inserted}${after}`;
      const nextCaret = before.length + inserted.length;
      setTextContent(next);
      setDismissedAtText(next);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(nextCaret, nextCaret);
        setCaret(nextCaret);
      });
    },
    [autocomplete, textContent, setTextContent],
  );

  const handleSubmit = useCallback(() => {
    const trimmed = textContent.trim();
    if ((!trimmed && attachments.length === 0) || isRunning || isLoadingMessages) {
      return;
    }
    if (executeLocalAppCommand(trimmed)) {
      return;
    }
    void processMessage({
      role: "user",
      content: trimmed || "Analyze the attached image(s).",
    });
    setTextContent("");
    setDismissedAtText(null);
  }, [
    textContent,
    attachments.length,
    isRunning,
    isLoadingMessages,
    executeLocalAppCommand,
    processMessage,
    setTextContent,
  ]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (activeItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % activeItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + activeItems.length) % activeItems.length);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedAtText(textContent);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const picked = activeItems[selectedIndex];
        if (picked) {
          if (autocomplete?.kind === "slash") {
            const cmd = picked as AcpCommand;
            if (cmd.category === "app" && cmd.name !== "usage") {
              executeLocalAppCommand(`/${cmd.name}`);
            } else if (e.key === "Enter" && !cmd.inputHint && cmd.name === "compact") {
              setTextContent("");
              void processMessage({ role: "user", content: "/compact" });
            } else if (e.key === "Enter" && cmd.name === "usage") {
              setTextContent("");
              void processMessage({ role: "user", content: "/usage" });
            } else {
              handleSelectCommand(cmd);
            }
          } else {
            handleSelectFile(picked as WorkspaceFileEntry);
          }
        }
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const attachFiles = useCallback((files: FileList | File[] | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        const base64 = result.includes(",") ? result.split(",")[1] ?? "" : result;
        if (base64) {
          acpStore.addAttachment({
            id: crypto.randomUUID(),
            name: file.name,
            mimeType: file.type,
            data: base64,
          });
        }
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.files;
    if (items && items.length > 0) {
      attachFiles(items);
    }
  };

  const handlePermissionDecision = async (
    perm: PendingPermissionRequest,
    optionId: string | null,
  ) => {
    setResolvingPermId(perm.requestId);
    try {
      await fetch("/api/acp/permission", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: perm.requestId,
          optionId,
          cancel: optionId === null,
        }),
      });
      acpStore.removePendingPermission(perm.threadId, perm.requestId);
    } finally {
      setResolvingPermId(null);
    }
  };

  const isShellCommand = textContent.trimStart().startsWith("!");

  return (
    <div className="openui-agent-composer-slot flex flex-col gap-2">
      {/* Live Plan Progress Strip */}
      {planEntries.length > 0 && (
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
      )}

      {/* Pending ACP Permission Requests */}
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
                      onClick={() => handlePermissionDecision(perm, opt.optionId)}
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

      {/* Autocomplete Menu (Slash Commands / Skills / Files) */}
      {autocomplete && (activeItems.length > 0 || autocomplete.kind === "slash") && (
        <div className="mx-auto w-full max-w-[760px] px-4">
          <div className="rounded-xl border border-black/15 dark:border-white/15 bg-white dark:bg-zinc-900 p-1.5 shadow-xl">
            {autocomplete.kind === "slash" && (
              <div className="mb-1 flex items-center justify-between gap-2 border-b border-black/10 dark:border-white/10 px-2 pb-1.5 text-[11px]">
                <div className="flex items-center gap-1">
                  {(
                    [
                      { id: "all", label: `All (${commands.length})` },
                      { id: "skill", label: `Skills (${skillCount})` },
                      { id: "commands", label: `Commands (${commands.length - skillCount})` },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setCommandFilter(tab.id);
                      }}
                      className={`rounded-md px-2 py-0.5 font-medium transition-colors ${
                        commandFilter === tab.id
                          ? "bg-black text-white dark:bg-white dark:text-black"
                          : "opacity-70 hover:bg-black/5 dark:hover:bg-white/10 hover:opacity-100"
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <span className="opacity-55">
                  {filteredCommands.length} shown
                </span>
              </div>
            )}

            <div
              id={listboxId}
              role="listbox"
              aria-label={
                autocomplete.kind === "slash" ? "Slash commands and skills" : "Workspace files"
              }
              className="max-h-64 overflow-y-auto"
            >
              {autocomplete.kind === "slash" ? (
                filteredCommands.length > 0 ? (
                  (activeItems as AcpCommand[]).map((cmd, idx) => {
                    const active = idx === selectedIndex;
                    return (
                      <button
                        key={cmd.name}
                        type="button"
                        role="option"
                        aria-selected={active}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setCommandFilter("all");
                          handleSelectCommand(cmd);
                        }}
                        className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                          active
                            ? "bg-black/10 dark:bg-white/15"
                            : "hover:bg-black/5 dark:hover:bg-white/10"
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Slash className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
                          <span className="shrink-0 whitespace-nowrap font-mono font-semibold">
                            /{cmd.name}
                          </span>
                          <span className="truncate opacity-70">{cmd.description}</span>
                        </div>
                        <span className="shrink-0 rounded-md border border-black/10 dark:border-white/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wider opacity-75">
                          {cmd.category ?? "skill"}
                        </span>
                      </button>
                    );
                  })
                ) : (
                  <div className="px-2.5 py-3 text-center text-xs opacity-60">
                    No matching items
                    {commandFilter !== "all" ? " in this tab" : ""}.
                  </div>
                )
              ) : (
                (activeItems as WorkspaceFileEntry[]).map((file, idx) => {
                  const active = idx === selectedIndex;
                  return (
                    <button
                      key={file.path}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleSelectFile(file);
                      }}
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                        active
                          ? "bg-black/10 dark:bg-white/15"
                          : "hover:bg-black/5 dark:hover:bg-white/10"
                      }`}
                    >
                      <FileCode2 className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
                      <span className="truncate font-mono">{file.label}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main Composer Input Box */}
      <div
        className="openui-agent-thread-composer"
        data-drafting={textContent.length > 0 || undefined}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("button, a, [role='button']")) {
            inputRef.current?.focus();
          }
        }}
      >
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-2">
            {attachments.map((att) => (
              <span
                key={att.id}
                className="inline-flex items-center gap-1.5 rounded-lg border border-black/15 dark:border-white/15 px-2 py-1 text-xs"
              >
                <span className="max-w-[160px] truncate">{att.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${att.name}`}
                  onClick={() => acpStore.removeAttachment(att.id)}
                  className="opacity-70 hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="openui-agent-thread-composer__input-wrapper antigravity-composer-stack">
          <textarea
            ref={inputRef}
            value={textContent}
            rows={1}
            placeholder={placeholder}
            aria-label="Message input"
            aria-autocomplete="list"
            aria-controls={
              autocomplete && (activeItems.length > 0 || autocomplete.kind === "slash")
                ? listboxId
                : undefined
            }
            className="openui-agent-thread-composer__input"
            onChange={(e) => {
              const nextVal = e.target.value;
              setTextContent(nextVal);
              setCaret(e.target.selectionStart ?? nextVal.length);
              setDismissedAtText(null);
              if (!nextVal.startsWith("/")) {
                setCommandFilter("all");
              }
            }}
            onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />

          <div className="openui-agent-thread-composer__action-bar flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  attachFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                aria-label="Attach image"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex min-h-[28px] min-w-[28px] items-center justify-center rounded-lg border border-black/10 dark:border-white/10 px-2 py-1 opacity-75 hover:opacity-100"
              >
                <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
              </button>

              <button
                type="button"
                onClick={() => openSlashMenu("all")}
                className="inline-flex min-h-[28px] items-center gap-1 rounded-lg border border-black/10 dark:border-white/10 px-2 py-1 opacity-75 hover:opacity-100"
              >
                <Slash className="h-3 w-3" aria-hidden="true" />
                <span>Commands</span>
              </button>

              <button
                type="button"
                onClick={() => openSlashMenu("skill")}
                className={`inline-flex min-h-[28px] items-center gap-1 rounded-lg border px-2 py-1 ${
                  autocomplete?.kind === "slash" && commandFilter === "skill"
                    ? "border-black/30 bg-black/10 dark:border-white/30 dark:bg-white/15 opacity-100"
                    : "border-black/10 dark:border-white/10 opacity-75 hover:opacity-100"
                }`}
              >
                <Sparkles className="h-3 w-3" aria-hidden="true" />
                <span>Skills{skillCount > 0 ? ` (${skillCount})` : ""}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  const next = textContent.startsWith("!") ? textContent : `!${textContent}`;
                  setTextContent(next);
                  requestAnimationFrame(() => inputRef.current?.focus());
                }}
                className={`inline-flex min-h-[28px] items-center gap-1 rounded-lg border px-2 py-1 ${
                  isShellCommand
                    ? "border-amber-500/50 bg-amber-500/15 text-amber-600 dark:text-amber-300"
                    : "border-black/10 dark:border-white/10 opacity-75 hover:opacity-100"
                }`}
              >
                <Terminal className="h-3 w-3" aria-hidden="true" />
                <span>Shell</span>
              </button>
            </div>

            <button
              type="button"
              onClick={isRunning ? cancelMessage : handleSubmit}
              aria-label={isRunning ? "Cancel generation" : "Send message"}
              className="openui-agent-thread-composer__submit-button inline-flex min-h-[32px] min-w-[32px] items-center justify-center rounded-full bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
              disabled={!isRunning && !textContent.trim() && attachments.length === 0}
            >
              {isRunning ? (
                <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
              ) : (
                <ArrowUp className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
