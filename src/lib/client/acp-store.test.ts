import type { AcpSessionSnapshot } from "@/lib/acp/types";
import {
  acpStore,
  getBootstrapThreadKey,
  getMergedSlashCommands,
  groupActiveThreadsByStatus,
  partitionThreadsByFolder,
  selectEffectiveOpenUI,
  selectEffectiveSnapshot,
  type AcpClientState,
} from "@/lib/client/acp-store";
import { afterEach, describe, expect, it, vi } from "vitest";

function makeSnapshot(threadId: string, overrides: Partial<AcpSessionSnapshot> = {}): AcpSessionSnapshot {
  return {
    threadId,
    sessionId: `sess-${threadId}`,
    cwd: "/workspace",
    additionalDirectories: [],
    commands: [],
    configOptions: [],
    plan: [],
    pendingPermissions: [],
    isStreaming: false,
    ...overrides,
  };
}

function makeState(
  snapshots: Record<string, AcpSessionSnapshot>,
  overrides: Partial<AcpClientState> = {},
): AcpClientState {
  return {
    hydrated: false,
    cwd: "/workspace",
    additionalDirectories: [],
    folders: [],
    activeFolderId: null,
    activeThreadId: null,
    threadFolderMap: {},
    hiddenThreadIds: [],
    hasInitializedDefaultFolder: false,
    sessionMcpServers: [],
    preferredMode: "auto",
    preferredModel: "",
    preferredThoughtLevel: "",
    notificationsEnabled: true,
    snapshots,
    acpSessionIds: {},
    appDataDirs: {},
    threadOpenUI: {},
    threadStatus: {},
    pendingAutoTitleIds: [],
    autoTitledThreadIds: [],
    manuallyRenamedThreadIds: [],
    attachments: [],
    queuedMessages: {},
    activeModal: null,
    lastError: null,
    ...overrides,
  };
}

describe("selectEffectiveSnapshot", () => {
  it("falls back to active folder bootstrap or default bootstrap snapshot when selectedThreadId is null or uncached", () => {
    const bootstrap = makeSnapshot("bootstrap", {
      commands: [
        {
          name: "prompt-template",
          description: "Load and execute saved prompt templates from ~/.pi/agent/prompts/.",
          category: "skill",
        },
      ],
    });
    const folderSnap = makeSnapshot("bootstrap:f1", { cwd: "/projects/f1" });
    const defaultState = makeState({ bootstrap });

    expect(selectEffectiveSnapshot(defaultState, null)).toBe(bootstrap);
    expect(selectEffectiveSnapshot(defaultState, "thread-unknown")).toBe(bootstrap);

    const folderState = makeState(
      { bootstrap, [getBootstrapThreadKey("f1")]: folderSnap },
      { activeFolderId: "f1" },
    );
    expect(selectEffectiveSnapshot(folderState, null)).toBe(folderSnap);
  });

  it("returns thread snapshot when present", () => {
    const bootstrap = makeSnapshot("bootstrap");
    const threadSnap = makeSnapshot("thread-1");
    const state = makeState({ bootstrap, "thread-1": threadSnap });

    expect(selectEffectiveSnapshot(state, "thread-1")).toBe(threadSnap);
  });
});

describe("getMergedSlashCommands", () => {
  it("retains dynamically discovered skills such as prompt-template alongside CLI and app commands", () => {
    const snap = makeSnapshot("bootstrap", {
      commands: [
        {
          name: "prompt-template",
          description: "Load and execute saved prompt templates.",
          category: "skill",
        },
        {
          name: "antigravity-guide",
          description: "Comprehensive guide for Google Antigravity.",
          category: "skill",
        },
      ],
    });

    const merged = getMergedSlashCommands(snap);
    const names = merged.map((c) => c.name);

    expect(names).toContain("prompt-template");
    expect(names).toContain("antigravity-guide");
    expect(names).toContain("goal");
    expect(names).toContain("mcp");
  });
});

describe("partitionThreadsByFolder", () => {
  it("groups visible threads by folder, places legacy unmapped threads into active folder, and excludes hidden threads", () => {
    const threads = [
      { id: "t1", title: "Alpha" },
      { id: "t2", title: "Beta" },
      { id: "t3", title: "Legacy" },
      { id: "t4", title: "Hidden" },
    ];
    const folders = [
      { id: "f1", name: "proj-1", cwd: "/proj-1" },
      { id: "f2", name: "proj-2", cwd: "/proj-2" },
    ];

    const { byFolder, hiddenThreads } = partitionThreadsByFolder({
      threads,
      folders,
      threadFolderMap: { t1: "f1", t2: "f2", t4: "f1" },
      hiddenThreadIds: ["t4"],
      activeFolderId: "f2",
    });

    expect(byFolder.f1.map((t) => t.id)).toEqual(["t1"]);
    expect(byFolder.f2.map((t) => t.id)).toEqual(["t2", "t3"]);
    expect(hiddenThreads.map((t) => t.id)).toEqual(["t4"]);
  });
});

