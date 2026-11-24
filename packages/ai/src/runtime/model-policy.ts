import { Logger } from "@bunest/core";
import type {
  Subscribable,
  SubscribableObserver,
  Unsubscribable,
} from "@bunest/core";
import {
  FallbackPolicy,
  ResilienceContext,
  ResilienceError,
  ResiliencePolicy,
  ResilienceTimeoutError,
  RetryPolicy,
  TimeoutPolicy,
  type AttemptContext,
  type Duration,
  type RetryOptions,
} from "@bunest/resilience";
import type { AiModelInfo } from "../interfaces/ai-types.interface";
import type { ResolvedModel } from "../models/ai-models.service";
import {
  AiBudgetExceededError,
  AiConfigurationError,
  AiModelError,
  AiOutputError,
  type AiAttemptFailure,
} from "../errors/ai.errors";
import { toMilliseconds } from "../utils/duration.util";

const logger = new Logger("AiModule");

/** Argument errors which no retry or fallback model can fix. */
const CALLER_MISTAKES = new Set([
  "AI_InvalidPromptError",
  "AI_InvalidArgumentError",
  "AI_InvalidMessageRoleError",
  "AI_MessageConversionError",
]);

const DEFAULT_TIMEOUT: Duration = "60s";
const DEFAULT_BACKOFF = { delay: 1_000, factor: 2, maxDelay: 30_000 } as const;

/** The identity the policy layer needs. */
export interface PolicyModel {
  info: AiModelInfo;
}

/** What one attempt of a model call receives. */
export interface StepAttempt<M extends PolicyModel = ResolvedModel> {
  model: M;
  /** 1-based, per model. */
  attempt: number;
  fallback: boolean;
  /** Aborted by the caller, or by the attempt's timeout. */
  signal: AbortSignal;
  /** Commits the attempt. */
  commit(): void;
  /** Sends a stream chunk to the consumer. */
  emit(chunk: unknown): void;
}

/** How a call's models are retried, timed out and replaced. Internal. */
export interface PolicyPlan<M extends PolicyModel = ResolvedModel> {
  chain: M[];
  /** The caller's signal. */
  signal: AbortSignal;
  /** Labels the policies' events. */
  source: string;
  /** The model's own policy. */
  policyFor(model: M): ResiliencePolicy | undefined;
  fallbackIf: (error: unknown) => boolean;
}

type StepStreamEvent<T, M extends PolicyModel> =
  | { type: "commit" }
  | { type: "chunk"; chunk: unknown }
  | { type: "outcome"; value: T; attempt: StepAttempt<M> };

/** Minimal cold Subscribable<T> adapter (zero RxJS per ADR-008). */
function createAttemptSubscribable<T>(
  subscribeFn: (
    observer: Required<SubscribableObserver<T>> & { readonly closed: boolean },
  ) => (() => void) | void,
): Subscribable<T> {
  return {
    subscribe(
      observerOrNext?: SubscribableObserver<T> | ((value: T) => void),
      error?: (err: unknown) => void,
      complete?: () => void,
    ): Unsubscribable {
      const obs: SubscribableObserver<T> =
        typeof observerOrNext === "function"
          ? { next: observerOrNext, error, complete }
          : (observerOrNext ?? {});
      let closed = false;
      let teardown: (() => void) | void;
      const wrapped = {
        get closed() {
          return closed;
        },
        next(value: T) {
          if (!closed) obs.next?.(value);
        },
        error(err: unknown) {
          if (!closed) {
            closed = true;
            obs.error?.(err);
          }
        },
        complete() {
          if (!closed) {
            closed = true;
            obs.complete?.();
          }
        },
      };
      teardown = subscribeFn(wrapped);
      return {
        unsubscribe() {
          if (!closed) {
            closed = true;
            teardown?.();
          }
        },
      };
    },
  };
}

/**
 * Runs one model call (a step) under the call's policies: the model's own (retry, timeout, or the application's),
 * then each fallback model's, through `@bunest/resilience`'s zero-RxJS `executeObservable()`.
 */
