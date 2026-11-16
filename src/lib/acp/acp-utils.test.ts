import { parseAgyMcpListOutput } from "@/lib/acp/mcp-cli";
import { convertReplayedUpdatesToMessages } from "@/lib/acp/session-manager";
import { describe, expect, it } from "vitest";

describe("parseAgyMcpListOutput", () => {
  it("parses agy mcp list stdout into structured servers", () => {
    const sample = `
NAME                      TYPE   STATUS   COMMAND/URL
cua-driver                stdio  enabled  /home/user/.local/bin/cua-driver mcp
invisible_playwright_mcp  stdio  disabled /home/user/.local/bin/uvx invisible-playwright-mcp
remote-api                http   enabled  https://example.com/mcp
`;
    const parsed = parseAgyMcpListOutput(sample);
    expect(parsed).toEqual([
      {
        name: "cua-driver",
        type: "stdio",
        status: "enabled",
        target: "/home/user/.local/bin/cua-driver mcp",
      },
      {
        name: "invisible_playwright_mcp",
        type: "stdio",
        status: "disabled",
        target: "/home/user/.local/bin/uvx invisible-playwright-mcp",
      },
      {
        name: "remote-api",
        type: "http",
        status: "enabled",
        target: "https://example.com/mcp",
      },
    ]);
  });

  it("returns empty list when no servers are configured", () => {
    expect(parseAgyMcpListOutput("No MCP servers configured.")).toEqual([]);
  });
});

describe("convertReplayedUpdatesToMessages", () => {
  it("reconstructs user, tool, and assistant messages from ACP replay updates", () => {
    const messages = convertReplayedUpdatesToMessages([
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Show package count" },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "Read package.json",
        status: "completed",
        rawInput: { Path: "package.json" },
        rawOutput: { name: "app" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "root = Stack([c])\nc = Card([])" },
      },
    ]);

    expect(messages).toHaveLength(4);
    expect(messages[0]).toMatchObject({ role: "user", content: "Show package count" });
    expect(messages[1]).toMatchObject({ role: "assistant" });
    expect(messages[1]?.toolCalls?.[0]?.id).toBe("tc-1");
    expect(messages[2]).toMatchObject({ role: "tool", toolCallId: "tc-1" });
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: "root = Stack([c])\nc = Card([])",
    });
  });
});
