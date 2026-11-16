"use client";

import type { AcpCustomEventPayload } from "@/lib/acp/types";
import { acpStore } from "@/lib/client/acp-store";
import { agUIAdapter, EventType, type StreamProtocolAdapter } from "@openuidev/react-headless";

/**
 * Wraps OpenUI's AG-UI SSE adapter so custom `acp` events update client state
 * (slash commands, model/mode config, token usage, plan progress, permissions)
 * while standard AG-UI events flow unmodified into OpenUI's chat store.
 */
export function createAcpStreamAdapter(getThreadId: () => string): StreamProtocolAdapter {
  const inner = agUIAdapter();
  return {
    async *parse(response: Response) {
      for await (const event of inner.parse(response)) {
        if (event.type === EventType.CUSTOM && "name" in event && event.name === "acp") {
          const payload = (event as { value?: AcpCustomEventPayload }).value;
          if (payload) {
            acpStore.applyCustomEvent(getThreadId(), payload);
          }
          continue;
        }
        yield event;
      }
    },
  };
}
