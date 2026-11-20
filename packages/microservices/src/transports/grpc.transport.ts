import { HttpException } from "@bunest/common";
import { ClientProxy } from "../client-proxy";
import { BaseRpcContext } from "../ctx-host";
import { GrpcStatus } from "../enums";
import { GrpcException, RpcException } from "../exceptions";
import {
  GrpcMetadata,
  RESERVED_HTTP_HEADERS,
  sanitizeHeaderKey,
  sanitizeHeaderValue,
  sanitizeMetadataHeaders,
} from "../grpc-metadata";
import type {
  ClientGrpc,
  GrpcCodec,
  GrpcMetadataLike,
  GrpcTransportOptions,
  MessageHandler,
  PatternInput,
  RpcContext,
} from "../interfaces";
import { MicroserviceTransportServer } from "../server";
import { Transport } from "../tokens";

export { GrpcException, GrpcMetadata, GrpcStatus };

function safeDecodeGrpcMessage(
  raw: string | null | undefined,
  fallback: string,
): string {
  if (!raw) {
    return fallback;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Standard 5-byte gRPC Length-Prefixed Framing ([flags:1][length:4][payload:N])
// ---------------------------------------------------------------------------

const GRPC_HEADER_BYTES = 5;
const GRPC_FLAG_COMPRESSED = 0x01;
const GRPC_FLAG_TRAILERS = 0x80;
const DEFAULT_MAX_GRPC_MESSAGE_BYTES = 16 * 1024 * 1024; // 16 MiB

export interface GrpcFrame {
  readonly flags: number;
  readonly compressed: boolean;
  readonly isTrailer: boolean;
  readonly payload: Uint8Array;
}

/**
 * Encodes a payload into a standard 5-byte gRPC length-prefixed frame:
 * `[compressed:1][length:uint32be:4][payload:N]`.
 */
export function encodeGrpcFrame(
  payload: Uint8Array,
  compressed = false,
): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(new ArrayBuffer(GRPC_HEADER_BYTES + payload.byteLength));
  const view = new DataView(frame.buffer);
  frame[0] = compressed ? GRPC_FLAG_COMPRESSED : 0x00;
  view.setUint32(1, payload.byteLength, false);
  frame.set(payload, GRPC_HEADER_BYTES);
  return frame;
}

/**
 * Encodes trailing gRPC status/metadata headers into a gRPC-Web-compatible
 * 5-byte trailer frame (`flags = 0x80`) for streaming responses.
 */
export function encodeGrpcTrailerFrame(
  trailers: Readonly<Record<string, string>>,
): Uint8Array<ArrayBuffer> {
  const lines = Object.entries(trailers)
    .map(([k, v]) => {
      const safeKey = sanitizeHeaderKey(k);
      if (!safeKey) return "";
      const safeVal = sanitizeHeaderValue(v);
      return `${safeKey}: ${safeVal}\r\n`;
    })
    .filter(Boolean)
    .join("");
  const payload = new TextEncoder().encode(lines);
  const frame = new Uint8Array(new ArrayBuffer(GRPC_HEADER_BYTES + payload.byteLength));
  const view = new DataView(frame.buffer);
  frame[0] = GRPC_FLAG_TRAILERS;
  view.setUint32(1, payload.byteLength, false);
  frame.set(payload, GRPC_HEADER_BYTES);
  return frame;
}

export function parseGrpcTrailers(payload: Uint8Array): Record<string, string> {
  const text = new TextDecoder().decode(payload);
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Streaming incremental decoder for 5-byte gRPC length-prefixed frames.
 */
export class GrpcFrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);
  private readonly maxMessageBytes: number;

  constructor(maxMessageBytes: number = DEFAULT_MAX_GRPC_MESSAGE_BYTES) {
    this.maxMessageBytes = Math.max(256, Math.floor(maxMessageBytes));
  }

  push(chunk: Uint8Array): GrpcFrame[] {
    if (chunk.byteLength > 0) {
      if (this.buffer.byteLength === 0) {
        this.buffer = new Uint8Array(chunk);
      } else {
        const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
        merged.set(this.buffer, 0);
        merged.set(chunk, this.buffer.byteLength);
        this.buffer = merged;
      }
    }

    const frames: GrpcFrame[] = [];
    while (this.buffer.byteLength >= GRPC_HEADER_BYTES) {
      const view = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset,
        this.buffer.byteLength,
      );
      const flags = this.buffer[0]!;
      const length = view.getUint32(1, false);
      if (length > this.maxMessageBytes) {
        this.buffer = new Uint8Array(0);
        throw new GrpcException(
          GrpcStatus.RESOURCE_EXHAUSTED,
          `gRPC frame size ${length} exceeds maxMessageBytes (${this.maxMessageBytes})`,
        );
      }
      const total = GRPC_HEADER_BYTES + length;
      if (this.buffer.byteLength < total) {
        break;
      }
      const payload = this.buffer.slice(GRPC_HEADER_BYTES, total);
      this.buffer =
        this.buffer.byteLength === total
          ? new Uint8Array(0)
          : this.buffer.slice(total);

      frames.push({
        flags,
        compressed: (flags & GRPC_FLAG_COMPRESSED) !== 0,
        isTrailer: (flags & GRPC_FLAG_TRAILERS) !== 0,
        payload,
      });
    }

    return frames;
  }

  get remainingBytes(): number {
    return this.buffer.byteLength;
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
  }
}

