import { HttpException } from "@bunest/common";
import type { Subscribable, Unsubscribable } from "@bunest/core";
import {
  currentAttempt,
  runInAttempt,
} from "../context/attempt-scope.context";
import type { ResilienceEvent } from "../events/resilience-events.interface";
import { publish } from "../events/resilience.channels";
import type {
  AttemptContext,
  ExecuteOptions,
} from "../interfaces/execute-options.interface";
import {
  createColdStream,
  isSubscribable,
  type ReactiveStream,
} from "../utils/reactive.util";
import { linkSignal } from "../utils/timers.util";

/**
 * State threaded through the stages of one execution.
 * @internal
 */
export interface Execution extends AttemptContext {
  readonly source?: string;
  /**
   * True once the outcome can no longer be replaced: a subscribable already
   * emitted, or the HTTP response was committed. Retry, Fallback and Timeout
   * stand down from then on.
   */
  readonly committed: () => boolean;
  /** Turns a fallback result into the execution's result. */
  readonly adopt: (value: unknown) => Promise<unknown>;
  /** What entrypoint fallbacks receive as their second argument (Bunest's `ExecutionContext`). */
  readonly invocation?: unknown;
}

/** @internal */
export type Next<T> = (execution: Execution) => Promise<T>;

/** @internal Options only the entrypoint interceptor passes. */
export interface ObserveOptions extends ExecuteOptions {
  /** Extra "the outcome is already committed" check (the interceptor checks headers sent). */
  committed?: () => boolean;
  invocation?: unknown;
}

/**
 * A resilience policy. Every primitive (`RetryPolicy`, `TimeoutPolicy`,
 * `CircuitBreakerPolicy`, `BulkheadPolicy`, `OutboundRateLimitPolicy`,
 * `FallbackPolicy`), every composition (`ResiliencePolicy.wrap(...)`) and
 * every preset (`ResilienceService.preset(name)`) is one.
 */
export abstract class ResiliencePolicy {
  /** Labels this policy's events (`policy`) and errors. */
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  /**
   * Composes policies in the order given: the first is outermost.
   * `ResiliencePolicy.wrap(fallback, retry, breaker, timeout)` runs
   * `fallback(retry(breaker(timeout(call))))`.
   */
  static wrap(...policies: ResiliencePolicy[]): ResiliencePolicy {
    return new PolicyWrap(
      policies.flatMap((p) => (p instanceof PolicyWrap ? p.policies : [p])),
    );
  }

  /** @internal Runs `next` under this policy. */
  abstract run<T>(next: Next<T>, execution: Execution): Promise<T>;

  /**
   * Runs `fn` under this policy. `fn` may be called several times (by a
   * retry) and receives its attempt's signal, which it should honor. While
   * `fn` runs, `ResilienceContext` reports that attempt.
   */
  execute<T>(
    fn: (context: AttemptContext) => T | PromiseLike<T>,
    options: ExecuteOptions = {},
  ): Promise<T> {
    const signal =
      options.signal ?? currentAttempt()?.signal ?? new AbortController().signal;
    if (signal.aborted) {
      return Promise.reject(signal.reason);
    }
    const execution: Execution = {
      signal,
      attempt: 1,
      source: options.source,
      committed: () => false,
      adopt: async (value) => value,
    };
    return this.run(
      async ({ signal: attemptSignal, attempt }) =>
        runInAttempt(
          { signal: attemptSignal, attempt },
          () => fn({ signal: attemptSignal, attempt }),
          true,
        ),
      execution,
    );
  }

  /**
   * Zero-RxJS reactive flavor (ADR-008): every attempt calls `factory` and
   * subscribes to what it returns, forwarding values as they arrive. The
   * returned stream is cold (`Subscribable<T> & AsyncIterable<T>`);
   * unsubscribing cancels the execution. Once a value has been emitted the
   * outcome is committed.
   */
  executeObservable<T>(
    factory: (context: AttemptContext) => Subscribable<T>,
    options: ExecuteOptions = {},
  ): ReactiveStream<T> {
    return observe(this, factory, options);
  }

  protected emit(event: ResilienceEvent): void {
    publish(this, event);
  }
}

/** @internal Promise-based execution helper for Bunest's Promise-native entrypoint interceptor. */
export function executeEntrypoint<T>(
  policy: ResiliencePolicy,
  fn: (context: AttemptContext) => T | PromiseLike<T>,
  options: ObserveOptions = {},
): Promise<T> {
  const signal =
    options.signal ?? currentAttempt()?.signal ?? new AbortController().signal;
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  const execution: Execution = {
    signal,
    attempt: 1,
    source: options.source,
    invocation: options.invocation,
    committed: () => options.committed?.() ?? false,
    adopt: async (value) => value,
  };
  return policy.run(
    async ({ signal: attemptSignal, attempt }) =>
      runInAttempt(
        { signal: attemptSignal, attempt },
        () => fn({ signal: attemptSignal, attempt }),
        true,
      ),
    execution,
  );
}

