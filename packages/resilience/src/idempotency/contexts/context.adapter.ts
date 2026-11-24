import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HTTP_STATUS_REASON_PHRASES,
  HttpException,
  ImATeapotException,
  MethodNotAllowedException,
  MisdirectedException,
  NotAcceptableException,
  NotFoundException,
  PayloadTooLargeException,
  PreconditionFailedException,
  RequestTimeoutException,
  UnauthorizedException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
  type ExecutionContext,
  type Type,
} from "@bunest/core";
import type { IdempotencyErrorCode } from "../interfaces/idempotency-error-code.interface";
import type { IdempotencyStoredResponse } from "../interfaces/idempotency-store.interface";
import type { IdempotencyContextType } from "../interfaces/idempotent-options.interface";
import { encodeResult, unreplayableReason } from "../utils/result.util";

/** A result that can't be stored and replayed, and why (logged once per handler). */
export class Unreplayable {
  readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }
}

/**
 * What a finished call leaves behind: the record to store, `null` when
 * `storeIf` says the outcome isn't final, or why it can't be replayed.
 */
export type Capture = IdempotencyStoredResponse | Unreplayable | null;

/** A protocol-neutral rejection; each context adapter renders it natively. */
export interface IdempotencyRejection {
  code: IdempotencyErrorCode;
  /** HTTP status equivalent. */
  status: number;
  message: string;
  /** Seconds, for `IDEMPOTENCY_KEY_IN_USE`. */
  retryAfter?: number;
}

export interface CaptureOptions {
  storeIf: (status: number, error?: unknown) => boolean;
}

/** A declarative key source, or `'default'` for the context's own default. */
export type DeclarativeKeySource =
  "default" | { header: string } | { arg: string } | { payload: string };

/** What a call is, for the fingerprint: who it targets, and with what. */
export interface CallDescription {
  /** Method and URL (http), field (graphql) or pattern (rpc). Always hashed. */
  identity: string[];
  /** Body (http), field arguments (graphql) or message payload (rpc). */
  payload: unknown;
}

/**
 * Everything protocol-specific. The interceptor owns the protocol-neutral
 * state machine (acquire -> execute/replay/reject -> complete/release) and
 * delegates here for how to read keys, fingerprint, capture and replay.
 */
export interface IdempotencyContextAdapter {
  readonly type: IdempotencyContextType;
  /** Lazily loads optional peer dependencies (graphql, microservices). */
  prepare?(): Promise<void>;
  /**
   * Whether a class-level `@Idempotent()` covers this call. Safe calls (GET,
   * HEAD, OPTIONS routes, GraphQL queries, nested field resolvers) are only
   * covered by a decorator on the handler itself.
   */
  coveredByClass(context: ExecutionContext): boolean;
  /** Why `@Idempotent()` can't apply to this handler at all (it runs untouched), if it can't. */
  passThrough?(context: ExecutionContext): string | undefined;
  /** Where a signed-in user sits on this call (`req.user`), if one does. */
  userLocation(context: ExecutionContext): string | undefined;
  readKey(
    context: ExecutionContext,
    source: DeclarativeKeySource,
    header: string,
  ): unknown;
  /** First argument for user `scope` callbacks. */
  target(context: ExecutionContext): unknown;
  describe(
    context: ExecutionContext,
  ): CallDescription | Promise<CallDescription>;
  /**
   * The media type of a request body that arrived but isn't in `payload`,
   * because no parser had read it yet (multipart, or a type no body parser handles).
   */
  unreadBody?(context: ExecutionContext, payload: unknown): string | undefined;
  /** Appended to the store key (GraphQL: the field path; RPC: the handler). */
  keySuffix?(context: ExecutionContext): string | undefined;
  captureSuccess(
    context: ExecutionContext,
    value: unknown,
    opts: CaptureOptions,
  ): Capture;
  captureError(
    error: unknown,
    opts: CaptureOptions,
  ): IdempotencyStoredResponse | null;
  replay(context: ExecutionContext, stored: IdempotencyStoredResponse): unknown;
  reject(context: ExecutionContext, rejection: IdempotencyRejection): Error;
}

