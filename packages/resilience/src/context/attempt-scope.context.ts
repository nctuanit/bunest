import { ContextStorage } from "@bunest/core";

/** The attempt a piece of code runs in: set per attempt by entrypoints and `execute()`. */
export interface AttemptScope {
  readonly signal: AbortSignal;
  readonly attempt: number;
}

interface StoredAttempt extends AttemptScope {
  readonly parent: StoredAttempt | undefined;
  ended: boolean;
}

const storage = new ContextStorage<StoredAttempt>();

function currentScope(): StoredAttempt | undefined {
  let scope = storage.getStore();
  while (scope?.ended) {
    scope = scope.parent;
  }
  return scope;
}

/**
 * @internal Runs `fn` with `scope` as the current attempt. With
 * `endsWhenSettled` (the attempts policies run), the scope stops being
 * current once `fn`'s result settles or the attempt's signal aborts (a
 * timeout, a cancelled execution), whichever comes first.
 */
export function runInAttempt<T>(
  scope: AttemptScope,
  fn: () => T,
  endsWhenSettled = false,
): T {
  const stored: StoredAttempt = {
    signal: scope.signal,
    attempt: scope.attempt,
    parent: endsWhenSettled ? currentScope() : undefined,
    ended: false,
  };
  if (!endsWhenSettled) {
    return storage.run(stored, fn);
  }

  const end = () => {
    stored.ended = true;
    scope.signal.removeEventListener("abort", end);
  };

  if (scope.signal.aborted) {
    end();
  } else {
    scope.signal.addEventListener("abort", end, { once: true });
  }

  let result: T;
  try {
    result = storage.run(stored, fn);
  } catch (error) {
    end();
    throw error;
  }

  if (
    result !== null &&
    (typeof result === "object" || typeof result === "function") &&
    typeof (result as unknown as PromiseLike<unknown>).then === "function"
  ) {
    (result as unknown as PromiseLike<unknown>).then(end, end);
  } else {
    end();
  }
  return result;
}

/** @internal The innermost attempt the calling code runs in that hasn't ended, if any. */
export function currentAttempt(): AttemptScope | undefined {
  return currentScope();
}

/** @internal What `@Signal()` injects; bootstrap looks for it to find handlers that use `@Signal()`. */
export function signalOfAttempt(): AbortSignal | undefined {
  return currentAttempt()?.signal;
}