export function decodeGrpcFrames(
  bytes: Uint8Array,
  maxMessageBytes?: number,
): GrpcFrame[] {
  const decoder = new GrpcFrameDecoder(maxMessageBytes);
  return decoder.push(bytes);
}

// ---------------------------------------------------------------------------
// Timeout Header Helpers (gRPC Spec: `<digits>[H|M|S|m|u|n]`)
// ---------------------------------------------------------------------------

export function formatGrpcTimeout(timeoutMs: number): string {
  const clamped = Math.max(1, Math.ceil(timeoutMs));
  return `${clamped}m`;
}

export function parseGrpcTimeout(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const match = /^(\d+)([HMSmun])$/.exec(trimmed);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2];
  switch (unit) {
    case "H":
      return value * 3_600_000;
    case "M":
      return value * 60_000;
    case "S":
      return value * 1_000;
    case "m":
      return value;
    case "u":
      return Math.max(1, Math.ceil(value / 1_000));
    case "n":
      return Math.max(1, Math.ceil(value / 1_000_000));
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Default JSON Codec (`application/grpc+json`)
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class JsonGrpcCodec implements GrpcCodec {
  public readonly contentType = "application/grpc+json";

  encode(value: unknown): Uint8Array {
    return textEncoder.encode(JSON.stringify(value === undefined ? null : value));
  }

  decode<T = unknown>(bytes: Uint8Array): T {
    if (bytes.byteLength === 0) {
      return undefined as T;
    }
    return JSON.parse(textDecoder.decode(bytes)) as T;
  }
}

export const defaultGrpcCodec: GrpcCodec = new JsonGrpcCodec();

// ---------------------------------------------------------------------------
// gRPC Execution Context
// ---------------------------------------------------------------------------

export class GrpcContext
  extends BaseRpcContext<[GrpcMetadata, string]>
  implements RpcContext
{
  public readonly transport = Transport.GRPC;
  public readonly pattern: string;
  public readonly service: string;
  public readonly method: string;
  public readonly path: string;
  public readonly grpcMetadata: GrpcMetadata;
  public readonly responseMetadata: GrpcMetadata;
  public readonly deadline?: number;
  public readonly signal: AbortSignal;
  public readonly metadata: Readonly<Record<string, unknown>>;

  constructor(params: {
    readonly service: string;
    readonly method: string;
    readonly path: string;
    readonly grpcMetadata: GrpcMetadata;
    readonly responseMetadata?: GrpcMetadata;
    readonly deadline?: number;
    readonly signal: AbortSignal;
  }) {
    super([params.grpcMetadata, params.path]);
    this.service = params.service;
    this.method = params.method;
    this.path = params.path;
    this.pattern = params.path;
    this.grpcMetadata = params.grpcMetadata;
    this.responseMetadata = params.responseMetadata ?? new GrpcMetadata();
    this.deadline = params.deadline;
    this.signal = params.signal;
    this.metadata = {
      service: params.service,
      method: params.method,
      path: params.path,
      headers: params.grpcMetadata.toRecord(),
      deadline: params.deadline,
    };
  }

  getMetadata(): GrpcMetadata {
    return this.grpcMetadata;
  }

  setResponseMetadata(key: string, value: string | Uint8Array): this {
    this.responseMetadata.set(key, value);
    return this;
  }
}

// ---------------------------------------------------------------------------
// Helpers for Route Resolution & Error Mapping
// ---------------------------------------------------------------------------

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in (value as Record<PropertyKey, unknown>)
  );
}

function parseGrpcPath(path: string): { service: string; method: string } | null {
  const clean = path.startsWith("/") ? path.slice(1) : path;
  const slashIdx = clean.indexOf("/");
  if (slashIdx <= 0 || slashIdx === clean.length - 1) {
    return null;
  }
  return {
    service: clean.slice(0, slashIdx),
    method: clean.slice(slashIdx + 1),
  };
}

function mapErrorToGrpc(err: unknown): {
  code: GrpcStatus;
  message: string;
  metadata?: GrpcMetadata;
} {
  if (err instanceof GrpcException) {
    return {
      code: err.code,
      message: err.details || err.message,
      metadata: err.metadata,
    };
  }
  if (err instanceof HttpException) {
    return {
      code: mapHttpStatusToGrpc(err.getStatus()),
      message: err.message,
    };
  }
  if (err instanceof RpcException) {
    const payload = err.getError();
    if (payload && typeof payload === "object") {
      const codeVal = (payload as Record<string, unknown>).code;
      const statusVal = (payload as Record<string, unknown>).status;
      if (typeof codeVal === "number" && codeVal >= 0 && codeVal <= 16) {
        return { code: codeVal as GrpcStatus, message: err.message };
      }
      if (typeof statusVal === "number") {
        return {
          code:
            statusVal <= 16
              ? (statusVal as GrpcStatus)
              : mapHttpStatusToGrpc(statusVal),
          message: err.message,
        };
      }
    }
    return { code: GrpcStatus.UNKNOWN, message: err.message };
  }
  if (err instanceof Error) {
    return { code: GrpcStatus.INTERNAL, message: err.message };
  }
  return { code: GrpcStatus.INTERNAL, message: String(err) };
}

