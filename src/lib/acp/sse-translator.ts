import { extractAcpToolOutput } from "@/lib/acp/replay";
import type * as acp from "@agentclientprotocol/sdk";
import { EventType } from "@openuidev/react-headless";

export interface AcpStreamTranslator {
  onUpdate: (update: acp.SessionUpdate) => void;
  flush: () => void;
  closeCurrentTextMessage: () => void;
  hasAssistantText: () => boolean;
  hasPendingBackgroundTask: () => boolean;
  clearPendingBackgroundTask: () => void;
  hasOpenTools: () => boolean;
  getToolArgs: (toolCallId: string) => string | undefined;
}

/**
 * Translates streaming ACP `SessionUpdate` notifications into AG-UI SSE events.
 */
export function createAcpStreamTranslator(
  emit: (event: Record<string, unknown>) => void,
): AcpStreamTranslator {
  let currentTextId: string | null = null;
  let currentTextBuffer = "";
  let assistantTextEmitted = false;
  let pendingBackgroundTask = false;
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
    currentTextBuffer = "";
  };

  const onUpdate = (update: acp.SessionUpdate) => {
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
          if (outputText.includes("Tool is running as a background task")) {
            pendingBackgroundTask = true;
          }
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
      if (
        currentTextId &&
        /(?:^|\n)root\s*=/.test(currentTextBuffer) &&
        /(?:^|\n)root\s*=/.test(delta)
      ) {
        closeTextMessage();
      }
      if (!currentTextId) {
        currentTextId = crypto.randomUUID();
        currentTextBuffer = "";
        activeParentMsgId = currentTextId;
        emit({
          type: EventType.TEXT_MESSAGE_START,
          messageId: currentTextId,
          role: "assistant",
        });
      }
      currentTextBuffer += delta;
      assistantTextEmitted = true;
      emit({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: currentTextId,
        delta,
      });
    }
  };

  const flush = () => {
    closeThinking();
    closeTextMessage();
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
  };

  return {
    onUpdate,
    flush,
    closeCurrentTextMessage: closeTextMessage,
    hasAssistantText: () => assistantTextEmitted,
    hasPendingBackgroundTask: () => pendingBackgroundTask,
    clearPendingBackgroundTask: () => {
      pendingBackgroundTask = false;
    },
    hasOpenTools: () => Array.from(toolState.values()).some((st) => st.started && !st.ended),
    getToolArgs: (toolCallId: string) => toolState.get(toolCallId)?.lastArgs,
  };
}
