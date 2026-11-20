import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { StorageDisk } from "../disks/storage.disk";
import {
  StorageError,
  StorageFileNotFoundError,
  StorageRangeNotSatisfiableError,
  StorageServiceError,
} from "../errors";
import type {
  S3Credentials,
  S3DiskOptions,
  StorageDownload,
  StorageFile,
  StorageListEntry,
  StorageListPage,
  StorageObjectWrite,
  StorageRange,
  StorageSignalOptions,
  StorageSignedUpload,
  StorageSignedUploadRequest,
  StorageWriteResult,
} from "../interfaces/storage-types";
import { readAll } from "../utils/body.util";
import { DEFAULT_CONTENT_TYPE } from "../utils/content-type.util";
import {
  assertValidPrefix,
  encodeKeyPath,
  encodeRfc3986,
} from "../utils/keys.util";
import {
  duration,
  type ResolvedRetry,
  resolveRetry,
  sleep,
} from "./retry.util";
import {
  EMPTY_SHA256,
  presignUrl,
  sha256Hex,
  signRequest,
} from "./sigv4.util";
import { encodeXml, xmlElements, xmlText } from "./xml.util";

const MIN_PART_SIZE = 5 * 1024 * 1024;
const DEFAULT_PART_SIZE = 8 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 4;
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set([
  "SlowDown",
  "InternalError",
  "RequestTimeout",
  "ServiceUnavailable",
  "Throttling",
  "ThrottlingException",
  "NetworkError",
  "Timeout",
]);

function isIpHost(hostname: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":");
}

function isVirtualHostBucketValid(bucket: string, isHttps: boolean): boolean {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    return false;
  }
  if (isHttps && bucket.includes(".")) {
    return false;
  }
  return true;
}

function parseMetadataHeaders(headers: Headers): Record<string, string> {
  const metadata: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("x-amz-meta-")) {
      metadata[lower.slice("x-amz-meta-".length)] = value;
    }
  });
  return metadata;
}

function parseContentRange(
  header: string | null,
): { start: number; end: number; total: number } | undefined {
  if (!header) return undefined;
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (!m) return undefined;
  const start = Number(m[1]);
  const end = Number(m[2]);
  const total = m[3] === "*" ? end + 1 : Number(m[3]);
  return { start, end, total };
}

function formatRangeHeader(range: StorageRange): string {
  if ("suffix" in range) {
    return `bytes=-${range.suffix}`;
  }
  return range.end === undefined
    ? `bytes=${range.start}-`
    : `bytes=${range.start}-${range.end}`;
}

/**
 * Amazon S3 and S3-compatible stores (Cloudflare R2, MinIO, Backblaze B2, Google Cloud
 * Storage's interoperability API), over native `fetch` with Signature Version 4 on `node:crypto`.
 */
export class S3Disk extends StorageDisk {
  readonly bucket: string;
  readonly region: string;
  private readonly endpoint: URL;
  private readonly pathStyle: boolean;
  private readonly credentials:
    | S3Credentials
    | (() => S3Credentials | Promise<S3Credentials>);
  private readonly prefix: string;
  private readonly encryptionHeaders: Record<string, string>;
  private readonly partSize: number;
  private readonly concurrency: number;
  private readonly retry: ResolvedRetry;
  private readonly timeoutMs: number | undefined;
  private readonly batchDelete: boolean;
  private readonly fetchFn?: typeof globalThis.fetch;

