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
  Folder,
  FolderOpen,
  FolderPlus,
  MessageCircle,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

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
        <div className="flex items-center justify-between px-1 pb-1">
          <span className="openui-agent-thread-list-group !p-0">Folders</span>
          <button
            type="button"
            onClick={() => acpStore.setActiveModal("add-folder")}
            aria-label="Add workspace folder"
            className="inline-flex min-h-[26px] items-center gap-1 rounded-md border border-black/10 dark:border-white/15 px-2 py-0.5 text-[11px] font-medium opacity-80 hover:bg-black/5 dark:hover:bg-white/10 hover:opacity-100"
          >
            <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Add</span>
          </button>
        </div>

        {showSkeleton ? (
          <div className="space-y-2 px-1 py-2 text-xs opacity-60" role="status" aria-live="polite">
            Loading folders...
          </div>
        ) : folders.length === 0 ? (
          <div className="rounded-xl border border-dashed border-black/15 dark:border-white/15 p-3 text-center text-xs">
            <p className="opacity-70">No folders in sidebar yet.</p>
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
          <ul className="space-y-1.5">
            {folders.map((folder) => {
              const folderThreads = byFolder[folder.id] ?? [];
              const isActive = folder.id === activeFolderId;
              const isExpanded = !folder.collapsed;

              return (
                <li key={folder.id} className="space-y-0.5">
                  <div
                    className={`group flex items-center gap-1 rounded-lg px-1 py-1 transition-colors ${
                      isActive
                        ? "bg-black/[0.06] dark:bg-white/[0.08]"
                        : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                    }`}
                  >
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      aria-label={`${isExpanded ? "Collapse" : "Expand"} folder ${folder.name}`}
                      onClick={() => acpStore.toggleFolderCollapsed(folder.id)}
                      className="inline-flex min-h-[24px] min-w-[24px] shrink-0 items-center justify-center rounded-md opacity-70 hover:bg-black/5 dark:hover:bg-white/10 hover:opacity-100"
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
                      onClick={() => acpStore.selectFolder(folder.id, { expand: true })}
                      className="flex min-h-[24px] flex-1 min-w-0 items-center gap-1.5 rounded-md px-1 text-left text-xs"
                    >
                      {isExpanded && isActive ? (
                        <FolderOpen className="h-3.5 w-3.5 shrink-0 opacity-85" aria-hidden="true" />
                      ) : (
                        <Folder className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
                      )}
                      <span className="truncate font-medium">{folder.name}</span>
                      <span className="ml-auto shrink-0 text-[10px] tabular-nums opacity-55">
                        {folderThreads.length}
                      </span>
                    </button>

                    <button
                      type="button"
                      aria-label={`New thread in ${folder.name}`}
                      onClick={() => handleNewThreadInFolder(folder)}
                      className="inline-flex min-h-[24px] min-w-[24px] shrink-0 items-center justify-center rounded-md opacity-70 hover:bg-black/10 dark:hover:bg-white/15 hover:opacity-100"
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>

                    <button
                      type="button"
                      aria-label={`Remove folder ${folder.name} from sidebar`}
                      onClick={() => handleRemoveFolder(folder, folderThreads)}
                      className="inline-flex min-h-[24px] min-w-[24px] shrink-0 items-center justify-center rounded-md opacity-0 group-hover:opacity-70 group-focus-within:opacity-70 focus-visible:opacity-100 hover:bg-red-500/15 hover:text-red-600 dark:hover:text-red-400 hover:opacity-100"
                    >
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </div>

                  {isExpanded && (
                    <ul className="ml-3 space-y-0.5 border-l border-black/10 dark:border-white/10 pl-2">
                      {folderThreads.length === 0 ? (
                        <li className="px-2 py-1 text-[11px] opacity-50">
                          No threads in this folder
                        </li>
                      ) : (
                        folderThreads.map((thread) => {
                          const selected = selectedThreadId === thread.id;
                          const isRenaming = renamingThreadId === thread.id;

                          return (
                            <li key={thread.id}>
                              {isRenaming ? (
                                <form
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    handleCommitRename(thread);
                                  }}
                                  className="flex items-center gap-1 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] px-1.5 py-1"
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
                                  className={`group/thread flex items-center gap-1 rounded-lg px-1.5 py-1 transition-colors ${
                                    selected
                                      ? "openui-agent-thread-button--selected font-medium"
                                      : "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                                  }`}
                                >
                                  <button
                                    type="button"
                                    onClick={() => {
                                      acpStore.selectFolder(folder.id);
                                      selectThread(thread.id);
                                      if (nav.path !== undefined) {
                                        nav.navigate(undefined);
                                      }
                                    }}
                                    className="flex min-h-[24px] flex-1 min-w-0 items-center gap-1.5 text-left text-xs"
                                  >
                                    <MessageCircle
                                      className="h-3.5 w-3.5 shrink-0 opacity-65"
                                      aria-hidden="true"
                                    />
                                    <span className="truncate">{thread.title}</span>
                                  </button>

                                  <button
                                    type="button"
                                    aria-label={`Rename thread ${thread.title}`}
                                    onClick={() => {
                                      setRenamingThreadId(thread.id);
                                      setRenameDraft(thread.title);
                                    }}
                                    className="inline-flex min-h-[24px] min-w-[24px] shrink-0 items-center justify-center rounded-md opacity-0 group-hover/thread:opacity-70 group-focus-within/thread:opacity-70 focus-visible:opacity-100 hover:bg-black/10 dark:hover:bg-white/15 hover:opacity-100"
                                  >
                                    <Pencil className="h-3 w-3" aria-hidden="true" />
                                  </button>

                                  <button
                                    type="button"
                                    aria-label={`Remove thread ${thread.title} from sidebar`}
                                    onClick={() => handleRemoveThreadFromSidebar(thread.id)}
                                    className="inline-flex min-h-[24px] min-w-[24px] shrink-0 items-center justify-center rounded-md opacity-0 group-hover/thread:opacity-70 group-focus-within/thread:opacity-70 focus-visible:opacity-100 hover:bg-red-500/15 hover:text-red-600 dark:hover:text-red-400 hover:opacity-100"
                                  >
                                    <X className="h-3 w-3" aria-hidden="true" />
                                  </button>
                                </div>
                              )}
                            </li>
                          );
                        })
                      )}
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
