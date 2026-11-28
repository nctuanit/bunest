import {
  DomainException,
  HttpException,
  type ClsContextCarrier,
  type DomainErrorKind,
} from "@bunest/core";
import {
  WorkerAbortedException,
  WorkerPoolError,
  WorkerPoolSaturatedException,
  WorkerSpawnException,
  WorkerTaskNotFoundException,
  WorkerTerminatedException,
  WorkerTimeoutException,
  WorkerValidationException,
} from "./errors";

export const WORKER_PROTOCOL_VERSION = 1 as const;
export const TRANSFERABLE_MARKER = Symbol.for("bunest:workers:transferable");

/**
 * Wrapper marking a value to be sent with an explicit `Transferable[]` list
 * for zero-copy cross-thread delivery via `postMessage(msg, transfer)`.
 */
export interface TransferablePayload<T = unknown> {
  readonly [TRANSFERABLE_MARKER]: true;
  readonly value: T;
  readonly transfer: Bun.Transferable[];
}

/**
 * Marks a worker return value (or payload) to transfer ownership of underlying
 * `ArrayBuffer` / `MessagePort` objects zero-copy across threads.
 */
export function transferable<T>(
  value: T,
  transfer: readonly Bun.Transferable[],
): TransferablePayload<T> {
  return {
    [TRANSFERABLE_MARKER]: true,
    value,
    transfer: [...transfer],
  };
}

export function isTransferablePayload(
  value: unknown,
): value is TransferablePayload<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[TRANSFERABLE_MARKER] === true &&
    Array.isArray((value as { transfer?: unknown }).transfer)
  );
}

export function unwrapTransferable<T>(input: T | TransferablePayload<T>): {
  readonly value: T;
  readonly transfer?: Bun.Transferable[];
} {
  if (isTransferablePayload(input)) {
    return {
      value: input.value as T,
      transfer: input.transfer.length > 0 ? input.transfer : undefined,
    };
  }
  return { value: input };
}

// ---------------------------------------------------------------------------
// Structured Cross-Thread Error Serialization
// ---------------------------------------------------------------------------

export interface SerializedWorkerError {
  readonly kind:
    | "error"
    | "http"
    | "domain"
    | "task_not_found"
    | "aborted"
    | "validation"
    | "worker_pool";
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
  readonly httpStatus?: number;
  readonly httpResponse?: string | Record<string, unknown>;
  readonly httpErrorCode?: string;
  readonly domainKind?: DomainErrorKind;
  readonly details?: unknown;
  readonly availableTasks?: readonly string[];
  readonly issues?: readonly {
    readonly message: string;
    readonly path?: readonly PropertyKey[];
  }[];
  readonly cause?: SerializedWorkerError;
}

function toSafeCloneable(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (t === "bigint") return value.toString();
  if (t === "symbol" || t === "function") return String(value);
  if (depth > 4) return "[…]";
  if (Array.isArray(value)) {
    return value.map((item) => toSafeCloneable(item, depth + 1));
  }
  if (value instanceof Error) {
    return serializeWorkerError(value, depth + 1);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = toSafeCloneable(v, depth + 1);
  }
  return out;
}

