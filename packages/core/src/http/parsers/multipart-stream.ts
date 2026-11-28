import {
  BadRequestException,
  concatBytes as concatByteChunks,
  HttpStatus,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from "../../common/index";
import { isDangerousKey } from "../security/prototype-sanitizer";

const textDecoder = new TextDecoder("utf-8", { fatal: false });
const textEncoder = new TextEncoder();

const EMPTY_BYTES = new Uint8Array(0);
const CRLF_CRLF = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);

const DEFAULT_MAX_PREAMBLE_BYTES = 64 * 1024;
const DEFAULT_MAX_HEADER_BYTES = 16 * 1024;
const DEFAULT_MAX_FIELD_SIZE = 1024 * 1024; // 1 MiB per text field

/** Options controlling zero-buffer streaming RFC 7578 multipart parsing. */
export interface MultipartStreamOptions {
  /** Maximum size in bytes for any single uploaded file part. */
  readonly maxFileSize?: number;
  /** Maximum number of file parts permitted in a single multipart request. */
  readonly maxFiles?: number;
  /** Maximum number of non-file text fields permitted in a single multipart request. */
  readonly maxFields?: number;
  /** Maximum byte size for a single non-file text field (default `1 MiB`). */
  readonly maxFieldSize?: number;
  /** Maximum byte size for any part's headers block (default `16 KiB`). */
  readonly maxHeaderSize?: number;
  /**
   * Optional allowlist of MIME types for uploaded file parts. Supports exact
   * MIME types (e.g. `"image/png"`), type wildcards (e.g. `"image/wildcard"` syntax `"image/*"`, `"*" + "/*"`), or `RegExp`.
   */
  readonly allowedMimeTypes?: readonly (string | RegExp)[];
}

/** Text form-field part yielded by `parseMultipartStream()`. */
export interface MultipartFieldPart {
  readonly kind: "field";
  readonly isFile: false;
  readonly fieldname: string;
  readonly value: string;
  readonly mimetype: string;
  readonly encoding: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Live streaming file part yielded by `parseMultipartStream()`.
 * Reading `part.stream` pulls directly from `req.body` with live backpressure
 * and zero full-body RAM buffering.
 */
export interface MultipartFilePart {
  readonly kind: "file";
  readonly isFile: true;
  readonly fieldname: string;
  readonly originalname: string;
  readonly filename: string;
  readonly mimetype: string;
  readonly encoding: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly stream: ReadableStream<Uint8Array>;
  /** Total bytes emitted by `stream` so far (final size once stream closes). */
  readonly bytesRead: number;
  /** Becomes `true` if the file exceeded `maxFileSize` and was aborted. */
  readonly truncated: boolean;
}

/** Discriminated union yielded by `parseMultipartStream()`. */
export type MultipartStreamPart = MultipartFieldPart | MultipartFilePart;

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  if (b.byteLength === 0) return a;
  return concatByteChunks([a, b]);
}

/** SIMD-accelerated byte-sequence search via native Buffer `indexOf`. */
function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
  const nLen = needle.byteLength;
  if (nLen === 0) return 0;
  if (haystack.byteLength < nLen) return -1;
  return Buffer.from(
    haystack.buffer,
    haystack.byteOffset,
    haystack.byteLength,
  ).indexOf(needle);
}

export function extractMultipartStreamBoundary(
  contentType: string | null,
): string | undefined {
  if (!contentType) return undefined;
  const semiIdx = contentType.indexOf(";");
  const essence = (
    semiIdx === -1 ? contentType : contentType.slice(0, semiIdx)
  )
    .trim()
    .toLowerCase();
  if (essence !== "multipart/form-data") {
    return undefined;
  }
  if (semiIdx === -1) {
    return undefined;
  }
  const params = contentType.slice(semiIdx + 1).split(";");
  for (let i = 0; i < params.length; i++) {
    const part = params[i]?.trim();
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

function decodeDispositionValue(value: string): string {
  if (!value.includes("%")) return value;
  return value
    .replace(/%22/gi, '"')
    .replace(/%0A/gi, "\n")
    .replace(/%0D/gi, "\r");
}

function parseStreamPartHeaders(headerText: string): {
  fieldname: string;
  originalname?: string;
  mimetype: string;
  encoding: string;
  headers: Record<string, string>;
} {
  let fieldname = "";
  let originalname: string | undefined;
  let mimetype = "application/octet-stream";
  let encoding = "7bit";
  const headers: Record<string, string> = {};

  const lines = headerText.split("\r\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const name = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    if (!name || isDangerousKey(name)) continue;
    headers[name] = value;

    if (name === "content-type") {
      if (value.length > 0) {
        mimetype = value;
      }
    } else if (name === "content-transfer-encoding") {
      if (value.length > 0) {
        encoding = value.toLowerCase();
      }
    } else if (name === "content-disposition") {
      const nameMatch = /;\s*name="((?:\\.|[^"\\])*)"/i.exec(value);
      if (nameMatch?.[1] !== undefined) {
        fieldname = decodeDispositionValue(
          nameMatch[1].replace(/\\(.)/g, "$1"),
        );
      } else {
        const unquotedName = /;\s*name=([^;\s]+)/i.exec(value);
        if (unquotedName?.[1] !== undefined) {
          fieldname = decodeDispositionValue(unquotedName[1]);
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
          originalname = decodeDispositionValue(
            filenameMatch[1].replace(/\\(.)/g, "$1"),
          );
        } else {
          const unquotedFilename = /;\s*filename=([^;\s]+)/i.exec(value);
          if (unquotedFilename?.[1] !== undefined) {
            originalname = decodeDispositionValue(unquotedFilename[1]);
          }
        }
      }
    }
  }

  return { fieldname, originalname, mimetype, encoding, headers };
}

