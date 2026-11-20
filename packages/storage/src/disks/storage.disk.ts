import {
  StorageError,
  StorageFileNotFoundError,
  StorageInvalidKeyError,
} from "../errors";
import type {
  StorageBody,
  StorageDiskOptions,
  StorageDownload,
  StorageFile,
  StorageGetOptions,
  StorageListEntry,
  StorageListOptions,
  StorageListPage,
  StorageObjectWrite,
  StoragePutOptions,
  StorageRange,
  StorageSignalOptions,
  StorageSignedUpload,
  StorageSignedUploadRequest,
  StorageSignedUrlClaims,
  StorageSignedUrlRequest,
  StorageWriteResult,
} from "../interfaces/storage-types";
import {
  abortable,
  checkLength,
  knownLength,
  readAll,
  toChunks,
} from "../utils/body.util";
import { contentTypeFromKey } from "../utils/content-type.util";
import { toMs } from "../utils/duration.util";
import {
  assertValidKey,
  assertValidPrefix,
  encodeKeyPath,
  encodeRfc3986,
} from "../utils/keys.util";
import { type SignedUrlQuery, UrlSigner } from "../utils/url-signer.util";

const DEFAULT_EXPIRES_MS = 15 * 60 * 1000;
const MAX_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LIST_LIMIT = 1000;
const MAX_METADATA_BYTES = 2048;
const METADATA_KEY_RE = /^[A-Za-z0-9_-]+$/;
// eslint-disable-next-line no-control-regex
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]*$/;

const SIGNED_URL_SERVERS = new WeakSet<StorageDisk>();

function normalizePublicBase(publicUrl: string | URL | undefined): URL | undefined {
  if (publicUrl === undefined) {
    return undefined;
  }
  const url = publicUrl instanceof URL ? new URL(publicUrl) : new URL(publicUrl);
  if (!/^https?:$/.test(url.protocol) || url.search || url.hash) {
    throw new TypeError(
      `\`publicUrl\` must be an absolute http(s) URL without a query or hash`,
    );
  }
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}

function validateMetadata(
  raw: Record<string, string> | undefined,
): Record<string, string> {
  if (!raw) {
    return {};
  }
  const normalized: Record<string, string> = {};
  let totalBytes = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (!METADATA_KEY_RE.test(k)) {
      throw new TypeError(
        `Invalid storage metadata key "${k}": must contain only letters, digits, "-" and "_"`,
      );
    }
    if (typeof v !== "string" || !PRINTABLE_ASCII_RE.test(v)) {
      throw new TypeError(
        `Invalid storage metadata value for "${k}": must be printable ASCII`,
      );
    }
    const lower = k.toLowerCase();
    normalized[lower] = v;
    totalBytes += Buffer.byteLength(lower, "utf8") + Buffer.byteLength(v, "utf8");
  }
  if (totalBytes > MAX_METADATA_BYTES) {
    throw new TypeError(
      `Storage metadata exceeds ${MAX_METADATA_BYTES} bytes (${totalBytes} bytes)`,
    );
  }
  return normalized;
}

function validateRangeInput(range: StorageRange | undefined): void {
  if (range === undefined) {
    return;
  }
  if ("suffix" in range) {
    if (!Number.isInteger(range.suffix) || range.suffix < 0) {
      throw new RangeError(
        `Invalid storage range suffix: ${String(range.suffix)}`,
      );
    }
    return;
  }
  if (!Number.isInteger(range.start) || range.start < 0) {
    throw new RangeError(`Invalid storage range start: ${String(range.start)}`);
  }
  if (range.end !== undefined) {
    if (!Number.isInteger(range.end) || range.end < range.start) {
      throw new RangeError(`Invalid storage range end: ${String(range.end)}`);
    }
  }
}

function resolveExpiresAt(expiresIn: StorageSignedUrlRequest["expiresIn"]): Date {
  const ms = expiresIn !== undefined ? toMs(expiresIn) : DEFAULT_EXPIRES_MS;
  if (ms <= 0 || ms > MAX_EXPIRES_MS) {
    throw new RangeError(
      `Signed URL expiresIn must be between 1ms and 7d (got ${ms}ms)`,
    );
  }
  return new Date(Date.now() + ms);
}

