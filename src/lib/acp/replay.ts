import {
  classifyAttachmentKind,
  extractInlineAttachmentsFromText,
  inferMimeType,
} from "@/lib/acp/attachments";
import type { ReplayedTranscriptMessage, UserMessageAttachmentMeta } from "@/lib/acp/types";
import type * as acp from "@agentclientprotocol/sdk";

function extractContentBlockText(block: acp.ContentBlock | undefined | null): string {
  if (!block) return "";
  switch (block.type) {
    case "text":
      return block.text;
    case "resource_link":
      return `[${block.name || block.uri}](${block.uri})`;
    case "resource":
      if ("text" in block.resource && typeof block.resource.text === "string") {
        return block.resource.text;
      }
      return `[Resource: ${block.resource.uri}]`;
    case "image":
      return "[Image attachment]";
    case "audio":
      return "[Audio attachment]";
    default:
      return "";
  }
}

function extractUserAttachmentFromBlock(
  block: acp.ContentBlock | undefined | null,
): UserMessageAttachmentMeta | null {
  if (!block) return null;
  if (block.type === "image") {
    return {
      id: crypto.randomUUID(),
      name: "Attached image",
      mimeType: block.mimeType,
      kind: "image",
      data: block.data,
    };
  }
  if (block.type === "resource_link") {
    const rawName = block.name || decodeURIComponent(block.uri.split("/").pop() || "file");
    const mimeType = inferMimeType(rawName, block.mimeType ?? undefined);
    return {
      id: crypto.randomUUID(),
      name: rawName,
      mimeType,
      size: typeof block.size === "number" ? block.size : undefined,
      kind: classifyAttachmentKind(rawName, mimeType),
    };
  }
  if (block.type === "resource") {
    const rawUri = block.resource.uri || "";
    const decoded = decodeURIComponent(
      rawUri.replace(/^attachment:\/\/\//, "").split("/").pop() || "file",
    );
    const mimeType = inferMimeType(decoded, block.resource.mimeType ?? undefined);
    const size =
      "text" in block.resource && typeof block.resource.text === "string"
        ? Buffer.byteLength(block.resource.text, "utf8")
        : "blob" in block.resource && typeof block.resource.blob === "string"
          ? Math.floor((block.resource.blob.length * 3) / 4)
          : undefined;
    return {
      id: crypto.randomUUID(),
      name: decoded,
      mimeType,
      size,
      kind: classifyAttachmentKind(decoded, mimeType),
    };
  }
  return null;
}

export function extractAcpToolOutput(
  update: acp.ToolCall | acp.ToolCallUpdate,
): string {
  if (Array.isArray(update.content) && update.content.length > 0) {
    const parts: string[] = [];
    for (const item of update.content) {
      if (item.type === "content" && item.content.type === "text") {
        parts.push(item.content.text);
      } else if (item.type === "diff") {
        parts.push(`Diff (${item.path}):\n${item.newText ?? ""}`);
      } else if (item.type === "terminal") {
        parts.push(`Terminal: ${item.terminalId}`);
      }
    }
    if (parts.length > 0) return parts.join("\n\n");
  }
  if (update.rawOutput !== undefined && update.rawOutput !== null) {
    return typeof update.rawOutput === "string"
      ? update.rawOutput
      : JSON.stringify(update.rawOutput, null, 2);
  }
  return update.status === "failed" ? "Tool execution failed." : "Completed.";
}

export function convertReplayedUpdatesToMessages(
  updates: acp.SessionUpdate[],
): ReplayedTranscriptMessage[] {
  const messages: ReplayedTranscriptMessage[] = [];
  let currentUser: ReplayedTranscriptMessage | null = null;
  let currentAssistant: ReplayedTranscriptMessage | null = null;
  let turnHasTrailingAssistantProse = false;
  let lastTurnProse = "";
  let pendingToolEntries = new Map<
    string,
    { tc: NonNullable<ReplayedTranscriptMessage["toolCalls"]>[number]; completed: boolean }
  >();

  const flushUser = () => {
    if (!currentUser) return;
    const { cleanText, attachments: inlineAttachments } = extractInlineAttachmentsFromText(
      currentUser.content,
    );
    if (inlineAttachments.length > 0) {
      const existing = currentUser.attachments ?? [];
      const seenNames = new Set(existing.map((a) => a.name));
      const merged = [
        ...existing,
        ...inlineAttachments.filter((a) => !seenNames.has(a.name)),
      ];
      currentUser = {
        ...currentUser,
        content: cleanText,
        attachments: merged,
      };
    }
    if (currentUser.content || currentUser.attachments?.length) {
      messages.push(currentUser);
    }
    currentUser = null;
  };

  const flushAssistant = () => {
    if (currentAssistant && (currentAssistant.content || currentAssistant.toolCalls?.length)) {
      messages.push(currentAssistant);
    }
    currentAssistant = null;
  };

  const emitToolResult = (
    toolCallId: string,
    status: string | undefined | null,
    outputText: string,
  ) => {
    const capped =
      outputText.length > 24_000
        ? `${outputText.slice(0, 24_000)}\n... [truncated ${outputText.length - 24_000} chars]`
        : outputText;
    messages.push({
      id: crypto.randomUUID(),
      role: "tool",
      toolCallId,
      content: capped,
      ...(status === "failed" ? { error: capped || "Tool failed" } : {}),
    });
  };

  const finalizeAssistantTurn = () => {
    flushAssistant();
    for (const [toolCallId, entry] of pendingToolEntries) {
      if (!entry.completed) {
        entry.completed = true;
        emitToolResult(toolCallId, "completed", "Completed or interrupted before output was recorded.");
      }
    }
    // OpenUI's InterleavedTurn renders only the final assistant segment's text as the turn answer.
    // If prose appeared only before tool calls with no trailing prose after the last tool, surface it at the end.
    if (lastTurnProse.trim() && !turnHasTrailingAssistantProse && messages.at(-1)?.role === "tool") {
      messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        content: lastTurnProse,
        toolCalls: [],
      });
    }
    pendingToolEntries = new Map();
    lastTurnProse = "";
    turnHasTrailingAssistantProse = false;
  };

  for (const update of updates) {
    if (update.sessionUpdate === "user_message_chunk") {
      finalizeAssistantTurn();
      if (!currentUser) {
        currentUser = { id: crypto.randomUUID(), role: "user", content: "" };
      }
      const att = extractUserAttachmentFromBlock(update.content);
      if (att) {
        currentUser.attachments = [...(currentUser.attachments ?? []), att];
      } else {
        currentUser.content += extractContentBlockText(update.content);
      }
    } else if (update.sessionUpdate === "agent_message_chunk") {
      flushUser();
      const text = extractContentBlockText(update.content);
      if (!currentAssistant) {
        currentAssistant = { id: crypto.randomUUID(), role: "assistant", content: "", toolCalls: [] };
      }
      currentAssistant.content += text;
      if (currentAssistant.content.trim()) {
        lastTurnProse = currentAssistant.content;
        turnHasTrailingAssistantProse = true;
      }
    } else if (update.sessionUpdate === "tool_call") {
      flushUser();
      if (!currentAssistant) {
        currentAssistant = { id: crypto.randomUUID(), role: "assistant", content: "", toolCalls: [] };
      }
      turnHasTrailingAssistantProse = false;
      const tcName =
        typeof (update as { name?: unknown }).name === "string"
          ? (update as { name: string }).name
          : update.title;
      const tc = {
        id: update.toolCallId,
        type: "function" as const,
        function: {
          name: tcName || "tool",
          arguments: JSON.stringify(update.rawInput ?? {}),
        },
      };
      currentAssistant.toolCalls?.push(tc);
      const entry = { tc, completed: false };
      pendingToolEntries.set(update.toolCallId, entry);

      if (update.status === "completed" || update.status === "failed") {
        entry.completed = true;
        flushAssistant();
        emitToolResult(update.toolCallId, update.status, extractAcpToolOutput(update));
      }
    } else if (update.sessionUpdate === "tool_call_update") {
      flushUser();
      turnHasTrailingAssistantProse = false;
      let entry = pendingToolEntries.get(update.toolCallId);
      if (!entry) {
        if (!currentAssistant) {
          currentAssistant = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            toolCalls: [],
          };
        }
        const tc = {
          id: update.toolCallId,
          type: "function" as const,
          function: {
            name: update.title || "tool",
            arguments: JSON.stringify(update.rawInput ?? {}),
          },
        };
        currentAssistant.toolCalls?.push(tc);
        entry = { tc, completed: false };
        pendingToolEntries.set(update.toolCallId, entry);
      } else {
        if (update.title && entry.tc.function.name === "tool") {
          entry.tc.function.name = update.title;
        }
        if (update.rawInput !== undefined) {
          const nextArgs = JSON.stringify(update.rawInput ?? {});
          if (nextArgs !== "{}" && nextArgs !== entry.tc.function.arguments) {
            entry.tc.function.arguments = nextArgs;
          }
        }
      }

      if ((update.status === "completed" || update.status === "failed") && !entry.completed) {
        entry.completed = true;
        flushAssistant();
        emitToolResult(update.toolCallId, update.status, extractAcpToolOutput(update));
      }
    }
  }
  flushUser();
  finalizeAssistantTurn();
  return messages;
}