function mapHttpStatusToGrpc(status: number): GrpcStatus {
  switch (status) {
    case 400:
    case 422:
      return GrpcStatus.INVALID_ARGUMENT;
    case 401:
      return GrpcStatus.UNAUTHENTICATED;
    case 403:
      return GrpcStatus.PERMISSION_DENIED;
    case 404:
      return GrpcStatus.NOT_FOUND;
    case 409:
      return GrpcStatus.ALREADY_EXISTS;
    case 429:
      return GrpcStatus.RESOURCE_EXHAUSTED;
    case 499:
      return GrpcStatus.CANCELLED;
    case 501:
      return GrpcStatus.UNIMPLEMENTED;
    case 503:
      return GrpcStatus.UNAVAILABLE;
    case 504:
      return GrpcStatus.DEADLINE_EXCEEDED;
    default:
      return GrpcStatus.INTERNAL;
  }
}

function resolveHostAndPort(options: GrpcTransportOptions): {
  host: string;
  port: number;
  baseUrl?: string;
} {
  if (options.url) {
    const normalized = /^https?:\/\//i.test(options.url)
      ? options.url
      : `http://${options.url}`;
    const parsed = new URL(normalized);
    return {
      host: options.host ?? parsed.hostname,
      port:
        options.port ??
        (parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80),
      baseUrl: `${parsed.protocol}//${parsed.host}`,
    };
  }
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  return { host, port };
}

interface GrpcRouteEntry {
  readonly service: string;
  readonly method: string;
  readonly path: string;
  readonly handler: MessageHandler;
  readonly streaming: boolean;
}

// ---------------------------------------------------------------------------
// Native Bun gRPC Server
// ---------------------------------------------------------------------------

/**
 * Native Bun gRPC server over HTTP/2-compatible `Bun.serve` implementing
 * standard 5-byte length-prefixed framing (`[compressed:1][length:4][payload:N]`),
 * pluggable codecs (`application/grpc+json` by default or custom protobuf binary
 * `GrpcCodec`), unary and server-streaming (`AsyncIterable`) RPCs, metadata
 * propagation, `grpc-timeout` deadline enforcement, and `GrpcStatus` mapping.
 */
export class GrpcServer extends MicroserviceTransportServer {
  public readonly transport = Transport.GRPC;

  private readonly host: string;
  private readonly requestedPort: number;
  private readonly packages: readonly string[];
  private readonly codec: GrpcCodec;
  private readonly maxMessageBytes: number;

  private readonly grpcRoutes = new Map<string, GrpcRouteEntry>();
  private server: ReturnType<typeof Bun.serve> | undefined;

  constructor(options: GrpcTransportOptions = {}) {
    super();
    const resolved = resolveHostAndPort(options);
    this.host = resolved.host;
    this.requestedPort = resolved.port;
    this.packages =
      options.package === undefined
        ? []
        : Array.isArray(options.package)
          ? options.package
          : [options.package];
    this.codec = options.codec ?? defaultGrpcCodec;
    this.maxMessageBytes =
      options.maxMessageBytes ?? DEFAULT_MAX_GRPC_MESSAGE_BYTES;
  }

  get port(): number | undefined {
    return this.server?.port;
  }

  get hostname(): string | undefined {
    return this.server?.hostname;
  }

  get url(): string | undefined {
    if (!this.server) return undefined;
    return `http://${this.server.hostname}:${this.server.port}`;
  }

  get address(): { readonly hostname: string; readonly port: number } | null {
    if (!this.server || this.server.port === undefined) return null;
    return {
      hostname: this.server.hostname ?? this.host,
      port: this.server.port,
    };
  }

  /**
   * Registers a unary or server-streaming gRPC method handler at `/${service}/${method}`
   * (plus `/${pkg}.${service}/${method}` when `package` option is configured).
   */
  addGrpcHandler(
    service: string,
    method: string,
    handler: MessageHandler,
    options: { readonly streaming?: boolean } = {},
  ): void {
    const streaming = options.streaming ?? false;
    const primaryPath = `/${service}/${method}`;
    const entry: GrpcRouteEntry = {
      service,
      method,
      path: primaryPath,
      handler,
      streaming,
    };

    if (this.grpcRoutes.has(primaryPath)) {
      throw new Error(
        `Duplicate gRPC handler registered for "${primaryPath}".`,
      );
    }

    this.grpcRoutes.set(primaryPath, entry);
    if (!this.messageHandlers.has(primaryPath)) {
      this.messageHandlers.set(primaryPath, handler);
    }

    if (!service.includes(".")) {
      for (const pkg of this.packages) {
        const qualifiedPath = `/${pkg}.${service}/${method}`;
        this.grpcRoutes.set(qualifiedPath, {
          ...entry,
          service: `${pkg}.${service}`,
          path: qualifiedPath,
        });
      }
    }
  }