export function runStep<T, M extends PolicyModel = ResolvedModel>(
  plan: PolicyPlan<M>,
  run: (attempt: StepAttempt<M>) => Promise<T>,
  emit?: (chunk: unknown) => void,
): Promise<{
  value: T;
  attempt: StepAttempt<M>;
  attempts: number;
}> {
  const failures: AiAttemptFailure[] = [];
  let attempts = 0;

  const attemptsOf =
    (index: number) =>
    (context: AttemptContext): Subscribable<StepStreamEvent<T, M>> =>
      createAttemptSubscribable<StepStreamEvent<T, M>>((subscriber) => {
        attempts++;
        const model = plan.chain[index]!;
        let settled = false;
        let committed = false;

        const record = (error: unknown) => {
          if (!settled) {
            settled = true;
            const reason = context.signal.aborted
              ? context.signal.reason
              : undefined;
            failures.push({
              model: model.info,
              attempt: context.attempt,
              error:
                reason instanceof ResilienceTimeoutError
                  ? reason
                  : unwrap(error),
            });
          }
        };

        const attempt: StepAttempt<M> = {
          model,
          attempt: context.attempt,
          fallback: index > 0,
          signal: context.signal,
          commit: () => {
            if (!committed && !subscriber.closed) {
              committed = true;
              subscriber.next({ type: "commit" });
            }
          },
          emit: (chunk: unknown) => {
            committed = true;
            subscriber.next({ type: "chunk", chunk });
          },
        };

        run(attempt).then(
          (value) => {
            settled = true;
            subscriber.next({ type: "outcome", value, attempt });
            subscriber.complete();
          },
          (error) => {
            record(error);
            subscriber.error(unwrap(error));
          },
        );

        return () => record(context.signal.reason);
      });

  const policyAt = (index: number): ResiliencePolicy => {
    const model = plan.chain[index]!;
    const own = plan.policyFor(model);
    const policies: ResiliencePolicy[] = [];
    if (index < plan.chain.length - 1) {
      policies.push(
        new FallbackPolicy(
          (error, context) => {
            logger.warn(
              `The model "${labelOf(model)}" failed (${describeError(error)}); falling back to "${labelOf(plan.chain[index + 1]!)}".`,
            );
            return policyAt(index + 1).executeObservable(
              attemptsOf(index + 1),
              {
                signal: context.signal,
                source: plan.source,
              },
            );
          },
          {
            name: `${nameOf(model)} fallback`,
            handleIf: (error) =>
              isFallbackable(error) && plan.fallbackIf(error),
          },
        ),
      );
    }
    if (own) {
      policies.push(own);
    }
    return ResiliencePolicy.wrap(...policies);
  };

  const ambient = new ResilienceContext().signal;
  const signal = ambient
    ? AbortSignal.any([plan.signal, ambient])
    : plan.signal;

  return new Promise((resolve, reject) => {
    let outcome: { value: T; attempt: StepAttempt<M> } | undefined;
    policyAt(0)
      .executeObservable(attemptsOf(0), { signal, source: plan.source })
      .subscribe({
        next: (event) => {
          if (event.type === "chunk") {
            emit?.(event.chunk);
          } else if (event.type === "outcome") {
            outcome = { value: event.value, attempt: event.attempt };
          }
        },
        error: (error) => reject(finalError(error, failures, signal)),
        complete: () =>
          outcome
            ? resolve({ ...outcome, attempts })
            : reject(
                finalError(
                  new Error("The model call ended without an answer"),
                  failures,
                  signal,
                ),
              ),
      });
  });
}

/**
 * The model's own policy from its settings: `RetryPolicy` (honoring `retry-after`) around
 * `TimeoutPolicy`, either one omitted when `false`.
 */
export function modelPolicy(
  model: PolicyModel,
  {
    retry,
    timeout,
  }: {
    retry: RetryOptions | false | undefined;
    timeout: Duration | false | undefined;
  },
  namespace = "ai",
): ResiliencePolicy | undefined {
  const policies: ResiliencePolicy[] = [];
  if (retry !== false) {
    policies.push(retryPolicy(model, retry ?? {}, namespace));
  }
  if (timeout !== false) {
    policies.push(
      new TimeoutPolicy({
        timeout: toMilliseconds(timeout ?? DEFAULT_TIMEOUT, "timeout"),
        name: `${nameOf(model, namespace)} timeout`,
      }),
    );
  }
  return policies.length > 0 ? ResiliencePolicy.wrap(...policies) : undefined;
}

