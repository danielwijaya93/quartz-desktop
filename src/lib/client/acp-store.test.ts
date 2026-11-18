import type { AcpSessionSnapshot } from "@/lib/acp/types";
import {
  acpStore,
  getBootstrapThreadKey,
  getMergedSlashCommands,
  partitionThreadsByFolder,
  selectEffectiveAgent,
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
    threadFolderMap: {},
    hiddenThreadIds: [],
    hasInitializedDefaultFolder: false,
    sessionMcpServers: [],
    preferredMode: "auto",
    preferredModel: "",
    preferredThoughtLevel: "",
    preferredAgent: "agy",
    snapshots,
    acpSessionIds: {},
    appDataDirs: {},
    threadAgents: {},
    threadOpenUI: {},
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

    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => {
        if (key === "agy-openui:workspace-prefs") {
          return JSON.stringify({
            cwd: "/home/danielwijaya",
            preferredMode: "plan",
          });
        }
        return null;
      },
      setItem: () => {},
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

    // Per-thread agent binding & fallback
    acpStore.setThreadAgent("thread-q", "quartz");
    expect(selectEffectiveAgent(acpStore.getState(), "thread-q")).toBe("quartz");
    expect(acpStore.getState().preferredAgent).toBe("quartz");
    acpStore.setPreferences({ preferredAgent: "agy" });
    expect(selectEffectiveAgent(acpStore.getState(), "thread-q")).toBe("quartz");
    expect(selectEffectiveAgent(acpStore.getState(), "thread-new")).toBe("agy");

    // Per-thread OpenUI toggle defaults to true and resets bootstrap on promote
    expect(selectEffectiveOpenUI(acpStore.getState(), "thread-new")).toBe(true);
    const bootstrapKey = getBootstrapThreadKey(acpStore.getState().activeFolderId);
    acpStore.setThreadOpenUI(bootstrapKey, false);
    expect(selectEffectiveOpenUI(acpStore.getState(), null)).toBe(false);
    expect(acpStore.promoteBootstrapOpenUI("thread-md")).toBe(false);
    expect(selectEffectiveOpenUI(acpStore.getState(), "thread-md")).toBe(false);
    expect(selectEffectiveOpenUI(acpStore.getState(), null)).toBe(true);
    expect(selectEffectiveOpenUI(acpStore.getState(), "thread-other")).toBe(true);

    // Per-thread mid-turn message queue (FIFO enqueue/dequeue/remove/clear)
    const q1 = acpStore.enqueueMessage("thread-q", { text: "first", attachments: [] });
    const q2 = acpStore.enqueueMessage("thread-q", { text: "second", attachments: [] });
    expect(acpStore.getState().queuedMessages["thread-q"]).toHaveLength(2);
    acpStore.removeQueuedMessage("thread-q", q1.id);
    expect(acpStore.getState().queuedMessages["thread-q"]).toHaveLength(1);
    expect(acpStore.dequeueMessage("thread-q")?.id).toBe(q2.id);
    expect(acpStore.getState().queuedMessages["thread-q"]).toBeUndefined();
    acpStore.enqueueMessage("thread-q", { text: "to-clear", attachments: [] });
    expect(acpStore.clearQueuedMessages("thread-q")).toHaveLength(1);
    expect(acpStore.getState().queuedMessages["thread-q"]).toBeUndefined();
  });
});
