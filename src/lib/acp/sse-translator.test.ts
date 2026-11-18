import { convertReplayedUpdatesToMessages } from "@/lib/acp/replay";
import { createAcpStreamTranslator } from "@/lib/acp/sse-translator";
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
