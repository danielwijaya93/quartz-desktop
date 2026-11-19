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
  getExistingAcpSession,
  getOrCreateAcpSession,
} from "@/lib/acp/session-manager";
import {
  createAcpStreamTranslator,
  isAgyMalformedToolCallNotice,
} from "@/lib/acp/sse-translator";
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
  openuiEnabled?: boolean;
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
      openuiEnabled: body.openuiEnabled,
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
      try {
        sessionEntry = await getOrCreateAcpSession({
          threadId,
          openuiEnabled: body.openuiEnabled,
          cwd,
          additionalDirectories: body.additionalDirectories,
          mcpServers: body.mcpServers,
          mode: body.mode ?? "auto",
          model: body.model,
          thoughtLevel: body.thoughtLevel,
        });
      } catch (fallbackErr) {
        const message =
          fallbackErr instanceof Error
            ? fallbackErr.message
            : "Failed to start Antigravity ACP session.";
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
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

  const translator = createAcpStreamTranslator(emit);

  sessionEntry.isStreaming = true;
  sessionEntry.lastUsed = Date.now();

  sessionEntry.activeCustomListener = (payload) => {
    emit({ type: EventType.CUSTOM, name: "acp", value: payload });
  };
  sessionEntry.activeUpdateListener = translator.onUpdate;

  const buildPromptBlocks = (extraBlocks: acp.ContentBlock[]): acp.ContentBlock[] => {
    const blocks: acp.ContentBlock[] = [];
    if (trimmedText) {
      blocks.push({ type: "text", text: trimmedText });
    }
    for (const img of messageImages) {
      blocks.push({
        type: "image",
        mimeType: img.mimeType,
        data: img.data,
      });
    }
    blocks.push(...extraBlocks);
    return blocks;
  };

  const { blocks: attachmentBlocks, hasBinaryBlobs } =
    buildPromptBlocksFromAttachments(fileAttachments);
  const promptBlocks = buildPromptBlocks(attachmentBlocks);

  void (async () => {
    let tempAttachmentDir: string | null = null;
    try {
      const MAX_MALFORMED_RETRIES = 2;
      let resp: acp.PromptResponse;
      let retryCount = 0;
      let activePromptBlocks = promptBlocks;

      while (true) {
        try {
          resp = await sessionEntry.connection.agent.request(
            acp.AGENT_METHODS.session_prompt,
            {
              sessionId: sessionEntry.sessionId,
              prompt: activePromptBlocks,
            },
          );
        } catch (promptErr) {
          if (retryCount > 0 || !hasBinaryBlobs || req.signal.aborted) {
            throw promptErr;
          }
          // Fallback for binary files (e.g. PDFs) if agent rejects inline BlobResourceContents
          const fallback = await buildFallbackBlocksWithTempFiles(fileAttachments);
          tempAttachmentDir = fallback.tempDir;
          resp = await sessionEntry.connection.agent.request(
            acp.AGENT_METHODS.session_prompt,
            {
              sessionId: sessionEntry.sessionId,
              prompt: buildPromptBlocks(fallback.blocks),
            },
          );
        }

        if (
          resp.stopReason !== "cancelled" &&
          (translator.hasPendingBackgroundTask() || translator.hasOpenBackgroundTools())
        ) {
          const initialBgTasks = translator.getOpenBackgroundTasks();
          const initialBgIds = new Set(initialBgTasks.map((t) => t.id));
          emit({
            type: EventType.CUSTOM,
            name: "acp",
            value: { type: "background_tasks", tasks: initialBgTasks },
          });

          await new Promise<void>((resolveWait) => {
            const IDLE_SETTLE_MS = 1800;
            const MAX_WAIT_MS = 5 * 60 * 1000;
            let settleTimer: ReturnType<typeof setTimeout> | null = null;
            let maxTimer: ReturnType<typeof setTimeout> | null = null;
            let sawWakeupActivity = false;
            let lastTasksKey = JSON.stringify(initialBgTasks.map((t) => t.id));
            let done = false;

            const finishWait = () => {
              if (done) return;
              done = true;
              if (settleTimer) clearTimeout(settleTimer);
              if (maxTimer) clearTimeout(maxTimer);
              sessionEntry.onCancelTurn = undefined;
              sessionEntry.activeUpdateListener = translator.onUpdate;
              sessionEntry.activeCustomListener = (payload) => {
                emit({ type: EventType.CUSTOM, name: "acp", value: payload });
              };
              emit({
                type: EventType.CUSTOM,
                name: "acp",
                value: { type: "background_tasks", tasks: [] },
              });
              resolveWait();
            };

            const armSettle = (delayMs: number) => {
              if (!sawWakeupActivity) return;
              if (settleTimer) clearTimeout(settleTimer);
              settleTimer = setTimeout(() => {
                if (translator.hasPendingBackgroundTask()) {
                  translator.clearPendingBackgroundTask();
                  return;
                }
                if (
                  !translator.hasOpenBackgroundTools(initialBgIds) &&
                  sessionEntry.pendingPermissions.size === 0
                ) {
                  finishWait();
                }
              }, delayMs);
            };

            // Clear the initial turn's flag and close its text message so wakeup output starts cleanly
            translator.closeCurrentTextMessage();
            translator.clearPendingBackgroundTask();
            maxTimer = setTimeout(finishWait, MAX_WAIT_MS);
            sessionEntry.onCancelTurn = finishWait;

            sessionEntry.activeUpdateListener = (update) => {
              translator.onUpdate(update);
              sawWakeupActivity = true;
              if (maxTimer) clearTimeout(maxTimer);
              maxTimer = setTimeout(finishWait, MAX_WAIT_MS);

              const currentTasks = translator.getOpenBackgroundTasks();
              const nextKey = JSON.stringify(currentTasks.map((t) => t.id));
              if (nextKey !== lastTasksKey) {
                lastTasksKey = nextKey;
                emit({
                  type: EventType.CUSTOM,
                  name: "acp",
                  value: { type: "background_tasks", tasks: currentTasks },
                });
              }

              if (translator.hasPendingBackgroundTask()) {
                if (settleTimer) {
                  clearTimeout(settleTimer);
                  settleTimer = null;
                }
                return;
              }
              if (
                !translator.hasOpenBackgroundTools(initialBgIds) &&
                sessionEntry.pendingPermissions.size === 0
              ) {
                armSettle(IDLE_SETTLE_MS);
              } else if (settleTimer) {
                clearTimeout(settleTimer);
                settleTimer = null;
              }
            };

            sessionEntry.activeCustomListener = (payload) => {
              emit({ type: EventType.CUSTOM, name: "acp", value: payload });
              if (payload.type === "usage") {
                translator.closeCurrentTextMessage();
                if (
                  sawWakeupActivity &&
                  !translator.hasPendingBackgroundTask() &&
                  !translator.hasOpenBackgroundTools(initialBgIds) &&
                  sessionEntry.pendingPermissions.size === 0
                ) {
                  armSettle(400);
                }
              }
            };
          });
        }

        if (
          resp.stopReason !== "cancelled" &&
          !req.signal.aborted &&
          isAgyMalformedToolCallNotice(translator.getCurrentText()) &&
          retryCount < MAX_MALFORMED_RETRIES
        ) {
          retryCount += 1;
          translator.closeCurrentTextMessage();
          activePromptBlocks = [
            {
              type: "text",
              text: "Please retry with a properly formatted function call and continue.",
            },
          ];
          continue;
        }

        break;
      }

      if (isAgyMalformedToolCallNotice(translator.getCurrentText())) {
        translator.closeCurrentTextMessage();
        const errCard = buildStatusCardOpenUILang(
          "Function Call Retry Exhausted",
          "The model produced malformed function calls across automatic retries. Send a follow-up message to continue.",
          "error",
        );
        const errMsgId = crypto.randomUUID();
        emit({ type: EventType.TEXT_MESSAGE_START, messageId: errMsgId, role: "assistant" });
        emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: errMsgId, delta: errCard });
        emit({ type: EventType.TEXT_MESSAGE_END, messageId: errMsgId });
      }

      translator.flush();

      if (!translator.hasAssistantText()) {
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
      }

      sessionEntry.isStreaming = false;
      emit({
        type: EventType.CUSTOM,
        name: "acp",
        value: { type: "session_snapshot", snapshot: buildSessionSnapshot(sessionEntry) },
      });
    } catch (err) {
      translator.flush();
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
      sessionEntry.onCancelTurn = undefined;
      finish();
    }
  })();

  return new Response(createRunSseStream(run, req.signal), {
    headers: SSE_HEADERS,
  });
}