/** Whether a disk signs its URLs for the app to serve (internal, for the HTTP helpers). */
export function servesSignedUrls(disk: StorageDisk): boolean {
  return SIGNED_URL_SERVERS.has(disk);
}

/**
 * Resolves a range against a file size, the way S3 does: `end` is clamped to the last byte,
 * a suffix longer than the file is the whole file, and a start at or past the end (or a
 * zero-length suffix, or any range on an empty file) is unsatisfiable (`undefined`).
 */
export function resolveRange(
  range: StorageRange,
  size: number,
): { start: number; end: number } | undefined {
  if (size <= 0) {
    return undefined;
  }
  if ("suffix" in range) {
    if (range.suffix <= 0) {
      return undefined;
    }
    const start = Math.max(0, size - range.suffix);
    return { start, end: size - 1 };
  }
  if (range.start < 0 || range.start >= size) {
    return undefined;
  }
  const end =
    range.end === undefined ? size - 1 : Math.min(range.end, size - 1);
  if (end < range.start) {
    return undefined;
  }
  return { start: range.start, end };
}

/**
 * `attachment; filename="..."; filename*=UTF-8''...`: an ASCII fallback for old clients and the
 * exact name for the rest (RFC 6266). Quotes, backslashes and control characters can't break out.
 */
