"use client";

import type { AcpCustomEventPayload } from "@/lib/acp/types";
import { acpStore } from "@/lib/client/acp-store";
import { agUIAdapter, EventType, type StreamProtocolAdapter } from "@openuidev/react-headless";

/**
 * Wraps OpenUI's AG-UI SSE adapter so custom `acp` events update client state
 * (slash commands, model/mode config, token usage, plan progress, permissions)
 * and tracks per-thread activity status (working, needs_input, unread) for the sidebar.
 */
export function createAcpStreamAdapter(
  getThreadId: (response: Response) => string,
): StreamProtocolAdapter {
  const inner = agUIAdapter();
  return {
    async *parse(response: Response) {
      let askedQuestion = false;
      let finished = false;
      let aborted = false;
      const threadId = getThreadId(response);

      try {
        for await (const event of inner.parse(response)) {
          const activeId = getThreadId(response) || threadId;

          if (event.type === EventType.CUSTOM && "name" in event && event.name === "acp") {
            const payload = (event as { value?: AcpCustomEventPayload }).value;
            if (payload) {
              acpStore.applyCustomEvent(activeId, payload);
            }
            continue;
          }

          if (event.type === EventType.RUN_STARTED && activeId) {
            askedQuestion = false;
            acpStore.setThreadStatus(activeId, "working");
          } else if (
            event.type === EventType.TOOL_CALL_START &&
            "toolCallName" in event &&
            event.toolCallName === "ask_question" &&
            activeId
          ) {
            askedQuestion = true;
            acpStore.setThreadStatus(activeId, "needs_input");
          } else if (event.type === EventType.RUN_FINISHED && activeId) {
            finished = true;
            acpStore.completeThreadRun(activeId, { needsInput: askedQuestion });
          } else if (event.type === EventType.RUN_ERROR && activeId) {
            finished = true;
            acpStore.completeThreadRun(activeId);
          }

          yield event;
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          aborted = true;
        } else if (err instanceof Error && err.name === "AbortError") {
          aborted = true;
        }
        throw err;
      } finally {
        const finalId = getThreadId(response) || threadId;
        // Do not mark a run complete on client abort (e.g. thread switch); the server run is still active.
        if (!aborted && !finished && finalId && acpStore.getState().threadStatus[finalId] === "working") {
          acpStore.completeThreadRun(finalId, { needsInput: askedQuestion });
        }
      }
    },
  };
}
