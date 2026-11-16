import type { AcpSessionSnapshot } from "@/lib/acp/types";
import {
  getMergedSlashCommands,
  selectEffectiveSnapshot,
  type AcpClientState,
} from "@/lib/client/acp-store";
import { describe, expect, it } from "vitest";

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
