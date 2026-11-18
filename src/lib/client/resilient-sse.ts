"use client";

function waitUntilVisibleOrDelay(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    if (typeof document === "undefined" || document.visibilityState === "visible") {
      const t = setTimeout(resolve, 400);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
      return;
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        document.removeEventListener("visibilitychange", onVisible);
        setTimeout(resolve, 250);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    signal?.addEventListener(
      "abort",
      () => {
        document.removeEventListener("visibilitychange", onVisible);
        resolve();
      },
      { once: true },
    );
  });
}

function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (timeoutMs <= 0) {
    return reader.read();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      reject(new Error("SSE read inactivity timeout"));
    }, timeoutMs);
    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function isSseCommentFrame(frame: string): boolean {
  return frame.trimStart().startsWith(":");
}

export function createResilientSseStream(
  initialBody: ReadableStream<Uint8Array>,
  threadId: string,
  signal?: AbortSignal,
  options?: { inactivityTimeoutMs?: number; maxReattachAttempts?: number },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const inactivityTimeoutMs = options?.inactivityTimeoutMs ?? 25_000;
  const maxReattachAttempts = options?.maxReattachAttempts ?? 20;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let currentBody: ReadableStream<Uint8Array> | null = initialBody;
      let forwardedFrames = 0;
      let sawDone = false;
      let reattachAttempts = 0;

      while (currentBody && !sawDone && !signal?.aborted) {
        const reader = currentBody.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let framesInThisStream = 0;
        let streamError: unknown = null;

        try {
          while (true) {
            const { done, value } = await readWithTimeout(reader, inactivityTimeoutMs);
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let sepIdx = buffer.indexOf("\n\n");
            while (sepIdx !== -1) {
              const frame = buffer.slice(0, sepIdx + 2);
              buffer = buffer.slice(sepIdx + 2);

              if (!isSseCommentFrame(frame)) {
                framesInThisStream += 1;
                if (framesInThisStream > forwardedFrames) {
                  forwardedFrames = framesInThisStream;
                  controller.enqueue(encoder.encode(frame));
                  if (frame.startsWith("data: [DONE]")) {
                    sawDone = true;
                  }
                }
              }
              sepIdx = buffer.indexOf("\n\n");
            }
          }

          const tail = buffer + decoder.decode();
          if (tail.trim() && !isSseCommentFrame(tail)) {
            framesInThisStream += 1;
            if (framesInThisStream > forwardedFrames) {
              forwardedFrames = framesInThisStream;
              controller.enqueue(encoder.encode(tail));
              if (tail.includes("data: [DONE]")) {
                sawDone = true;
              }
            }
          }
        } catch (err) {
          streamError = err;
        }

        if (sawDone || signal?.aborted) {
          break;
        }

        if (reattachAttempts >= maxReattachAttempts) {
          if (streamError) {
            controller.error(streamError);
          } else {
            controller.close();
          }
          return;
        }

        reattachAttempts += 1;
        await waitUntilVisibleOrDelay(signal);
        if (signal?.aborted) {
          if (streamError) {
            controller.error(streamError);
          } else {
            controller.close();
          }
          return;
        }

        const resumeRes = await fetch(
          `/api/chat?threadId=${encodeURIComponent(threadId)}`,
          { signal },
        ).catch(() => null);

        if (!resumeRes?.ok || !resumeRes.body) {
          if (streamError) {
            controller.error(streamError);
          } else {
            controller.close();
          }
          return;
        }
        currentBody = resumeRes.body;
      }

      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  });
}