describe("acpStore hydration and folder lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("migrates legacy single cwd on hydrateFromStorage and manages folders/threads without losing history", () => {
    expect(acpStore.getState().hydrated).toBe(false);
    expect(acpStore.getState().cwd).toBe("");

    const stored = new Map<string, string>([
      [
        "agy-openui:workspace-prefs",
        JSON.stringify({
          cwd: "/home/danielwijaya",
          preferredMode: "plan",
        }),
      ],
    ]);
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, val: string) => {
        stored.set(key, val);
      },
    });

    acpStore.hydrateFromStorage();

    expect(acpStore.getState().hydrated).toBe(true);
    expect(acpStore.getState().cwd).toBe("/home/danielwijaya");
    expect(acpStore.getState().additionalDirectories).toEqual([]);
    expect(acpStore.getState().preferredMode).toBe("plan");
    expect(acpStore.getState().folders).toHaveLength(1);
    expect(acpStore.getState().folders[0]).toMatchObject({
      id: "default",
      name: "danielwijaya",
      cwd: "/home/danielwijaya",
    });

    const extra = acpStore.addFolder({ cwd: "/projects/app/", name: "App" });
    expect(extra.cwd).toBe("/projects/app");
    expect(acpStore.getState().activeFolderId).toBe(extra.id);
    expect(acpStore.getState().cwd).toBe("/projects/app");

    acpStore.assignThreadToFolder("thread-a", extra.id);
    expect(acpStore.getState().threadFolderMap["thread-a"]).toBe(extra.id);

    // Hide individual thread without losing mapping
    acpStore.hideThreadFromSidebar("thread-a");
    expect(acpStore.getState().hiddenThreadIds).toContain("thread-a");

    // Restore brings thread back cleanly
    acpStore.restoreHiddenThread("thread-a");
    expect(acpStore.getState().hiddenThreadIds).not.toContain("thread-a");

    // Remove folder hides its threads cleanly without deleting anything on disk
    acpStore.removeFolder(extra.id, ["thread-a"]);
    expect(acpStore.getState().folders.some((f) => f.id === extra.id)).toBe(false);
    expect(acpStore.getState().hiddenThreadIds).toContain("thread-a");
    expect(acpStore.getState().activeFolderId).toBe("default");
    expect(acpStore.getState().cwd).toBe("/home/danielwijaya");

    // Auto-title vs manual rename guards & appDataDir tracking
    acpStore.markPendingAutoTitle("thread-auto");
    expect(acpStore.getState().pendingAutoTitleIds).toContain("thread-auto");
    expect(acpStore.isApplyingAutoTitle()).toBe(false);
    acpStore.runAsAutoTitle(() => {
      expect(acpStore.isApplyingAutoTitle()).toBe(true);
    });
    expect(acpStore.isApplyingAutoTitle()).toBe(false);
    acpStore.markThreadAutoTitled("thread-auto");
    expect(acpStore.getState().autoTitledThreadIds).toContain("thread-auto");
    expect(acpStore.getState().pendingAutoTitleIds).not.toContain("thread-auto");

    acpStore.markPendingAutoTitle("thread-manual");
    acpStore.markThreadManuallyRenamed("thread-manual");
    expect(acpStore.getState().manuallyRenamedThreadIds).toContain("thread-manual");
    expect(acpStore.getState().pendingAutoTitleIds).not.toContain("thread-manual");

    acpStore.setSnapshot("thread-app", makeSnapshot("thread-app", { appDataDir: "antigravity" }));
    expect(acpStore.getState().appDataDirs["thread-app"]).toBe("antigravity");

    acpStore.setSnapshot("thread-stream", makeSnapshot("thread-stream", { isStreaming: true }));
    expect(acpStore.getState().threadStatus["thread-stream"]).toBe("working");
    acpStore.setSnapshot("thread-stream", makeSnapshot("thread-stream", { isStreaming: false }));
    expect(acpStore.getState().threadStatus["thread-stream"]).toBeUndefined();

    // Per-thread OpenUI toggle defaults to true and resets bootstrap on promote
    expect(selectEffectiveOpenUI(acpStore.getState(), "thread-new")).toBe(true);
    const bootstrapKey = getBootstrapThreadKey(acpStore.getState().activeFolderId);
    acpStore.setThreadOpenUI(bootstrapKey, false);
    expect(selectEffectiveOpenUI(acpStore.getState(), null)).toBe(false);
    expect(acpStore.promoteBootstrapOpenUI("thread-md")).toBe(false);
    expect(selectEffectiveOpenUI(acpStore.getState(), "thread-md")).toBe(false);
    expect(selectEffectiveOpenUI(acpStore.getState(), null)).toBe(true);
    expect(selectEffectiveOpenUI(acpStore.getState(), "thread-other")).toBe(true);
    const savedPrefs = JSON.parse(stored.get("agy-openui:workspace-prefs") ?? "{}") as {
      threadOpenUI?: Record<string, boolean>;
    };
    expect(savedPrefs.threadOpenUI?.["thread-md"]).toBe(false);

    // Per-thread mid-turn message queue (FIFO enqueue/dequeue/remove/clear)
    const q1 = acpStore.enqueueMessage("thread-q", { text: "first", attachments: [] });
    const q2 = acpStore.enqueueMessage("thread-q", { text: "second", attachments: [] });
    expect(acpStore.getState().queuedMessages["thread-q"]).toHaveLength(2);
    acpStore.removeQueuedMessage("thread-q", q1.id);
    expect(acpStore.getState().queuedMessages["thread-q"]).toHaveLength(1);
    expect(acpStore.dequeueMessage("thread-q")?.id).toBe(q2.id);

    // Per-thread sidebar activity status lifecycle (working -> needs_input -> unread -> viewed)
    acpStore.markThreadViewed("thread-other");
    acpStore.setSnapshot("thread-bg", makeSnapshot("thread-bg", { isStreaming: true }));
    acpStore.setThreadStatus("thread-bg", "working");
    expect(acpStore.getState().threadStatus["thread-bg"]).toBe("working");
    acpStore.completeThreadRun("thread-bg");
    expect(acpStore.getState().threadStatus["thread-bg"]).toBe("unread");
    expect(acpStore.getState().snapshots["thread-bg"]?.isStreaming).toBe(false);
    acpStore.markThreadViewed("thread-bg");
    expect(acpStore.getState().threadStatus["thread-bg"]).toBeUndefined();

    acpStore.setThreadStatus("thread-bg", "working");
    acpStore.completeThreadRun("thread-bg", { needsInput: true });
    expect(acpStore.getState().threadStatus["thread-bg"]).toBe("needs_input");
    acpStore.markThreadViewed("thread-bg");
    expect(acpStore.getState().threadStatus["thread-bg"]).toBe("needs_input");
    acpStore.setThreadStatus("thread-bg", "working");
    acpStore.completeThreadRun("thread-bg");
    // Stays "unread" (Ready) while user remains on the finished thread until they switch away or acknowledge it
    expect(acpStore.getState().threadStatus["thread-bg"]).toBe("unread");
    acpStore.markThreadViewed("thread-bg", { acknowledgeCurrent: true });
    expect(acpStore.getState().threadStatus["thread-bg"]).toBeUndefined();

    acpStore.setThreadStatus("thread-bg", "working");
    acpStore.completeThreadRun("thread-bg");
    expect(acpStore.getState().threadStatus["thread-bg"]).toBe("unread");
    acpStore.markThreadViewed("thread-other");
    expect(acpStore.getState().threadStatus["thread-bg"]).toBeUndefined();
    expect(acpStore.getState().queuedMessages["thread-q"]).toBeUndefined();
    acpStore.enqueueMessage("thread-q", { text: "to-clear", attachments: [] });
    expect(acpStore.clearQueuedMessages("thread-q")).toHaveLength(1);
    expect(acpStore.getState().queuedMessages["thread-q"]).toBeUndefined();
  });
});

