import type { AcpTierInfo, AcpUsageInfo, AskQuestionEntry } from "@/lib/acp/types";

/** Escapes a string literal for OpenUI Lang double-quoted strings. */
export function quoteOpenUI(value: string): string {
  return JSON.stringify(value);
}

/**
 * Strips accidental markdown code fences around OpenUI Lang output
 * (e.g. ```openui-lang ... ```) so the parser always receives raw statements.
 */
export function stripOpenUIFences(raw: string, isStreaming = false): string {
  if (!raw) return "";
  let text = raw.trimStart();
  const openFenceMatch = /^```[a-zA-Z0-9_-]*\r?\n/.exec(text);
  if (openFenceMatch) {
    text = text.slice(openFenceMatch[0].length);
    if (!isStreaming || /\r?\n```\s*$/.test(text)) {
      text = text.replace(/\r?\n```\s*$/, "");
    }
  }
  return text;
}

/** Returns true if the text looks like an OpenUI Lang program (with or without fence). */
export function hasOpenUILangSyntax(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const cleaned = stripOpenUIFences(raw, false);
  return /(^|\n)\s*root\s*=/.test(cleaned);
}

/**
 * Converts Antigravity's `ask_question` tool payload into an interactive
 * OpenUI Lang Form so users can pick options and submit back via @ToAssistant.
 */
export function questionsToOpenUILang(questions: AskQuestionEntry[]): string {
  if (!questions.length) {
    return buildStatusCardOpenUILang("Question", "Please provide your response in the chat composer.", "info");
  }

  const lines: string[] = [
    "root = Stack([qCard])",
    "qCard = Card([qHeader, qForm])",
    'qHeader = CardHeader("Clarification Needed", "Select your preferences and submit to continue")',
  ];

  const fieldRefs: string[] = [];

  questions.forEach((q, idx) => {
    const fcName = `fc${idx}`;
    const ctrlName = `ctrl${idx}`;
    const itemsName = `items${idx}`;
    const itemRefs: string[] = [];

    if (q.is_multi_select) {
      q.options.forEach((opt, optIdx) => {
        const itemVar = `cb${idx}_${optIdx}`;
        const recommended = opt.startsWith("(Recommended)");
        const label = recommended ? opt.replace("(Recommended)", "").trim() : opt;
        const desc = recommended ? "Recommended" : "";
        itemRefs.push(itemVar);
        lines.push(
          `${itemVar} = CheckBoxItem(${quoteOpenUI(label)}, ${quoteOpenUI(desc)}, ${quoteOpenUI(`opt_${optIdx}`)}, ${recommended})`,
        );
      });
      lines.push(`${itemsName} = [${itemRefs.join(", ")}]`);
      lines.push(`${ctrlName} = CheckBoxGroup(${quoteOpenUI(`q_${idx}`)}, ${itemsName})`);
    } else {
      let defaultVal: string | null = null;
      q.options.forEach((opt, optIdx) => {
        const itemVar = `rad${idx}_${optIdx}`;
        const recommended = opt.startsWith("(Recommended)");
        const label = recommended ? opt.replace("(Recommended)", "").trim() : opt;
        const desc = recommended ? "Recommended" : "";
        if (recommended && defaultVal === null) {
          defaultVal = opt;
        }
        itemRefs.push(itemVar);
        lines.push(
          `${itemVar} = RadioItem(${quoteOpenUI(label)}, ${quoteOpenUI(desc)}, ${quoteOpenUI(opt)})`,
        );
      });
      lines.push(`${itemsName} = [${itemRefs.join(", ")}]`);
      lines.push(
        `${ctrlName} = RadioGroup(${quoteOpenUI(`q_${idx}`)}, ${itemsName}, ${defaultVal ? quoteOpenUI(defaultVal) : "null"}, {required: true})`,
      );
    }

    lines.push(`${fcName} = FormControl(${quoteOpenUI(q.question)}, ${ctrlName})`);
    fieldRefs.push(fcName);
  });

  lines.push('notesCtrl = TextArea("notes", "Optional additional instructions or custom answer...", 2)');
  lines.push('fcNotes = FormControl("Additional Notes", notesCtrl, "Optional")');
  fieldRefs.push("fcNotes");

  lines.push('submitBtn = Button("Submit Answer", @ToAssistant("Submit my answers"), "primary")');
  lines.push("formBtns = Buttons([submitBtn])");
  lines.push(`qForm = Form("ask_question_form", formBtns, [${fieldRefs.join(", ")}])`);

  return lines.join("\n");
}

/** Builds a clean OpenUI Lang status card for silent commands like /compact or notices. */
export function buildStatusCardOpenUILang(
  title: string,
  description: string,
  variant: "info" | "success" | "warning" | "error" | "neutral" = "info",
  metrics?: Array<{ label: string; subtitle: string; value: string; subtext?: string; icon?: string }>,
): string {
  const lines: string[] = [];
  const children = ["statusBanner"];

  lines.push(
    `statusBanner = Callout(${quoteOpenUI(variant)}, ${quoteOpenUI(title)}, ${quoteOpenUI(description)})`,
  );

  if (metrics && metrics.length > 0) {
    const itemRefs: string[] = [];
    metrics.forEach((m, idx) => {
      const itemVar = `metric${idx}`;
      const lhsVar = `metricLhs${idx}`;
      const rhsVar = `metricRhs${idx}`;
      const iconVar = `metricIcon${idx}`;
      itemRefs.push(itemVar);
      lines.push(`${iconVar} = Icon(${quoteOpenUI(m.icon ?? "activity")}, "general")`);
      lines.push(
        `${lhsVar} = IconText(${iconVar}, "neutral", "m", ${quoteOpenUI(m.label)}, ${quoteOpenUI(m.subtitle)}, false, "horizontal")`,
      );
      lines.push(
        `${rhsVar} = BoldText("text", ${quoteOpenUI(m.value)}${m.subtext ? `, ${quoteOpenUI(m.subtext)}` : ""})`,
      );
      lines.push(`${itemVar} = SnippetCardItem(${quoteOpenUI(`m_${idx}`)}, ${lhsVar}, ${rhsVar})`);
    });
    lines.push(`metricsBlock = SnippetCardBlock([${itemRefs.join(", ")}])`);
    children.push("metricsBlock");
  }

  lines.unshift(`statusCard = Card([${children.join(", ")}])`);
  lines.unshift("root = Stack([statusCard])");
  return lines.join("\n");
}

/** Builds an OpenUI Lang dashboard card for direct `!command` shell execution. */
export function buildShellResultOpenUILang(params: {
  command: string;
  cwd: string;
  output: string;
  exitCode: number;
  durationMs: number;
}): string {
  const statusVariant = params.exitCode === 0 ? "success" : "error";
  const statusLabel = params.exitCode === 0 ? "Succeeded (exit 0)" : `Failed (exit ${params.exitCode})`;
  const safeOutput = params.output.trimEnd() || "(no output)";

  return [
    "root = Stack([shellCard])",
    "shellCard = Card([shellHeader, shellMetrics, shellCallout, shellCode])",
    `shellHeader = CardHeader(${quoteOpenUI(`$ ${params.command}`)}, ${quoteOpenUI(`Executed in ${params.cwd}`)})`,
    "shellMetrics = SnippetCardBlock([mExit, mTime])",
    'mExit = SnippetCardItem("exit", mExitLhs, mExitRhs)',
    'mExitIcon = Icon("terminal", "development")',
    'mExitLhs = IconText(mExitIcon, "neutral", "m", "Exit Status", "Shell process", false, "horizontal")',
    `mExitRhs = BoldText("text", ${quoteOpenUI(String(params.exitCode))}, ${quoteOpenUI(statusLabel)})`,
    'mTime = SnippetCardItem("time", mTimeLhs, mTimeRhs)',
    'mTimeIcon = Icon("clock", "general")',
    'mTimeLhs = IconText(mTimeIcon, "neutral", "m", "Duration", "Wall clock", false, "horizontal")',
    `mTimeRhs = BoldText("text", ${quoteOpenUI(`${params.durationMs} ms`)})`,
    `shellCallout = Callout(${quoteOpenUI(statusVariant)}, ${quoteOpenUI(statusLabel)}, ${quoteOpenUI(params.command)})`,
    `shellCode = CodeBlock("bash", ${quoteOpenUI(safeOutput)})`,
  ].join("\n");
}

/** Builds an OpenUI Lang usage/quota card for the `/usage` command. */
export function buildUsageCardOpenUILang(params: {
  usage?: AcpUsageInfo;
  tier?: AcpTierInfo;
  model?: string;
  mode?: string;
  cwd: string;
}): string {
  const used = params.usage?.used ?? 0;
  const size = params.usage?.size ?? 1_048_576;
  const pct = size > 0 ? ((used / size) * 100).toFixed(1) : "0.0";
  return buildStatusCardOpenUILang(
    "Session Context & Runtime Status",
    `Workspace: ${params.cwd}`,
    "info",
    [
      {
        label: "Context Usage",
        subtitle: `${pct}% of window`,
        value: `${used.toLocaleString()}`,
        subtext: `/ ${size.toLocaleString()} tokens`,
        icon: "cpu",
      },
      {
        label: "Active Model",
        subtitle: `Mode: ${params.mode ?? "auto"}`,
        value: params.model ?? "default",
        icon: "sparkles",
      },
      {
        label: "Account Tier",
        subtitle: "Antigravity ACP",
        value: params.tier?.name ?? "Authenticated",
        icon: "shield-check",
      },
    ],
  );
}