  constructor(options: S3DiskOptions) {
    super({ publicUrl: options.publicUrl });
    if (!options?.bucket || typeof options.bucket !== "string") {
      throw new TypeError("S3Disk requires a non-empty `bucket`");
    }
    this.bucket = options.bucket;
    this.region =
      options.region ??
      process.env.AWS_REGION ??
      process.env.AWS_DEFAULT_REGION ??
      "us-east-1";

    this.endpoint = options.endpoint
      ? options.endpoint instanceof URL
        ? new URL(options.endpoint)
        : new URL(options.endpoint)
      : new URL(`https://s3.${this.region}.amazonaws.com`);

    this.pathStyle =
      options.forcePathStyle === true ||
      isIpHost(this.endpoint.hostname) ||
      !isVirtualHostBucketValid(
        this.bucket,
        this.endpoint.protocol === "https:",
      );

    if (options.credentials) {
      this.credentials = options.credentials;
    } else {
      this.credentials = () => {
        const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? "";
        const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? "";
        const sessionToken = process.env.AWS_SESSION_TOKEN;
        if (!accessKeyId || !secretAccessKey) {
          throw new StorageServiceError({
            operation: "credentials",
            code: "MissingCredentials",
            message:
              "AWS credentials not provided and AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are unset",
          });
        }
        return {
          accessKeyId,
          secretAccessKey,
          ...(sessionToken ? { sessionToken } : {}),
        };
      };
    }

    const prefix = options.prefix ?? "";
    if (prefix) {
      assertValidPrefix(prefix);
    }
    this.prefix = prefix;

    this.encryptionHeaders = {};
    if (options.serverSideEncryption) {
      this.encryptionHeaders["x-amz-server-side-encryption"] =
        options.serverSideEncryption;
    }
    if (options.kmsKeyId) {
      this.encryptionHeaders["x-amz-server-side-encryption-aws-kms-key-id"] =
        options.kmsKeyId;
    }

    const partSize = options.multipart?.partSize ?? DEFAULT_PART_SIZE;
    if (!Number.isInteger(partSize) || partSize < MIN_PART_SIZE) {
      throw new RangeError(
        `S3Disk multipart.partSize must be an integer >= ${MIN_PART_SIZE}`,
      );
    }
    this.partSize = partSize;

    const concurrency = options.multipart?.concurrency ?? DEFAULT_CONCURRENCY;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError(
        "S3Disk multipart.concurrency must be an integer >= 1",
      );
    }
    this.concurrency = concurrency;