  addGrpcStreamHandler(
    service: string,
    method: string,
    handler: MessageHandler,
  ): void {
    this.addGrpcHandler(service, method, handler, { streaming: true });
  }

  override addMessageHandler(
    pattern: PatternInput,
    handler: MessageHandler,
  ): void {
    super.addMessageHandler(pattern, handler);

    if (typeof pattern === "string") {
      if (pattern.startsWith("/")) {
        const parsed = parseGrpcPath(pattern);
        if (parsed && !this.grpcRoutes.has(pattern)) {
          this.grpcRoutes.set(pattern, {
            service: parsed.service,
            method: parsed.method,
            path: pattern,
            handler,
            streaming: false,
          });
        }
      } else {
        const dotIdx = pattern.lastIndexOf(".");
        if (dotIdx > 0 && dotIdx < pattern.length - 1) {
          const service = pattern.slice(0, dotIdx);
          const method = pattern.slice(dotIdx + 1);
          const path = `/${service}/${method}`;
          if (!this.grpcRoutes.has(path)) {
            this.grpcRoutes.set(path, {
              service,
              method,
              path,
              handler,
              streaming: false,
            });
          }
        }
      }
    }
  }

  async listen(callback?: (...optionalParams: unknown[]) => any): Promise<void> {
    if (this.listening && this.server) {
      callback?.();
      return;
    }
    this.server = Bun.serve({
      hostname: this.host,
      port: this.requestedPort,
      fetch: (req) => this.handleHttpRequest(req),
    });
    this.listening = true;
    this.emitStatus("connected");
    callback?.();
  }

  async close(): Promise<void> {
    this.listening = false;
    this.emitStatus("disconnected");
    if (this.server) {
      try {
        await this.server.stop(true);
      } catch {
        // Ignore already-stopped server
      }
      this.server = undefined;
    }
  }

  private resolveRoute(pathname: string): GrpcRouteEntry | undefined {
    const exact = this.grpcRoutes.get(pathname);
    if (exact) return exact;

    const parsed = parseGrpcPath(pathname);
    if (!parsed) return undefined;

    // Try PascalCase method fallback (e.g. findOne -> FindOne)
    const capitalizedMethod =
      parsed.method.charAt(0).toUpperCase() + parsed.method.slice(1);
    const byCap = this.grpcRoutes.get(`/${parsed.service}/${capitalizedMethod}`);
    if (byCap) return byCap;

    // Try stripping package prefix if request sent `/pkg.Service/Method`
    const dotIdx = parsed.service.lastIndexOf(".");
    if (dotIdx !== -1) {
      const shortService = parsed.service.slice(dotIdx + 1);
      return (
        this.grpcRoutes.get(`/${shortService}/${parsed.method}`) ??
        this.grpcRoutes.get(`/${shortService}/${capitalizedMethod}`)
      );
    }

    return undefined;
  }

  private buildErrorResponse(
    code: GrpcStatus,
    message: string,
    metadata?: GrpcMetadata,
  ): Response {
    const headers: Record<string, string> = {
      ...sanitizeMetadataHeaders(metadata),
      "content-type": this.codec.contentType,
      "grpc-status": String(code),
      "grpc-message": encodeURIComponent(message),
    };
    return new Response(new Uint8Array(0), { status: 200, headers });
  }

  private async handleHttpRequest(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return this.buildErrorResponse(
        GrpcStatus.UNIMPLEMENTED,
        `gRPC requires POST, received ${req.method}`,
      );
    }

    const url = new URL(req.url);
    const pathname = url.pathname;
    const route = this.resolveRoute(pathname);
    if (!route) {
      return this.buildErrorResponse(
        GrpcStatus.UNIMPLEMENTED,
        `Unimplemented gRPC method "${pathname}"`,
      );
    }

    // Parse incoming 5-byte gRPC frame
    let requestData: unknown;
    try {
      const rawBuf = new Uint8Array(await req.arrayBuffer());
      if (rawBuf.byteLength > 0) {
        const frames = decodeGrpcFrames(rawBuf, this.maxMessageBytes);
        if (frames.length === 0) {
          return this.buildErrorResponse(
            GrpcStatus.INVALID_ARGUMENT,
            "Incomplete gRPC request frame",
          );
        }
        requestData = this.codec.decode(frames[0]!.payload, pathname);
      }
    } catch (err) {
      const mapped = mapErrorToGrpc(err);
      return this.buildErrorResponse(
        mapped.code === GrpcStatus.INTERNAL
          ? GrpcStatus.INVALID_ARGUMENT
          : mapped.code,
        mapped.message,
        mapped.metadata,
      );
    }

    const incomingMetadata = GrpcMetadata.fromHeaders(req.headers);
    const timeoutMs = parseGrpcTimeout(req.headers.get("grpc-timeout"));
    const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;

