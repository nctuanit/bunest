export interface AttemptTimer {
  readonly signal: AbortSignal;
  clear(): void;
}

export function createTimer(ms: number | undefined): AttemptTimer | undefined {
  if (!ms) {
    return undefined;
  }
  const controller = new AbortController();
  const handle = setTimeout(
    () =>
      controller.abort(
        new DOMException(`Timed out after ${ms}ms`, "TimeoutError"),
      ),
    ms,
  );
  return {
    signal: controller.signal,
    clear: () => clearTimeout(handle),
  };
}

function normalizeSignal(signal: AbortSignal): AbortSignal {
  if (signal instanceof AbortSignal) {
    return signal;
  }
  const controller = new AbortController();
  const duck = signal as unknown as {
    aborted?: boolean;
    reason?: unknown;
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  };
  if (duck.aborted) {
    controller.abort(duck.reason);
    return controller.signal;
  }
  const onAbort = () => {
    duck.removeEventListener?.("abort", onAbort);
    controller.abort(duck.reason);
  };
  duck.addEventListener?.("abort", onAbort);
  return controller.signal;
}

export function anySignal(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal {
  const present = signals
    .filter((s): s is AbortSignal => Boolean(s))
    .map(normalizeSignal);
  if (present.length === 0) {
    return new AbortController().signal;
  }
  return present.length === 1 ? present[0]! : AbortSignal.any(present);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The longest delay `setTimeout` supports (about 24.8 days); longer ones fire at once. */
export const MAX_TIMER_MS = 2_147_483_647;