    this.retry = resolveRetry(options.retry, "S3Disk");
    this.timeoutMs =
      options.timeout !== undefined
        ? duration(options.timeout, "S3Disk.timeout")
        : undefined;
    this.batchDelete = options.batchDelete ?? true;
    this.fetchFn = options.fetch;
  }

  protected override async writeObject(
    key: string,
    body: AsyncIterable<Buffer>,
    file: StorageObjectWrite,
  ): Promise<StorageWriteResult> {
    if (
      file.contentLength !== undefined &&
      file.contentLength <= this.partSize
    ) {
      const data = await readAll(body);
      const url = this.objectUrl(key);
      const headers = this.writeHeaders(file);
      headers["content-length"] = String(data.byteLength);
      const res = await this.send(
        "put",
        "PUT",
        url,
        headers,
        data,
        sha256Hex(data),
        file.signal,
      );
      const etag = res.headers.get("etag") ?? undefined;
      return {
        key,
        size: data.byteLength,
        contentType: file.contentType,
        ...(etag !== undefined ? { etag } : {}),
      };
    }

    // Buffer first part up to partSize + 1 to see if single PUT suffices
    const buffered: Buffer[] = [];
    let bufferedBytes = 0;
    const iterator = body[Symbol.asyncIterator]();
    let done = false;

    while (bufferedBytes <= this.partSize) {
      const next = await iterator.next();
      if (next.done) {
        done = true;
        break;
      }
      buffered.push(next.value);
      bufferedBytes += next.value.byteLength;
    }

    if (done && bufferedBytes <= this.partSize) {
      const data = Buffer.concat(buffered);
      const url = this.objectUrl(key);
      const headers = this.writeHeaders(file);
      headers["content-length"] = String(data.byteLength);
      const res = await this.send(
        "put",
        "PUT",
        url,
        headers,
        data,
        sha256Hex(data),
        file.signal,
      );
      const etag = res.headers.get("etag") ?? undefined;
      return {
        key,
        size: data.byteLength,
        contentType: file.contentType,
        ...(etag !== undefined ? { etag } : {}),
      };
    }

    return await this.multipartUpload(key, buffered, iterator, file);
  }

  private async multipartUpload(
    key: string,
    initialChunks: Buffer[],
    iterator: AsyncIterator<Buffer>,
    file: StorageObjectWrite,
  ): Promise<StorageWriteResult> {
    const initUrl = this.objectUrl(key);
    initUrl.searchParams.set("uploads", "");
    const initRes = await this.send(
      "createMultipartUpload",
      "POST",
      initUrl,
      this.writeHeaders(file),
      undefined,
      EMPTY_SHA256,
      file.signal,
    );
    const initXml = await initRes.text();
    const uploadId = xmlText(initXml, "UploadId");
    if (!uploadId) {
      throw new StorageServiceError({
        operation: "createMultipartUpload",
        code: "InvalidResponse",
        message: "S3 CreateMultipartUpload response missing UploadId",
      });
    }

    const parts: Array<{ partNumber: number; etag: string }> = [];
    let totalBytes = 0;

    try {
      const pendingChunks: Buffer[] = [...initialChunks];
      let pendingSize = pendingChunks.reduce((sum, b) => sum + b.byteLength, 0);
      let partNumber = 1;
      const inFlight = new Set<Promise<void>>();

      const uploadPart = async (num: number, data: Buffer) => {
        const partUrl = this.objectUrl(key);
        partUrl.searchParams.set("partNumber", String(num));
        partUrl.searchParams.set("uploadId", uploadId);
        const res = await this.send(
          "uploadPart",
          "PUT",
          partUrl,
          { "content-length": String(data.byteLength) },
          data,
          sha256Hex(data),
          file.signal,
        );
        const etag = res.headers.get("etag") ?? "";
        parts.push({ partNumber: num, etag });
      };

      const flushPart = async (data: Buffer) => {
        const num = partNumber++;
        totalBytes += data.byteLength;
        const p = uploadPart(num, data);
        inFlight.add(p);
        p.finally(() => inFlight.delete(p));
        if (inFlight.size >= this.concurrency) {
          await Promise.race(inFlight);
        }
      };

      const drainFullParts = async () => {
        while (pendingSize >= this.partSize) {
          const combined = Buffer.concat(pendingChunks);
          const partData = combined.subarray(0, this.partSize);
          const rest = combined.subarray(this.partSize);
          pendingChunks.length = 0;
          if (rest.byteLength > 0) {
            pendingChunks.push(rest);
          }
          pendingSize = rest.byteLength;
          await flushPart(partData);
        }
      };

      await drainFullParts();
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        pendingChunks.push(next.value);
        pendingSize += next.value.byteLength;
        await drainFullParts();
      }
      if (pendingSize > 0) {
        await flushPart(Buffer.concat(pendingChunks));
      }
      await Promise.all(inFlight);

      parts.sort((a, b) => a.partNumber - b.partNumber);
      const completeBody = `<CompleteMultipartUpload>${parts
        .map(
          (p) =>
            `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${encodeXml(p.etag)}</ETag></Part>`,
        )
        .join("")}</CompleteMultipartUpload>`;
      const completeBytes = Buffer.from(completeBody, "utf8");
      const completeUrl = this.objectUrl(key);
      completeUrl.searchParams.set("uploadId", uploadId);
      const completeRes = await this.send(
        "completeMultipartUpload",
        "POST",
        completeUrl,
        {
          "content-type": "application/xml",
          "content-length": String(completeBytes.byteLength),
        },
        completeBytes,
        sha256Hex(completeBytes),
        file.signal,
      );
      const completeXml = await completeRes.text();
      const etag =
        xmlText(completeXml, "ETag") ??
        completeRes.headers.get("etag") ??
        undefined;
      return {
        key,
        size: totalBytes,
        contentType: file.contentType,
        ...(etag !== undefined ? { etag } : {}),
      };
    } catch (err) {
      const abortUrl = this.objectUrl(key);
      abortUrl.searchParams.set("uploadId", uploadId);
      await this.send(
        "abortMultipartUpload",
        "DELETE",
        abortUrl,
        {},
        undefined,
        EMPTY_SHA256,
      ).catch(() => {});
      throw err;
    }
  }

  protected override async copyObject(
    from: string,
    to: string,
    options?: StorageSignalOptions,
  ): Promise<StorageWriteResult> {
    const sourceKey = this.prefixedKey(from);
    const url = this.objectUrl(to);
    const headers: Record<string, string> = {
      ...this.encryptionHeaders,
      "x-amz-copy-source": `/${encodeRfc3986(this.bucket)}/${encodeKeyPath(sourceKey)}`,
    };
    const res = await this.send(
      "copy",
      "PUT",
      url,
      headers,
      undefined,
      EMPTY_SHA256,
      options?.signal,
      from,
    );
    const xml = await res.text();
    const etag = xmlText(xml, "ETag");
    const head = await this.headObject(to, options);
    return {
      key: to,
      size: head.size,
      contentType: head.contentType,
      ...(etag ?? head.etag ? { etag: etag ?? head.etag } : {}),
    };
  }

  protected override async deleteObjects(
    keys: string[],
    options?: StorageSignalOptions,
  ): Promise<void> {
    if (keys.length === 1 || !this.batchDelete) {
      for (const key of keys) {
        options?.signal?.throwIfAborted();
        const url = this.objectUrl(key);
        try {
          await this.send(
            "delete",
            "DELETE",
            url,
            {},
            undefined,
            EMPTY_SHA256,
            options?.signal,
          );
        } catch (err) {
          if (err instanceof StorageFileNotFoundError) {
            continue;
          }
          throw err;
        }
      }
      return;
    }

    for (let i = 0; i < keys.length; i += 1000) {
      options?.signal?.throwIfAborted();
      const batch = keys.slice(i, i + 1000);
      const xml = `<Delete><Quiet>true</Quiet>${batch
        .map((k) => `<Object><Key>${encodeXml(this.prefixedKey(k))}</Key></Object>`)
        .join("")}</Delete>`;
      const bodyBytes = Buffer.from(xml, "utf8");
      const contentMd5 = createHash("md5").update(bodyBytes).digest("base64");
      const url = this.bucketUrl();
      url.searchParams.set("delete", "");
      await this.send(
        "deleteObjects",
        "POST",
        url,
        {
          "content-type": "application/xml",
          "content-md5": contentMd5,
          "content-length": String(bodyBytes.byteLength),
        },
        bodyBytes,
        sha256Hex(bodyBytes),
        options?.signal,
      );
    }
  }

  protected override async readObject(
    key: string,
    range: StorageRange | undefined,
    options?: StorageSignalOptions,
  ): Promise<StorageDownload> {
    const url = this.objectUrl(key);
    const headers: Record<string, string> = {};
    if (range !== undefined) {
      headers["range"] = formatRangeHeader(range);
    }
    const res = await this.send(
      "get",
      "GET",
      url,
      headers,
      undefined,
      EMPTY_SHA256,
      options?.signal,
      key,
    );

    const parsedRange = parseContentRange(res.headers.get("content-range"));
    const contentLength = Number(res.headers.get("content-length") ?? "0");
    const size = parsedRange ? parsedRange.total : contentLength;
    const contentType = res.headers.get("content-type") ?? DEFAULT_CONTENT_TYPE;
    const lastModifiedStr = res.headers.get("last-modified");
    const lastModified = lastModifiedStr ? new Date(lastModifiedStr) : new Date();
    const etag = res.headers.get("etag") ?? undefined;
    const cacheControl = res.headers.get("cache-control") ?? undefined;
    const contentDispositionHeader =
      res.headers.get("content-disposition") ?? undefined;
    const metadata = parseMetadataHeaders(res.headers);

    const body = res.body
      ? Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream)
      : Readable.from([]);

    return {
      key,
      size,
      contentType,
      lastModified,
      ...(etag !== undefined ? { etag } : {}),
      ...(cacheControl !== undefined ? { cacheControl } : {}),
      ...(contentDispositionHeader !== undefined
        ? { contentDisposition: contentDispositionHeader }
        : {}),
      metadata,
      body,
      ...(parsedRange
        ? { range: { start: parsedRange.start, end: parsedRange.end } }
        : {}),
    };
  }

  protected override async headObject(
    key: string,
    options?: StorageSignalOptions,
  ): Promise<StorageFile> {
    const url = this.objectUrl(key);
    const res = await this.send(
      "stat",
      "HEAD",
      url,
      {},
      undefined,
      EMPTY_SHA256,
      options?.signal,
      key,
    );
    const size = Number(res.headers.get("content-length") ?? "0");
    const contentType = res.headers.get("content-type") ?? DEFAULT_CONTENT_TYPE;
    const lastModifiedStr = res.headers.get("last-modified");
    const lastModified = lastModifiedStr ? new Date(lastModifiedStr) : new Date();
    const etag = res.headers.get("etag") ?? undefined;
    const cacheControl = res.headers.get("cache-control") ?? undefined;
    const contentDispositionHeader =
      res.headers.get("content-disposition") ?? undefined;
    const metadata = parseMetadataHeaders(res.headers);

    return {
      key,
      size,
      contentType,
      lastModified,
      ...(etag !== undefined ? { etag } : {}),
      ...(cacheControl !== undefined ? { cacheControl } : {}),
      ...(contentDispositionHeader !== undefined
        ? { contentDisposition: contentDispositionHeader }
        : {}),
      metadata,
    };
  }

  protected override async listObjects(options: {
    prefix: string;
    cursor?: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<StorageListPage> {
    const url = this.bucketUrl();
    url.searchParams.set("list-type", "2");
    const fullPrefix = `${this.prefix}${options.prefix}`;
    if (fullPrefix) {
      url.searchParams.set("prefix", fullPrefix);
    }
    url.searchParams.set("max-keys", String(options.limit));
    if (options.cursor !== undefined) {
      url.searchParams.set("continuation-token", options.cursor);
    }
    const res = await this.send(
      "list",
      "GET",
      url,
      {},
      undefined,
      EMPTY_SHA256,
      options.signal,
    );
    const xml = await res.text();
    const entries: StorageListEntry[] = [];
    for (const itemXml of xmlElements(xml, "Contents")) {
      const rawKey = xmlText(itemXml, "Key");
      if (!rawKey) continue;
      const key =
        this.prefix && rawKey.startsWith(this.prefix)
          ? rawKey.slice(this.prefix.length)
          : rawKey;
      const size = Number(xmlText(itemXml, "Size") ?? "0");
      const lastMod = xmlText(itemXml, "LastModified");
      const etag = xmlText(itemXml, "ETag");
      entries.push({
        key,
        size,
        lastModified: lastMod ? new Date(lastMod) : new Date(),
        ...(etag !== undefined ? { etag } : {}),
      });
    }
    const isTruncated = xmlText(xml, "IsTruncated") === "true";
    const nextToken = xmlText(xml, "NextContinuationToken");
    return {
      entries,
      ...(isTruncated && nextToken ? { cursor: nextToken } : {}),
    };
  }

  protected override async presignGet(
    key: string,
    expiresAt: Date,
    dispositionHeader: string | undefined,
  ): Promise<string> {
    const creds = await this.resolveCredentials();
    const url = this.objectUrl(key);
    if (dispositionHeader !== undefined) {
      url.searchParams.set("response-content-disposition", dispositionHeader);
    }
    const seconds = Math.max(
      1,
      Math.floor((expiresAt.getTime() - Date.now()) / 1000),
    );
    return presignUrl({
      method: "GET",
      url,
      expiresInSeconds: seconds,
      credentials: creds,
      region: this.region,
    }).toString();
  }

  protected override async presignPut(
    key: string,
    expiresAt: Date,
    request: StorageSignedUploadRequest,
  ): Promise<StorageSignedUpload> {
    const creds = await this.resolveCredentials();
    const url = this.objectUrl(key);
    const signedHeaders: Record<string, string> = {
      "content-type": request.contentType,
      ...this.encryptionHeaders,
    };
    if (request.contentLength !== undefined) {
      signedHeaders["content-length"] = String(request.contentLength);
    }
    const seconds = Math.max(
      1,
      Math.floor((expiresAt.getTime() - Date.now()) / 1000),
    );
    const signed = presignUrl({
      method: "PUT",
      url,
      headers: signedHeaders,
      expiresInSeconds: seconds,
      credentials: creds,
      region: this.region,
    });
    const clientHeaders: Record<string, string> = {
      "Content-Type": request.contentType,
      ...this.encryptionHeaders,
    };
    return {
      url: signed.toString(),
      method: "PUT",
      headers: clientHeaders,
      expiresAt,
    };
  }

  private async resolveCredentials(): Promise<S3Credentials> {
    return typeof this.credentials === "function"
      ? await this.credentials()
      : this.credentials;
  }

  private prefixedKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  private bucketUrl(): URL {
    const url = new URL(this.endpoint);
    if (this.pathStyle) {
      const basePath = url.pathname.replace(/\/+$/, "");
      url.pathname = `${basePath}/${encodeRfc3986(this.bucket)}`;
    } else {
      url.hostname = `${this.bucket}.${url.hostname}`;
      url.pathname = "/";
    }
    url.search = "";
    url.hash = "";
    return url;
  }

  private objectUrl(key: string): URL {
    const fullKey = this.prefixedKey(key);
    const url = new URL(this.endpoint);
    const encodedKey = encodeKeyPath(fullKey);
    if (this.pathStyle) {
      const basePath = url.pathname.replace(/\/+$/, "");
      url.pathname = `${basePath}/${encodeRfc3986(this.bucket)}/${encodedKey}`;
    } else {
      url.hostname = `${this.bucket}.${url.hostname}`;
      url.pathname = `/${encodedKey}`;
    }
    url.search = "";
    url.hash = "";
    return url;
  }

  private writeHeaders(file: StorageObjectWrite): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": file.contentType,
      ...this.encryptionHeaders,
    };
    if (file.cacheControl !== undefined) {
      headers["cache-control"] = file.cacheControl;
    }
    if (file.contentDisposition !== undefined) {
      headers["content-disposition"] = file.contentDisposition;
    }
    for (const [k, v] of Object.entries(file.metadata)) {
      headers[`x-amz-meta-${k}`] = v;
    }
    return headers;
  }

  private async send(
    operation: string,
    method: string,
    url: URL,
    headers: Record<string, string>,
    body: Buffer | undefined,
    payloadHash: string,
    signal?: AbortSignal,
    keyForError?: string,
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      signal?.throwIfAborted();
      try {
        return await this.attempt(
          operation,
          method,
          url,
          headers,
          body,
          payloadHash,
          signal,
          keyForError,
        );
      } catch (err) {
        lastError = err;
        if (signal?.aborted) {
          throw signal.reason ?? err;
        }
        const retryable = this.isRetryable(err);
        const canRetry =
          attempt < this.retry.attempts &&
          retryable &&
          (this.retry.retryIf ? this.retry.retryIf(err, attempt) : true);
        if (!canRetry) {
          throw err;
        }
        const waitMs = this.retry.delay(attempt, err);
        await sleep(waitMs, signal);
      }
    }
    throw lastError;
  }

  private async attempt(
    operation: string,
    method: string,
    url: URL,
    headers: Record<string, string>,
    body: Buffer | undefined,
    payloadHash: string,
    signal?: AbortSignal,
    keyForError?: string,
  ): Promise<Response> {
    const creds = await this.resolveCredentials();
    const signedHeaders = signRequest({
      method,
      url,
      headers,
      payloadHash,
      credentials: creds,
      region: this.region,
    });
    const fetchImpl = this.fetchFn ?? globalThis.fetch;
    let combinedSignal: AbortSignal | undefined = signal;
    if (this.timeoutMs !== undefined && this.timeoutMs > 0) {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
    }

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method,
        headers: signedHeaders,
        ...(body !== undefined ? { body: new Uint8Array(body) } : {}),
        ...(combinedSignal ? { signal: combinedSignal } : {}),
      });
    } catch (err) {
      throw this.transportError(operation, err, signal);
    }

    if (response.ok) {
      return response;
    }
    throw await this.responseError(operation, response, keyForError);
  }

  private transportError(
    operation: string,
    err: unknown,
    callerSignal?: AbortSignal,
  ): Error {
    if (callerSignal?.aborted) {
      return (callerSignal.reason as Error) ?? (err as Error);
    }
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    return new StorageServiceError({
      operation,
      code: isTimeout ? "Timeout" : "NetworkError",
      message: err instanceof Error ? err.message : String(err),
      cause: err,
    });
  }

  private async responseError(
    operation: string,
    response: Response,
    key?: string,
  ): Promise<StorageError> {
    const text = await response.text().catch(() => "");
    const code = xmlText(text, "Code") ?? `HTTP_${response.status}`;
    const message = xmlText(text, "Message") ?? response.statusText;
    const requestId =
      xmlText(text, "RequestId") ??
      response.headers.get("x-amz-request-id") ??
      undefined;

    if (
      (response.status === 404 || code === "NoSuchKey" || code === "NotFound") &&
      key !== undefined
    ) {
      return new StorageFileNotFoundError(key);
    }
    if (
      (response.status === 416 || code === "InvalidRange") &&
      key !== undefined
    ) {
      const cr = response.headers.get("content-range");
      const sizeMatch = cr ? /\/(\d+)$/.exec(cr) : null;
      return new StorageRangeNotSatisfiableError(
        key,
        sizeMatch ? Number(sizeMatch[1]) : undefined,
      );
    }
    return new StorageServiceError({
      operation,
      code,
      message,
      upstreamStatus: response.status,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }

  private isRetryable(err: unknown): boolean {
    if (!(err instanceof StorageServiceError)) {
      return false;
    }
    if (TRANSIENT_CODES.has(err.code)) {
      return true;
    }
    if (
      err.upstreamStatus !== undefined &&
      TRANSIENT_STATUSES.has(err.upstreamStatus)
    ) {
      return true;
    }
    return false;
  }
}