export function jsonClone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** Reads a nested property (`meta.eventId`) from a payload or arguments. */
export function pick(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Reads a header case-insensitively from either a native Web `Request` (`Headers`)
 * or an Express/Fastify-like request object (`Record<string, string | string[]>`).
 */
export function getHeaderFromRequest(req: unknown, name: string): unknown {
  if (!req || typeof req !== "object") {
    return undefined;
  }
  const headers = (req as { headers?: unknown }).headers;
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  if (typeof (headers as Headers).get === "function") {
    const val = (headers as Headers).get(name);
    return val === null ? undefined : val;
  }
  const record = headers as Record<string, unknown>;
  const lower = name.toLowerCase();
  return record[lower] ?? record[name];
}

/**
 * Dynamically imports an optional peer package without triggering static
 * bundler resolution in `bun build`.
 */
export async function tryOptionalImport<T>(
  specifier: string,
): Promise<T | undefined> {
  try {
    return (await import(specifier)) as T;
  } catch {
    return undefined;
  }
}

/**
 * `HttpException`s by status. Another error with a numeric 4xx `status` (or
 * `statusCode`) is the caller's fault, captured as the matching exception with
 * its default body. Any other error as a 500 (if stored at all).
 */
export function captureHttpOrUnknownError(
  error: unknown,
  opts: CaptureOptions,
): IdempotencyStoredResponse | null {
  const exception =
    error instanceof HttpException ? error : clientErrorException(error);
  if (exception) {
    const status = exception.getStatus();
    if (!opts.storeIf(status, error)) {
      return null;
    }
    return {
      status,
      headers: {},
      body: jsonClone(exception.getResponse()),
      error: "http",
    };
  }
  if (!opts.storeIf(500, error)) {
    return null;
  }
  return {
    status: 500,
    headers: {},
    body: { statusCode: 500, message: "Internal server error" },
    error: "http",
  };
}

/** Built-in HTTP exception classes, for the default body of a status. */
const BUILTIN_EXCEPTIONS: Record<number, Type<HttpException>> = {
  400: BadRequestException,
  401: UnauthorizedException,
  403: ForbiddenException,
  404: NotFoundException,
  405: MethodNotAllowedException,
  406: NotAcceptableException,
  408: RequestTimeoutException,
  409: ConflictException,
  410: GoneException,
  412: PreconditionFailedException,
  413: PayloadTooLargeException,
  415: UnsupportedMediaTypeException,
  418: ImATeapotException,
  421: MisdirectedException,
  422: UnprocessableEntityException,
};

/** The `HttpException` for an error with a numeric 4xx `status` or `statusCode`, if it has one. */
function clientErrorException(error: unknown): HttpException | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const errObj = error as { status?: unknown; statusCode?: unknown };
  const code =
    typeof errObj.status === "number" ? errObj.status : errObj.statusCode;
  if (
    typeof code !== "number" ||
    !Number.isInteger(code) ||
    code < 400 ||
    code > 499
  ) {
    return undefined;
  }
  const ExceptionClass = BUILTIN_EXCEPTIONS[code];
  if (ExceptionClass) {
    return new ExceptionClass();
  }
  const message = HTTP_STATUS_REASON_PHRASES[code] ?? "Error";
  return new HttpException(
    HttpException.createBody(undefined, message, code),
    code,
  );
}

export function rebuildHttpException(
  stored: IdempotencyStoredResponse,
): HttpException {
  return new HttpException(
    stored.body as string | Record<string, unknown>,
    stored.status,
  );
}

/** A successful GraphQL or RPC result, as a 200. */
export function successCapture(
  value: unknown,
  opts: CaptureOptions,
  { strict = false }: { strict?: boolean } = {},
): Capture {
  const reason = unreplayableReason(value);
  if (reason) {
    return new Unreplayable(reason);
  }
  if (!opts.storeIf(200)) {
    return null;
  }
  return { status: 200, headers: {}, body: encodeResult(value, { strict }) };
}

export function unsupportedSource(
  type: IdempotencyContextType,
  source: unknown,
): Error {
  const fits =
    "Use { arg } for graphql, { payload } for rpc, { header } or a function for any context, " +
    "or one source per context: { graphql: { arg: ... }, rpc: { payload: ... } }.";
  return new Error(
    `@Idempotent({ keyFrom: ${JSON.stringify(source)} }) is not supported in the "${type}" context. ${fits}`,
  );
}
