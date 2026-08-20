/**
 * A deadline that actually stops the request.
 *
 * The previous timeout raced a timer against the whole request promise. Losing
 * that race rejected the caller, and nothing else: the browser kept the
 * connection open, the server kept doing the work, and a slow response
 * eventually arrived to nobody. A read that has given up should stop being a
 * read.
 *
 * So the deadline is expressed the way the platform expresses cancellation — as
 * an `AbortSignal` handed to `fetch` — and the timer aborts it. `Promise.race`
 * survives here only for dependencies that cannot accept a signal at all (the
 * Supabase auth call), and never for fetch itself.
 */

export class RequestTimeoutError extends Error {
  readonly code = "read_timeout";
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`The read exceeded its ${timeoutMs}ms deadline.`);
    this.name = "RequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface RequestDeadline {
  /** Hand this to `fetch`. Aborts on caller cancellation or on the deadline. */
  readonly signal: AbortSignal;
  /**
   * Release the timer and the caller listener. Safe to call more than once, and
   * required in a `finally` — a disposed deadline can no longer abort, so a
   * settled request cannot be cancelled retroactively.
   */
  dispose(): void;
}

/**
 * Compose the caller's cancellation with a time limit.
 *
 * The caller's reason is forwarded verbatim rather than replaced, because
 * "the component unmounted" and "the server took too long" are different facts
 * and retry policy has to tell them apart.
 */
export function withDeadline(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): RequestDeadline {
  const controller = new AbortController();

  if (callerSignal?.aborted) {
    controller.abort(callerSignal.reason);
    return { signal: controller.signal, dispose: () => {} };
  }

  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  const timer = setTimeout(() => {
    controller.abort(new RequestTimeoutError(timeoutMs));
  }, timeoutMs);

  let disposed = false;
  return {
    signal: controller.signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/**
 * Bound a promise that has no way to accept a signal.
 *
 * Only for such dependencies: the work itself is not cancelled, it is merely
 * stopped being waited on. Anything that can take a signal gets the signal.
 */
export function awaitWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
