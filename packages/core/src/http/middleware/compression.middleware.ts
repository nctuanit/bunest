import {
  DecoratorRegistry,
  Injectable,
  type BunestMiddleware,
  type MiddlewareFunction,
  type NextFunction,
  type ResponseContext,
} from "../../common/index";

export type SupportedCompressionEncoding = "zstd" | "gzip" | "deflate";

export interface CompressionOptions {
  /**
   * Minimum response byte size required before compressing.
   * @default 1024
   */
  threshold?: number;
  /**
   * Minimum byte size for offloading `zstd` compression to Bun's async thread pool
   * (`Bun.zstdCompress`) instead of running synchronously on the event loop.
   * Set to `0` to always use async `zstd`, or `Infinity` to always use sync.
   * @default 16384 (16 KiB)
   */
  asyncThreshold?: number;
  /**
   * Ordered server-preferred compression encodings.
   * @default ["gzip", "deflate"]
   */
  encodings?: readonly SupportedCompressionEncoding[];
  /**
   * Optional compression level forwarded to Bun native compressors.
   */
  level?: number;
  /**
   * Custom predicate returning `false` to skip compression for a given request/response.
   */
  filter?: (req: Request, res: Response) => boolean;
}

const INCOMPRESSIBLE_PREFIXES = ["image/", "video/", "audio/"];
const INCOMPRESSIBLE_EXACT = new Set([
  "application/gzip",
  "application/x-gzip",
  "application/zip",
  "application/zstd",
  "application/x-brotli",
  "application/pdf",
  "application/octet-stream",
  "font/woff",
  "font/woff2",
  "text/event-stream",
]);

function isCompressibleContentType(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }
  const semi = contentType.indexOf(";");
  const mediaType = (semi === -1 ? contentType : contentType.slice(0, semi))
    .trim()
    .toLowerCase();
  if (!mediaType) {
    return false;
  }
  if (mediaType === "image/svg+xml") {
    return true;
  }
  if (INCOMPRESSIBLE_EXACT.has(mediaType)) {
    return false;
  }
  for (const prefix of INCOMPRESSIBLE_PREFIXES) {
    if (mediaType.startsWith(prefix)) {
      return false;
    }
  }
  return (
    mediaType.startsWith("text/") ||
    mediaType.includes("json") ||
    mediaType.includes("xml") ||
    mediaType.includes("javascript") ||
    mediaType === "application/wasm"
  );
}

function negotiateEncoding(
  acceptEncoding: string | null,
  preferred: readonly SupportedCompressionEncoding[],
): SupportedCompressionEncoding | null {
  if (!acceptEncoding) {
    return null;
  }

  const parsed = new Map<string, number>();
  for (const token of acceptEncoding.split(",")) {
    const trimmed = token.trim().toLowerCase();
    if (!trimmed) continue;
    const parts = trimmed.split(";");
    const name = parts[0]?.trim() ?? "";
    if (!name) continue;
    let q = 1;
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i]?.trim() ?? "";
      if (p.startsWith("q=")) {
        const val = Number(p.slice(2));
        if (Number.isFinite(val)) {
          q = val;
        }
      }
    }
    parsed.set(name, q);
  }

  let bestEncoding: SupportedCompressionEncoding | null = null;
  let bestQ = 0;

  for (const candidate of preferred) {
    const explicit = parsed.get(candidate);
    const q = explicit !== undefined ? explicit : (parsed.get("*") ?? 0);
    if (q > bestQ) {
      bestQ = q;
      bestEncoding = candidate;
    }
  }

  return bestQ > 0 ? bestEncoding : null;
}

function compressBytes(
  data: Uint8Array,
  encoding: SupportedCompressionEncoding,
  level?: number,
  asyncThreshold = 16 * 1024,
): Uint8Array | Promise<Uint8Array> {
  if (encoding === "zstd") {
    if (data.byteLength >= asyncThreshold) {
      return level !== undefined
        ? Bun.zstdCompress(data, { level })
        : Bun.zstdCompress(data);
    }
    return level !== undefined
      ? Bun.zstdCompressSync(data, { level })
      : Bun.zstdCompressSync(data);
  }
  const typed = data as Uint8Array<ArrayBuffer>;
  if (encoding === "deflate") {
    return level !== undefined
      ? Bun.deflateSync(typed, { level: level as 1 })
      : Bun.deflateSync(typed);
  }
  return level !== undefined
    ? Bun.gzipSync(typed, { level: level as 1 })
    : Bun.gzipSync(typed);
}

