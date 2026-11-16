import {
  buildShellResultOpenUILang,
  buildStatusCardOpenUILang,
  buildUsageCardOpenUILang,
  hasOpenUILangSyntax,
  questionsToOpenUILang,
  stripOpenUIFences,
} from "@/lib/openui/lang-helpers";
import { createParser } from "@openuidev/lang-core";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
import { describe, expect, it } from "vitest";

const parser = createParser(openuiLibrary.toJSONSchema());

describe("OpenUI lang-helpers", () => {
  it("strips fenced openui-lang blocks cleanly", () => {
    const fenced = "```openui-lang\nroot = Stack([card])\ncard = Card([TextContent(\"Hi\")])\n```";
    const stripped = stripOpenUIFences(fenced, false);
    expect(stripped.startsWith("root = Stack")).toBe(true);
    expect(stripped.includes("```")).toBe(false);
    expect(hasOpenUILangSyntax(fenced)).toBe(true);
    expect(hasOpenUILangSyntax("Just plain markdown prose")).toBe(false);
  });

  it("synthesizes valid openui-lang Form from ask_question payloads", () => {
    const lang = questionsToOpenUILang([
      {
        question: "Which chart should we render?",
        is_multi_select: false,
        options: ["(Recommended) Bar Chart", "Line Chart"],
      },
      {
        question: "Select sections to include",
        is_multi_select: true,
        options: ["Summary KPIs", "Raw Table"],
      },
    ]);

    const parsed = parser.parse(lang);
    expect(parsed.meta.errors).toEqual([]);
    expect(parsed.meta.unresolved).toEqual([]);
    expect(parsed.root).toBeTruthy();
    expect(lang).toContain("@ToAssistant");
  });

  it("synthesizes valid openui-lang for shell results, status cards, and usage cards", () => {
    const shellLang = buildShellResultOpenUILang({
      command: "git status -s",
      cwd: "/repo",
      output: "M src/app/page.tsx",
      exitCode: 0,
      durationMs: 24,
    });
    const parsedShell = parser.parse(shellLang);
    expect(parsedShell.meta.errors).toEqual([]);
    expect(parsedShell.meta.unresolved).toEqual([]);

    const statusLang = buildStatusCardOpenUILang("Compacted", "Context compacted cleanly", "success", [
      { label: "Tokens", subtitle: "Current window", value: "12,000", subtext: "/ 1,048,576" },
    ]);
    const parsedStatus = parser.parse(statusLang);
    expect(parsedStatus.meta.errors).toEqual([]);
    expect(parsedStatus.meta.unresolved).toEqual([]);

    const usageLang = buildUsageCardOpenUILang({
      usage: { used: 4200, size: 1048576 },
      tier: { id: "g1-pro-tier", name: "Google AI Pro" },
      model: "gemini-4-argon",
      mode: "auto",
      cwd: "/repo",
    });
    const parsedUsage = parser.parse(usageLang);
    expect(parsedUsage.meta.errors).toEqual([]);
    expect(parsedUsage.meta.unresolved).toEqual([]);
  });
});