    const abortController = new AbortController();
    const onClientAbort = () => abortController.abort(new Error("Client cancelled"));
    req.signal.addEventListener("abort", onClientAbort, { once: true });

    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        abortController.abort(
          new GrpcException(
            GrpcStatus.DEADLINE_EXCEEDED,
            `gRPC deadline exceeded after ${timeoutMs}ms for "${pathname}"`,
          ),
        );
      }, timeoutMs);
      if (typeof (timeoutTimer as { unref?: () => void }).unref === "function") {
        (timeoutTimer as { unref: () => void }).unref();
      }
    }

    const clearCallResources = () => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      req.signal.removeEventListener("abort", onClientAbort);
    };

    const grpcCtx = new GrpcContext({
      service: route.service,
      method: route.method,
      path: pathname,
      grpcMetadata: incomingMetadata,
      deadline,
      signal: abortController.signal,
    });

    try {
      const result = await this.runWithProcessingHooks(grpcCtx, () =>
        this.invokeWithDeadline(
          () => Promise.resolve(route.handler(requestData, grpcCtx)),
          abortController.signal,
          () => timedOut,
          pathname,
          timeoutMs,
        ),
      );

      if (route.streaming || isAsyncIterable(result)) {
        if (!isAsyncIterable(result)) {
          clearCallResources();
          const encoded = this.codec.encode(result, pathname);
          const headers: Record<string, string> = {
            ...sanitizeMetadataHeaders(grpcCtx.responseMetadata),
            "content-type": this.codec.contentType,
            "grpc-status": String(GrpcStatus.OK),
            "grpc-message": "",
          };
          return new Response(encodeGrpcFrame(encoded), {
            status: 200,
            headers,
          });
        }

        const iterator = result[Symbol.asyncIterator]();
        const codec = this.codec;
        let streamClosed = false;

        const nextWithAbort = (): Promise<
          | { readonly aborted: true }
          | { readonly aborted: false; readonly step: IteratorResult<unknown> }
        > => {
          if (abortController.signal.aborted) {
            return Promise.resolve({ aborted: true });
          }
          return new Promise((resolve, reject) => {
            const onAbort = () => {
              resolve({ aborted: true });
            };
            abortController.signal.addEventListener("abort", onAbort, {
              once: true,
            });
            iterator.next().then(
              (step) => {
                abortController.signal.removeEventListener("abort", onAbort);
                resolve({ aborted: false, step });
              },
              (err) => {
                abortController.signal.removeEventListener("abort", onAbort);
                reject(err);
              },
            );
          });
        };

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const safeEnqueue = (chunk: Uint8Array) => {
              if (streamClosed) return;
              try {
                controller.enqueue(chunk);
              } catch {
                streamClosed = true;
              }
            };
            const safeClose = () => {
              if (streamClosed) return;
              streamClosed = true;
              try {
                controller.close();
              } catch {
                // Already closed or cancelled
              }
            };

            try {
              while (!streamClosed) {
                const outcome = await nextWithAbort();
                if (streamClosed) {
                  break;
                }
                if (outcome.aborted) {
                  const errCode = timedOut
                    ? GrpcStatus.DEADLINE_EXCEEDED
                    : GrpcStatus.CANCELLED;
                  const errMsg = timedOut
                    ? `gRPC deadline exceeded for "${pathname}"`
                    : "gRPC stream cancelled";
                  void iterator.return?.().catch(() => {});
                  safeEnqueue(
                    encodeGrpcTrailerFrame({
                      ...sanitizeMetadataHeaders(grpcCtx.responseMetadata),
                      "grpc-status": String(errCode),
                      "grpc-message": encodeURIComponent(errMsg),
                    }),
                  );
                  safeClose();
                  return;
                }
                if (outcome.step.done) {
                  break;
                }
                const payload = codec.encode(outcome.step.value, pathname);
                safeEnqueue(encodeGrpcFrame(payload));
              }

              if (!streamClosed) {
                safeEnqueue(
                  encodeGrpcTrailerFrame({
                    ...sanitizeMetadataHeaders(grpcCtx.responseMetadata),
                    "grpc-status": String(GrpcStatus.OK),
                    "grpc-message": "",
                  }),
                );
                safeClose();
              }
            } catch (streamErr) {
              if (!streamClosed) {
                const mapped = mapErrorToGrpc(streamErr);
                const trailerHeaders: Record<string, string> = {
                  ...sanitizeMetadataHeaders(grpcCtx.responseMetadata),
                  ...sanitizeMetadataHeaders(mapped.metadata),
                  "grpc-status": String(mapped.code),
                  "grpc-message": encodeURIComponent(mapped.message),
                };
                safeEnqueue(encodeGrpcTrailerFrame(trailerHeaders));
                safeClose();
              }
            } finally {
              clearCallResources();
            }
          },
          cancel() {
            streamClosed = true;
            abortController.abort();
            void iterator.return?.().catch(() => {});
            clearCallResources();
          },
        });

        const headers: Record<string, string> = {
          ...sanitizeMetadataHeaders(grpcCtx.responseMetadata),
          "content-type": this.codec.contentType,
          "grpc-status": String(GrpcStatus.OK),
          "grpc-message": "",
        };
        return new Response(stream, { status: 200, headers });
      }

      clearCallResources();
      const encoded = this.codec.encode(result, pathname);
      const headers: Record<string, string> = {
        ...sanitizeMetadataHeaders(grpcCtx.responseMetadata),
        "content-type": this.codec.contentType,
        "grpc-status": String(GrpcStatus.OK),
        "grpc-message": "",
      };
      return new Response(encodeGrpcFrame(encoded), { status: 200, headers });
    } catch (err) {
      clearCallResources();
      const mapped = mapErrorToGrpc(err);
      const mergedMd = grpcCtx.responseMetadata.clone();
      if (mapped.metadata) {
        for (const [k, v] of Object.entries(mapped.metadata.toHeaders())) {
          mergedMd.set(k, v);
        }
      }
      return this.buildErrorResponse(mapped.code, mapped.message, mergedMd);
    }
  }

  private async invokeWithDeadline<T>(
    exec: () => Promise<T>,
    signal: AbortSignal,
    isTimedOut: () => boolean,
    pathname: string,
    timeoutMs: number | undefined,
  ): Promise<T> {
    if (signal.aborted) {
      throw new GrpcException(
        isTimedOut() ? GrpcStatus.DEADLINE_EXCEEDED : GrpcStatus.CANCELLED,
        isTimedOut()
          ? `gRPC deadline exceeded after ${timeoutMs}ms for "${pathname}"`
          : "gRPC request cancelled",
      );
    }

    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        reject(
          new GrpcException(
            isTimedOut() ? GrpcStatus.DEADLINE_EXCEEDED : GrpcStatus.CANCELLED,
            isTimedOut()
              ? `gRPC deadline exceeded after ${timeoutMs}ms for "${pathname}"`
              : "gRPC request cancelled",
          ),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });

      exec().then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Native Bun gRPC Client Proxy
