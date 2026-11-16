import { describe, expect, it } from "vitest";
import {
  FALLBACK_MODELS,
  findConfigOption,
  formatContextPercent,
  resolveChoiceName,
} from "./acp-session-controls";
import type { AcpSessionSnapshot } from "@/lib/acp/types";

describe("acp-session-controls helpers", () => {
  it("formats missing or zero-size context usage as 0%", () => {
    expect(formatContextPercent(undefined)).toEqual({
      percent: 0,
      label: "0%",
      title: "Context window usage: 0%",
    });
    expect(formatContextPercent({ used: 500, size: 0 })).toEqual({
      percent: 0,
      label: "0%",
      title: "Context window usage: 0%",
    });
  });

  it("rounds and clamps context token usage to a percentage with token details in title", () => {
    expect(formatContextPercent({ used: 19_000, size: 1_049_000 })).toEqual({
      percent: 2,
      label: "2%",
      title: "Context window usage: 19k / 1049k tokens (2%)",
    });
    expect(formatContextPercent({ used: 1_500_000, size: 1_000_000 })).toEqual({
      percent: 100,
      label: "100%",
      title: "Context window usage: 1500k / 1000k tokens (100%)",
    });
  });

  it("finds config options and resolves display labels", () => {
    const snapshot: AcpSessionSnapshot = {
      threadId: "t1",
      sessionId: "s1",
      cwd: "/tmp",
      additionalDirectories: [],
      commands: [],
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gemini-4-argon",
          options: FALLBACK_MODELS,
        },
      ],
      pendingPermissions: [],
      plan: [],
      isStreaming: false,
    };

    expect(findConfigOption(snapshot, "model")?.currentValue).toBe("gemini-4-argon");
    expect(findConfigOption(snapshot, "missing")).toBeUndefined();
    expect(resolveChoiceName(FALLBACK_MODELS, "claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(resolveChoiceName(FALLBACK_MODELS, "unknown-model")).toBe("unknown-model");
  });
});