function retryPolicy(
  model: PolicyModel,
  retry: RetryOptions,
  namespace: string,
): RetryPolicy {
  const backoff = retry.backoff;
  const maxDelay =
    typeof backoff === "object" && backoff.maxDelay !== undefined
      ? toMilliseconds(backoff.maxDelay, "retry.backoff.maxDelay")
      : DEFAULT_BACKOFF.maxDelay;
  const retryIf = retry.retryIf ?? isRetryable;
  return new RetryPolicy({
    name: `${nameOf(model, namespace)} retry`,
    attempts: retry.attempts ?? 3,
    ...(retry.retryOnResult && { retryOnResult: retry.retryOnResult }),
    retryIf: (error, attempt) =>
      !(error instanceof AiOutputError) &&
      (retryAfter(error) ?? 0) <= maxDelay &&
      retryIf(error, attempt),
    backoff:
      typeof backoff === "function"
        ? backoff
        : (attempt, error) =>
            retryAfter(error) ??
            exponential(attempt, { ...DEFAULT_BACKOFF, ...backoff }),
  });
}

/** What is retried by default: provider-retryable errors (including 408/409/429/5xx & network failures) and timeouts. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ResilienceTimeoutError) {
    return true;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return false;
  }
  if (typeof error === "object" && error !== null) {
    const e = error as Record<string, any>;
    if (e["isRetryable"] === true) return true;
    if (e["isRetryable"] === false) return false;
    const status =
      typeof e["statusCode"] === "number"
        ? e["statusCode"]
        : typeof e["status"] === "number"
          ? e["status"]
          : undefined;
    if (status !== undefined) {
      return (
        status === 408 || status === 409 || status === 429 || status >= 500
      );
    }
    if (
      e["code"] === "ECONNRESET" ||
      e["code"] === "ECONNREFUSED" ||
      e["code"] === "ETIMEDOUT" ||
      e["code"] === "UND_ERR_SOCKET"
    ) {
      return true;
    }
  }
  return false;
}

function isFallbackable(error: unknown): boolean {
  return (
    !(error instanceof AiOutputError) &&
    !(error instanceof Error && CALLER_MISTAKES.has(error.name))
  );
}

function finalError(
  error: unknown,
  failures: AiAttemptFailure[],
  signal: AbortSignal,
): unknown {
  if (signal.aborted) {
    return signal.reason;
  }
  if (
    error instanceof AiOutputError ||
    error instanceof AiBudgetExceededError ||
    error instanceof AiConfigurationError
  ) {
    return error;
  }
  if (
    error instanceof ResilienceError &&
    !(error instanceof ResilienceTimeoutError)
  ) {
    return error;
  }
  return new AiModelError(
    failures.length > 0
      ? failures
      : [
          {
            model: { provider: "unknown", modelId: "unknown" },
            attempt: 1,
            error,
          },
        ],
  );
}

function unwrap(error: unknown): unknown {
  if (
    typeof error === "object" &&
    error !== null &&
    "lastError" in error &&
    (error as { name?: unknown }).name === "AI_RetryError"
  ) {
    return (error as { lastError?: unknown }).lastError ?? error;
  }
  return error;
}

function exponential(
  attempt: number,
  {
    delay,
    factor = 2,
    maxDelay,
    jitter = "full",
  }: {
    delay?: Duration;
    factor?: number;
    maxDelay?: Duration;
    jitter?: "full" | "equal" | "none";
  },
): number {
  const max = toMilliseconds(
    maxDelay ?? DEFAULT_BACKOFF.maxDelay,
    "retry.backoff.maxDelay",
  );
  const computed = Math.min(
    max,
    toMilliseconds(delay ?? DEFAULT_BACKOFF.delay, "retry.backoff.delay") *
      Math.max(1, factor) ** (attempt - 1),
  );
  switch (jitter) {
    case "none":
      return computed;
    case "equal":
      return computed / 2 + Math.random() * (computed / 2);
    default:
      return Math.random() * computed;
  }
}

function retryAfter(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const rawHeaders = (error as { responseHeaders?: Record<string, string> })
    .responseHeaders;
  if (!rawHeaders) return undefined;
  const headers = Object.fromEntries(
    Object.entries(rawHeaders).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  const ms = Number.parseFloat(headers["retry-after-ms"] ?? "");
  if (Number.isFinite(ms) && ms >= 0) {
    return ms;
  }
  const value = headers["retry-after"];
  if (value === undefined) return undefined;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function nameOf(model: PolicyModel, namespace = "ai"): string {
  return `${namespace}:${labelOf(model)}`;
}

function labelOf(model: PolicyModel): string {
  return model.info.name ?? `${model.info.provider}:${model.info.modelId}`;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const { statusCode, status } = error as Error & {
    statusCode?: unknown;
    status?: unknown;
  };
  const code =
    typeof statusCode === "number"
      ? statusCode
      : typeof status === "number"
        ? status
        : undefined;
  return `${error.constructor.name}${code !== undefined ? `, ${code}` : ""}: ${error.message}`;
}
