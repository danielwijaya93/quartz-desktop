import { convertReplayedUpdatesToMessages } from "@/lib/acp/replay";
import {
  createAcpStreamTranslator,
  isAgyMalformedToolCallNotice,
} from "@/lib/acp/sse-translator";
import type * as acp from "@agentclientprotocol/sdk";
import { EventType } from "@openuidev/react-headless";
import { describe, expect, it } from "vitest";

describe("createAcpStreamTranslator", () => {
  it("translates thought, tool_call, tool_call_update, and message chunks into AG-UI events", () => {
    const events: Array<Record<string, unknown>> = [];
    const translator = createAcpStreamTranslator((ev) => events.push(ev));

    translator.onUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Let me check..." },
    } as acp.SessionUpdate);

    translator.onUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc-1",
      title: "read_file",
      rawInput: { path: "README.md" },
      status: "in_progress",
    } as acp.SessionUpdate);

    translator.onUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      status: "completed",
      rawOutput: "Hello world",
    } as acp.SessionUpdate);

    translator.onUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "root = Stack([])" },
    } as acp.SessionUpdate);

    translator.flush();

    expect(translator.hasAssistantText()).toBe(true);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.TOOL_CALL_START);
    expect(types).toContain(EventType.TOOL_CALL_ARGS);
    expect(types).toContain(EventType.TOOL_CALL_END);
    expect(types).toContain(EventType.TOOL_CALL_RESULT);
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).toContain(EventType.TEXT_MESSAGE_END);
  });

  it("closes pending interactive tools on flush when no completion update arrived", () => {
    const events: Array<Record<string, unknown>> = [];
    const translator = createAcpStreamTranslator((ev) => events.push(ev));

    translator.onUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "ask-1",
      title: "ask_question",
      rawInput: { questions: [] },
      status: "in_progress",
    } as acp.SessionUpdate);

    translator.flush();

    expect(translator.hasAssistantText()).toBe(false);
    expect(events.some((e) => e.type === EventType.TOOL_CALL_END && e.toolCallId === "ask-1")).toBe(
      true,
    );
    expect(
      events.some((e) => e.type === EventType.TOOL_CALL_RESULT && e.toolCallId === "ask-1"),
    ).toBe(true);
  });

  it("tracks pending background tasks and open tool state", () => {
    const translator = createAcpStreamTranslator(() => {});
    expect(translator.hasPendingBackgroundTask()).toBe(false);
    expect(translator.hasOpenTools()).toBe(false);

    translator.onUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "cmd-bg",
      title: "run_command",
      rawInput: { CommandLine: "uv run pytest", toolSummary: "Run pytest suite" },
      status: "in_progress",
    } as acp.SessionUpdate);
    expect(translator.hasOpenTools()).toBe(true);
    expect(translator.hasOpenBackgroundTools()).toBe(true);
    expect(translator.getOpenBackgroundTasks().map((t) => t.label)).toEqual(["Run pytest suite"]);

    translator.onUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "cmd-bg",
      status: "completed",
      rawOutput: "Tool is running as a background task with task id: abc/task-1",
    } as acp.SessionUpdate);
    expect(translator.hasOpenTools()).toBe(false);
    expect(translator.hasOpenBackgroundTools()).toBe(false);
    expect(translator.hasPendingBackgroundTask()).toBe(true);
    expect(translator.getOpenBackgroundTasks().map((t) => t.label)).toEqual(["Run pytest suite"]);

    translator.clearPendingBackgroundTask();
    expect(translator.hasPendingBackgroundTask()).toBe(false);
  });

  it("splits consecutive OpenUI root blocks into separate assistant messages", () => {
    const events: Array<Record<string, unknown>> = [];
    const translator = createAcpStreamTranslator((ev) => events.push(ev));

    translator.onUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "root = Stack([a])\na = TextContent(\"first\")" },
    } as acp.SessionUpdate);

    translator.onUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "\nroot = Stack([b])\nb = TextContent(\"second\")" },
    } as acp.SessionUpdate);

    translator.flush();

    const starts = events.filter((e) => e.type === EventType.TEXT_MESSAGE_START);
    const ends = events.filter((e) => e.type === EventType.TEXT_MESSAGE_END);
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(starts[0]?.messageId).not.toBe(starts[1]?.messageId);
  });

  it("detects agy malformed function call retry notices", () => {
    expect(
      isAgyMalformedToolCallNotice(
        "\n⚠ Your previous response contained an improperly formatted function call: Malformed function call: Failed to parse function call. Retries remaining: 3",
      ),
    ).toBe(true);
    expect(isAgyMalformedToolCallNotice("All 77 tests passed.")).toBe(false);
  });
});

describe("convertReplayedUpdatesToMessages", () => {
  it("updates tool arguments when tool_call_update provides fuller rawInput", () => {
    const messages = convertReplayedUpdatesToMessages([
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc-2",
        title: "run_command",
        rawInput: { cmd: "ls" },
        status: "in_progress",
      } as acp.SessionUpdate,
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-2",
        rawInput: { cmd: "ls -la", cwd: "/tmp" },
        status: "completed",
        rawOutput: "ok",
      } as acp.SessionUpdate,
    ]);

    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.toolCalls?.[0]?.function.arguments).toBe(
      JSON.stringify({ cmd: "ls -la", cwd: "/tmp" }),
    );
  });
});
