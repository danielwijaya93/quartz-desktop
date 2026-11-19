import { parseAgyMcpListOutput } from "@/lib/acp/mcp-cli";
import {
  buildAgentSpawnSpec,
  convertReplayedUpdatesToMessages,
  detectSessionAppDataDir,
} from "@/lib/acp/session-manager";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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

  it("handles tool_call_update, content outputs, and pre-tool prose cleanly", () => {
    const messages = convertReplayedUpdatesToMessages([
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Inspect repo" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Checking README first." },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc-upd",
        title: "read_file",
        status: "in_progress",
        rawInput: { Path: "README.md" },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-upd",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "# Readme Content" } }],
      },
    ]);

    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(messages[1]?.toolCalls?.[0]?.id).toBe("tc-upd");
    expect(messages[2]).toMatchObject({
      role: "tool",
      toolCallId: "tc-upd",
      content: "# Readme Content",
    });
    expect(messages[3]?.content).toBe("Checking README first.");
  });

  it("extracts attachment metadata onto user messages when replaying resource and image chunks", () => {
    const messages = convertReplayedUpdatesToMessages([
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Run stock market recap" },
      },
      {
        sessionUpdate: "user_message_chunk",
        content: {
          type: "resource",
          resource: {
            uri: "attachment:///market_data.csv",
            mimeType: "text/csv",
            text: "ticker,price\nSPY,745.71\n",
          },
        },
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("Run stock market recap");
    expect(messages[0]?.attachments).toEqual([
      expect.objectContaining({
        name: "market_data.csv",
        mimeType: "text/csv",
        kind: "text",
      }),
    ]);
  });

  it("strips ACP serialized Content of attachment:/// text blocks into attachment chips", () => {
    const messages = convertReplayedUpdatesToMessages([
      {
        sessionUpdate: "user_message_chunk",
        content: {
          type: "text",
          text: "Attached is the refreshed intraday data, any update?",
        },
      },
      {
        sessionUpdate: "user_message_chunk",
        content: {
          type: "text",
          text: "Content of attachment:///2026-11-16T16-13_export.csv:\nTicker,Close\nSPY,746.36\n",
        },
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("Attached is the refreshed intraday data, any update?");
    expect(messages[0]?.attachments).toEqual([
      expect.objectContaining({
        name: "2026-11-16T16-13_export.csv",
        mimeType: "text/csv",
        kind: "text",
      }),
    ]);
  });
});

describe("detectSessionAppDataDir", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      rmSync(tempRoots.pop()!, { recursive: true, force: true });
    }
  });

  it("detects Antigravity App vs CLI conversation stores from .db files", () => {
    const home = mkdtempSync(join(tmpdir(), "agy-appdir-"));
    tempRoots.push(home);

    const cliDir = join(home, ".gemini", "antigravity-cli", "conversations");
    const appDir = join(home, ".gemini", "antigravity", "conversations");
    mkdirSync(cliDir, { recursive: true });
    mkdirSync(appDir, { recursive: true });

    writeFileSync(join(cliDir, "sess-cli.db"), "");
    writeFileSync(join(appDir, "sess-app.db"), "");

    expect(detectSessionAppDataDir("sess-cli", undefined, home)).toBe("antigravity-cli");
    expect(detectSessionAppDataDir("sess-app", undefined, home)).toBe("antigravity");
    expect(detectSessionAppDataDir("sess-missing", "antigravity", home)).toBe("antigravity");
  });

  it("builds spawn spec for agy ACP agent", () => {
    expect(
      buildAgentSpawnSpec({
        additionalDirectories: ["/tmp/extra"],
        appDataDir: "antigravity",
      }),
    ).toEqual({
      command: "agy",
      args: ["acp", "--disable-telemetry", "--app-data-dir", "antigravity", "--add-dir", "/tmp/extra"],
    });
  });
});
