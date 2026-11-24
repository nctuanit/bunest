import { MetadataRegistry, type ExecutionContext } from "@bunest/core";
import { DEFAULT_KEY_FIELD } from "../idempotency.constants";
import type { IdempotencyStoredResponse } from "../interfaces/idempotency-store.interface";
import { canonicalJson } from "../utils/fingerprint.util";
import { decodeResult } from "../utils/result.util";
import {
  captureHttpOrUnknownError,
  pick,
  rebuildHttpException,
  successCapture,
  tryOptionalImport,
  unsupportedSource,
  type CallDescription,
  type Capture,
  type CaptureOptions,
  type DeclarativeKeySource,
  type IdempotencyContextAdapter,
  type IdempotencyRejection,
} from "./context.adapter";

const PATTERN_METADATA = "microservices:pattern";
const BUNEST_MESSAGE_PATTERN_METADATA = Symbol.for(
  "bunest:microservices:message-pattern",
);
const BUNEST_EVENT_PATTERN_METADATA = Symbol.for(
  "bunest:microservices:event-pattern",
);

interface MicroservicesModuleLike {
  RpcException: new (error: string | object) => Error & {
    getError(): string | object;
  };
}

class FallbackRpcException extends Error {
  private readonly errorPayload: string | object;

  constructor(error: string | object) {
    super(
      typeof error === "string"
        ? error
        : typeof (error as { message?: unknown })?.message === "string"
          ? (error as { message: string }).message
          : JSON.stringify(error),
    );
    this.name = "RpcException";
    this.errorPayload = error;
  }

  getError(): string | object {
    return this.errorPayload;
  }
}

function isRpcExceptionLike(
  error: unknown,
  msMod: MicroservicesModuleLike | undefined,
): error is Error & { getError(): unknown } {
  if (msMod && error instanceof msMod.RpcException) {
    return true;
  }
  return (
    error instanceof Error &&
    typeof (error as { getError?: unknown }).getError === "function"
  );
}

function headerValue(v: unknown): unknown {
  if (Array.isArray(v)) {
    v = v[0];
  }
  return Buffer.isBuffer(v) ? v.toString("utf8") : v;
}

/**
 * Best-effort transport header lookup across NATS, Kafka, RabbitMQ, MQTT 5, and gRPC.
 */
function transportHeader(context: ExecutionContext, name: string): unknown {
  const rpcCtx = context.switchToRpc().getContext<any>();
  const lower = name.toLowerCase();
  const candidates: Array<() => unknown> = [
    // NATS: MsgHdrs, whose get() returns '' for a missing header
    () =>
      rpcCtx?.getHeaders?.()?.get?.(name) ||
      rpcCtx?.getHeaders?.()?.get?.(lower),
    // Kafka: message.headers (Buffers)
    () =>
      rpcCtx?.getMessage?.()?.headers?.[name] ??
      rpcCtx?.getMessage?.()?.headers?.[lower],
    // RabbitMQ: message.properties.headers
    () =>
      rpcCtx?.getMessage?.()?.properties?.headers?.[name] ??
      rpcCtx?.getMessage?.()?.properties?.headers?.[lower],
    // MQTT 5: packet.properties.userProperties
    () =>
      rpcCtx?.getPacket?.()?.properties?.userProperties?.[name] ??
      rpcCtx?.getPacket?.()?.properties?.userProperties?.[lower],
    // gRPC: second handler argument is Metadata
    () => {
      const metadata = context.getArgByIndex<any>(1);
      return typeof metadata?.get === "function"
        ? metadata.get(lower)
        : undefined;
    },
  ];
  for (const candidate of candidates) {
    try {
      const v = headerValue(candidate());
      if (v !== undefined && v !== null && v !== "") {
        return v;
      }
    } catch {
      // Not this transport.
    }
  }
  return undefined;
}

/**
 * `@MessagePattern()` / `@EventPattern()` handlers on any transport.
 *
 * Default key: `payload.idempotencyKey`, falling back to the transport
 * header named by the `header` option. Records are per handler
 * (`<key>:<Class>.<method>`).
 */
