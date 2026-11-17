import type { ComposerAttachmentPayload } from "@/lib/acp/attachments";
import {
  buildFallbackBlocksWithTempFiles,
  buildPromptBlocksFromAttachments,
} from "@/lib/acp/prompt-attachments";
import {
  createBufferedRun,
  createRunSseStream,
  finishBufferedRun,
  pushRunEvent,
} from "@/lib/acp/run-buffer";
import {
  buildSessionSnapshot,
  extractAcpToolOutput,
  getExistingAcpSession,
  getOrCreateAcpSession,
} from "@/lib/acp/session-manager";
import type { AcpAppDataDir, AcpSessionMcpServer } from "@/lib/acp/types";
import { executeWorkspaceShell, resolveWorkspaceDir } from "@/lib/acp/workspace";
import {
  buildShellResultOpenUILang,
  buildStatusCardOpenUILang,
  buildUsageCardOpenUILang,
} from "@/lib/openui/lang-helpers";
import * as acp from "@agentclientprotocol/sdk";
import { EventType } from "@openuidev/react-headless";
import type { NextRequest } from "next/server";
import { promises as fs } from "node:fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface IncomingPart {
  type?: string;
  text?: string;
  mimeType?: string;
  data?: string;
}

interface IncomingMessage {
  role?: string;
  content?: string | IncomingPart[];
}

interface ChatRequestBody {
  threadId?: string;
  runId?: string;
  messages?: IncomingMessage[];
  acpSessionId?: string;
  appDataDir?: AcpAppDataDir;
  cwd?: string;
  additionalDirectories?: string[];
  mcpServers?: AcpSessionMcpServer[];
  mode?: string;
  model?: string;
  thoughtLevel?: string;
  attachments?: ComposerAttachmentPayload[];
}

