import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  BadRequestException,
  BODY_SANITIZED_SYMBOL,
  PayloadTooLargeException,
  type UploadedFileInfo,
} from "@bunest/common";
import type {
  DiskUploadedFileInfo,
  MultipartStorageOptions,
} from "../interfaces/http-bridge.interface";
import { isDangerousKey, sanitizeObject } from "../security/prototype-sanitizer";

export interface ParsedBodyResult {
  readonly body: unknown;
  readonly files: readonly UploadedFileInfo[];
  readonly rawBody?: Uint8Array;
}

export interface ParseRequestBodyOptions {
  readonly maxBodyBytes?: number;
  readonly rawBody?: boolean;
  readonly multipart?: MultipartStorageOptions;
}

const EMPTY_FILES: readonly UploadedFileInfo[] = Object.freeze([]);
const EMPTY_BYTES = new Uint8Array(0);
const textDecoder = new TextDecoder("utf-8", { fatal: false });
const textEncoder = new TextEncoder();

const MAX_MULTIPART_PREAMBLE_BYTES = 64 * 1024;
const MAX_MULTIPART_HEADER_BYTES = 16 * 1024;
const DEFAULT_MAX_FIELD_BYTES = 10 * 1024 * 1024;

function getMediaType(contentTypeHeader: string | null): string {
  if (!contentTypeHeader) return "";
  const semiIdx = contentTypeHeader.indexOf(";");
  const raw =
    semiIdx === -1 ? contentTypeHeader : contentTypeHeader.slice(0, semiIdx);
  return raw.trim().toLowerCase();
}

function isJsonMediaType(mediaType: string): boolean {
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function markBodySanitized(value: unknown): void {
  if (value !== null && typeof value === "object") {
    Object.defineProperty(value, BODY_SANITIZED_SYMBOL, {
      value: true,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }
}

/**
 * Parses a JSON string and performs a fast 1-pass prototype-pollution check.
 * When the raw JSON text contains none of `__proto__`, `constructor`, `prototype`,
 * or `\u` unicode escape sequences (99.99% of safe payloads), skips recursive
 * object cloning completely and marks the parsed value with non-enumerable
 * `BODY_SANITIZED_SYMBOL` so downstream pipes (e.g. `ValidationPipe`) skip
 * redundant second-pass tree walks.
 */
function parseAndSanitizeJson(rawText: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new BadRequestException("Malformed JSON payload");
  }

  if (parsed === null || typeof parsed !== "object") {
    return parsed;
  }

  const mightContainDangerousKey =
    rawText.includes("__proto__") ||
    rawText.includes("constructor") ||
    rawText.includes("prototype") ||
    rawText.includes("\\u");

  const sanitized = mightContainDangerousKey ? sanitizeObject(parsed) : parsed;
  markBodySanitized(sanitized);
  return sanitized;
}

/**
 * Strictly parses a non-negative integer `Content-Length` header value.
 * Returns `undefined` if the header is missing, empty, or not a valid integer.
 */
function parseValidContentLength(header: string | null): number | undefined {
  if (header === null || header.length === 0) {
    return undefined;
  }
  const trimmed = header.trim();
  const len = trimmed.length;
  if (len === 0) {
    return undefined;
  }
  let value = 0;
  for (let i = 0; i < len; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 48 || code > 57) {
      return undefined;
    }
    value = value * 10 + (code - 48);
    if (!Number.isSafeInteger(value)) {
      return undefined;
    }
  }
  return value;
}

function assertTextByteLength(
  text: string,
  maxBodyBytes: number | undefined,
): void {
  if (maxBodyBytes === undefined) {
    return;
  }
  if (text.length > maxBodyBytes) {
    throw new PayloadTooLargeException(
      `Request body exceeds maximum allowed size of ${maxBodyBytes} bytes`,
    );
  }
  // Each UTF-16 code unit encodes to at most 3 UTF-8 bytes (4 for surrogate pairs, i.e., 2 per code unit).
  // Skip Buffer.byteLength when even the worst-case UTF-8 expansion fits within maxBodyBytes.
  if (text.length * 3 > maxBodyBytes && Buffer.byteLength(text, "utf8") > maxBodyBytes) {
    throw new PayloadTooLargeException(
      `Request body exceeds maximum allowed size of ${maxBodyBytes} bytes`,
    );
  }
}

/**
 * Fast O(1) Content-Length header check executed before buffering the body.
 */
export function assertBodySizeHeader(
  req: Request,
  maxBodyBytes: number | undefined,
): void {
  if (maxBodyBytes === undefined) {
    return;
  }
  const contentLengthHeader = req.headers.get("content-length");
  if (!contentLengthHeader) {
    return;
  }
  const contentLength = Number(contentLengthHeader);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    throw new PayloadTooLargeException(
      `Request body exceeds maximum allowed size of ${maxBodyBytes} bytes`,
    );
  }
}