// ---------------------------------------------------------------------------

export interface GrpcCallOptions {
  readonly timeoutMs?: number;
  readonly metadata?: GrpcMetadata | Readonly<Record<string, string>>;
}

export interface GrpcCallResult<TRes = unknown> {
  readonly data: TRes;
  readonly metadata: GrpcMetadata;
  readonly status: GrpcStatus;
}

/**
 * Native Bun gRPC client proxy supporting unary RPCs (`call`, `callWithMetadata`,
 * `send`), server-streaming RPCs (`stream`), typed dynamic service proxies
 * (`getService`), custom codecs, `GrpcMetadata`, `grpc-timeout`, and `GrpcException`
 * status code propagation.
 */
export class GrpcClientProxy extends ClientProxy implements ClientGrpc {
  public readonly transport = Transport.GRPC;

  private readonly baseUrl: string;
  private readonly defaultPackage?: string;
  private readonly codec: GrpcCodec;
  private readonly maxMessageBytes: number;
  private readonly defaultMetadata?: GrpcMetadata;

  private readonly activeControllers = new Set<AbortController>();
  private readonly serviceClients = new Map<string, any>();
  private closed = false;

  constructor(options: GrpcTransportOptions = {}) {
    super(options.defaultTimeoutMs ?? 5000);
    const resolved = resolveHostAndPort(options);
    this.baseUrl =
      resolved.baseUrl ?? `http://${resolved.host}:${resolved.port}`;
    this.defaultPackage = Array.isArray(options.package)
      ? options.package[0]
      : options.package;
    this.codec = options.codec ?? defaultGrpcCodec;
    this.maxMessageBytes =
      options.maxMessageBytes ?? DEFAULT_MAX_GRPC_MESSAGE_BYTES;

    if (options.metadata) {
      if (options.metadata instanceof GrpcMetadata) {
        this.defaultMetadata = options.metadata.clone();
      } else if (
        typeof (options.metadata as GrpcMetadataLike).toHeaders === "function"
      ) {
        this.defaultMetadata = GrpcMetadata.fromHeaders(
          (options.metadata as GrpcMetadataLike).toHeaders(),
        );
      } else {
        this.defaultMetadata = new GrpcMetadata(
          options.metadata as Readonly<Record<string, string>>,
        );
      }
    }
  }