export class RpcContextAdapter implements IdempotencyContextAdapter {
  readonly type = "rpc" as const;
  private ms?: MicroservicesModuleLike;
  private prepared = false;

  async prepare(): Promise<void> {
    if (this.prepared) {
      return;
    }
    this.prepared = true;
    this.ms = await tryOptionalImport<MicroservicesModuleLike>(
      "@bunest/microservices",
    );
  }

  coveredByClass(): boolean {
    return true;
  }

  /** Where an authentication guard leaves the user of a message (the transport context). */
  userLocation(context: ExecutionContext): string | undefined {
    const rpcCtx = context.switchToRpc().getContext<{ user?: unknown }>();
    return rpcCtx?.user ? "the transport context's user" : undefined;
  }

  readKey(
    context: ExecutionContext,
    source: DeclarativeKeySource,
    header: string,
  ): unknown {
    const data = context.switchToRpc().getData<unknown>();
    if (source === "default") {
      return pick(data, DEFAULT_KEY_FIELD) ?? transportHeader(context, header);
    }
    if ("header" in source) {
      return transportHeader(context, source.header);
    }
    if ("payload" in source) {
      return pick(data, source.payload);
    }
    throw unsupportedSource(this.type, source);
  }

  target(context: ExecutionContext): unknown {
    return context.switchToRpc().getData();
  }

  keySuffix(context: ExecutionContext): string {
    return `${context.getClass().name}.${context.getHandler().name}`;
  }

  describe(context: ExecutionContext): CallDescription {
    const rpcCtx = context.switchToRpc().getContext<any>();
    let pattern: unknown;
    try {
      pattern = rpcCtx?.getPattern?.();
    } catch {
      // Not every context exposes the pattern.
    }
    const handler = context.getHandler();
    pattern ??=
      MetadataRegistry.get(PATTERN_METADATA, handler) ??
      MetadataRegistry.get(BUNEST_MESSAGE_PATTERN_METADATA, handler) ??
      MetadataRegistry.get(BUNEST_EVENT_PATTERN_METADATA, handler);
    return {
      identity: [
        "rpc",
        typeof pattern === "string" ? pattern : canonicalJson(pattern),
      ],
      payload: context.switchToRpc().getData(),
    };
  }

  captureSuccess(
    _context: ExecutionContext,
    value: unknown,
    opts: CaptureOptions,
  ): Capture {
    return successCapture(value, opts);
  }

  captureError(
    error: unknown,
    opts: CaptureOptions,
  ): IdempotencyStoredResponse | null {
    if (isRpcExceptionLike(error, this.ms)) {
      const body = error.getError() as Record<string, unknown> | string | null;
      const statusCode =
        body && typeof body === "object" ? body.statusCode : undefined;
      const status =
        typeof statusCode === "number" && statusCode >= 400 && statusCode <= 599
          ? statusCode
          : 400;
      if (!opts.storeIf(status, error)) {
        return null;
      }
      return {
        status,
        headers: {},
        body: JSON.parse(JSON.stringify(body ?? null)),
        error: "rpc",
      };
    }
    return captureHttpOrUnknownError(error, opts);
  }

  replay(
    _context: ExecutionContext,
    stored: IdempotencyStoredResponse,
  ): unknown {
    if (stored.error === "rpc") {
      const ErrorCtor = this.ms?.RpcException ?? FallbackRpcException;
      throw new ErrorCtor(stored.body as string | object);
    }
    if (stored.error) {
      throw rebuildHttpException(stored);
    }
    return decodeResult(stored.body);
  }

  reject(_context: ExecutionContext, rejection: IdempotencyRejection): Error {
    const ErrorCtor = this.ms?.RpcException ?? FallbackRpcException;
    return new ErrorCtor({
      status: "error",
      code: rejection.code,
      statusCode: rejection.status,
      message: rejection.message,
      ...(rejection.retryAfter !== undefined && {
        retryAfter: rejection.retryAfter,
      }),
    });
  }
}