export function contentDisposition(
  type: "attachment" | "inline",
  filename?: string,
): string {
  if (!filename) {
    return type;
  }
  // eslint-disable-next-line no-control-regex
  const clean = filename.replace(/[\x00-\x1f\x7f\r\n/\\]/g, "_");
  const asciiFallback = clean
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  const encoded = encodeRfc3986(clean);
  return `${type}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * A place files live: a local directory, a bucket, memory. The abstract class is the
 * contract, and the injection token of the default disk (`@InjectDisk(name)` for the others).
 */
export abstract class StorageDisk {
  private readonly publicBase?: URL;
  private readonly signer?: UrlSigner;

  protected constructor(options?: StorageDiskOptions) {
    this.publicBase = normalizePublicBase(options?.publicUrl);
    if (options?.signedUrls) {
      this.signer = new UrlSigner(options.signedUrls, new.target.name);
      SIGNED_URL_SERVERS.add(this);
    }
  }

  protected abstract writeObject(
    key: string,
    body: AsyncIterable<Buffer>,
    file: StorageObjectWrite,
  ): Promise<StorageWriteResult>;

  protected abstract readObject(
    key: string,
    range: StorageRange | undefined,
    options?: StorageSignalOptions,
  ): Promise<StorageDownload>;

  protected abstract headObject(
    key: string,
    options?: StorageSignalOptions,
  ): Promise<StorageFile>;

  protected abstract deleteObjects(
    keys: string[],
    options?: StorageSignalOptions,
  ): Promise<void>;

  protected abstract listObjects(options: {
    prefix: string;
    cursor?: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<StorageListPage>;

  protected abstract copyObject(
    from: string,
    to: string,
    options?: StorageSignalOptions,
  ): Promise<StorageWriteResult>;

  protected async moveObject(
    from: string,
    to: string,
    options?: StorageSignalOptions,
  ): Promise<StorageWriteResult> {
    const copied = await this.copyObject(from, to, options);
    if (from !== to) {
      await this.deleteObjects([from]);
    }
    return copied;
  }

  protected async presignGet(
    key: string,
    expiresAt: Date,
    dispositionHeader: string | undefined,
  ): Promise<string> {
    const signer = this.requireSigner();
    return signer.sign({
      key,
      method: "GET",
      expiresAt,
      ...(dispositionHeader !== undefined
        ? { contentDisposition: dispositionHeader }
        : {}),
    });
  }

  protected async presignPut(
    key: string,
    expiresAt: Date,
    request: StorageSignedUploadRequest,
  ): Promise<StorageSignedUpload> {
    const signer = this.requireSigner();
    const url = signer.sign({
      key,
      method: "PUT",
      expiresAt,
      contentType: request.contentType,
      ...(request.contentLength !== undefined
        ? { contentLength: request.contentLength }
        : {}),
    });
    return {
      url,
      method: "PUT",
      headers: {
        "Content-Type": request.contentType,
      },
      expiresAt,
    };
  }

  /** Optional. Releases what the disk opened itself. Called on application shutdown. */
  close?(): Promise<void>;

  /** Stores `body` at `key`, replacing what was there. */
  async put(
    key: string,
    body: StorageBody,
    options: StoragePutOptions = {},
  ): Promise<StorageWriteResult> {
    assertValidKey(key);
    options.signal?.throwIfAborted();
    if (options.contentLength !== undefined) {
      if (
        !Number.isInteger(options.contentLength) ||
        options.contentLength < 0
      ) {
        throw new RangeError(
          `contentLength must be a non-negative integer (got ${options.contentLength})`,
        );
      }
    }
    const metadata = validateMetadata(options.metadata);
    const explicitContentType = options.contentType !== undefined;
    const contentType = options.contentType ?? contentTypeFromKey(key);
    const inferredLen = knownLength(body);
    const expectedLen = options.contentLength ?? inferredLen;
    const chunks = checkLength(
      abortable(toChunks(body), options.signal),
      options.contentLength,
    );
    const file: StorageObjectWrite = {
      contentType,
      ...(options.cacheControl !== undefined
        ? { cacheControl: options.cacheControl }
        : {}),
      ...(options.contentDisposition !== undefined
        ? { contentDisposition: options.contentDisposition }
        : {}),
      metadata,
      ...(expectedLen !== undefined ? { contentLength: expectedLen } : {}),
      explicitContentType,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    };
    return await this.writeObject(key, chunks, file);
  }

  /** The file's body as a stream, and its metadata. Throws `StorageFileNotFoundError`. */
  async get(
    key: string,
    options: StorageGetOptions = {},
  ): Promise<StorageDownload> {
    assertValidKey(key);
    validateRangeInput(options.range);
    options.signal?.throwIfAborted();
    return await this.readObject(key, options.range, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  async getBuffer(
    key: string,
    options?: StorageSignalOptions,
  ): Promise<Buffer> {
    const download = await this.get(key, options);
    try {
      return await readAll(download.body);
    } finally {
      if (!download.body.destroyed) {
        download.body.destroy();
      }
    }
  }

  async getText(key: string, options?: StorageSignalOptions): Promise<string> {
    const buf = await this.getBuffer(key, options);
    return buf.toString("utf8");
  }

  async exists(key: string, options?: StorageSignalOptions): Promise<boolean> {
    try {
      await this.stat(key, options);
      return true;
    } catch (err) {
      if (err instanceof StorageFileNotFoundError) {
        return false;
      }
      throw err;
    }
  }

  /** Throws `StorageFileNotFoundError`. */
  async stat(
    key: string,
    options?: StorageSignalOptions,
  ): Promise<StorageFile> {
    assertValidKey(key);
    options?.signal?.throwIfAborted();
    return await this.headObject(key, options);
  }

  /** Deletes one key or several. Deleting a missing key is not an error. */
  async delete(
    keys: string | readonly string[],
    options?: StorageSignalOptions,
  ): Promise<void> {
    const list = typeof keys === "string" ? [keys] : [...keys];
    if (list.length === 0) {
      return;
    }
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const k of list) {
      assertValidKey(k);
      if (!seen.has(k)) {
        seen.add(k);
        unique.push(k);
      }
    }
    options?.signal?.throwIfAborted();
    await this.deleteObjects(unique, options);
  }

  /** One page of files, in key order. */
  async list(options: StorageListOptions = {}): Promise<StorageListPage> {
    const prefix = options.prefix ?? "";
    assertValidPrefix(prefix);
    const limit = options.limit ?? MAX_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new RangeError(
        `list() limit must be an integer between 1 and ${MAX_LIST_LIMIT} (got ${limit})`,
      );
    }
    options.signal?.throwIfAborted();
    return await this.listObjects({
      prefix,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      limit,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  /** Every file under `prefix`, page by page. */
  async *listAll(
    options: Omit<StorageListOptions, "cursor"> = {},
  ): AsyncIterable<StorageListEntry> {
    let cursor: string | undefined;
    do {
      const page = await this.list({
        ...options,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const entry of page.entries) {
        yield entry;
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
  }

  /** Copies content and metadata within this disk. Throws `StorageFileNotFoundError`. */
  async copy(
    from: string,
    to: string,
    options?: StorageSignalOptions,
  ): Promise<StorageWriteResult> {
    assertValidKey(from);
    assertValidKey(to);
    options?.signal?.throwIfAborted();
    if (from === to) {
      return await this.touchResult(from, options);
    }
    return await this.copyObject(from, to, options);
  }

  /** Moves within this disk. Atomic on a local disk; a copy and a delete on S3. */
  async move(
    from: string,
    to: string,
    options?: StorageSignalOptions,
  ): Promise<StorageWriteResult> {
    assertValidKey(from);
    assertValidKey(to);
    options?.signal?.throwIfAborted();
    if (from === to) {
      return await this.touchResult(from, options);
    }
    return await this.moveObject(from, to, options);
  }

  /** The public URL of `key` under `publicUrl`. */
  url(key: string): string {
    assertValidKey(key);
    if (!this.publicBase) {
      throw new StorageError(
        `${this.constructor.name} has no \`publicUrl\` configured`,
      );
    }
    return new URL(encodeKeyPath(key), this.publicBase).toString();
  }

  /** A time-limited download link for a private file. */
  async signedUrl(
    key: string,
    options: StorageSignedUrlRequest = {},
  ): Promise<string> {
    assertValidKey(key);
    const expiresAt = resolveExpiresAt(options.expiresIn);
    let dispositionHeader: string | undefined;
    if (options.disposition !== undefined || options.filename !== undefined) {
      dispositionHeader = contentDisposition(
        options.disposition ?? "attachment",
        options.filename,
      );
    }
    return await this.presignGet(key, expiresAt, dispositionHeader);
  }

  /** A time-limited upload URL: the client `PUT`s the file straight to the disk. */
  async signedUpload(
    key: string,
    options: StorageSignedUploadRequest,
  ): Promise<StorageSignedUpload> {
    assertValidKey(key);
    if (!options?.contentType || typeof options.contentType !== "string") {
      throw new TypeError("signedUpload() requires a non-empty `contentType`");
    }
    if (options.contentLength !== undefined) {
      if (
        !Number.isInteger(options.contentLength) ||
        options.contentLength < 0
      ) {
        throw new RangeError(
          `signedUpload() contentLength must be a non-negative integer`,
        );
      }
    }
    const expiresAt = resolveExpiresAt(options.expiresIn);
    return await this.presignPut(key, expiresAt, options);
  }

  /**
   * Checks an app-served signed URL (the full request URL, or its query) and returns what it
   * grants. Throws `StorageSignedUrlError` (status 403).
   */
  verifySignedUrl(
    url: SignedUrlQuery,
    method: "GET" | "PUT" = "GET",
  ): StorageSignedUrlClaims {
    const claims = this.requireSigner().verify(url, method);
    try {
      assertValidKey(claims.key);
    } catch (err) {
      if (err instanceof StorageInvalidKeyError) {
        throw err;
      }
      throw err;
    }
    return claims;
  }

  private requireSigner(): UrlSigner {
    if (!this.signer) {
      throw new StorageError(
        `${this.constructor.name} cannot sign URLs without \`signedUrls\` configured`,
      );
    }
    return this.signer;
  }

  private async touchResult(
    key: string,
    options?: StorageSignalOptions,
  ): Promise<StorageWriteResult> {
    const info = await this.headObject(key, options);
    return {
      key: info.key,
      size: info.size,
      contentType: info.contentType,
      ...(info.etag !== undefined ? { etag: info.etag } : {}),
    };
  }
}
