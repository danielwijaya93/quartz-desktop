import {
  buildThreadTitlePrompt,
  isSyntheticTitleSession,
  sanitizeThreadTitle,
  summarizeForTitlePrompt,
} from "@/lib/acp/thread-title";
import { describe, expect, it } from "vitest";

describe("thread-title helpers", () => {
  it("identifies synthetic title-generator prompt sessions", () => {
    expect(isSyntheticTitleSession("Generate a concise 3 to 6 word title for this chat thread.")).toBe(true);
    expect(isSyntheticTitleSession("Checking Recent Git Commits")).toBe(false);
    expect(isSyntheticTitleSession(null)).toBe(false);
  });

  it("sanitizes quotes, prefixes, punctuation, and long titles cleanly", () => {
    expect(sanitizeThreadTitle('  Title: "Inspect Workspace Dependencies." \nExtra line')).toBe(
      "Inspect Workspace Dependencies",
    );
    expect(sanitizeThreadTitle("`Analyze Macro Yield Curve`")).toBe("Analyze Macro Yield Curve");
    expect(sanitizeThreadTitle("   ")).toBeNull();

    const long = sanitizeThreadTitle(
      "Comprehensive Multi-Quarter Portfolio Optimization Analysis And Rebalancing Plan",
    );
    expect(long).not.toBeNull();
    expect(long!.length).toBeLessThanOrEqual(60);
  });

  it("strips OpenUI code boilerplate when summarizing assistant output", () => {
    const raw = `Here is your report.\nroot = Stack([header, chart])\nheader = CardHeader("Stats")`;
    expect(summarizeForTitlePrompt(raw)).toBe("Here is your report.");

    const prompt = buildThreadTitlePrompt("!git status", "Succeeded with 0 changes.");
    expect(prompt).toContain("User: !git status");
    expect(prompt).toContain("Assistant summary: Succeeded with 0 changes.");
  });
});
