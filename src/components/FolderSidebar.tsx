"use client";

import {
  acpStore,
  partitionThreadsByFolder,
  useAcpStore,
  type WorkspaceFolder,
} from "@/lib/client/acp-store";
import { useThreadList, type Thread } from "@openuidev/react-headless";
import { useNav } from "@openuidev/react-ui";
import {
  ChevronRight,
  FolderPlus,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

function formatShortAge(createdAt: string | number | undefined): string {
  const ts = typeof createdAt === "number" ? createdAt : createdAt ? Date.parse(createdAt) : 0;
  if (!ts || !Number.isFinite(ts)) return "";
  const diffMin = Math.max(0, Math.floor((Date.now() - ts) / 60_000));
  if (diffMin < 60) return `${Math.max(1, diffMin)}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d`;
  return `${Math.floor(diffDay / 30)}mo`;
}

export function FolderSidebar() {
  const threads = useThreadList((s) => s.threads);
  const isLoadingThreads = useThreadList((s) => s.isLoadingThreads);
  const selectedThreadId = useThreadList((s) => s.selectedThreadId);
  const loadThreads = useThreadList((s) => s.loadThreads);
  const selectThread = useThreadList((s) => s.selectThread);
  const updateThread = useThreadList((s) => s.updateThread);
  const switchToNewThread = useThreadList((s) => s.switchToNewThread);
  const nav = useNav();

  const folders = useAcpStore((s) => s.folders);
  const activeFolderId = useAcpStore((s) => s.activeFolderId);
  const threadFolderMap = useAcpStore((s) => s.threadFolderMap);
  const hiddenThreadIds = useAcpStore((s) => s.hiddenThreadIds);
  const threadAgents = useAcpStore((s) => s.threadAgents);
  const hydrated = useAcpStore((s) => s.hydrated);

  const [hasRequestedThreads, setHasRequestedThreads] = useState(false);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputId = useId();
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setHasRequestedThreads(true);
    loadThreads();
  }, [loadThreads]);

  useEffect(() => {
    if (renamingThreadId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingThreadId]);

  const { byFolder } = useMemo(
    () =>
      partitionThreadsByFolder({
        threads,
        folders,
        threadFolderMap,
        hiddenThreadIds,
        activeFolderId,
      }),
    [threads, folders, threadFolderMap, hiddenThreadIds, activeFolderId],
  );

  // Sort folders with threads (or currently active empty workspace) above empty (0) folders
  const sortedFolders = useMemo(() => {
    return [...folders].sort((a, b) => {
      const aCount = (byFolder[a.id] ?? []).length;
      const bCount = (byFolder[b.id] ?? []).length;
      const aHasWork = aCount > 0 || a.id === activeFolderId ? 1 : 0;
      const bHasWork = bCount > 0 || b.id === activeFolderId ? 1 : 0;
      if (aHasWork !== bHasWork) return bHasWork - aHasWork;
      if ((aCount > 0) !== (bCount > 0)) return aCount > 0 ? -1 : 1;
      return 0;
    });
  }, [folders, byFolder, activeFolderId]);

  const focusComposer = () => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message input']")?.focus();
    });
  };

  const handleNewThreadInFolder = (folder: WorkspaceFolder) => {
    acpStore.selectFolder(folder.id, { expand: true });
    switchToNewThread();
    if (nav.path !== undefined) {
      nav.navigate(undefined);
    }
    focusComposer();
  };

  const handleRemoveFolder = (folder: WorkspaceFolder, folderThreads: Thread[]) => {
    const memberIds = folderThreads.map((t) => t.id);
    if (selectedThreadId && memberIds.includes(selectedThreadId)) {
      switchToNewThread();
    }
    acpStore.removeFolder(folder.id, memberIds);
  };

  const handleRemoveThreadFromSidebar = (threadId: string) => {
    acpStore.hideThreadFromSidebar(threadId);
    if (selectedThreadId === threadId) {
      switchToNewThread();
    }
  };

  const handleCommitRename = (thread: Thread) => {
    const nextTitle = renameDraft.trim();
    if (nextTitle && nextTitle !== thread.title) {
      updateThread({ ...thread, title: nextTitle });
    }
    setRenamingThreadId(null);
  };

  const showSkeleton = !hydrated || !hasRequestedThreads || isLoadingThreads;

  return (
    <div className="openui-agent-thread-list" aria-label="Workspace folders and threads">
      <div className="openui-agent-thread-list-content">
        <div className="flex items-center justify-between px-1.5 pb-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider opacity-50">
            Workspaces
          </span>
          <button
            type="button"
            onClick={() => acpStore.setActiveModal("add-folder")}
            aria-label="Add workspace folder"
            title="Add workspace folder"
            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium opacity-65 transition-colors hover:bg-black/[0.06] hover:opacity-100 dark:hover:bg-white/[0.08]"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Add</span>
          </button>
        </div>

        {showSkeleton ? (
          <div className="space-y-2 px-1.5 py-2 text-xs opacity-60" role="status" aria-live="polite">
            Loading workspaces...
          </div>
        ) : sortedFolders.length === 0 ? (
          <div className="rounded-xl border border-dashed border-black/15 dark:border-white/15 p-3 text-center text-xs">
            <p className="opacity-70">No workspaces in sidebar yet.</p>
            <button
              type="button"
              onClick={() => acpStore.setActiveModal("add-folder")}
              className="mt-2 inline-flex min-h-[28px] items-center gap-1.5 rounded-lg bg-black px-2.5 py-1 text-[11px] font-medium text-white dark:bg-white dark:text-black"
            >
              <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Add Folder</span>
            </button>
          </div>
        ) : (
          <ul className="space-y-1">
            {sortedFolders.map((folder) => {
              const folderThreads = byFolder[folder.id] ?? [];
              const isActive = folder.id === activeFolderId;
              const isExpanded = !folder.collapsed;
              const hasSelectedThreadInside = folderThreads.some(
                (t) => t.id === selectedThreadId,
              );

              return (
                <li key={folder.id} className="space-y-0.5">
                  <div
                    className={`group flex items-center gap-0.5 rounded-md px-1 py-0.5 transition-colors ${
                      isActive && !hasSelectedThreadInside
                        ? "bg-black/[0.06] dark:bg-white/[0.08] ring-1 ring-black/[0.08] dark:ring-white/[0.1]"
                        : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                    }`}
                  >
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      aria-label={`${isExpanded ? "Collapse" : "Expand"} folder ${folder.name}`}
                      onClick={() => acpStore.toggleFolderCollapsed(folder.id)}
                      className="inline-flex h-6 w-5 shrink-0 items-center justify-center rounded opacity-55 hover:opacity-100"
                    >
                      <ChevronRight
                        className={`h-3.5 w-3.5 motion-safe:transition-transform ${
                          isExpanded ? "rotate-90" : ""
                        }`}
                        aria-hidden="true"
                      />
                    </button>

                    <button
                      type="button"
                      title={`${folder.name} (${folder.cwd})`}
                      onClick={() => acpStore.selectFolder(folder.id, { expand: true })}
                      className={`flex min-h-[26px] flex-1 min-w-0 items-center gap-1.5 rounded px-1 text-left text-[13px] transition-opacity ${
                        isActive
                          ? "font-semibold opacity-100"
                          : folderThreads.length > 0
                            ? "font-medium opacity-85 hover:opacity-100"
                            : "font-normal opacity-55 hover:opacity-90"
                      }`}
                    >
                      <span className="truncate">{folder.name}</span>
                      {folderThreads.length > 0 && (
                        <span className="ml-auto shrink-0 rounded-full bg-black/[0.05] dark:bg-white/[0.08] px-1.5 py-0.2 text-[10px] font-medium tabular-nums opacity-70 group-hover:hidden">
                          {folderThreads.length}
                        </span>
                      )}
                    </button>

                    <div className="flex shrink-0 items-center opacity-70 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
                      <button
                        type="button"
                        aria-label={`New thread in ${folder.name}`}
                        title={`New chat in ${folder.name}`}
                        onClick={() => handleNewThreadInFolder(folder)}
                        className="inline-flex h-6 w-6 items-center justify-center rounded opacity-75 hover:bg-black/10 dark:hover:bg-white/15 hover:opacity-100"
                      >
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>

                      <button
                        type="button"
                        aria-label={`Remove folder ${folder.name} from sidebar`}
                        title={`Hide ${folder.name}`}
                        onClick={() => handleRemoveFolder(folder, folderThreads)}
                        className="inline-flex h-6 w-6 items-center justify-center rounded opacity-70 hover:bg-red-500/15 hover:text-red-600 dark:hover:text-red-400 hover:opacity-100"
                      >
                        <Trash2 className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </div>
                  </div>

                  {isExpanded && folderThreads.length > 0 && (
                    <ul className="ml-3 space-y-0">
                      {folderThreads.map((thread, idx) => {
                        const selected = selectedThreadId === thread.id;
                        const isRenaming = renamingThreadId === thread.id;
                        const isLast = idx === folderThreads.length - 1;
                        const ageLabel = formatShortAge(thread.createdAt);
                        const isQuartz = threadAgents[thread.id] === "quartz";

                        return (
                          <li key={thread.id} className="relative pl-4">
                            {/* File-tree L / ├ branch connector */}
                            {!isLast && (
                              <span
                                aria-hidden="true"
                                className="pointer-events-none absolute left-0 top-0 bottom-0 w-px bg-black/15 dark:bg-white/15"
                              />
                            )}
                            <span
                              aria-hidden="true"
                              className="pointer-events-none absolute left-0 top-0 h-[15px] w-3 rounded-bl-[4px] border-b border-l border-black/15 dark:border-white/15"
                            />

                            {isRenaming ? (
                              <form
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  handleCommitRename(thread);
                                }}
                                className="flex items-center gap-1 rounded-md bg-black/[0.04] dark:bg-white/[0.06] px-1.5 py-1"
                              >
                                <label htmlFor={renameInputId} className="sr-only">
                                  Rename thread
                                </label>
                                <input
                                  id={renameInputId}
                                  ref={renameInputRef}
                                  type="text"
                                  value={renameDraft}
                                  onChange={(e) => setRenameDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Escape") {
                                      e.stopPropagation();
                                      setRenamingThreadId(null);
                                    }
                                  }}
                                  onBlur={() => handleCommitRename(thread)}
                                  className="w-full min-w-0 rounded border border-black/20 dark:border-white/20 bg-white dark:bg-zinc-900 px-1.5 py-0.5 text-xs"
                                />
                              </form>
                            ) : (
                              <div
                                className={`group/thread relative flex items-center gap-1 rounded-md pl-1.5 pr-1 py-0.5 transition-colors ${
                                  selected
                                    ? "bg-black/[0.07] dark:bg-white/[0.1] font-medium before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2.5px] before:rounded-full before:bg-black/80 dark:before:bg-white/85"
                                    : "opacity-80 hover:bg-black/[0.04] dark:hover:bg-white/[0.05] hover:opacity-100"
                                }`}
                              >
                                <button
                                  type="button"
                                  title={thread.title}
                                  onClick={() => {
                                    acpStore.selectFolder(folder.id);
                                    selectThread(thread.id);
                                    if (nav.path !== undefined) {
                                      nav.navigate(undefined);
                                    }
                                  }}
                                  className="flex min-h-[24px] flex-1 min-w-0 items-center text-left text-[12.5px] leading-snug"
                                >
                                  <span className="truncate">{thread.title}</span>
                                </button>

                                {(isQuartz || ageLabel) && (
                                  <span className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums opacity-45 group-hover/thread:hidden group-focus-within/thread:hidden">
                                    {isQuartz && (
                                      <span className="rounded bg-black/[0.06] dark:bg-white/[0.1] px-1 py-px font-mono text-[9px] uppercase">
                                        q
                                      </span>
                                    )}
                                    {ageLabel}
                                  </span>
                                )}

                                <div className="hidden shrink-0 items-center group-hover/thread:flex group-focus-within/thread:flex">
                                  <button
                                    type="button"
                                    aria-label={`Rename thread ${thread.title}`}
                                    title="Rename"
                                    onClick={() => {
                                      setRenamingThreadId(thread.id);
                                      setRenameDraft(thread.title);
                                    }}
                                    className="inline-flex h-5 w-5 items-center justify-center rounded opacity-70 hover:bg-black/10 dark:hover:bg-white/15 hover:opacity-100"
                                  >
                                    <Pencil className="h-3 w-3" aria-hidden="true" />
                                  </button>

                                  <button
                                    type="button"
                                    aria-label={`Remove thread ${thread.title} from sidebar`}
                                    title="Remove from sidebar"
                                    onClick={() => handleRemoveThreadFromSidebar(thread.id)}
                                    className="inline-flex h-5 w-5 items-center justify-center rounded opacity-70 hover:bg-red-500/15 hover:text-red-600 dark:hover:text-red-400 hover:opacity-100"
                                  >
                                    <X className="h-3 w-3" aria-hidden="true" />
                                  </button>
                                </div>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