describe("groupActiveThreadsByStatus", () => {
  it("groups only non-hidden active threads in priority order with workspace metadata", () => {
    const folders = [
      { id: "f1", name: "alpha", cwd: "/alpha", collapsed: false },
      { id: "f2", name: "beta", cwd: "/beta", collapsed: false },
    ];
    const threads = [
      { id: "t-idle", title: "Idle" },
      { id: "t-unread", title: "Finished" },
      { id: "t-working", title: "Running" },
      { id: "t-input", title: "Question" },
      { id: "t-hidden", title: "Hidden Working" },
    ];

    const groups = groupActiveThreadsByStatus({
      threads,
      folders,
      threadFolderMap: {
        "t-unread": "f2",
        "t-working": "f1",
        "t-input": "f2",
      },
      hiddenThreadIds: ["t-hidden"],
      activeFolderId: "f1",
      threadStatus: {
        "t-unread": "unread",
        "t-working": "working",
        "t-input": "needs_input",
        "t-hidden": "working",
      },
      snapshots: {},
    });

    expect(groups.map((g) => g.status)).toEqual(["needs_input", "working", "unread"]);
    expect(groups[0]?.items).toEqual([
      { thread: threads[3], status: "needs_input", folderId: "f2", folderName: "beta" },
    ]);
    expect(groups[1]?.items).toEqual([
      { thread: threads[2], status: "working", folderId: "f1", folderName: "alpha" },
    ]);
    expect(groups[2]?.items).toEqual([
      { thread: threads[1], status: "unread", folderId: "f2", folderName: "beta" },
    ]);
  });

  it("returns empty array when no threads are active", () => {
    const groups = groupActiveThreadsByStatus({
      threads: [{ id: "t1", title: "Idle" }],
      folders: [{ id: "f1", name: "alpha", cwd: "/alpha", collapsed: false }],
      threadFolderMap: {},
      hiddenThreadIds: [],
      activeFolderId: "f1",
      threadStatus: {},
      snapshots: {},
    });
    expect(groups).toEqual([]);
  });
});
