import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  StreamableFile,
} from "@bunest/common";
import { Readable } from "node:stream";
import {
  contentDisposition,
  servesSignedUrls,
  type StorageDisk,
} from "../disks/storage.disk";
import {
  StorageBodyLengthError,
  StorageFileNotFoundError,
  StorageInvalidKeyError,
  StorageKeyConflictError,
  StorageRangeNotSatisfiableError,
  StorageSignedUrlError,
} from "../errors";
import type {
  ServeFileOptions,
  ServeSignedUrlOptions,
  StorageRange,
  StorageSignedUrlClaims,
} from "../interfaces/storage-types";
import { contentTypeEssence } from "../utils/content-type.util";
import { basename } from "../utils/keys.util";

const INLINE_SAFE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/heic",
  "image/bmp",
  "image/tiff",
  "image/vnd.microsoft.icon",
  "application/pdf",
  "text/plain",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/ogg",
]);

interface ResponseLike {
  status?: (code: number) => unknown;
  code?: (code: number) => unknown;
  statusCode?: number;
  header?: (n: string, v: string) => unknown;
  setHeader?: (n: string, v: string) => unknown;
  raw?: unknown;
  once?: (event: string, listener: () => void) => unknown;
  destroyed?: boolean;
}

export function assertResponse(res: unknown): asserts res is ResponseLike {
  if (!res || typeof res !== "object") {
    throw new TypeError("serveFile() requires a response object (`res`)");
  }
  const r = res as ResponseLike;
  if (
    typeof r.header !== "function" &&
    typeof r.setHeader !== "function" &&
    (!r.raw || typeof (r.raw as ResponseLike).setHeader !== "function")
  ) {
    throw new TypeError(
      "Response object must provide `header()` or `setHeader()`",
    );
  }
}

export function setHeader(res: unknown, name: string, value: string): void {
  const r = res as ResponseLike;
  if (typeof r.header === "function") {
    r.header(name, value);
  } else if (typeof r.setHeader === "function") {
    r.setHeader(name, value);
  } else if (r.raw && typeof (r.raw as ResponseLike).setHeader === "function") {
    (r.raw as ResponseLike).setHeader!(name, value);
  }
}

export function setStatus(res: unknown, status: number): void {
  const r = res as ResponseLike;
  if (typeof r.code === "function") {
    r.code(status);
  } else if (typeof r.status === "function") {
    r.status(status);
  } else if ("statusCode" in r || typeof r === "object") {
    r.statusCode = status;
  }
}

export function requestHeaders(req: unknown): Record<string, string | undefined> {
  if (!req || typeof req !== "object") {
    return {};
  }
  if (req instanceof Request) {
    const out: Record<string, string | undefined> = {};
    req.headers.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  const rawHeaders = (req as { headers?: unknown }).headers;
  if (rawHeaders instanceof Headers) {
    const out: Record<string, string | undefined> = {};
    rawHeaders.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  if (rawHeaders && typeof rawHeaders === "object") {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof v === "string") {
        out[k.toLowerCase()] = v;
      } else if (Array.isArray(v) && typeof v[0] === "string") {
        out[k.toLowerCase()] = v.join(", ");
      }
    }
    return out;
  }
  return {};
}

export function requestUrl(req: unknown): string {
  if (!req || typeof req !== "object") {
    return "";
  }
  if (req instanceof Request) {
    return req.url;
  }
  const r = req as { originalUrl?: unknown; url?: unknown };
  if (typeof r.originalUrl === "string") {
    return r.originalUrl;
  }
  if (typeof r.url === "string") {
    return r.url;
  }
  return "";
}

function parseSingleRangeHeader(header: string | undefined): StorageRange | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!/^bytes=/i.test(trimmed)) return undefined;
  const spec = trimmed.slice(6).trim();
  // Multi-range not supported -> ignore Range header per RFC 9110
  if (spec.includes(",")) return undefined;
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) return undefined;
  const [, startStr, endStr] = match;
  if (!startStr && !endStr) return undefined;
  if (!startStr && endStr) {
    return { suffix: Number(endStr) };
  }
  const start = Number(startStr);
  if (!endStr) {
    return { start };
  }
  const end = Number(endStr);
  if (end < start) return undefined;
  return { start, end };
}

