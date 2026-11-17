import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSyncedMessages,
  getSyncedState,
  mergeSyncedState,
  saveSyncedMessages,
  subscribeSyncEvents,
  upsertSyncedThread,
  type SyncChangeEvent,
} from "./sync-store";

describe("sync-store", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "genui-sync-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("persists threads and messages across reads and notifies subscribers", async () => {
    const events: SyncChangeEvent[] = [];
    const unsubscribe = subscribeSyncEvents((ev) => events.push(ev));

    await upsertSyncedThread(
      {
        id: "t1",
        title: "Desktop Thread",
        createdAt: 1000,
        acpSessionId: "acp-1",
      },
      { clientId: "desktop-1", dataDir: tempDir },
    );

    await saveSyncedMessages(
      "t1",
      [{ id: "m1", role: "user", content: "Hello from desktop" }],
      { clientId: "desktop-1", dataDir: tempDir },
    );

    unsubscribe();

    const state = getSyncedState(tempDir);
    expect(state.threads).toHaveLength(1);
    expect(state.threads[0]?.title).toBe("Desktop Thread");
    expect(state.acpSessionIds["t1"]).toBe("acp-1");
    expect(getSyncedMessages("t1", tempDir)).toEqual([
      { id: "m1", role: "user", content: "Hello from desktop" },
    ]);
    expect(events.length).toBe(2);
    expect(events[1]?.threadId).toBe("t1");
  });

  it("merges desktop and mobile threads, folders, and messages without clobbering", async () => {
    await upsertSyncedThread(
      { id: "desktop-t", title: "Desktop", createdAt: 1000 },
      { dataDir: tempDir },
    );
    await saveSyncedMessages(
      "desktop-t",
      [{ id: "m1", role: "user", content: "hi" }],
      { dataDir: tempDir },
    );

    const merged = await mergeSyncedState(
      {
        threads: [{ id: "mobile-t", title: "Mobile", createdAt: 2000 }],
        folders: [{ id: "f1", name: "repo", cwd: "/tmp/repo", collapsed: false }],
        threadFolders: { "mobile-t": "f1" },
        messagesByThread: {
          "mobile-t": [{ id: "m2", role: "user", content: "from phone" }],
        },
      },
      { clientId: "mobile-1", dataDir: tempDir },
    );

    expect(merged.threads.map((t) => t.id)).toEqual(["mobile-t", "desktop-t"]);
    expect(merged.folders).toHaveLength(1);
    expect(merged.threadFolders["mobile-t"]).toBe("f1");
    expect(getSyncedMessages("desktop-t", tempDir)).toHaveLength(1);
    expect(getSyncedMessages("mobile-t", tempDir)).toHaveLength(1);
  });

  it("remaps colliding default folder IDs and duplicate-cwd UUIDs during merge", async () => {
    // Desktop seeded "default" -> /repo-a and "desk-b" -> /repo-b
    await mergeSyncedState(
      {
        threads: [
          { id: "t-a", title: "Repo A", createdAt: 1000 },
          { id: "t-b", title: "Repo B", createdAt: 1100 },
        ],
        folders: [
          { id: "default", name: "repo-a", cwd: "/repo-a", collapsed: false },
          { id: "desk-b", name: "repo-b", cwd: "/repo-b", collapsed: false },
        ],
        activeFolderId: "default",
        threadFolders: { "t-a": "default", "t-b": "desk-b" },
      },
      { clientId: "desktop", dataDir: tempDir },
    );

    // Mobile had "default" -> /repo-c (colliding ID, different cwd) and "mob-b" -> /repo-b (same cwd, different ID)
    const merged = await mergeSyncedState(
      {
        threads: [
          { id: "t-c", title: "Repo C", createdAt: 2000 },
          { id: "t-b2", title: "Repo B Mobile", createdAt: 2100 },
        ],
        folders: [
          { id: "default", name: "repo-c", cwd: "/repo-c", collapsed: false },
          { id: "mob-b", name: "repo-b", cwd: "/repo-b", collapsed: false },
        ],
        activeFolderId: "default",
        threadFolders: { "t-c": "default", "t-b2": "mob-b" },
      },
      { clientId: "mobile", dataDir: tempDir },
    );

    expect(merged.folders).toHaveLength(3);
    const repoCFolder = merged.folders.find((f) => f.cwd === "/repo-c");
    expect(repoCFolder).toBeDefined();
    expect(repoCFolder?.id).not.toBe("default");
    expect(merged.threadFolders["t-a"]).toBe("default");
    expect(merged.threadFolders["t-b"]).toBe("desk-b");
    expect(merged.threadFolders["t-b2"]).toBe("desk-b");
    expect(merged.threadFolders["t-c"]).toBe(repoCFolder?.id);
  });
});
