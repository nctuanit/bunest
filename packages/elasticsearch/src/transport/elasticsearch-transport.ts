import { ensurePrefix } from "@bunest/core/common";
import {
  ElasticsearchAbortError,
  ElasticsearchConnectionError,
  ElasticsearchResponseError,
  ElasticsearchTimeoutError,
} from "../errors/elasticsearch.errors";
import type {
  ClientOptions,
  Context,
  ElasticsearchAuth,
  FetchLike,
  GenerateRequestIdFn,
  TransportRequestOptions,
  TransportRequestParams,
  TransportResult,
} from "../interfaces/elasticsearch-types.interface";
import { ElasticsearchConnectionPool } from "./connection-pool";
import { ElasticsearchDiagnostic } from "./diagnostic";
import { ElasticsearchSerializer } from "./serializer";

const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

function buildAuthHeader(auth?: ElasticsearchAuth): string | undefined {
  if (!auth) return undefined;
  if ("username" in auth && "password" in auth) {
    const token = Buffer.from(
      `${auth.username}:${auth.password}`,
      "utf8",
    ).toString("base64");
    return `Basic ${token}`;
  }
  if ("apiKey" in auth) {
    if (typeof auth.apiKey === "string") {
      return `ApiKey ${auth.apiKey}`;
    }
    const token = Buffer.from(
      `${auth.apiKey.id}:${auth.apiKey.api_key}`,
      "utf8",
    ).toString("base64");
    return `ApiKey ${token}`;
  }
  if ("bearer" in auth) {
    return `Bearer ${auth.bearer}`;
  }
  return undefined;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function parseWarnings(headers: Headers): string[] {
  const warning = headers.get("warning");
  if (!warning) return [];
  return warning
    .split(/,\s*(?=\d{3}\s)/)
    .map((w) => w.trim())
    .filter(Boolean);
}

function combineSignals(
  signal?: AbortSignal,
  timeoutMs?: number,
): { signal?: AbortSignal; timeoutSignal?: AbortSignal } {
  const timeoutSignal =
    timeoutMs !== undefined && timeoutMs > 0
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  if (signal && timeoutSignal) {
    return { signal: AbortSignal.any([signal, timeoutSignal]), timeoutSignal };
  }
  return { signal: signal ?? timeoutSignal, timeoutSignal };
}

export class ElasticsearchTransport {
  readonly connectionPool: ElasticsearchConnectionPool;
  readonly serializer: ElasticsearchSerializer;
  readonly diagnostic: ElasticsearchDiagnostic;
  readonly name: string | symbol;
  readonly maxRetries: number;
  readonly requestTimeout?: number;
  readonly pingTimeout: number;
  readonly compression: boolean | "gzip" | "zstd";
  readonly enableMetaHeader: boolean;
  readonly opaqueIdPrefix?: string;
  readonly maxPathLength?: number | null;
  readonly maxResponseSize?: number;
  readonly sniffEndpoint: string;
  readonly serverMode: "stack" | "serverless";
  readonly defaultHeaders: Record<string, string>;
  readonly defaultContext: Context | null;
  private readonly authHeader?: string;
  private readonly generateRequestId: GenerateRequestIdFn;
  private readonly fetchImpl: FetchLike;
  private reqCounter = 0;

  constructor(
    options: ClientOptions,
    shared?: {
      connectionPool?: ElasticsearchConnectionPool;
      serializer?: ElasticsearchSerializer;
      diagnostic?: ElasticsearchDiagnostic;
    },
  ) {
    this.connectionPool =
      shared?.connectionPool ??
      new ElasticsearchConnectionPool({
        node: options.node,
        nodes: options.nodes,
        cloud: options.cloud,
        resurrectStrategy: options.resurrectStrategy,
        nodeFilter: options.nodeFilter,
        nodeSelector: options.nodeSelector,
      });

    this.serializer =
      shared?.serializer ??
      new ElasticsearchSerializer(options.disablePrototypePoisoningProtection);

    this.diagnostic = shared?.diagnostic ?? new ElasticsearchDiagnostic();
    this.name = options.name ?? "elasticsearch-js";
    this.maxRetries = options.maxRetries ?? 3;
    this.requestTimeout = options.requestTimeout;
    this.pingTimeout = options.pingTimeout ?? 3000;
    this.compression = options.compression ?? false;
    this.enableMetaHeader = options.enableMetaHeader ?? true;
    this.opaqueIdPrefix = options.opaqueIdPrefix;
    this.maxPathLength = options.maxPathLength;
    this.maxResponseSize = options.maxResponseSize;
    this.sniffEndpoint = options.sniffEndpoint ?? "_nodes/_all/http";
    this.serverMode = options.serverMode ?? "stack";
    this.defaultContext = options.context ? { ...options.context } : null;
    this.authHeader = buildAuthHeader(options.auth);
    this.fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);

    this.defaultHeaders = {};
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        if (v !== undefined && v !== null) {
          this.defaultHeaders[k.toLowerCase()] = String(v);
        }
      }
    }

    this.generateRequestId =
      options.generateRequestId ?? (() => ++this.reqCounter);
  }

  async request<TBody = any>(
    params: TransportRequestParams,
    options: TransportRequestOptions = {},
  ): Promise<TransportResult<TBody>> {
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const requestTimeout = options.requestTimeout ?? this.requestTimeout;
    const ignoreCodes = new Set(options.ignore ?? []);
    const requestId = this.generateRequestId(params, options);
    const context = options.context ?? this.defaultContext;

    const mergedQuery =
      typeof params.querystring === "string"
        ? params.querystring
        : {
            ...(params.querystring ?? {}),
            ...(options.querystring ?? {}),
          };
    const qs = this.serializer.qserialize(mergedQuery);
    const cleanPath = ensurePrefix(params.path, "/");
    const fullPath = qs ? `${cleanPath}?${qs}` : cleanPath;

    if (
      this.maxPathLength !== undefined &&
      this.maxPathLength !== null &&
      Buffer.byteLength(fullPath, "utf8") > this.maxPathLength
    ) {
      throw new ElasticsearchConnectionError(
        `Request path length (${Buffer.byteLength(fullPath, "utf8")}) exceeds maxPathLength (${this.maxPathLength})`,
      );
    }

    let serializedBody: string | Uint8Array | undefined;
    const useNdjson = Boolean(params.ndjson);

    if (params.body !== undefined && params.body !== null) {
      if (useNdjson && Array.isArray(params.body)) {
        serializedBody = this.serializer.ndserialize(params.body);
      } else if (
        typeof params.body === "string" ||
        params.body instanceof Uint8Array
      ) {
        serializedBody = params.body;
      } else {
        serializedBody = this.serializer.serialize(params.body);
      }
    }

    let attempt = 0;
    let lastError: unknown;

    while (attempt <= maxRetries) {
      attempt += 1;
      const connection = this.connectionPool.getConnection();
      if (!connection) {
        throw new ElasticsearchConnectionError(
          "No living connections available",
        );
      }

      const targetUrl = new URL(fullPath, connection.url);
      const headers = new Headers();
      headers.set("accept", "application/json");
      headers.set("user-agent", "bunest-elasticsearch/0.1.0");
      if (this.enableMetaHeader) {
        headers.set(
          "x-elastic-client-meta",
          `es=9.0.0,js=${Bun.version},t=9.0.0,hc=bun`,
        );
      }

      for (const [k, v] of Object.entries(this.defaultHeaders)) {
        headers.set(k, v);
      }
      for (const [k, v] of Object.entries(connection.headers)) {
        headers.set(k, v);
      }
      if (params.headers) {
        for (const [k, v] of Object.entries(params.headers)) {
          if (v !== undefined && v !== null) headers.set(k, String(v));
        }
      }
      if (options.headers) {
        for (const [k, v] of Object.entries(options.headers)) {
          if (v !== undefined && v !== null) headers.set(k, String(v));
        }
      }

      if (this.authHeader && !headers.has("authorization")) {
        headers.set("authorization", this.authHeader);
      }

      const baseOpaqueId =
        options.opaqueId || (this.opaqueIdPrefix ? requestId : undefined);
      const opaqueId =
        baseOpaqueId !== undefined
          ? `${this.opaqueIdPrefix ?? ""}${baseOpaqueId}`
          : undefined;
      if (opaqueId && !headers.has("x-opaque-id")) {
        headers.set("x-opaque-id", opaqueId);
      }

      const methodUpper = params.method.toUpperCase();
      const canSendBody = methodUpper !== "GET" && methodUpper !== "HEAD";
      let finalBody: RequestInit["body"] | undefined;
      if (canSendBody && serializedBody !== undefined) {
        if (!headers.has("content-type")) {
          headers.set(
            "content-type",
            useNdjson ? "application/x-ndjson" : "application/json",
          );
        }
        const compressionMode = options.compression ?? this.compression;
        if (compressionMode) {
          const rawBytes =
            typeof serializedBody === "string"
              ? Buffer.from(serializedBody, "utf8")
              : serializedBody;
          if (compressionMode === "zstd") {
            finalBody = await Bun.zstdCompress(rawBytes);
            headers.set("content-encoding", "zstd");
          } else {
            const gzipInput: Uint8Array<ArrayBuffer> =
              rawBytes.buffer instanceof ArrayBuffer
                ? (rawBytes as Uint8Array<ArrayBuffer>)
                : new Uint8Array(rawBytes);
            finalBody = Bun.gzipSync(gzipInput);
            headers.set("content-encoding", "gzip");
          }
        } else {
          finalBody = serializedBody as RequestInit["body"];
        }
      }

      const { signal, timeoutSignal } = combineSignals(
        options.signal,
        requestTimeout,
      );

      const metaBase = {
        context,
        name: this.name,
        request: { params, options, id: requestId },
        connection: { url: connection.url.href, id: connection.id },
        attempts: attempt,
        aborted: false,
      };

      this.diagnostic.emit("request", null, metaBase);

      try {
        const response = await this.fetchImpl(targetUrl.toString(), {
          method: methodUpper,
          headers,
          body: canSendBody ? finalBody : undefined,
          signal,
        });

        const responseHeaders = headersToRecord(response.headers);
        const warnings = parseWarnings(response.headers);
        const statusCode = response.status;

        let parsedBody: unknown;
        if (methodUpper === "HEAD") {
          parsedBody = "";
        } else {
          const rawText = await response.text();
          if (
            this.maxResponseSize !== undefined &&
            Buffer.byteLength(rawText, "utf8") > this.maxResponseSize
          ) {
            throw new ElasticsearchConnectionError(
              `Response size exceeds maxResponseSize (${this.maxResponseSize})`,
              {
                statusCode,
                headers: responseHeaders,
                warnings,
                meta: metaBase,
              },
            );
          }
          const ct = (responseHeaders["content-type"] ?? "").toLowerCase();
          if (rawText.length === 0) {
            parsedBody = "";
          } else if (
            params.ndjsonResponse ||
            options.ndjsonResponse ||
            ct.includes("application/x-ndjson") ||
            ct.includes("application/jsonl")
          ) {
            try {
              parsedBody = this.serializer.deserializeNdjson(rawText);
            } catch {
              parsedBody = rawText;
            }
          } else if (
            ct.includes("application/json") ||
            ct.includes("+json") ||
            rawText.startsWith("{") ||
            rawText.startsWith("[")
          ) {
            try {
              parsedBody = this.serializer.deserialize(rawText);
            } catch {
              parsedBody = rawText;
            }
          } else {
            parsedBody = rawText;
          }
        }

        const result: TransportResult<TBody> = {
          body: parsedBody as TBody,
          statusCode,
          headers: responseHeaders,
          warnings,
          meta: metaBase,
        };

        if (statusCode >= 400 && !ignoreCodes.has(statusCode)) {
          const respErr = new ElasticsearchResponseError({
            body: parsedBody,
            statusCode,
            headers: responseHeaders,
            warnings,
            meta: metaBase,
          });
          if (RETRYABLE_STATUS_CODES.has(statusCode) && attempt <= maxRetries) {
            this.connectionPool.markDead(connection);
            lastError = respErr;
            this.diagnostic.emit("response", respErr, result);
            continue;
          }
          this.diagnostic.emit("response", respErr, result);
          throw respErr;
        }

        this.connectionPool.markAlive(connection);
        this.diagnostic.emit("response", null, result);
        return result;
      } catch (error: unknown) {
        if (error instanceof ElasticsearchResponseError) {
          throw error;
        }
        const isTimeout =
          Boolean(timeoutSignal?.aborted) ||
          (error instanceof Error && error.name === "TimeoutError");
        const isAbort =
          Boolean(options.signal?.aborted) ||
          (error instanceof Error && error.name === "AbortError");

        if (isAbort && !isTimeout) {
          const abortErr = new ElasticsearchAbortError(
            error instanceof Error ? error.message : "Request aborted",
            { meta: { ...metaBase, aborted: true } },
            error,
          );
          this.diagnostic.emit("response", abortErr, { meta: metaBase });
          throw abortErr;
        }

        this.connectionPool.markDead(connection);
        const wrapped = isTimeout
          ? new ElasticsearchTimeoutError(
              error instanceof Error ? error.message : "Request timed out",
              { meta: metaBase },
              error,
            )
          : new ElasticsearchConnectionError(
              error instanceof Error ? error.message : String(error),
              { meta: metaBase },
              error,
            );

        lastError = wrapped;
        this.diagnostic.emit("response", wrapped, { meta: metaBase });

        if (attempt > maxRetries) {
          throw wrapped;
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new ElasticsearchConnectionError("Request failed after retries");
  }

  async sniff(): Promise<TransportResult<any>> {
    const res = await this.request({
      method: "GET",
      path: this.sniffEndpoint,
    });
    this.diagnostic.emit("sniff", null, res);
    return res;
  }

  async close(): Promise<void> {
    await this.connectionPool.close();
  }
}