function getMimeEssence(mimetype: string): string {
  const semiIdx = mimetype.indexOf(";");
  return (semiIdx === -1 ? mimetype : mimetype.slice(0, semiIdx))
    .trim()
    .toLowerCase();
}

function isMimeTypeAllowed(
  mimetype: string,
  allowedMimeTypes: readonly (string | RegExp)[] | undefined,
): boolean {
  if (!allowedMimeTypes || allowedMimeTypes.length === 0) {
    return true;
  }
  const essence = getMimeEssence(mimetype);
  for (let i = 0; i < allowedMimeTypes.length; i++) {
    const rule = allowedMimeTypes[i];
    if (!rule) continue;
    if (rule instanceof RegExp) {
      if (rule.test(essence) || rule.test(mimetype)) {
        return true;
      }
      continue;
    }
    const normalized = getMimeEssence(rule);
    if (normalized === "*/*" || normalized === essence) {
      return true;
    }
    if (normalized.endsWith("/*")) {
      const prefix = normalized.slice(0, -1); // e.g. "image/"
      if (essence.startsWith(prefix)) {
        return true;
      }
    }
  }
  return false;
}

function createPayloadTooLarge(message: string, limit?: number): PayloadTooLargeException {
  return new PayloadTooLargeException({
    statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
    error: "Payload Too Large",
    message,
    ...(limit !== undefined ? { limit } : {}),
  });
}

/**
 * Streams RFC 7578 `multipart/form-data` straight from `req.body`
 * (`ReadableStream<Uint8Array>`) with zero full-body RAM buffering and live
 * pull-based backpressure on every yielded file's `stream: ReadableStream<Uint8Array>`.
 *
 * Consumers must consume or cancel each yielded file part's `stream` before
 * advancing to the next part; if a consumer skips a file part without reading
 * its `stream`, the parser automatically drains and discards that part in
 * constant memory before yielding the next part.
 */
