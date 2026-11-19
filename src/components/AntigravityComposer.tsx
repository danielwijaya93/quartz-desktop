"use client";

import {
  ComposerConfigControls,
  ComposerContextUsageBadge,
} from "@/components/ComposerControls";
import {
  PendingPermissionsBanner,
  PlanProgressStrip,
} from "@/components/ComposerOverlays";
import {
  classifyAttachmentKind,
  formatFileSize,
  inferMimeType,
  MAX_ATTACHMENT_BYTES,
} from "@/lib/acp/attachments";
import type {
  AcpCommand,
  PendingPermissionRequest,
  UserMessageAttachmentMeta,
} from "@/lib/acp/types";
import type { WorkspaceFileEntry } from "@/lib/acp/workspace";
import {
  acpStore,
  getActivePendingPermissions,
  getBootstrapThreadKey,
  getMergedSlashCommands,
  selectEffectiveSnapshot,
  useAcpStore,
  type ComposerAttachment,
} from "@/lib/client/acp-store";
import { useThread, useThreadList } from "@openuidev/react-headless";
import {
  ArrowUp,
  FileCode2,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Paperclip,
  Slash,
  Square,
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
  type DragEvent,
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
  const activeFolderId = useAcpStore((s) => s.activeFolderId);
  const effectiveThreadId = selectedThreadId || getBootstrapThreadKey(activeFolderId);
  const cwd = useAcpStore((s) => s.cwd);
  const additionalDirectories = useAcpStore((s) => s.additionalDirectories);
  const attachments = useAcpStore((s) => s.attachments);
  const activeModal = useAcpStore((s) => s.activeModal);
  const queuedMessages = useAcpStore((s) => s.queuedMessages[effectiveThreadId]);
  const queued = useMemo(() => queuedMessages ?? [], [queuedMessages]);

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
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);

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

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const syncHeight = () => {
      const maxHeight =
        typeof window !== "undefined"
          ? Math.max(96, Math.min(200, Math.round(window.innerHeight * 0.35)))
          : 200;
      el.style.height = "auto";
      const naturalHeight = Math.max(el.scrollHeight, 32);
      const clampedHeight = Math.min(naturalHeight, maxHeight);
      el.style.height = `${clampedHeight}px`;
      el.style.overflowY = naturalHeight > maxHeight ? "auto" : "hidden";
    };
    syncHeight();
    window.addEventListener("resize", syncHeight);
    return () => window.removeEventListener("resize", syncHeight);
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

  const dispatchUserMessage = useCallback(
    (text: string, msgAttachments: ComposerAttachment[]) => {
      const messageAttachments: UserMessageAttachmentMeta[] = msgAttachments.map((att) => ({
        id: att.id,
        name: att.name,
        mimeType: att.mimeType,
        size: att.size,
        kind: att.kind,
        ...(att.kind === "image" && att.data ? { data: att.data } : {}),
      }));
      if (msgAttachments.length > 0) {
        acpStore.setAttachments(msgAttachments);
      }
      void processMessage({
        role: "user",
        content: text || "Analyze the attached file(s).",
        ...(messageAttachments.length > 0 ? { attachments: messageAttachments } : {}),
      } as Parameters<typeof processMessage>[0]);
    },
    [processMessage],
  );

  const handleCancel = useCallback(() => {
    const cleared = acpStore.clearQueuedMessages(effectiveThreadId);
    if (cleared.length > 0 && !textContent.trim() && attachments.length === 0) {
      const first = cleared[0]!;
      setTextContent(first.text);
      if (first.attachments.length > 0) {
        acpStore.setAttachments(first.attachments);
      }
    }
    if (selectedThreadId) {
      void fetch("/api/acp/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", threadId: selectedThreadId }),
      }).catch(() => {});
    }
    cancelMessage();
  }, [effectiveThreadId, selectedThreadId, textContent, attachments.length, cancelMessage]);

  const handleSubmit = useCallback(() => {
    const trimmed = textContent.trim();
    if ((!trimmed && attachments.length === 0) || isLoadingMessages) {
      return;
    }
    if (isRunning) {
      acpStore.enqueueMessage(effectiveThreadId, {
        text: trimmed,
        attachments: [...attachments],
      });
      setTextContent("");
      setDismissedAtText(null);
      if (attachments.length > 0) {
        acpStore.setAttachments([]);
      }
      return;
    }
    if (executeLocalAppCommand(trimmed)) {
      return;
    }
    dispatchUserMessage(trimmed, attachments);
    setTextContent("");
    setDismissedAtText(null);
  }, [
    textContent,
    attachments,
    isRunning,
    isLoadingMessages,
    effectiveThreadId,
    executeLocalAppCommand,
    dispatchUserMessage,
    setTextContent,
  ]);

  const wasRunningRef = useRef(false);
  const runningThreadIdRef = useRef<string | null>(null);
  if (isRunning) {
    runningThreadIdRef.current = effectiveThreadId;
  }
  useEffect(() => {
    const wasRunning = wasRunningRef.current;
    wasRunningRef.current = isRunning;
    if (wasRunning && !isRunning && !isLoadingMessages) {
      const finishedThreadId = runningThreadIdRef.current;
      runningThreadIdRef.current = null;
      if (finishedThreadId && finishedThreadId === effectiveThreadId) {
        const next = acpStore.dequeueMessage(effectiveThreadId);
        if (next) {
          dispatchUserMessage(next.text, next.attachments);
        }
      }
    }
  }, [isRunning, isLoadingMessages, effectiveThreadId, dispatchUserMessage]);

  useEffect(() => {
    if (!isRunning || activeModal !== null) return;
    const onWindowKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        handleCancel();
      }
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [isRunning, activeModal, handleCancel]);

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
    setAttachmentError(null);
    for (const file of Array.from(files)) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setAttachmentError(
          `"${file.name}" (${formatFileSize(file.size)}) exceeds the 10 MB per-file limit.`,
        );
        continue;
      }
      const mimeType = inferMimeType(file.name, file.type);
      const kind = classifyAttachmentKind(file.name, mimeType);
      const reader = new FileReader();

      if (kind === "text") {
        reader.onload = () => {
          const text = typeof reader.result === "string" ? reader.result : "";
          acpStore.addAttachment({
            id: crypto.randomUUID(),
            name: file.name,
            mimeType,
            size: file.size,
            kind: "text",
            text,
          });
        };
        reader.readAsText(file);
      } else {
        reader.onload = () => {
          const result = typeof reader.result === "string" ? reader.result : "";
          const base64 = result.includes(",") ? result.split(",")[1] ?? "" : result;
          if (base64) {
            acpStore.addAttachment({
              id: crypto.randomUUID(),
              name: file.name,
              mimeType,
              size: file.size,
              kind,
              data: base64,
            });
          }
        };
        reader.readAsDataURL(file);
      }
    }
  }, []);

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
      if (!isDraggingFiles) setIsDraggingFiles(true);
    }
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setIsDraggingFiles(false);
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      e.preventDefault();
      setIsDraggingFiles(false);
      attachFiles(e.dataTransfer.files);
    }
  };

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

  return (
    <div className="openui-agent-composer-slot flex flex-col gap-2">
      <PlanProgressStrip planEntries={planEntries} />

      <PendingPermissionsBanner
        pendingPermissions={pendingPermissions}
        resolvingPermId={resolvingPermId}
        onDecision={handlePermissionDecision}
      />

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
        className={`openui-agent-thread-composer ${
          isDraggingFiles ? "ring-2 ring-blue-500/60 rounded-2xl" : ""
        }`}
        data-drafting={textContent.length > 0 || undefined}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={(e) => {
          if (
            !(e.target as HTMLElement).closest(
              "button, a, select, label, [role='button'], [data-composer-popover]",
            )
          ) {
            inputRef.current?.focus();
          }
        }}
      >
        {queued.length > 0 && (
          <div className="mx-3 mt-2 flex flex-col gap-1">
            {queued.map((item, idx) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.04] px-2.5 py-1 text-xs"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0 rounded bg-black/10 dark:bg-white/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide opacity-75">
                    {idx === 0 ? "Queued" : `Queued #${idx + 1}`}
                  </span>
                  <span className="truncate opacity-85">
                    {item.text || `${item.attachments.length} attachment(s)`}
                  </span>
                  {item.text && item.attachments.length > 0 && (
                    <span className="shrink-0 text-[10px] opacity-60">
                      +{item.attachments.length} file{item.attachments.length > 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  aria-label="Remove queued message"
                  title="Remove queued message"
                  onClick={() => acpStore.removeQueuedMessage(effectiveThreadId, item.id)}
                  className="shrink-0 opacity-60 hover:opacity-100 cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}

        {attachmentError && (
          <div className="mx-3 mt-2 flex items-center justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-700 dark:text-red-300">
            <span>{attachmentError}</span>
            <button
              type="button"
              aria-label="Dismiss attachment error"
              onClick={() => setAttachmentError(null)}
              className="opacity-70 hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-2">
            {attachments.map((att) => {
              const lowerName = att.name.toLowerCase();
              const isSheet =
                lowerName.endsWith(".csv") ||
                lowerName.endsWith(".tsv") ||
                lowerName.endsWith(".xlsx") ||
                lowerName.endsWith(".xls");
              const sizeText = formatFileSize(att.size);
              return (
                <span
                  key={att.id}
                  title={`${att.name}${sizeText ? ` (${sizeText})` : ""}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-black/15 dark:border-white/15 bg-black/[0.02] dark:bg-white/[0.04] px-2 py-1 text-xs"
                >
                  {att.kind === "image" ? (
                    <ImageIcon className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
                  ) : isSheet ? (
                    <FileSpreadsheet
                      className="h-3.5 w-3.5 shrink-0 opacity-70"
                      aria-hidden="true"
                    />
                  ) : (
                    <FileText className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
                  )}
                  <span className="max-w-[160px] truncate">{att.name}</span>
                  {sizeText && (
                    <span className="text-[10px] opacity-55 tabular-nums">{sizeText}</span>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${att.name}`}
                    onClick={() => acpStore.removeAttachment(att.id)}
                    className="opacity-70 hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              );
            })}
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
            <div className="flex min-w-0 flex-wrap sm:flex-nowrap items-center gap-0.5 sm:gap-1 text-xs">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  attachFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                aria-label="Attach files"
                title="Attach images, PDFs, CSVs, or other files"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex min-h-[28px] min-w-[28px] shrink-0 items-center justify-center rounded-lg px-2 py-1 opacity-65 transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.08] hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/25 dark:focus-visible:ring-white/30 cursor-pointer"
              >
                <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
              </button>

              <span
                aria-hidden="true"
                className="mx-0.5 h-3.5 w-px shrink-0 bg-black/10 dark:bg-white/10"
              />

              <ComposerConfigControls />
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              <ComposerContextUsageBadge />

              {isRunning && (textContent.trim() || attachments.length > 0) && (
                <button
                  type="button"
                  onClick={handleSubmit}
                  aria-label="Queue message"
                  title="Queue message for after current turn (Enter)"
                  className="openui-agent-thread-composer__submit-button inline-flex min-h-[32px] min-w-[32px] items-center justify-center rounded-full bg-black text-white dark:bg-white dark:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/35 dark:focus-visible:ring-white/40 cursor-pointer"
                >
                  <ArrowUp className="h-4 w-4" aria-hidden="true" />
                </button>
              )}

              <button
                type="button"
                onClick={isRunning ? handleCancel : handleSubmit}
                aria-label={isRunning ? "Cancel generation (Esc)" : "Send message"}
                title={isRunning ? "Cancel generation (Esc)" : "Send message (Enter)"}
                className="openui-agent-thread-composer__submit-button inline-flex min-h-[32px] min-w-[32px] items-center justify-center rounded-full bg-black text-white dark:bg-white dark:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/35 dark:focus-visible:ring-white/40 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
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
    </div>
  );
}
