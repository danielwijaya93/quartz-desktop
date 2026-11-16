import { describe, expect, it } from "vitest";
import {
  createBufferedRun,
  createRunSseStream,
  finishBufferedRun,
  pushRunEvent,
} from "./run-buffer";

async function readAllText(stream: ReadableStream<Uint8Array>): Promise<string> {
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

describe("run-buffer", () => {
  it("replays buffered events and streams live events after reattach without cancelling", async () => {
    const run = createBufferedRun("t1", "r1");
    pushRunEvent(run, 'data: {"type":"RUN_STARTED"}\n\n');
    pushRunEvent(run, 'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Hello"}\n\n');

    // Simulate first client disconnecting early
    const controller = new AbortController();
    const firstStream = createRunSseStream(run, controller.signal);
    const reader1 = firstStream.getReader();
    const firstChunk = await reader1.read();
    expect(firstChunk.done).toBe(false);
    controller.abort();

    // Server keeps emitting while client is disconnected
    pushRunEvent(run, 'data: {"type":"TEXT_MESSAGE_CONTENT","delta":" world"}\n\n');

    // Second client reattaches via GET /api/chat and receives everything + live finish
    const secondStream = createRunSseStream(run);
    const secondPromise = readAllText(secondStream);
    finishBufferedRun(run);

    const replayed = await secondPromise;
    expect(replayed).toContain('"delta":"Hello"');
    expect(replayed).toContain('"delta":" world"');
    expect(replayed).toContain("data: [DONE]");
  });

  it("immediately replays and closes when reattaching to an already-finished run", async () => {
    const run = createBufferedRun("t2", "r2");
    pushRunEvent(run, 'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Done"}\n\n');
    finishBufferedRun(run);

    const text = await readAllText(createRunSseStream(run));
    expect(text).toBe('data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Done"}\n\ndata: [DONE]\n\n');
  });
});