function etagMatches(ifNoneMatch: string | undefined, etag: string | undefined): boolean {
  if (!ifNoneMatch || !etag) return false;
  const trimmed = ifNoneMatch.trim();
  if (trimmed === "*") return true;
  const normalize = (tag: string) => tag.trim().replace(/^W\//i, "");
  const target = normalize(etag);
  return trimmed
    .split(",")
    .map(normalize)
    .some((candidate) => candidate === target);
}

/** The one place the HTTP helpers turn storage errors into responses. */
export function toHttpError(error: unknown, res?: unknown): unknown {
  if (error instanceof StorageFileNotFoundError) {
    return new NotFoundException(error.message);
  }
  if (error instanceof StorageInvalidKeyError) {
    return new BadRequestException(error.message);
  }
  if (error instanceof StorageBodyLengthError) {
    return new BadRequestException(error.message);
  }
  if (error instanceof StorageKeyConflictError) {
    return new ConflictException(error.message);
  }
  if (error instanceof StorageSignedUrlError) {
    return new ForbiddenException(error.message);
  }
  if (error instanceof StorageRangeNotSatisfiableError) {
    if (res && error.size !== undefined) {
      setHeader(res, "Content-Range", `bytes */${error.size}`);
    }
    return new HttpException(error.message, HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
  }
  return error;
}

export function verify(
  disk: StorageDisk,
  req: unknown,
  method: "GET" | "PUT",
): StorageSignedUrlClaims {
  if (!servesSignedUrls(disk)) {
    throw new ForbiddenException(
      "Disk is not configured for app-served signed URLs",
    );
  }
  const url = requestUrl(req);
  try {
    return disk.verifySignedUrl(url, method);
  } catch (err) {
    throw toHttpError(err);
  }
}

async function serveDownload(
  disk: StorageDisk,
  key: string,
  options: ServeFileOptions & { forcedDisposition?: string },
): Promise<StreamableFile | undefined> {
  assertResponse(options.res);
  const headers = requestHeaders(options.req);
  const ifNoneMatch = headers["if-none-match"];
  const range = parseSingleRangeHeader(headers["range"]);

  const ac = new AbortController();
  const reqSignal =
    options.req instanceof Request
      ? options.req.signal
      : (options.req as { signal?: AbortSignal } | undefined)?.signal;
  if (reqSignal) {
    if (reqSignal.aborted) ac.abort(reqSignal.reason);
    else reqSignal.addEventListener("abort", () => ac.abort(reqSignal.reason), { once: true });
  }

  try {
    if (ifNoneMatch) {
      const info = await disk.stat(key, { signal: ac.signal });
      if (etagMatches(ifNoneMatch, info.etag)) {
        if (info.etag) setHeader(options.res, "ETag", info.etag);
        setHeader(options.res, "Last-Modified", info.lastModified.toUTCString());
        setHeader(
          options.res,
          "Cache-Control",
          options.cacheControl ?? info.cacheControl ?? "private",
        );
        setHeader(options.res, "X-Content-Type-Options", "nosniff");
        setStatus(options.res, 304);
        return undefined;
      }
    }

    const download = await disk.get(key, {
      ...(range !== undefined ? { range } : {}),
      signal: ac.signal,
    });

    const safeInline = INLINE_SAFE_TYPES.has(
      contentTypeEssence(download.contentType),
    );
    const filename = options.filename ?? basename(key);
    let dispositionValue: string;
    if (options.forcedDisposition !== undefined) {
      if (
        options.forcedDisposition.startsWith("inline") &&
        !safeInline
      ) {
        dispositionValue = contentDisposition("attachment", filename);
      } else {
        dispositionValue = options.forcedDisposition;
      }
    } else {
      const reqDisp = options.disposition ?? "attachment";
      const effectiveDisp: "attachment" | "inline" =
        reqDisp === "inline" && safeInline ? "inline" : "attachment";
      dispositionValue =
        download.contentDisposition ??
        contentDisposition(effectiveDisp, filename);
    }

    const bodyLength = download.range
      ? download.range.end - download.range.start + 1
      : download.size;

    setHeader(options.res, "Content-Type", download.contentType);
    setHeader(options.res, "Content-Length", String(bodyLength));
    setHeader(options.res, "Content-Disposition", dispositionValue);
    if (download.etag) {
      setHeader(options.res, "ETag", download.etag);
    }
    setHeader(options.res, "Last-Modified", download.lastModified.toUTCString());
    setHeader(
      options.res,
      "Cache-Control",
      options.cacheControl ?? download.cacheControl ?? "private",
    );
    setHeader(options.res, "X-Content-Type-Options", "nosniff");
    setHeader(options.res, "Accept-Ranges", "bytes");

    if (download.range) {
      setHeader(
        options.res,
        "Content-Range",
        `bytes ${download.range.start}-${download.range.end}/${download.size}`,
      );
      setStatus(options.res, 206);
    }

    const webStream = Readable.toWeb(
      download.body,
    ) as unknown as ReadableStream<Uint8Array>;

    return new StreamableFile(webStream, {
      type: download.contentType,
      disposition: dispositionValue,
      length: bodyLength,
    });
  } catch (err) {
    throw toHttpError(err, options.res);
  }
}

/**
 * Streams a file from a disk as the response with safe headers, Range (206/416) and ETag (304).
 */
export async function serveFile(
  disk: StorageDisk,
  key: string,
  options: ServeFileOptions,
): Promise<StreamableFile | undefined> {
  return await serveDownload(disk, key, options);
}

/**
 * Serves a file behind an app-served signed URL (`LocalDisk` / `InMemoryDisk` with `signedUrls`).
 */
export async function serveSignedUrl(
  disk: StorageDisk,
  options: ServeSignedUrlOptions,
): Promise<StreamableFile | undefined> {
  const claims = verify(disk, options.req, "GET");
  return await serveDownload(disk, claims.key, {
    ...options,
    forcedDisposition:
      claims.contentDisposition ??
      contentDisposition("attachment", basename(claims.key)),
  });
}
