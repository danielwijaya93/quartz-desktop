import { afterEach, describe, expect, it, vi } from "vitest";
import { createResilientSseStream } from "./local-storage";

function streamFromChunks(chunks: string[], closeAtEnd = true): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      if (closeAtEnd) {
        controller.close();
      }
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

describe("createResilientSseStream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reattaches on clean EOF before [DONE] and ignores keepalive comments when deduplicating", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        streamFromChunks([
          'data: {"type":"RUN_STARTED"}\n\n',
          'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Finished"}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    // Initial stream sends 1 data frame + 2 keepalive comments, then closes cleanly without [DONE]
    const initial = streamFromChunks([
      'data: {"type":"RUN_STARTED"}\n\n',
      ": keepalive\n\n",
      ": keepalive\n\n",
    ]);

    const resilient = createResilientSseStream(initial, "thread-1", undefined, {
      inactivityTimeoutMs: 5000,
    });
    const text = await readAll(resilient);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(text).toBe(
      'data: {"type":"RUN_STARTED"}\n\n' +
        'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Finished"}\n\n' +
        "data: [DONE]\n\n",
    );
  });

  it("reattaches when the stream stalls past inactivityTimeoutMs", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        streamFromChunks([
          'data: {"type":"RUN_STARTED"}\n\n',
          'data: {"type":"RUN_FINISHED"}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    // Initial stream sends 1 frame and then stalls forever (never closes)
    const stalled = streamFromChunks(['data: {"type":"RUN_STARTED"}\n\n'], false);
    const resilient = createResilientSseStream(stalled, "thread-2", undefined, {
      inactivityTimeoutMs: 30,
    });
    const text = await readAll(resilient);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(text).toContain('"RUN_FINISHED"');
    expect(text).toContain("data: [DONE]");
  });
});