export function serializeWorkerError(
  err: unknown,
  depth = 0,
): SerializedWorkerError {
  if (err instanceof WorkerTaskNotFoundException) {
    return {
      kind: "task_not_found",
      name: err.name,
      message: err.message,
      stack: err.stack,
      code: err.code,
      details: err.taskName,
      availableTasks: err.availableTasks ? [...err.availableTasks] : undefined,
    };
  }

  if (err instanceof WorkerAbortedException) {
    return {
      kind: "aborted",
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }

  if (err instanceof WorkerValidationException) {
    return {
      kind: "validation",
      name: err.name,
      message: err.message,
      stack: err.stack,
      issues: err.issues.map((issue) => ({
        message: issue.message,
        ...(issue.path ? { path: issue.path.map(String) } : {}),
      })),
    };
  }

  if (err instanceof WorkerPoolError) {
    return {
      kind: "worker_pool",
      name: err.name,
      message: err.message,
      stack: err.stack,
      code: err.code,
      details: toSafeCloneable(err.details, depth + 1),
    };
  }

  if (err instanceof HttpException) {
    const rawResp = err.getResponse();
    return {
      kind: "http",
      name: err.name,
      message: err.message,
      stack: err.stack,
      httpStatus: err.getStatus(),
      httpResponse:
        typeof rawResp === "string"
          ? rawResp
          : (toSafeCloneable(rawResp, depth + 1) as Record<string, unknown>),
      httpErrorCode: err.errorCode,
    };
  }

  if (err instanceof DomainException) {
    return {
      kind: "domain",
      name: err.name,
      message: err.message,
      stack: err.stack,
      code: err.code,
      domainKind: err.kind,
      details: toSafeCloneable(err.details, depth + 1),
    };
  }

  if (err instanceof Error) {
    const rawCode = (err as { code?: unknown }).code;
    const rawCause = (err as { cause?: unknown }).cause;
    return {
      kind: "error",
      name: err.name || "Error",
      message: err.message,
      stack: err.stack,
      ...(typeof rawCode === "string" ? { code: rawCode } : {}),
      ...(rawCause !== undefined && depth < 3
        ? { cause: serializeWorkerError(rawCause, depth + 1) }
        : {}),
    };
  }

  return {
    kind: "error",
    name: "Error",
    message: typeof err === "string" ? err : String(err),
  };
}

export function deserializeWorkerError(
  serialized: SerializedWorkerError,
): Error {
  if (serialized.kind === "task_not_found") {
    const taskName =
      typeof serialized.details === "string" ? serialized.details : "unknown";
    const err = new WorkerTaskNotFoundException(
      taskName,
      serialized.availableTasks,
    );
    if (serialized.stack) err.stack = serialized.stack;
    return err;
  }

  if (serialized.kind === "aborted") {
    const err = new WorkerAbortedException(serialized.message);
    if (serialized.stack) err.stack = serialized.stack;
    return err;
  }

  if (serialized.kind === "validation") {
    const err = new WorkerValidationException(
      "worker-task",
      serialized.issues ?? [{ message: serialized.message }],
    );
    err.message = serialized.message;
    if (serialized.stack) err.stack = serialized.stack;
    return err;
  }

  if (serialized.kind === "http" && typeof serialized.httpStatus === "number") {
    const err = new HttpException(
      serialized.httpResponse ?? serialized.message,
      serialized.httpStatus,
      serialized.httpErrorCode
        ? { errorCode: serialized.httpErrorCode }
        : undefined,
    );
    err.name = serialized.name || err.name;
    if (serialized.stack) err.stack = serialized.stack;
    return err;
  }

  if (serialized.kind === "domain") {
    const err = new DomainException({
      code: serialized.code ?? "WORKER_DOMAIN_ERROR",
      kind: serialized.domainKind ?? "unprocessable",
      message: serialized.message,
      details: serialized.details,
    });
    err.name = serialized.name || err.name;
    if (serialized.stack) err.stack = serialized.stack;
    return err;
  }

  if (serialized.kind === "worker_pool" && serialized.code) {
    const details =
      serialized.details && typeof serialized.details === "object"
        ? (serialized.details as Record<string, unknown>)
        : undefined;
    let err: WorkerPoolError;
    switch (serialized.code) {
      case "BUNEST_E201":
        err = new WorkerSpawnException(serialized.message, { details });
        break;
      case "BUNEST_E202":
        err = new WorkerTimeoutException(
          String(details?.taskName ?? "unknown"),
          Number(details?.timeoutMs ?? 0),
          typeof details?.poolName === "string" ? details.poolName : undefined,
        );
        break;
      case "BUNEST_E203":
        err = new WorkerPoolSaturatedException(
          String(details?.poolName ?? "default"),
          Number(details?.maxQueueSize ?? 0),
        );
        break;
      case "BUNEST_E204":
        err = new WorkerTerminatedException(serialized.message, { details });
        break;
      default:
        err = new WorkerPoolError(serialized.message, serialized.code, {
          details,
        });
        break;
    }
    if (serialized.stack) err.stack = serialized.stack;
    return err;
  }

  const cause = serialized.cause
    ? deserializeWorkerError(serialized.cause)
    : undefined;
  let err: Error;
  switch (serialized.name) {
    case "TypeError":
      err = new TypeError(serialized.message, cause ? { cause } : undefined);
      break;
    case "RangeError":
      err = new RangeError(serialized.message, cause ? { cause } : undefined);
      break;
    case "SyntaxError":
      err = new SyntaxError(serialized.message, cause ? { cause } : undefined);
      break;
    default:
      err = new Error(serialized.message, cause ? { cause } : undefined);
      err.name = serialized.name || "Error";
      break;
  }
  if (serialized.code) {
    (err as Error & { code?: string }).code = serialized.code;
  }
  if (serialized.stack) {
    err.stack = serialized.stack;
  }
  return err;
}

// ---------------------------------------------------------------------------
// Wire Protocol Frames (Main <-> Worker)
// ---------------------------------------------------------------------------

export interface WorkerInitFrame {
  readonly __bw: typeof WORKER_PROTOCOL_VERSION;
  readonly t: "init";
  readonly workerId: string;
  readonly initData?: unknown;
}

export interface WorkerTaskFrame {
  readonly __bw: typeof WORKER_PROTOCOL_VERSION;
  readonly t: "task";
  readonly id: string;
  readonly task: string;
  readonly payload: unknown;
  readonly cls?: ClsContextCarrier;
  readonly traceparent?: string;
}

export interface WorkerCancelFrame {
  readonly __bw: typeof WORKER_PROTOCOL_VERSION;
  readonly t: "cancel";
  readonly id: string;
  readonly reason?: string;
}

export interface WorkerBroadcastFrame {
  readonly __bw: typeof WORKER_PROTOCOL_VERSION;
  readonly t: "broadcast";
  readonly event: string;
  readonly payload: unknown;
}

export interface WorkerPingFrame {
  readonly __bw: typeof WORKER_PROTOCOL_VERSION;
  readonly t: "ping";
  readonly id: string;
}

export interface WorkerShutdownFrame {
  readonly __bw: typeof WORKER_PROTOCOL_VERSION;
  readonly t: "shutdown";
  readonly reason?: string;
}

export type MainToWorkerFrame =
  | WorkerInitFrame
  | WorkerTaskFrame
  | WorkerCancelFrame
  | WorkerBroadcastFrame
  | WorkerPingFrame
  | WorkerShutdownFrame;

export interface WorkerReadyFrame {
  readonly __bw: typeof WORKER_PROTOCOL_VERSION;
  readonly t: "ready";
  readonly workerId: string;
  readonly tasks: readonly string[];
}

export interface WorkerResultFrame {
  readonly __bw: typeof WORKER_PROTOCOL_VERSION;
  readonly t: "result";
  readonly id: string;
  readonly value: unknown;
}

export interface WorkerErrorFrame {
  readonly __bw: typeof WORKER_PROTOCOL_VERSION;
  readonly t: "error";
  readonly id: string;
  readonly error: SerializedWorkerError;
}

export interface WorkerProgressFrame {
  readonly __bw: typeof WORKER_PROTOCOL_VERSION;
  readonly t: "progress";
  readonly id: string;
  readonly progress: unknown;
}

export interface WorkerPongFrame {
  readonly __bw: typeof WORKER_PROTOCOL_VERSION;
  readonly t: "pong";
  readonly id: string;
}

export interface WorkerShutdownAckFrame {
  readonly __bw: typeof WORKER_PROTOCOL_VERSION;
  readonly t: "shutdown_ack";
  readonly workerId: string;
}

export type WorkerToMainFrame =
  | WorkerReadyFrame
  | WorkerResultFrame
  | WorkerErrorFrame
  | WorkerProgressFrame
  | WorkerPongFrame
  | WorkerShutdownAckFrame;

export function isWorkerProtocolFrame(
  value: unknown,
): value is MainToWorkerFrame | WorkerToMainFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __bw?: unknown }).__bw === WORKER_PROTOCOL_VERSION &&
    typeof (value as { t?: unknown }).t === "string"
  );
}
