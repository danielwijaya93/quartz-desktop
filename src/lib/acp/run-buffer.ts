export interface BufferedRun {
  runId: string;
  threadId: string;
  events: string[];
  done: boolean;
  startedAt: number;
  finishedAt?: number;
  subscribers: Set<(chunk: string | null) => void>;
}

const encoder = new TextEncoder();

export function createBufferedRun(threadId: string, runId: string): BufferedRun {
  return {
    runId,
    threadId,
    events: [],
    done: false,
    startedAt: Date.now(),
    subscribers: new Set(),
  };
}

export function pushRunEvent(run: BufferedRun, sseFrame: string): void {
  if (run.done) return;
  run.events.push(sseFrame);
  for (const notify of run.subscribers) {
    notify(sseFrame);
  }
}

export function finishBufferedRun(run: BufferedRun, doneFrame = "data: [DONE]\n\n"): void {
  if (run.done) return;
  run.events.push(doneFrame);
  run.done = true;
  run.finishedAt = Date.now();
  for (const notify of run.subscribers) {
    notify(doneFrame);
    notify(null);
  }
  run.subscribers.clear();
}

/**
 * Creates a `ReadableStream` that replays all buffered SSE frames for `run` from the start
 * and streams any subsequent live frames until completion. Aborting `signal` detaches only
 * this HTTP reader without cancelling the underlying ACP turn.
 */
export function createRunSseStream(
  run: BufferedRun,
  signal?: AbortSignal,
  options?: { heartbeatMs?: number },
): ReadableStream<Uint8Array> {
  const heartbeatMs = options?.heartbeatMs ?? 10_000;
  let unsubscribe: (() => void) | null = null;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      const closeStream = () => {
        if (closed) return;
        closed = true;
        if (heartbeatTimer !== null) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        unsubscribe?.();
        unsubscribe = null;
        try {
          controller.close();
        } catch {
          // stream already closed
        }
      };

      const replayCount = run.events.length;
      for (let i = 0; i < replayCount; i += 1) {
        const frame = run.events[i];
        if (frame) {
          controller.enqueue(encoder.encode(frame));
        }
      }

      if (run.done) {
        closeStream();
        return;
      }

      if (heartbeatMs > 0) {
        heartbeatTimer = setInterval(() => {
          if (closed || run.done) return;
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            closeStream();
          }
        }, heartbeatMs);
      }

      const listener = (chunk: string | null) => {
        if (closed) return;
        if (chunk === null) {
          closeStream();
          return;
        }
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closeStream();
        }
      };

      run.subscribers.add(listener);
      const onAbort = () => closeStream();
      signal?.addEventListener("abort", onAbort, { once: true });

      unsubscribe = () => {
        if (heartbeatTimer !== null) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        run.subscribers.delete(listener);
        signal?.removeEventListener("abort", onAbort);
      };
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
    },
  });
}
