import { HttpNetworkError } from "../errors/http-network.error";
import { HttpTimeoutError } from "../errors/http-timeout.error";
import type { HttpRequest } from "../interfaces/http-request.interface";
import type {
  HttpBackoffOptions,
  HttpRetryOptions,
} from "../interfaces/http-retry-options.interface";
import type { Duration } from "../types/duration.type";
import { durationOption } from "./duration.util";
import { toResponseError } from "./response.util";
import { parseRetryAfter } from "./retry-after.util";

export interface ResolvedBackoff {
  delay: number;
  factor: number;
  maxDelay: number;
  jitter: "full" | "equal" | "none";
}

export interface ResolvedRetry {
  attempts: number;
  methods: string[];
  statusCodes: number[];
  backoff: ResolvedBackoff | ((attempt: number, error: unknown) => Duration);
  maxRetryAfter: number;
  retryIf?: ((error: unknown, attempt: number) => boolean) | undefined;
}

/**
 * Asks `retryIf`, which may only narrow the defaults. What it throws
 * propagates; a Promise is refused, since it would always count as `true`.
 */
export function shouldRetry(
  retry: ResolvedRetry,
  error: unknown,
  attempt: number,
): boolean {
  if (!retry.retryIf) {
    return true;
  }
  const verdict = retry.retryIf(error, attempt) as unknown;
  if (
    verdict !== null &&
    (typeof verdict === "object" || typeof verdict === "function") &&
    typeof (verdict as PromiseLike<unknown>).then === "function"
  ) {
    (verdict as PromiseLike<unknown>).then(undefined, () => undefined);
    throw new TypeError(
      "HttpClient `retry.retryIf` must return a boolean, not a Promise",
    );
  }
  return Boolean(verdict);
}

/**
 * The wait before retrying a response with a retryable status, or `undefined`
 * to stop. `Retry-After` replaces the backoff, and one longer than
 * `maxDelay` is not waited out.
 */
export async function retryDelay(
  retry: ResolvedRetry,
  response: Response,
  request: HttpRequest,
  attempt: number,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const error =
    retry.retryIf || typeof retry.backoff === "function"
      ? await toResponseError(
          response.clone() as unknown as Response,
          request,
          signal,
        )
      : undefined;
  if (retry.retryIf && !shouldRetry(retry, error, attempt)) {
    return undefined;
  }
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  if (retryAfter !== undefined) {
    return retryAfter <= retry.maxRetryAfter ? retryAfter : undefined;
  }
  return backoffDelay(retry, attempt, error);
}

/**
 * Connection-level failures and timeouts. A network error without a `code`
 * fails the same way on every attempt.
 */
export function isTransient(error: unknown): boolean {
  if (error instanceof HttpTimeoutError) {
    return true;
  }
  return (
    error instanceof HttpNetworkError &&
    typeof (error.cause as { code?: unknown } | null | undefined)?.code ===
      "string"
  );
}

const DEFAULT_BACKOFF: ResolvedBackoff = {
  delay: 200,
  factor: 2,
  maxDelay: 30_000,
  jitter: "full",
};

export const DEFAULT_RETRY = {
  attempts: 3,
  methods: ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"],
  statusCodes: [408, 429, 500, 502, 503, 504],
  backoff: DEFAULT_BACKOFF,
};

/**
 * Layers retry settings (`forRoot()` -> client -> request).
 */
export function mergeRetry(
  base: number | false | HttpRetryOptions | undefined,
  layer: number | false | HttpRetryOptions | undefined,
): number | false | HttpRetryOptions | undefined {
  if (layer === undefined) {
    return base;
  }
  if (layer === false) {
    return false;
  }
  const previous: HttpRetryOptions =
    typeof base === "number" ? { attempts: base } : base || {};
  const next: HttpRetryOptions =
    typeof layer === "number" ? { attempts: layer } : layer;
  const merged: HttpRetryOptions = {
    ...previous,
    ...(definedOnly(next) as HttpRetryOptions),
  };
  const backoff = mergeBackoff(previous.backoff, next.backoff);
  if (backoff !== undefined) {
    merged.backoff = backoff;
  }
  return merged;
}