export async function* parseMultipartStream(
  req: Request,
  options: MultipartStreamOptions = {},
): AsyncIterable<MultipartStreamPart> {
  const rawContentType = req.headers.get("content-type");
  const boundary = extractMultipartStreamBoundary(rawContentType);
  if (!boundary) {
    throw new BadRequestException(
      "Malformed multipart/form-data payload: missing or invalid Content-Type boundary",
    );
  }
  if (!req.body) {
    throw new BadRequestException(
      "Malformed multipart/form-data payload: request body stream is empty",
    );
  }

  const firstBoundary = textEncoder.encode(`--${boundary}`);
  const partBoundary = textEncoder.encode(`\r\n--${boundary}`);
  const overlapKeep = partBoundary.byteLength - 1;

  const maxFileSize = options.maxFileSize;
  const maxFiles = options.maxFiles;
  const maxFields = options.maxFields;
  const maxFieldSize = options.maxFieldSize ?? DEFAULT_MAX_FIELD_SIZE;
  const maxHeaderSize = options.maxHeaderSize ?? DEFAULT_MAX_HEADER_BYTES;
  const allowedMimeTypes = options.allowedMimeTypes;

  const reader = req.body.getReader();
  let pending: Uint8Array = EMPTY_BYTES;
  let eof = false;
  let fileCount = 0;
  let fieldCount = 0;
  let parserDone = false;

  const readMore = async (): Promise<boolean> => {
    if (eof) return false;
    const { done, value } = await reader.read();
    if (done) {
      eof = true;
      return false;
    }
    if (value && value.byteLength > 0) {
      pending = concatBytes(pending, value);
    }
    return true;
  };

  try {
    // 1. Locate initial `--boundary`
    while (true) {
      const idx = findBytes(pending, firstBoundary);
      if (idx !== -1) {
        pending = pending.subarray(idx + firstBoundary.byteLength);
        break;
      }
      if (pending.byteLength > DEFAULT_MAX_PREAMBLE_BYTES) {
        throw new BadRequestException("Malformed multipart/form-data preamble");
      }
      if (!(await readMore())) {
        throw new BadRequestException(
          "Malformed multipart/form-data payload: opening boundary not found",
        );
      }
    }

    // 2. Main part loop
    while (!parserDone) {
      // 2a. After boundary: skip optional transport padding spaces/tabs, then check `--` or `\r\n`
      while (true) {
        let pad = 0;
        while (
          pad < pending.byteLength &&
          (pending[pad] === 0x20 || pending[pad] === 0x09)
        ) {
          pad++;
        }
        if (pad > 0) {
          pending = pending.subarray(pad);
        }
        if (pending.byteLength >= 2) {
          const b0 = pending[0];
          const b1 = pending[1];
          if (b0 === 0x2d && b1 === 0x2d) {
            pending = pending.subarray(2);
            parserDone = true;
            break;
          }
          if (b0 === 0x0d && b1 === 0x0a) {
            pending = pending.subarray(2);
            break;
          }
          throw new BadRequestException(
            "Malformed multipart/form-data boundary delimiter",
          );
        }
        if (!(await readMore())) {
          if (
            pending.byteLength === 2 &&
            pending[0] === 0x2d &&
            pending[1] === 0x2d
          ) {
            parserDone = true;
            break;
          }
          throw new BadRequestException(
            "Malformed multipart/form-data payload: truncated boundary",
          );
        }
      }

      if (parserDone) {
        break;
      }

      // 2b. Read part headers up to `\r\n\r\n`
      let headerEnd = -1;
      while (true) {
        headerEnd = findBytes(pending, CRLF_CRLF);
        if (headerEnd !== -1) {
          if (headerEnd > maxHeaderSize) {
            throw new BadRequestException(
              `Multipart part headers exceed maximum allowed size of ${maxHeaderSize} bytes`,
            );
          }
          break;
        }
        if (pending.byteLength > maxHeaderSize) {
          throw new BadRequestException(
            `Multipart part headers exceed maximum allowed size of ${maxHeaderSize} bytes`,
          );
        }
        if (!(await readMore())) {
          throw new BadRequestException(
            "Malformed multipart/form-data payload: truncated part headers",
          );
        }
      }

      const headerText = textDecoder.decode(pending.subarray(0, headerEnd));
      pending = pending.subarray(headerEnd + 4);
      const parsedHeader = parseStreamPartHeaders(headerText);
      const isFilePart = parsedHeader.originalname !== undefined;

      // 2c. Text field part (bounded by `maxFieldSize` and `maxFields`)
      if (!isFilePart) {
        fieldCount++;
        if (maxFields !== undefined && fieldCount > maxFields) {
          throw createPayloadTooLarge(
            `Multipart field count exceeds maximum allowed limit of ${maxFields}`,
            maxFields,
          );
        }

        const fieldChunks: Uint8Array[] = [];
        let fieldBytes = 0;

        while (true) {
          const boundaryIdx = findBytes(pending, partBoundary);
          if (boundaryIdx !== -1) {
            if (boundaryIdx > 0) {
              fieldBytes += boundaryIdx;
              if (fieldBytes > maxFieldSize) {
                throw createPayloadTooLarge(
                  `Multipart field "${parsedHeader.fieldname}" exceeds maximum allowed size of ${maxFieldSize} bytes`,
                  maxFieldSize,
                );
              }
              fieldChunks.push(pending.slice(0, boundaryIdx));
            }
            pending = pending.subarray(boundaryIdx + partBoundary.byteLength);
            break;
          }

          if (pending.byteLength > overlapKeep) {
            const flushLen = pending.byteLength - overlapKeep;
            fieldBytes += flushLen;
            if (fieldBytes > maxFieldSize) {
              throw createPayloadTooLarge(
                `Multipart field "${parsedHeader.fieldname}" exceeds maximum allowed size of ${maxFieldSize} bytes`,
                maxFieldSize,
              );
            }
            fieldChunks.push(pending.slice(0, flushLen));
            pending = pending.subarray(flushLen);
          }

          if (!(await readMore())) {
            throw new BadRequestException(
              "Malformed multipart/form-data payload: unexpected end of stream in field",
            );
          }
        }

        const merged =
          fieldChunks.length === 0
            ? EMPTY_BYTES
            : fieldChunks.length === 1
              ? fieldChunks[0]!
              : concatByteChunks(fieldChunks);

        yield {
          kind: "field",
          isFile: false,
          fieldname: parsedHeader.fieldname,
          value: textDecoder.decode(merged),
          mimetype: parsedHeader.mimetype,
          encoding: parsedHeader.encoding,
          headers: parsedHeader.headers,
        };
        continue;
      }

      // 2d. Streaming file part with live pull-based backpressure
      fileCount++;
      if (maxFiles !== undefined && fileCount > maxFiles) {
        throw createPayloadTooLarge(
          `Uploaded file count exceeds maximum allowed limit of ${maxFiles}`,
          maxFiles,
        );
      }

      if (!isMimeTypeAllowed(parsedHeader.mimetype, allowedMimeTypes)) {
        throw new UnsupportedMediaTypeException(
          `Unsupported file MIME type "${parsedHeader.mimetype}" for field "${parsedHeader.fieldname}"`,
        );
      }

      const originalname = parsedHeader.originalname ?? "";
      let partBytes = 0;
      let partTruncated = false;
      let partFinished = false;
      let partError: unknown;
      let partCancelled = false;

      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (partFinished) {
            return;
          }
          try {
            while (true) {
              const boundaryIdx = findBytes(pending, partBoundary);
              if (boundaryIdx !== -1) {
                if (boundaryIdx > 0) {
                  const nextTotal = partBytes + boundaryIdx;
                  if (maxFileSize !== undefined && nextTotal > maxFileSize) {
                    partTruncated = true;
                    partFinished = true;
                    partError = createPayloadTooLarge(
                      `Uploaded file "${originalname}" exceeds maximum allowed size of ${maxFileSize} bytes`,
                      maxFileSize,
                    );
                    controller.error(partError);
                    return;
                  }
                  const chunk = pending.slice(0, boundaryIdx);
                  partBytes = nextTotal;
                  pending = pending.subarray(
                    boundaryIdx + partBoundary.byteLength,
                  );
                  partFinished = true;
                  controller.enqueue(chunk);
                  controller.close();
                  return;
                }
                pending = pending.subarray(partBoundary.byteLength);
                partFinished = true;
                controller.close();
                return;
              }

              if (pending.byteLength > overlapKeep) {
                const flushLen = pending.byteLength - overlapKeep;
                const nextTotal = partBytes + flushLen;
                if (maxFileSize !== undefined && nextTotal > maxFileSize) {
                  partTruncated = true;
                  partFinished = true;
                  partError = createPayloadTooLarge(
                    `Uploaded file "${originalname}" exceeds maximum allowed size of ${maxFileSize} bytes`,
                    maxFileSize,
                  );
                  controller.error(partError);
                  return;
                }
                const chunk = pending.slice(0, flushLen);
                partBytes = nextTotal;
                pending = pending.subarray(flushLen);
                controller.enqueue(chunk);
                return;
              }

              if (!(await readMore())) {
                partFinished = true;
                partError = new BadRequestException(
                  "Malformed multipart/form-data payload: unexpected end of stream in file part",
                );
                controller.error(partError);
                return;
              }
            }
          } catch (err) {
            partFinished = true;
            partError = err;
            controller.error(err);
          }
        },
        cancel() {
          partCancelled = true;
        },
      });

      const filePart: MultipartFilePart = {
        kind: "file",
        isFile: true,
        fieldname: parsedHeader.fieldname,
        originalname,
        filename: originalname,
        mimetype: parsedHeader.mimetype,
        encoding: parsedHeader.encoding,
        headers: parsedHeader.headers,
        stream,
        get bytesRead(): number {
          return partBytes;
        },
        get truncated(): boolean {
          return partTruncated;
        },
      };

      yield filePart;

      if (partError !== undefined) {
        throw partError;
      }

      // If consumer skipped or cancelled `part.stream` early, drain remainder up to the next boundary in O(1) RAM.
      if (!partFinished) {
        if (!partCancelled && !stream.locked) {
          await stream.cancel().catch(() => {});
        }
        while (true) {
          const boundaryIdx = findBytes(pending, partBoundary);
          if (boundaryIdx !== -1) {
            pending = pending.subarray(boundaryIdx + partBoundary.byteLength);
            partFinished = true;
            break;
          }
          if (pending.byteLength > overlapKeep) {
            pending = pending.subarray(pending.byteLength - overlapKeep);
          }
          if (!(await readMore())) {
            throw new BadRequestException(
              "Malformed multipart/form-data payload: unexpected end of stream while skipping file part",
            );
          }
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