function sseLine(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function extractUserInput(msg: IncomingMessage | undefined): {
  text: string;
  images: Array<{ mimeType: string; data: string }>;
} {
  if (!msg?.content) return { text: "", images: [] };
  if (typeof msg.content === "string") {
    return { text: msg.content, images: [] };
  }
  const texts: string[] = [];
  const images: Array<{ mimeType: string; data: string }> = [];
  for (const part of msg.content) {
    if (typeof part?.text === "string") {
      texts.push(part.text);
    } else if (part?.type === "binary" && part.mimeType && part.data) {
      images.push({ mimeType: part.mimeType, data: part.data });
    }
  }
  return { text: texts.join("\n"), images };
}

function streamStaticOpenUIResponse(
  threadId: string,
  runId: string,
  openuiText: string,
  customEvents: Array<{ name: string; value: unknown }> = [],
): Response {
  const encoder = new TextEncoder();
  const messageId = crypto.randomUUID();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(sseLine({ type: EventType.RUN_STARTED, threadId, runId })),
      );
      for (const custom of customEvents) {
        controller.enqueue(
          encoder.encode(sseLine({ type: EventType.CUSTOM, name: custom.name, value: custom.value })),
        );
      }
      controller.enqueue(
        encoder.encode(
          sseLine({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" }),
        ),
      );
      controller.enqueue(
        encoder.encode(
          sseLine({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: openuiText }),
        ),
      );
      controller.enqueue(
        encoder.encode(sseLine({ type: EventType.TEXT_MESSAGE_END, messageId })),
      );
      controller.enqueue(
        encoder.encode(sseLine({ type: EventType.RUN_FINISHED, threadId, runId })),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
} as const;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const threadId = url.searchParams.get("threadId")?.trim();
  const metaOnly = url.searchParams.get("meta") === "1";
  if (!threadId) {
    return new Response(JSON.stringify({ error: "threadId is required." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const entry = getExistingAcpSession(threadId);
  if (!entry?.activeRun) {
    return new Response(JSON.stringify({ error: "No active or recent run found." }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (metaOnly) {
    return new Response(
      JSON.stringify({
        runId: entry.activeRun.runId,
        threadId: entry.activeRun.threadId,
        done: entry.activeRun.done,
        startedAt: entry.activeRun.startedAt,
        finishedAt: entry.activeRun.finishedAt ?? null,
        eventCount: entry.activeRun.events.length,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  return new Response(createRunSseStream(entry.activeRun, req.signal), {
    headers: SSE_HEADERS,
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as ChatRequestBody;
  const threadId = body.threadId?.trim() || crypto.randomUUID();
  const runId = body.runId?.trim() || crypto.randomUUID();
  const cwd = resolveWorkspaceDir(body.cwd);

  const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
  const { text: userText, images: messageImages } = extractUserInput(lastUser);
  const fileAttachments = body.attachments ?? [];
  const trimmedText = userText.trim();

  if (!trimmedText && messageImages.length === 0 && fileAttachments.length === 0) {
    return new Response(JSON.stringify({ error: "No user message provided." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Handle direct `!command` CLI shell shortcut
  if (trimmedText.startsWith("!") && trimmedText.length > 1) {
    const shellCmd = trimmedText.slice(1).trim();
    const result = await executeWorkspaceShell(shellCmd, cwd);
    const ui = buildShellResultOpenUILang({
      command: shellCmd,
      cwd,
      output: result.output,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    });
    return streamStaticOpenUIResponse(threadId, runId, ui);
  }

  // Acquire or create persistent ACP session (fallback to fresh session if acpSessionId is stale)
  let sessionEntry;
  try {
    sessionEntry = await getOrCreateAcpSession({
      threadId,
      acpSessionId: body.acpSessionId,
      appDataDir: body.appDataDir,
      cwd,
      additionalDirectories: body.additionalDirectories,
      mcpServers: body.mcpServers,
      mode: body.mode ?? "auto",
      model: body.model,
      thoughtLevel: body.thoughtLevel,
    });
  } catch (err) {
    if (body.acpSessionId) {
      sessionEntry = await getOrCreateAcpSession({
        threadId,
        cwd,
        additionalDirectories: body.additionalDirectories,
        mcpServers: body.mcpServers,
        mode: body.mode ?? "auto",
        model: body.model,
        thoughtLevel: body.thoughtLevel,
      });
    } else {
      const message = err instanceof Error ? err.message : "Failed to start Antigravity ACP session.";
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Handle local `/usage` inspection command cleanly
  if (trimmedText === "/usage") {
    const activeModel =
      sessionEntry.configOptions.find((c) => c.id === "model")?.currentValue ??
      sessionEntry.models?.currentModelId;
    const activeMode =
      sessionEntry.configOptions.find((c) => c.id === "mode")?.currentValue ??
      sessionEntry.modes?.currentModeId;
    return streamStaticOpenUIResponse(
      threadId,
      runId,
      buildUsageCardOpenUILang({
        usage: sessionEntry.usage,
        tier: sessionEntry.tier,
        model: activeModel,
        mode: activeMode,
        cwd: sessionEntry.cwd,
      }),
      [{ name: "acp", value: { type: "session_snapshot", snapshot: buildSessionSnapshot(sessionEntry) } }],
    );
  }

  if (sessionEntry.isStreaming) {
    return streamStaticOpenUIResponse(
      threadId,
      runId,
      buildStatusCardOpenUILang(
        "Turn In Progress",
        "Wait for the active Antigravity turn to finish or click Stop before sending another prompt.",
        "warning",
      ),
    );
  }

  const run = createBufferedRun(threadId, runId);
  sessionEntry.activeRun = run;

  const emit = (event: Record<string, unknown>) => {
    pushRunEvent(run, sseLine(event));
  };

  const finish = () => {
    emit({ type: EventType.RUN_FINISHED, threadId, runId });
    finishBufferedRun(run);
  };

  emit({ type: EventType.RUN_STARTED, threadId, runId });
  emit({
    type: EventType.CUSTOM,
    name: "acp",
    value: { type: "session_snapshot", snapshot: buildSessionSnapshot(sessionEntry) },
  });

  let currentTextId: string | null = null;
  let hasAssistantText = false;
  let thinkingId: string | null = null;
      let thinkingStarted = false;
      let thinkingText = "";
      let activeParentMsgId: string | undefined;
      const toolState = new Map<
        string,
        { started: boolean; ended: boolean; resultSent: boolean; name: string; lastArgs: string }
      >();

      const closeThinking = () => {
        if (!thinkingId || !thinkingStarted) return;
        emit({ type: EventType.TOOL_CALL_END, toolCallId: thinkingId });
        emit({
          type: EventType.TOOL_CALL_RESULT,
          messageId: crypto.randomUUID(),
          toolCallId: thinkingId,
          content: thinkingText || "Reasoning completed.",
        });
        thinkingId = null;
        thinkingStarted = false;
        thinkingText = "";
      };

      const closeTextMessage = () => {
        if (!currentTextId) return;
        emit({ type: EventType.TEXT_MESSAGE_END, messageId: currentTextId });
        currentTextId = null;
      };

      sessionEntry.isStreaming = true;
      sessionEntry.lastUsed = Date.now();

      sessionEntry.activeCustomListener = (payload) => {
        emit({ type: EventType.CUSTOM, name: "acp", value: payload });
      };

      sessionEntry.activeUpdateListener = (update) => {
        if (update.sessionUpdate === "agent_thought_chunk") {
          const delta = update.content.type === "text" ? update.content.text : "";
          if (!delta) return;
          closeTextMessage();
          if (!thinkingId) {
            thinkingId = `thinking-${crypto.randomUUID()}`;
            thinkingStarted = true;
            emit({
              type: EventType.TOOL_CALL_START,
              toolCallId: thinkingId,
              toolCallName: "Thinking",
              ...(activeParentMsgId ? { parentMessageId: activeParentMsgId } : {}),
            });
          }
          thinkingText += delta;
          emit({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: thinkingId,
            delta,
          });
          return;
        }

        if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
          closeThinking();
          closeTextMessage();

          const id = update.toolCallId;
          const tcName =
            typeof (update as { name?: unknown }).name === "string"
              ? (update as { name: string }).name
              : update.title || "tool";
          let st = toolState.get(id);
          if (!st) {
            st = { started: false, ended: false, resultSent: false, name: tcName, lastArgs: "" };
            toolState.set(id, st);
          }

          if (!st.started) {
            st.started = true;
            emit({
              type: EventType.TOOL_CALL_START,
              toolCallId: id,
              toolCallName: st.name,
              ...(activeParentMsgId ? { parentMessageId: activeParentMsgId } : {}),
            });
          }

          if (update.rawInput !== undefined) {
            const nextArgs =
              typeof update.rawInput === "string"
                ? update.rawInput
                : JSON.stringify(update.rawInput ?? {});
            if (nextArgs && nextArgs !== "{}" && !st.lastArgs) {
              st.lastArgs = nextArgs;
              emit({
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: id,
                delta: nextArgs,
              });
            } else if (nextArgs.startsWith(st.lastArgs) && nextArgs.length > st.lastArgs.length) {
              const delta = nextArgs.slice(st.lastArgs.length);
              st.lastArgs = nextArgs;
              emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta });
            }
          }

          if (update.status === "completed" || update.status === "failed") {
            if (!st.ended) {
              st.ended = true;
              emit({ type: EventType.TOOL_CALL_END, toolCallId: id });
            }
            if (!st.resultSent) {
              st.resultSent = true;
              const outputText = extractAcpToolOutput(update);
              emit({
                type: EventType.TOOL_CALL_RESULT,
                messageId: crypto.randomUUID(),
                toolCallId: id,
                content: outputText,
                ...(update.status === "failed" ? { isError: true, error: outputText } : {}),
              });
            }
          }
          return;
        }

        if (update.sessionUpdate === "agent_message_chunk") {
          const delta = update.content.type === "text" ? update.content.text : "";
          if (!delta) return;
          closeThinking();
          if (!currentTextId) {
            currentTextId = crypto.randomUUID();
            activeParentMsgId = currentTextId;
            emit({
              type: EventType.TEXT_MESSAGE_START,
              messageId: currentTextId,
              role: "assistant",
            });
          }
          hasAssistantText = true;
          emit({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: currentTextId,
            delta,
          });
        }
      };

      const { blocks: attachmentBlocks, hasBinaryBlobs } =
        buildPromptBlocksFromAttachments(fileAttachments);
      const promptBlocks: acp.ContentBlock[] = [];
      if (trimmedText) {
        promptBlocks.push({ type: "text", text: trimmedText });
      }
      for (const img of messageImages) {
        promptBlocks.push({
          type: "image",
          mimeType: img.mimeType,
          data: img.data,
        });
      }
      promptBlocks.push(...attachmentBlocks);

      void (async () => {
        let tempAttachmentDir: string | null = null;
        try {
          let resp;
          try {
            resp = await sessionEntry.connection.agent.request(
              acp.AGENT_METHODS.session_prompt,
              {
                sessionId: sessionEntry.sessionId,
                prompt: promptBlocks,
              },
            );
          } catch (promptErr) {
            if (!hasBinaryBlobs || req.signal.aborted) {
              throw promptErr;
            }
            // Fallback for binary files (e.g. PDFs) if agent rejects inline BlobResourceContents
            const fallback = await buildFallbackBlocksWithTempFiles(fileAttachments);
            tempAttachmentDir = fallback.tempDir;
            const fallbackPrompt: acp.ContentBlock[] = [];
            if (trimmedText) {
              fallbackPrompt.push({ type: "text", text: trimmedText });
            }
            for (const img of messageImages) {
              fallbackPrompt.push({
                type: "image",
                mimeType: img.mimeType,
                data: img.data,
              });
            }
            fallbackPrompt.push(...fallback.blocks);
            resp = await sessionEntry.connection.agent.request(
              acp.AGENT_METHODS.session_prompt,
              {
                sessionId: sessionEntry.sessionId,
                prompt: fallbackPrompt,
              },
            );
          }

          closeThinking();
          // Ensure any pending interactive tools (e.g. ask_question) cleanly close at end_turn
          for (const [id, st] of toolState) {
            if (st.started && !st.ended) {
              st.ended = true;
              emit({ type: EventType.TOOL_CALL_END, toolCallId: id });
            }
            if (!st.resultSent) {
              st.resultSent = true;
              emit({
                type: EventType.TOOL_CALL_RESULT,
                messageId: crypto.randomUUID(),
                toolCallId: id,
                content: st.lastArgs || "Awaiting user response.",
              });
            }
          }

          if (!hasAssistantText) {
            // Silent slash commands like /compact produce no message chunks: synthesize an OpenUI status card
            const cmdLabel = trimmedText.startsWith("/") ? trimmedText.split(/\s+/)[0]! : "Command";
            const statusCard = buildStatusCardOpenUILang(
              `${cmdLabel} completed (${resp.stopReason})`,
              "Session state has been updated.",
              "success",
              sessionEntry.usage
                ? [
                    {
                      label: "Context Usage",
                      subtitle: "Updated window",
                      value: sessionEntry.usage.used.toLocaleString(),
                      subtext: `/ ${sessionEntry.usage.size.toLocaleString()} tokens`,
                      icon: "cpu",
                    },
                  ]
                : undefined,
            );
            const fallbackMsgId = crypto.randomUUID();
            emit({
              type: EventType.TEXT_MESSAGE_START,
              messageId: fallbackMsgId,
              role: "assistant",
            });
            emit({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: fallbackMsgId,
              delta: statusCard,
            });
            emit({ type: EventType.TEXT_MESSAGE_END, messageId: fallbackMsgId });
          } else {
            closeTextMessage();
          }

          emit({
            type: EventType.CUSTOM,
            name: "acp",
            value: { type: "session_snapshot", snapshot: buildSessionSnapshot(sessionEntry) },
          });
        } catch (err) {
          closeThinking();
          closeTextMessage();
          const msg = err instanceof Error ? err.message : String(err);
          emit({ type: EventType.RUN_ERROR, message: msg });
        } finally {
          if (tempAttachmentDir) {
            void fs.rm(tempAttachmentDir, { recursive: true, force: true }).catch(() => {});
          }
          sessionEntry.isStreaming = false;
          sessionEntry.lastUsed = Date.now();
          sessionEntry.activeUpdateListener = undefined;
          sessionEntry.activeCustomListener = undefined;
          finish();
        }
      })();

  return new Response(createRunSseStream(run, req.signal), {
    headers: SSE_HEADERS,
  });
}