function mergeBackoff(
  base: HttpRetryOptions["backoff"],
  layer: HttpRetryOptions["backoff"],
): HttpRetryOptions["backoff"] {
  if (layer === undefined) {
    return base;
  }
  if (
    typeof layer === "function" ||
    typeof base !== "object" ||
    base === null
  ) {
    return layer;
  }
  return { ...base, ...(definedOnly(layer) as HttpBackoffOptions) };
}

/**
 * Applies the defaults. `undefined` means a single attempt.
 */
export function resolveRetry(
  input: number | false | HttpRetryOptions | undefined,
): ResolvedRetry | undefined {
  if (input === false) {
    return undefined;
  }
  const options: HttpRetryOptions =
    typeof input === "number" ? { attempts: input } : (input ?? {});
  const backoff =
    typeof options.backoff === "function"
      ? options.backoff
      : resolveBackoff(options.backoff);
  const attempts = attemptsOption(options.attempts ?? DEFAULT_RETRY.attempts);
  if (attempts <= 1) {
    return undefined;
  }
  return {
    attempts,
    methods: (options.methods ?? DEFAULT_RETRY.methods).map((method) =>
      method.toUpperCase(),
    ),
    statusCodes: [...(options.statusCodes ?? DEFAULT_RETRY.statusCodes)],
    backoff,
    maxRetryAfter:
      typeof backoff === "function"
        ? DEFAULT_BACKOFF.maxDelay
        : backoff.maxDelay,
    retryIf: options.retryIf,
  };
}

function resolveBackoff(options: HttpBackoffOptions = {}): ResolvedBackoff {
  return {
    delay:
      options.delay === undefined
        ? DEFAULT_BACKOFF.delay
        : durationOption(options.delay, "retry.backoff.delay"),
    factor:
      options.factor === undefined
        ? DEFAULT_BACKOFF.factor
        : factorOption(options.factor),
    maxDelay:
      options.maxDelay === undefined
        ? DEFAULT_BACKOFF.maxDelay
        : durationOption(options.maxDelay, "retry.backoff.maxDelay"),
    jitter:
      options.jitter === undefined
        ? DEFAULT_BACKOFF.jitter
        : jitterOption(options.jitter),
  };
}

function attemptsOption(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new TypeError(
    `HttpClient \`retry.attempts\`: Invalid number of attempts ${show(value)}. ` +
      "Use a whole number, e.g. 3; 1 or `false` makes a single attempt.",
  );
}

function factorOption(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  throw new TypeError(
    `HttpClient \`retry.backoff.factor\`: Invalid factor ${show(value)}. ` +
      "Use a non-negative number; 1 keeps the delay constant.",
  );
}

const JITTER_MODES = ["full", "equal", "none"] as const;

function jitterOption(value: unknown): "full" | "equal" | "none" {
  if (
    typeof value === "string" &&
    (JITTER_MODES as readonly string[]).includes(value)
  ) {
    return value as "full" | "equal" | "none";
  }
  throw new TypeError(
    `HttpClient \`retry.backoff.jitter\`: Invalid jitter ${show(value)}. ` +
      'Use "full", "equal" or "none".',
  );
}

function show(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * The wait after attempt `attempt` (1-based) failed with `error`.
 */
export function backoffDelay(
  retry: ResolvedRetry,
  attempt: number,
  error: unknown,
  random: () => number = Math.random,
): number {
  if (typeof retry.backoff === "function") {
    return durationOption(
      retry.backoff(attempt, error),
      "retry.backoff()",
      error,
    );
  }
  const { delay, factor, maxDelay, jitter } = retry.backoff;
  const ceiling = Math.min(maxDelay, delay * factor ** (attempt - 1));
  switch (jitter) {
    case "none":
      return Math.floor(ceiling);
    case "equal":
      return Math.floor(ceiling / 2 + (random() * ceiling) / 2);
    default:
      return Math.floor(random() * ceiling);
  }
}

function definedOnly(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  );
}
