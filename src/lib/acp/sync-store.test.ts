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
});