  async connect(): Promise<void> {
    this.closed = false;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of [...this.activeControllers]) {
      controller.abort(new GrpcException(GrpcStatus.CANCELLED, "GrpcClientProxy closed"));
    }
    this.activeControllers.clear();
  }

  private buildMethodPath(service: string, method: string): string {
    const qualifiedService =
      this.defaultPackage && !service.includes(".")
        ? `${this.defaultPackage}.${service}`
        : service;
    return `/${qualifiedService}/${method}`;
  }

  private buildRequestHeaders(
    timeoutMs: number,
    callMetadata?: GrpcMetadata | Readonly<Record<string, string>>,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": this.codec.contentType,
      te: "trailers",
      "grpc-timeout": formatGrpcTimeout(timeoutMs),
    };
    if (this.defaultMetadata) {
      Object.assign(headers, this.defaultMetadata.toHeaders());
    }
    if (callMetadata) {
      if (callMetadata instanceof GrpcMetadata) {
        Object.assign(headers, callMetadata.toHeaders());
      } else {
        Object.assign(headers, new GrpcMetadata(callMetadata).toHeaders());
      }
    }
    return headers;
  }

  /**
   * Executes a unary gRPC RPC call and returns both the decoded response payload
   * and response `GrpcMetadata`.
   */
  async callWithMetadata<TRes = any, TReq = any>(
    service: string,
    method: string,
    data: TReq,
    options?: GrpcCallOptions,
  ): Promise<GrpcCallResult<TRes>> {
    if (this.closed) {
      throw new GrpcException(
        GrpcStatus.UNAVAILABLE,
        "GrpcClientProxy is closed.",
      );
    }

    const path = this.buildMethodPath(service, method);
    const timeoutMs = Math.max(
      1,
      Math.floor(options?.timeoutMs ?? this.defaultTimeoutMs),
    );
    const encoded = this.codec.encode(data, path);
    const frame = encodeGrpcFrame(encoded);
    const headers = this.buildRequestHeaders(timeoutMs, options?.metadata);

    const controller = new AbortController();
    this.activeControllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: frame,
        signal: controller.signal,
      });

      const responseMetadata = GrpcMetadata.fromHeaders(response.headers);
      const statusHeader = response.headers.get("grpc-status");
      const messageHeader = response.headers.get("grpc-message");
      const grpcStatus =
        statusHeader !== null
          ? (Number(statusHeader) as GrpcStatus)
          : response.ok
            ? GrpcStatus.OK
            : mapHttpStatusToGrpc(response.status);

      if (grpcStatus !== GrpcStatus.OK) {
        const msg = safeDecodeGrpcMessage(
          messageHeader,
          `gRPC call "${path}" failed with status ${grpcStatus}`,
        );
        throw new GrpcException(grpcStatus, msg, responseMetadata);
      }

      const rawBytes = new Uint8Array(await response.arrayBuffer());
      const decoder = new GrpcFrameDecoder(this.maxMessageBytes);
      const frames = decoder.push(rawBytes);
      if (decoder.remainingBytes > 0) {
        throw new GrpcException(
          GrpcStatus.DATA_LOSS,
          `Truncated gRPC response frame for "${path}" (${decoder.remainingBytes} trailing bytes)`,
          responseMetadata,
        );
      }

      let resultData: TRes = undefined as TRes;
      for (const f of frames) {
        if (f.isTrailer) {
          const trailers = parseGrpcTrailers(f.payload);
          for (const [k, v] of Object.entries(trailers)) {
            if (!RESERVED_HTTP_HEADERS.has(k)) {
              responseMetadata.set(k, v);
            }
          }
          const tStatus =
            trailers["grpc-status"] !== undefined
              ? (Number(trailers["grpc-status"]) as GrpcStatus)
              : GrpcStatus.OK;
          if (tStatus !== GrpcStatus.OK) {
            const tMsg = safeDecodeGrpcMessage(
              trailers["grpc-message"],
              `gRPC call "${path}" failed with status ${tStatus}`,
            );
            throw new GrpcException(tStatus, tMsg, responseMetadata);
          }
        } else {
          resultData = this.codec.decode<TRes>(f.payload, path);
        }
      }

      return {
        data: resultData,
        metadata: responseMetadata,
        status: GrpcStatus.OK,
      };
    } catch (err) {
      if (err instanceof GrpcException) {
        throw err;
      }
      if (timedOut) {
        throw new GrpcException(
          GrpcStatus.DEADLINE_EXCEEDED,
          `gRPC call "${path}" timed out after ${timeoutMs}ms`,
        );
      }
      if (controller.signal.aborted) {
        throw new GrpcException(
          GrpcStatus.CANCELLED,
          `gRPC call "${path}" was cancelled`,
        );
      }
      throw new GrpcException(
        GrpcStatus.UNAVAILABLE,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      clearTimeout(timer);
      this.activeControllers.delete(controller);
    }
  }

  /**
   * Executes a unary gRPC RPC call and returns the decoded response payload.
   */
  async call<TRes = any, TReq = any>(
    service: string,
    method: string,
    data: TReq,
    options?: GrpcCallOptions,
  ): Promise<TRes> {
    const res = await this.callWithMetadata<TRes, TReq>(
      service,
      method,
      data,
      options,
    );
    return res.data;
  }

  /**
   * Executes a server-streaming gRPC RPC call, incrementally yielding decoded
   * response messages from 5-byte length-prefixed frames.
   */
  async *stream<TRes = any, TReq = any>(
    service: string,
    method: string,
    data: TReq,
    options?: GrpcCallOptions,
  ): AsyncGenerator<TRes, void, unknown> {
    if (this.closed) {
      throw new GrpcException(
        GrpcStatus.UNAVAILABLE,
        "GrpcClientProxy is closed.",
      );
    }

    const path = this.buildMethodPath(service, method);
    const timeoutMs = Math.max(
      1,
      Math.floor(options?.timeoutMs ?? this.defaultTimeoutMs),
    );
    const encoded = this.codec.encode(data, path);
    const frame = encodeGrpcFrame(encoded);
    const headers = this.buildRequestHeaders(timeoutMs, options?.metadata);

    const controller = new AbortController();
    this.activeControllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }

    let activeReader: { cancel(): Promise<unknown> } | undefined;

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: frame,
        signal: controller.signal,
      });

      const responseMetadata = GrpcMetadata.fromHeaders(response.headers);
      const statusHeader = response.headers.get("grpc-status");
      const messageHeader = response.headers.get("grpc-message");
      const initialStatus =
        statusHeader !== null
          ? (Number(statusHeader) as GrpcStatus)
          : response.ok
            ? GrpcStatus.OK
            : mapHttpStatusToGrpc(response.status);

      if (initialStatus !== GrpcStatus.OK) {
        const msg = safeDecodeGrpcMessage(
          messageHeader,
          `gRPC stream "${path}" failed with status ${initialStatus}`,
        );
        throw new GrpcException(initialStatus, msg, responseMetadata);
      }

      if (!response.body) {
        return;
      }

      const decoder = new GrpcFrameDecoder(this.maxMessageBytes);
      const streamReader = response.body.getReader();
      activeReader = streamReader;

      while (true) {
        const { done, value } = await streamReader.read();
        if (done) {
          break;
        }
        if (!value || value.byteLength === 0) {
          continue;
        }

        const frames = decoder.push(value);
        for (const f of frames) {
          if (f.isTrailer) {
            const trailers = parseGrpcTrailers(f.payload);
            const trailerMd = responseMetadata.clone();
            for (const [k, v] of Object.entries(trailers)) {
              if (!RESERVED_HTTP_HEADERS.has(k)) {
                trailerMd.set(k, v);
              }
            }
            const tStatus =
              trailers["grpc-status"] !== undefined
                ? (Number(trailers["grpc-status"]) as GrpcStatus)
                : GrpcStatus.OK;
            if (tStatus !== GrpcStatus.OK) {
              const tMsg = safeDecodeGrpcMessage(
                trailers["grpc-message"],
                `gRPC stream "${path}" terminated with status ${tStatus}`,
              );
              throw new GrpcException(tStatus, tMsg, trailerMd);
            }
          } else {
            yield this.codec.decode<TRes>(f.payload, path);
          }
        }
      }

      if (decoder.remainingBytes > 0) {
        throw new GrpcException(
          GrpcStatus.DATA_LOSS,
          `Truncated gRPC stream frame for "${path}" (${decoder.remainingBytes} trailing bytes)`,
          responseMetadata,
        );
      }
    } catch (err) {
      if (err instanceof GrpcException) {
        throw err;
      }
      if (timedOut) {
        throw new GrpcException(
          GrpcStatus.DEADLINE_EXCEEDED,
          `gRPC stream "${path}" timed out after ${timeoutMs}ms`,
        );
      }
      if (controller.signal.aborted) {
        throw new GrpcException(
          GrpcStatus.CANCELLED,
          `gRPC stream "${path}" was cancelled`,
        );
      }
      throw new GrpcException(
        GrpcStatus.UNAVAILABLE,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      clearTimeout(timer);
      if (activeReader) {
        try {
          await activeReader.cancel();
        } catch {
          // Ignore stream cancellation error
        }
      }
      this.activeControllers.delete(controller);
    }
  }

  /**
   * Returns a NestJS-compatible dynamic proxy for a named gRPC service where
   * calling `service.findOne(req, options?)` invokes `/${serviceName}/FindOne`.
   */
  getService<T extends object>(serviceName: string): T {
    const existing = this.serviceClients.get(serviceName);
    if (existing) {
      return existing as T;
    }
    const proxy = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (typeof prop !== "string" || prop === "then") {
            return undefined;
          }
          return (data: unknown, options?: GrpcCallOptions) =>
            this.call(serviceName, prop, data, options);
        },
      },
    ) as T;
    this.serviceClients.set(serviceName, proxy);
    return proxy;
  }

  /**
   * Returns a cached client proxy for the named gRPC service (matches NestJS `ClientGrpc.getClientByServiceName`).
   */
  getClientByServiceName<T = any>(name: string): T {
    return this.getService<object>(name) as T;
  }

  protected override async sendOnce<TRes = any, TReq = any>(
    pattern: string,
    data: TReq,
    timeoutMs: number,
  ): Promise<TRes> {
    const resolved = this.parsePatternToServiceMethod(pattern);
    return await this.call<TRes, TReq>(resolved.service, resolved.method, data, {
      timeoutMs,
    });
  }

  protected override async dispatchEvent<TReq = any>(
    pattern: string,
    data: TReq,
  ): Promise<void> {
    await this.sendOnce(pattern, data, this.defaultTimeoutMs);
  }

  private parsePatternToServiceMethod(pattern: string): {
    service: string;
    method: string;
  } {
    if (pattern.startsWith("/")) {
      const parsed = parseGrpcPath(pattern);
      if (parsed) return parsed;
    }
    if (pattern.startsWith("{")) {
      try {
        const obj = JSON.parse(pattern) as {
          service?: string;
          method?: string;
        };
        if (obj.service && obj.method) {
          return { service: obj.service, method: obj.method };
        }
      } catch {
        // Fall through
      }
    }
    const dotIdx = pattern.lastIndexOf(".");
    if (dotIdx > 0 && dotIdx < pattern.length - 1) {
      return {
        service: pattern.slice(0, dotIdx),
        method: pattern.slice(dotIdx + 1),
      };
    }
    throw new GrpcException(
      GrpcStatus.INVALID_ARGUMENT,
      `Invalid gRPC pattern "${pattern}". Expected "/Service/Method" or "Service.Method".`,
    );
  }
}

export { GrpcServer as ServerGrpc, GrpcClientProxy as ClientGrpcProxy };