function appendVaryAcceptEncoding(headers: Headers): void {
  const existing = headers.get("vary");
  if (!existing) {
    headers.set("Vary", "Accept-Encoding");
    return;
  }
  const tokens = existing
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.some((t) => t.toLowerCase() === "accept-encoding" || t === "*")) {
    tokens.push("Accept-Encoding");
    headers.set("Vary", tokens.join(", "));
  }
}

/**
 * Creates a Bun-native HTTP response compression middleware (`gzip`, `deflate`, `zstd`)
 * using `Bun.gzipSync` / `Bun.deflateSync` / `Bun.zstdCompress` (async off-thread for large payloads)
 * and `Bun.zstdCompressSync` with zero external deps.
 */
export function createCompressionMiddleware(
  options: CompressionOptions = {},
): MiddlewareFunction {
  const threshold = options.threshold ?? 1024;
  const asyncThreshold = options.asyncThreshold ?? 16 * 1024;
  const encodings: readonly SupportedCompressionEncoding[] =
    options.encodings ?? ["gzip", "deflate"];
  const level = options.level;
  const filter = options.filter;

  return async (
    req: Request,
    _res: ResponseContext,
    next: NextFunction,
  ): Promise<Response | void> => {
    const response = await next();
    if (!response) {
      return response;
    }

    if (req.method === "HEAD") {
      return response;
    }
    if (
      response.status < 200 ||
      response.status === 204 ||
      response.status === 206 ||
      response.status === 304 ||
      response.body === null
    ) {
      return response;
    }
    if (
      response.headers.has("content-encoding") ||
      response.headers.has("content-range")
    ) {
      return response;
    }
    const cacheControl = response.headers.get("cache-control");
    if (cacheControl && cacheControl.toLowerCase().includes("no-transform")) {
      return response;
    }

    const contentType = response.headers.get("content-type");
    const shouldCompress = filter
      ? filter(req, response)
      : isCompressibleContentType(contentType);
    if (!shouldCompress) {
      return response;
    }

    const encoding = negotiateEncoding(
      req.headers.get("accept-encoding"),
      encodings,
    );
    if (!encoding) {
      return response;
    }

    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader !== null) {
      const declaredLength = Number(contentLengthHeader.trim());
      if (
        Number.isFinite(declaredLength) &&
        declaredLength >= 0 &&
        declaredLength < threshold
      ) {
        const headers = new Headers(response.headers);
        appendVaryAcceptEncoding(headers);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
    }

    const rawBytes = await response.bytes();
    if (rawBytes.byteLength < threshold) {
      const headers = new Headers(response.headers);
      appendVaryAcceptEncoding(headers);
      return new Response(rawBytes, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    const compressed = await compressBytes(
      rawBytes,
      encoding,
      level,
      asyncThreshold,
    );
    const headers = new Headers(response.headers);
    headers.set("Content-Encoding", encoding);
    headers.set("Content-Length", String(compressed.byteLength));
    appendVaryAcceptEncoding(headers);

    // RFC 9110: weaken strong ETag when representation changes via content coding
    const etag = headers.get("etag");
    if (etag && !etag.startsWith("W/")) {
      headers.set("ETag", `W/${etag}`);
    }

    return new Response(compressed, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

/**
 * Class-based Bun-native HTTP response compression middleware compatible with
 * both `app.use(CompressionMiddleware)` and `MiddlewareConsumer.apply(CompressionMiddleware)`.
 */
@Injectable()
export class CompressionMiddleware implements BunestMiddleware {
  private readonly fn: MiddlewareFunction;

  constructor(options: CompressionOptions = {}) {
    this.fn = createCompressionMiddleware(options);
  }

  use(
    req: Request,
    res: ResponseContext,
    next: NextFunction,
  ): Promise<Response | void> | Response | void {
    return this.fn(req, res, next);
  }
}

DecoratorRegistry.markInternal(CompressionMiddleware);
