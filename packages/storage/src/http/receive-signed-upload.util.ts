import {
  BadRequestException,
  ForbiddenException,
  PayloadTooLargeException,
} from "@bunest/common";
import type { StorageDisk } from "../disks/storage.disk";
import type {
  ReceiveSignedUploadOptions,
  StorageBody,
  StorageWriteResult,
} from "../interfaces/storage-types";
import { toChunks } from "../utils/body.util";
import { requestHeaders, setHeader, toHttpError, verify } from "./serve-file.util";

function extractBodySource(req: unknown): StorageBody {
  if (req instanceof Request) {
    if (req.body) {
      return req.body;
    }
    return Buffer.alloc(0);
  }
  if (req && typeof req === "object") {
    const r = req as Record<string, unknown>;
    if (r.raw && typeof r.raw === "object" && Symbol.asyncIterator in (r.raw as object)) {
      return r.raw as AsyncIterable<Uint8Array>;
    }
    if (Symbol.asyncIterator in r) {
      return r as unknown as AsyncIterable<Uint8Array>;
    }
    if (r.body instanceof Uint8Array || typeof r.body === "string" || r.body instanceof ReadableStream) {
      return r.body as StorageBody;
    }
  }
  throw new BadRequestException("Upload request has no readable body stream");
}

function limitStream(
  source: AsyncIterable<Buffer>,
  maxSize: number,
): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      let received = 0;
      for await (const chunk of source) {
        received += chunk.byteLength;
        if (received > maxSize) {
          throw new PayloadTooLargeException(
            `Signed upload exceeds maximum allowed size of ${maxSize} bytes`,
          );
        }
        yield chunk;
      }
    },
  };
}

/**
 * Receives a `PUT` to an app-served signed upload URL (`signedUpload()` on a `LocalDisk` or
 * `InMemoryDisk` with `signedUrls`).
 */
export async function receiveSignedUpload(
  disk: StorageDisk,
  options: ReceiveSignedUploadOptions,
): Promise<StorageWriteResult> {
  const claims = verify(disk, options.req, "PUT");
  const headers = requestHeaders(options.req);

  const reqContentType = headers["content-type"];
  if (
    claims.contentType !== undefined &&
    reqContentType !== claims.contentType
  ) {
    throw new ForbiddenException(
      `Signed upload Content-Type mismatch (expected "${claims.contentType}")`,
    );
  }

  const reqContentLengthHeader = headers["content-length"];
  const reqContentLength =
    reqContentLengthHeader !== undefined && /^\d+$/.test(reqContentLengthHeader)
      ? Number(reqContentLengthHeader)
      : undefined;

  if (
    claims.contentLength !== undefined &&
    reqContentLength !== undefined &&
    reqContentLength !== claims.contentLength
  ) {
    throw new BadRequestException(
      `Signed upload Content-Length mismatch (expected ${claims.contentLength}, got ${reqContentLength})`,
    );
  }

  if (
    claims.contentLength === undefined &&
    options.maxSize !== undefined &&
    reqContentLength !== undefined &&
    reqContentLength > options.maxSize
  ) {
    throw new PayloadTooLargeException(
      `Signed upload exceeds maximum allowed size of ${options.maxSize} bytes`,
    );
  }

  let body: StorageBody = extractBodySource(options.req);
  if (claims.contentLength === undefined && options.maxSize !== undefined) {
    body = limitStream(toChunks(body), options.maxSize);
  }

  const signal =
    options.req instanceof Request
      ? options.req.signal
      : (options.req as { signal?: AbortSignal } | undefined)?.signal;

  try {
    const result = await disk.put(claims.key, body, {
      ...(claims.contentType !== undefined
        ? { contentType: claims.contentType }
        : {}),
      ...(claims.contentLength !== undefined
        ? { contentLength: claims.contentLength }
        : {}),
      ...(signal ? { signal } : {}),
    });
    if (options.res && result.etag) {
      setHeader(options.res, "ETag", result.etag);
    }
    return result;
  } catch (err) {
    throw toHttpError(err, options.res);
  }
}