/**
 * Reads the request body stream into a single `Uint8Array`, enforcing
 * `maxBodyBytes` incrementally so chunked/unlabelled payloads cannot bypass limits.
 */
async function readBoundedBytes(
  req: Request,
  maxBodyBytes: number | undefined,
): Promise<{ bytes: Uint8Array; hadStream: boolean }> {
  assertBodySizeHeader(req, maxBodyBytes);

  if (req.body === null) {
    return { bytes: EMPTY_BYTES, hadStream: false };
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      totalBytes += value.byteLength;
      if (maxBodyBytes !== undefined && totalBytes > maxBodyBytes) {
        await reader.cancel().catch(() => {});
        throw new PayloadTooLargeException(
          `Request body exceeds maximum allowed size of ${maxBodyBytes} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    return { bytes: EMPTY_BYTES, hadStream: true };
  }

  if (chunks.length === 1 && chunks[0] !== undefined) {
    return { bytes: chunks[0], hadStream: true };
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  return { bytes: merged, hadStream: true };
}

function appendFieldValue(
  fields: Record<string, unknown>,
  key: string,
  value: string,
): void {
  if (isDangerousKey(key)) {
    return;
  }
  if (Object.prototype.hasOwnProperty.call(fields, key)) {
    const existing = fields[key];
    if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      fields[key] = [existing, value];
    }
  } else {
    fields[key] = value;
  }
}

function parseUrlEncoded(text: string): Record<string, unknown> {
  const params = new URLSearchParams(text);
  const out: Record<string, unknown> = {};

  for (const [key, value] of params.entries()) {
    appendFieldValue(out, key, value);
  }

  markBodySanitized(out);
  return out;
}

async function parseMultipartInMemory(
  rawBytes: Uint8Array,
  rawContentType: string,
  multipart?: MultipartStorageOptions,
  rawBody?: Uint8Array,
): Promise<ParsedBodyResult> {
  let formData: Awaited<ReturnType<Response["formData"]>>;
  try {
    const response = new Response(rawBytes, {
      headers: { "content-type": rawContentType },
    });
    formData = await response.formData();
  } catch {
    throw new BadRequestException("Malformed multipart/form-data payload");
  }

  const fields: Record<string, unknown> = {};
  const files: UploadedFileInfo[] = [];
  const maxFiles = multipart?.maxFiles;
  const maxFileSize = multipart?.maxFileSize;

  for (const [fieldname, rawEntry] of formData.entries()) {
    const entry: unknown = rawEntry;
    if (entry instanceof File) {
      if (maxFiles !== undefined && files.length + 1 > maxFiles) {
        throw new PayloadTooLargeException(
          `Uploaded file count exceeds maximum allowed limit of ${maxFiles}`,
        );
      }
      if (maxFileSize !== undefined && entry.size > maxFileSize) {
        throw new PayloadTooLargeException(
          `Uploaded file "${entry.name}" exceeds maximum allowed size of ${maxFileSize} bytes`,
        );
      }
      const buffer = new Uint8Array(await entry.arrayBuffer());
      if (maxFileSize !== undefined && buffer.byteLength > maxFileSize) {
        throw new PayloadTooLargeException(
          `Uploaded file "${entry.name}" exceeds maximum allowed size of ${maxFileSize} bytes`,
        );
      }
      files.push({
        fieldname,
        originalname: entry.name,
        mimetype: entry.type || "application/octet-stream",
        size: entry.size,
        buffer,
        file: entry,
        stream: () => entry.stream(),
      });
      continue;
    }

    appendFieldValue(fields, fieldname, String(entry));
  }

  markBodySanitized(fields);
  return rawBody !== undefined
    ? { body: fields, files, rawBody }
    : { body: fields, files };
}

function extractMultipartBoundary(contentType: string): string | undefined {
  const parts = contentType.split(";");
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]?.trim();
    if (!part) continue;
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim().toLowerCase();
    if (key !== "boundary") continue;
    let val = part.slice(eqIdx + 1).trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    return val.length > 0 ? val : undefined;
  }
  return undefined;
}

function extractSafeExtension(originalname: string): string {
  const base = originalname.split(/[\\/]/).pop() ?? "";
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === base.length - 1) {
    return "";
  }
  const rawExt = base.slice(dotIdx).toLowerCase();
  if (/^\.[a-z0-9]{1,15}$/.test(rawExt)) {
    return rawExt;
  }
  return "";
}

function parsePartHeaders(headerText: string): {
  fieldname: string;
  originalname?: string;
  mimetype: string;
} {
  let fieldname = "";
  let originalname: string | undefined;
  let mimetype = "application/octet-stream";

  const lines = headerText.split("\r\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const name = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (name === "content-type") {
      if (value.length > 0) {
        mimetype = value;
      }
    } else if (name === "content-disposition") {
      const nameMatch = /;\s*name="((?:\\.|[^"\\])*)"/i.exec(value);
      if (nameMatch?.[1] !== undefined) {
        fieldname = nameMatch[1].replace(/\\(.)/g, "$1");
      } else {
        const unquotedName = /;\s*name=([^;\s]+)/i.exec(value);
        if (unquotedName?.[1] !== undefined) {
          fieldname = unquotedName[1];
        }
      }

      const filenameStarMatch = /;\s*filename\*=UTF-8''([^;\s]+)/i.exec(value);
      if (filenameStarMatch?.[1] !== undefined) {
        try {
          originalname = decodeURIComponent(filenameStarMatch[1]);
        } catch {
          originalname = filenameStarMatch[1];
        }
      } else {
        const filenameMatch = /;\s*filename="((?:\\.|[^"\\])*)"/i.exec(value);
        if (filenameMatch?.[1] !== undefined) {
          originalname = filenameMatch[1].replace(/\\(.)/g, "$1");
        } else {
          const unquotedFilename = /;\s*filename=([^;\s]+)/i.exec(value);
          if (unquotedFilename?.[1] !== undefined) {
            originalname = unquotedFilename[1];
          }
        }
      }
    }
  }

  return { fieldname, originalname, mimetype };
}

function concatUint8Arrays(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  if (b.byteLength === 0) return a;
  const merged = new Uint8Array(a.byteLength + b.byteLength);
  merged.set(a, 0);
  merged.set(b, a.byteLength);
  return merged;
}

function findSequence(haystack: Uint8Array, needle: Uint8Array): number {
  if (haystack.byteLength < needle.byteLength) {
    return -1;
  }
  return Buffer.from(
    haystack.buffer,
    haystack.byteOffset,
    haystack.byteLength,
  ).indexOf(needle);
}

const CRLF_CRLF = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);

const enum MultipartState {
  FIND_FIRST_BOUNDARY = 0,
  AFTER_BOUNDARY = 1,
  READ_HEADERS = 2,
  STREAM_FILE_BODY = 3,
  READ_FIELD_BODY = 4,
  DONE = 5,
}

/**
 * Streams a `multipart/form-data` request directly from `req.body` into files on disk
 * inside `multipart.diskStorageDir` using `Bun.file().writer()` without buffering
 * file payloads into RAM. Cleans up any partially written files on error.
 */
async function parseMultipartToDisk(
  req: Request,
  rawContentType: string,
  multipart: MultipartStorageOptions,
  maxBodyBytes: number | undefined,
  captureRawBody: boolean,
): Promise<ParsedBodyResult> {
  const boundary = extractMultipartBoundary(rawContentType);
  if (!boundary) {
    throw new BadRequestException(
      "Malformed multipart/form-data payload: missing boundary",
    );
  }

  if (req.body === null) {
    throw new BadRequestException("Malformed multipart/form-data payload");
  }

  const resolvedDiskDir = resolve(multipart.diskStorageDir!);
  await mkdir(resolvedDiskDir, { recursive: true });

  const firstBoundary = textEncoder.encode(`--${boundary}`);
  const partBoundary = textEncoder.encode(`\r\n--${boundary}`);
  const overlapKeep = partBoundary.byteLength - 1;
  // Streamed files enforce explicit `multipart.maxFileSize`, falling back to `bodyLimit`
  // only when `multipart.maxFileSize` is omitted so small JSON `bodyLimit` never blocks large disk uploads.
  const maxFileSize = multipart.maxFileSize ?? maxBodyBytes;
  const maxFiles = multipart.maxFiles;
  const maxFieldBytes = maxBodyBytes ?? DEFAULT_MAX_FIELD_BYTES;

  const fields: Record<string, unknown> = {};
  const files: DiskUploadedFileInfo[] = [];
  const writtenPaths: string[] = [];
  const rawChunks: Uint8Array[] | undefined = captureRawBody ? [] : undefined;

  let state: MultipartState = MultipartState.FIND_FIRST_BOUNDARY;
  let pending: Uint8Array = EMPTY_BYTES;
  let totalBytes = 0;

  let currentFieldname = "";
  let currentOriginalname = "";
  let currentMimetype = "application/octet-stream";
  let currentGeneratedName = "";
  let currentDestPath = "";
  let currentFileBytes = 0;
  let currentWriter: ReturnType<ReturnType<typeof Bun.file>["writer"]> | undefined;

  let fieldChunks: Uint8Array[] = [];
  let fieldBytes = 0;
  let totalFieldBytes = 0;

  const reader = req.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (!done && value && value.byteLength > 0) {
        totalBytes += value.byteLength;
        if (rawChunks) {
          rawChunks.push(value);
        }
        pending = concatUint8Arrays(pending, value);
      }

      // Process as much of `pending` as possible
      let progress = true;
      while (progress && state !== MultipartState.DONE) {
        progress = false;

        if (state === MultipartState.FIND_FIRST_BOUNDARY) {
          const idx = findSequence(pending, firstBoundary);
          if (idx !== -1) {
            pending = pending.subarray(idx + firstBoundary.byteLength);
            state = MultipartState.AFTER_BOUNDARY;
            progress = true;
          } else if (pending.byteLength > MAX_MULTIPART_PREAMBLE_BYTES) {
            throw new BadRequestException("Malformed multipart/form-data payload");
          }
        } else if (state === MultipartState.AFTER_BOUNDARY) {
          if (pending.byteLength >= 2) {
            const b0 = pending[0];
            const b1 = pending[1];
            if (b0 === 0x2d && b1 === 0x2d) {
              // "--" closing boundary
              pending = pending.subarray(2);
              state = MultipartState.DONE;
              progress = true;
            } else if (b0 === 0x0d && b1 === 0x0a) {
              // "\r\n" next part headers
              pending = pending.subarray(2);
              state = MultipartState.READ_HEADERS;
              progress = true;
            } else {
              throw new BadRequestException(
                "Malformed multipart/form-data boundary delimiter",
              );
            }
          }
        } else if (state === MultipartState.READ_HEADERS) {
          const headerEnd = findSequence(pending, CRLF_CRLF);
          if (headerEnd !== -1) {
            if (headerEnd > MAX_MULTIPART_HEADER_BYTES) {
              throw new BadRequestException(
                "Multipart part headers exceed maximum allowed size",
              );
            }
            const headerText = textDecoder.decode(pending.subarray(0, headerEnd));
            pending = pending.subarray(headerEnd + 4);

            const parsedHeader = parsePartHeaders(headerText);
            currentFieldname = parsedHeader.fieldname;
            currentMimetype = parsedHeader.mimetype;

            if (parsedHeader.originalname !== undefined) {
              if (maxFiles !== undefined && files.length + 1 > maxFiles) {
                throw new PayloadTooLargeException(
                  `Uploaded file count exceeds maximum allowed limit of ${maxFiles}`,
                );
              }
              currentOriginalname = parsedHeader.originalname;
              const ext = extractSafeExtension(currentOriginalname);
              currentGeneratedName = `${randomUUID()}${ext}`;
              currentDestPath = join(resolvedDiskDir, currentGeneratedName);
              currentFileBytes = 0;
              writtenPaths.push(currentDestPath);
              currentWriter = Bun.file(currentDestPath).writer();
              state = MultipartState.STREAM_FILE_BODY;
            } else {
              fieldChunks = [];
              fieldBytes = 0;
              state = MultipartState.READ_FIELD_BODY;
            }
            progress = true;
          } else if (pending.byteLength > MAX_MULTIPART_HEADER_BYTES) {
            throw new BadRequestException(
              "Multipart part headers exceed maximum allowed size",
            );
          }
        } else if (state === MultipartState.STREAM_FILE_BODY) {
          const boundaryIdx = findSequence(pending, partBoundary);
          if (boundaryIdx !== -1) {
            if (boundaryIdx > 0) {
              currentFileBytes += boundaryIdx;
              if (maxFileSize !== undefined && currentFileBytes > maxFileSize) {
                throw new PayloadTooLargeException(
                  `Uploaded file "${currentOriginalname}" exceeds maximum allowed size of ${maxFileSize} bytes`,
                );
              }
              const chunkToWrite = pending.slice(0, boundaryIdx);
              currentWriter!.write(chunkToWrite);
            }
            await currentWriter!.end();
            currentWriter = undefined;

            const diskBunFile = Bun.file(currentDestPath);
            files.push({
              fieldname: currentFieldname,
              originalname: currentOriginalname,
              mimetype: currentMimetype,
              size: currentFileBytes,
              buffer: EMPTY_BYTES,
              file: diskBunFile as unknown as File,
              stream: () => diskBunFile.stream(),
              path: currentDestPath,
              filename: currentGeneratedName,
              destination: resolvedDiskDir,
            });

            pending = pending.subarray(boundaryIdx + partBoundary.byteLength);
            state = MultipartState.AFTER_BOUNDARY;
            progress = true;
          } else if (pending.byteLength > overlapKeep) {
            const flushLen = pending.byteLength - overlapKeep;
            currentFileBytes += flushLen;
            if (maxFileSize !== undefined && currentFileBytes > maxFileSize) {
              throw new PayloadTooLargeException(
                `Uploaded file "${currentOriginalname}" exceeds maximum allowed size of ${maxFileSize} bytes`,
              );
            }
            const chunkToWrite = pending.slice(0, flushLen);
            const writeRes = currentWriter!.write(chunkToWrite);
            if (writeRes instanceof Promise) {
              await writeRes;
            }
            pending = pending.subarray(flushLen);
          }
        } else if (state === MultipartState.READ_FIELD_BODY) {
          const boundaryIdx = findSequence(pending, partBoundary);
          if (boundaryIdx !== -1) {
            if (boundaryIdx > 0) {
              fieldBytes += boundaryIdx;
              totalFieldBytes += boundaryIdx;
              if (fieldBytes > maxFieldBytes || totalFieldBytes > maxFieldBytes) {
                throw new PayloadTooLargeException(
                  `Multipart form field exceeds maximum allowed size`,
                );
              }
              fieldChunks.push(pending.slice(0, boundaryIdx));
            }
            let mergedField: Uint8Array;
            if (fieldChunks.length === 0) {
              mergedField = EMPTY_BYTES;
            } else if (fieldChunks.length === 1) {
              mergedField = fieldChunks[0]!;
            } else {
              mergedField = new Uint8Array(fieldBytes);
              let off = 0;
              for (let i = 0; i < fieldChunks.length; i++) {
                const c = fieldChunks[i]!;
                mergedField.set(c, off);
                off += c.byteLength;
              }
            }
            appendFieldValue(
              fields,
              currentFieldname,
              textDecoder.decode(mergedField),
            );
            fieldChunks = [];
            fieldBytes = 0;

            pending = pending.subarray(boundaryIdx + partBoundary.byteLength);
            state = MultipartState.AFTER_BOUNDARY;
            progress = true;
          } else if (pending.byteLength > overlapKeep) {
            const flushLen = pending.byteLength - overlapKeep;
            fieldBytes += flushLen;
            totalFieldBytes += flushLen;
            if (fieldBytes > maxFieldBytes || totalFieldBytes > maxFieldBytes) {
              throw new PayloadTooLargeException(
                `Multipart form field exceeds maximum allowed size`,
              );
            }
            fieldChunks.push(pending.slice(0, flushLen));
            pending = pending.subarray(flushLen);
          }
        }
      }

      if (done) {
        break;
      }
      if (state === MultipartState.DONE && !captureRawBody) {
        await reader.cancel().catch(() => {});
        break;
      }
    }

    if (state !== MultipartState.DONE) {
      throw new BadRequestException("Malformed multipart/form-data payload");
    }

    let rawBody: Uint8Array | undefined;
    if (rawChunks) {
      if (rawChunks.length === 0) {
        rawBody = EMPTY_BYTES;
      } else if (rawChunks.length === 1) {
        rawBody = rawChunks[0];
      } else {
        rawBody = new Uint8Array(totalBytes);
        let off = 0;
        for (let i = 0; i < rawChunks.length; i++) {
          const c = rawChunks[i]!;
          rawBody.set(c, off);
          off += c.byteLength;
        }
      }
    }

    markBodySanitized(fields);
    return rawBody !== undefined
      ? { body: fields, files, rawBody }
      : { body: fields, files };
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (currentWriter) {
      try {
        await currentWriter.end();
      } catch {
        // Ignore close error during cleanup
      }
      currentWriter = undefined;
    }
    for (let i = 0; i < writtenPaths.length; i++) {
      const p = writtenPaths[i];
      if (p) {
        await unlink(p).catch(() => {});
      }
    }
    throw err;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parses a Web Request body once per request according to Content-Type,
 * enforcing `maxBodyBytes`, fast 1-pass prototype-pollution sanitization,
 * optional `rawBody` capture, optional streaming multipart disk storage,
 * and distinguishing missing body (`undefined`) vs JSON `null` vs empty string `""`.
 */
export async function parseRequestBody(
  req: Request,
  maxBodyBytesOrOptions?: number | ParseRequestBodyOptions,
): Promise<ParsedBodyResult> {
  if (req.method === "GET" || req.method === "HEAD") {
    return { body: undefined, files: EMPTY_FILES };
  }

  let maxBodyBytes: number | undefined;
  let captureRawBody = false;
  let multipart: MultipartStorageOptions | undefined;

  if (typeof maxBodyBytesOrOptions === "number") {
    maxBodyBytes = maxBodyBytesOrOptions;
  } else if (maxBodyBytesOrOptions !== undefined) {
    maxBodyBytes = maxBodyBytesOrOptions.maxBodyBytes;
    captureRawBody = maxBodyBytesOrOptions.rawBody === true;
    multipart = maxBodyBytesOrOptions.multipart;
  }

  const rawContentType = req.headers.get("content-type");
  const mediaType = getMediaType(rawContentType);

  // Streaming multipart disk storage path (streams directly to disk without RAM buffering)
  if (
    mediaType === "multipart/form-data" &&
    rawContentType &&
    multipart?.diskStorageDir
  ) {
    return parseMultipartToDisk(
      req,
      rawContentType,
      multipart,
      maxBodyBytes,
      captureRawBody,
    );
  }

  // Fast O(1) Content-Length header validation
  const hasTransferEncoding = req.headers.has("transfer-encoding");
  const contentLengthHeader = hasTransferEncoding
    ? null
    : req.headers.get("content-length");
  const contentLength = parseValidContentLength(contentLengthHeader);

  if (maxBodyBytes !== undefined && contentLengthHeader !== null) {
    const numericCl = Number(contentLengthHeader);
    if (Number.isFinite(numericCl) && numericCl > maxBodyBytes) {
      throw new PayloadTooLargeException(
        `Request body exceeds maximum allowed size of ${maxBodyBytes} bytes`,
      );
    }
  }

  // Hot fast-path when Content-Length is present & valid (all standard HTTP/1.1 requests on Bun.serve):
  // avoids instantiating a Web ReadableStream + ReadableStreamDefaultReader chunk loop!
  if (
    contentLength !== undefined &&
    (maxBodyBytes === undefined || contentLength <= maxBodyBytes)
  ) {
    if (!captureRawBody) {
      if (isJsonMediaType(mediaType)) {
        const rawText = await req.text();
        assertTextByteLength(rawText, maxBodyBytes);
        if (rawText.length === 0 || rawText.trim().length === 0) {
          return { body: undefined, files: EMPTY_FILES };
        }
        return { body: parseAndSanitizeJson(rawText), files: EMPTY_FILES };
      }

      if (mediaType === "application/x-www-form-urlencoded") {
        const rawText = await req.text();
        assertTextByteLength(rawText, maxBodyBytes);
        if (rawText.length === 0) {
          const empty: Record<string, unknown> = {};
          markBodySanitized(empty);
          return { body: empty, files: EMPTY_FILES };
        }
        return { body: parseUrlEncoded(rawText), files: EMPTY_FILES };
      }

      if (mediaType.startsWith("text/")) {
        const rawText = await req.text();
        assertTextByteLength(rawText, maxBodyBytes);
        return { body: rawText, files: EMPTY_FILES };
      }
    }

    // Fast native binary read via `req.bytes()` when rawBody is requested or binary/multipart with known Content-Length
    const bytes = await req.bytes();
    if (maxBodyBytes !== undefined && bytes.byteLength > maxBodyBytes) {
      throw new PayloadTooLargeException(
        `Request body exceeds maximum allowed size of ${maxBodyBytes} bytes`,
      );
    }
    const rawBody = captureRawBody ? bytes : undefined;

    if (bytes.byteLength === 0) {
      if (mediaType.startsWith("text/")) {
        return rawBody !== undefined
          ? { body: "", files: EMPTY_FILES, rawBody }
          : { body: "", files: EMPTY_FILES };
      }
      if (mediaType === "application/x-www-form-urlencoded") {
        const empty: Record<string, unknown> = {};
        markBodySanitized(empty);
        return rawBody !== undefined
          ? { body: empty, files: EMPTY_FILES, rawBody }
          : { body: empty, files: EMPTY_FILES };
      }
      return rawBody !== undefined
        ? { body: undefined, files: EMPTY_FILES, rawBody }
        : { body: undefined, files: EMPTY_FILES };
    }

    if (isJsonMediaType(mediaType)) {
      const rawText = textDecoder.decode(bytes);
      if (rawText.trim().length === 0) {
        return rawBody !== undefined
          ? { body: undefined, files: EMPTY_FILES, rawBody }
          : { body: undefined, files: EMPTY_FILES };
      }
      const parsed = parseAndSanitizeJson(rawText);
      return rawBody !== undefined
        ? { body: parsed, files: EMPTY_FILES, rawBody }
        : { body: parsed, files: EMPTY_FILES };
    }

    if (mediaType === "application/x-www-form-urlencoded") {
      const parsed = parseUrlEncoded(textDecoder.decode(bytes));
      return rawBody !== undefined
        ? { body: parsed, files: EMPTY_FILES, rawBody }
        : { body: parsed, files: EMPTY_FILES };
    }

    if (mediaType === "multipart/form-data" && rawContentType) {
      return parseMultipartInMemory(bytes, rawContentType, multipart, rawBody);
    }

    if (mediaType === "application/octet-stream") {
      return rawBody !== undefined
        ? { body: bytes, files: EMPTY_FILES, rawBody }
        : { body: bytes, files: EMPTY_FILES };
    }

    const decoded = textDecoder.decode(bytes);
    return rawBody !== undefined
      ? { body: decoded, files: EMPTY_FILES, rawBody }
      : { body: decoded, files: EMPTY_FILES };
  }

  // Bounded stream reader path (chunked Transfer-Encoding, missing/invalid Content-Length)
  const { bytes, hadStream } = await readBoundedBytes(req, maxBodyBytes);
  const rawBody = captureRawBody && hadStream ? bytes : undefined;

  if (bytes.byteLength === 0) {
    if (mediaType.startsWith("text/")) {
      return rawBody !== undefined
        ? { body: "", files: EMPTY_FILES, rawBody }
        : { body: "", files: EMPTY_FILES };
    }
    if (mediaType === "application/x-www-form-urlencoded") {
      const empty: Record<string, unknown> = {};
      markBodySanitized(empty);
      return rawBody !== undefined
        ? { body: empty, files: EMPTY_FILES, rawBody }
        : { body: empty, files: EMPTY_FILES };
    }
    if (mediaType === "" && hadStream) {
      return rawBody !== undefined
        ? { body: "", files: EMPTY_FILES, rawBody }
        : { body: "", files: EMPTY_FILES };
    }
    return rawBody !== undefined
      ? { body: undefined, files: EMPTY_FILES, rawBody }
      : { body: undefined, files: EMPTY_FILES };
  }

  if (isJsonMediaType(mediaType)) {
    const rawText = textDecoder.decode(bytes);
    if (rawText.trim().length === 0) {
      return rawBody !== undefined
        ? { body: undefined, files: EMPTY_FILES, rawBody }
        : { body: undefined, files: EMPTY_FILES };
    }
    const parsed = parseAndSanitizeJson(rawText);
    return rawBody !== undefined
      ? { body: parsed, files: EMPTY_FILES, rawBody }
      : { body: parsed, files: EMPTY_FILES };
  }

  if (mediaType === "application/x-www-form-urlencoded") {
    const parsed = parseUrlEncoded(textDecoder.decode(bytes));
    return rawBody !== undefined
      ? { body: parsed, files: EMPTY_FILES, rawBody }
      : { body: parsed, files: EMPTY_FILES };
  }

  if (mediaType === "multipart/form-data" && rawContentType) {
    return parseMultipartInMemory(bytes, rawContentType, multipart, rawBody);
  }

  if (mediaType === "application/octet-stream") {
    return rawBody !== undefined
      ? { body: bytes, files: EMPTY_FILES, rawBody }
      : { body: bytes, files: EMPTY_FILES };
  }

  const decoded = textDecoder.decode(bytes);
  return rawBody !== undefined
    ? { body: decoded, files: EMPTY_FILES, rawBody }
    : { body: decoded, files: EMPTY_FILES };
}
