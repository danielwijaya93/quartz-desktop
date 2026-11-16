import type { AcpSessionSnapshot } from "@/lib/acp/types";
import {
  acpStore,
  getMergedSlashCommands,
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

function makeState(snapshots: Record<string, AcpSessionSnapshot>): AcpClientState {
  return {
    hydrated: false,
    cwd: "/workspace",
    additionalDirectories: [],
    sessionMcpServers: [],
    preferredMode: "auto",
    preferredModel: "",
    preferredThoughtLevel: "",
    snapshots,
    acpSessionIds: {},
    attachments: [],
    activeModal: null,
    lastError: null,
  };
}

describe("selectEffectiveSnapshot", () => {
  it("falls back to bootstrap snapshot when selectedThreadId is null or uncached", () => {
    const bootstrap = makeSnapshot("bootstrap", {
      commands: [
        {
          name: "prompt-template",
          description: "Load and execute saved prompt templates from ~/.pi/agent/prompts/.",
          category: "skill",
        },
      ],
    });
    const state = makeState({ bootstrap });

    expect(selectEffectiveSnapshot(state, null)).toBe(bootstrap);
    expect(selectEffectiveSnapshot(state, "thread-unknown")).toBe(bootstrap);
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

describe("acpStore hydration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts with SSR-safe defaults and loads persisted prefs only on hydrateFromStorage", () => {
    expect(acpStore.getState().hydrated).toBe(false);
    expect(acpStore.getState().cwd).toBe("");

    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => {
        if (key === "agy-openui:workspace-prefs") {
          return JSON.stringify({
            cwd: "/home/danielwijaya",
            additionalDirectories: ["/tmp/extra"],
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
    expect(acpStore.getState().additionalDirectories).toEqual(["/tmp/extra"]);
    expect(acpStore.getState().preferredMode).toBe("plan");
  });
});