/** @internal `executeObservable()`, plus the interceptor's options. */
export function observe<T>(
  policy: ResiliencePolicy,
  factory: (context: AttemptContext) => Subscribable<T>,
  options: ObserveOptions = {},
): ReactiveStream<T> {
  return createColdStream<T>((subscriber) => {
    const controller = new AbortController();
    const outer = options.signal ?? currentAttempt()?.signal;
    const unlink = outer ? linkSignal(outer, controller) : () => undefined;
    const { signal } = controller;
    let emitted = false;
    let settled = false;

    const forward = (
      source: Subscribable<T>,
      attemptSignal: AbortSignal,
    ): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        if (attemptSignal.aborted) {
          reject(attemptSignal.reason);
          return;
        }
        let sub: Unsubscribable | undefined;
        const onAbort = () => {
          sub?.unsubscribe();
          reject(attemptSignal.reason);
        };
        attemptSignal.addEventListener("abort", onAbort, { once: true });
        sub = source.subscribe({
          next: (value) => {
            emitted = true;
            subscriber.next(value);
          },
          error: (error) => {
            attemptSignal.removeEventListener("abort", onAbort);
            reject(error);
          },
          complete: () => {
            attemptSignal.removeEventListener("abort", onAbort);
            resolve();
          },
        });
        if (attemptSignal.aborted) {
          sub.unsubscribe();
        }
      });

    const execution: Execution = {
      signal,
      attempt: 1,
      source: options.source,
      invocation: options.invocation,
      committed: () => emitted || (options.committed?.() ?? false),
      adopt: async (value) => {
        if (isSubscribable<T>(value)) {
          return forward(value, signal);
        }
        const resolved = (await value) as T;
        emitted = true;
        subscriber.next(resolved);
        return undefined;
      },
    };

    if (signal.aborted) {
      unlink();
      subscriber.error(signal.reason);
      return;
    }

    policy
      .run(
        async ({ signal: attemptSignal, attempt }) =>
          runInAttempt(
            { signal: attemptSignal, attempt },
            () => forward(factory({ signal: attemptSignal, attempt }), attemptSignal),
            true,
          ),
        execution,
      )
      .then(
        () => {
          settled = true;
          unlink();
          subscriber.complete();
        },
        (error) => {
          settled = true;
          unlink();
          subscriber.error(error);
        },
      );

    return () => {
      if (!settled) {
        controller.abort();
      }
      unlink();
    };
  });
}

/** @internal Policies composed in explicit order: the first is outermost. */
export class PolicyWrap extends ResiliencePolicy {
  readonly policies: readonly ResiliencePolicy[];

  constructor(policies: readonly ResiliencePolicy[]) {
    super(policies.map((p) => p.name).join(" > ") || "noop");
    this.policies = policies;
  }

  /** @internal */
  override run<T>(next: Next<T>, execution: Execution): Promise<T> {
    let chain = next;
    for (let i = this.policies.length - 1; i >= 0; i--) {
      const policy = this.policies[i]!;
      const inner = chain;
      chain = (e) => policy.run(inner, e);
    }
    return chain(execution);
  }
}

/** Dependency answers that mean "slow down" rather than "your request is wrong". */
const BACK_PRESSURE_STATUSES = new Set([408, 429]);

/**
 * Errors caused by the request rather than by a failing dependency. By default
 * they are not retried, not recorded by breakers and not replaced by fallbacks:
 *
 * - `HttpException`s below 500: the handler rejected its caller's request.
 * - Any other error with a numeric `status` or `statusCode` from 400 to 499
 *   (except 408 and 429, which represent dependency back-pressure).
 */
export function isClientError(error: unknown): boolean {
  if (error instanceof HttpException) {
    return error.getStatus() < 500;
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { status, statusCode } = error as {
    status?: unknown;
    statusCode?: unknown;
  };
  const code = typeof status === "number" ? status : statusCode;
  return (
    typeof code === "number" &&
    code >= 400 &&
    code < 500 &&
    !BACK_PRESSURE_STATUSES.has(code)
  );
}

/**
 * @internal Executions whose signal aborted before the dependency was called.
 */
export const abortedBeforeCall = new WeakSet<Execution>();

/** @internal Runs `next`, turning a synchronous throw into a rejection. */
export function call<T>(next: Next<T>, execution: Execution): Promise<T> {
  try {
    return next(execution);
  } catch (error) {
    return Promise.reject(error);
  }
}
