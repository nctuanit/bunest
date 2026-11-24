/** Milliseconds, or a string such as `"250ms"`, `"30s"`, `"15m"`, `"6h"`, `"3d"`, `"1w"`. */
export type Duration =
  number | `${number}${"ms" | "s" | "m" | "h" | "d" | "w"}`;

/** How long to wait between attempts. */
export interface StorageBackoffOptions {
  /** Wait before the first retry. Default 100 ms. */
  delay?: Duration;
  /** Growth per retry; `1` = constant. Default 2. */
  factor?: number;
  /** Cap for a single wait. Default 20 s. */
  maxDelay?: Duration;
  /** Default `full`: a random wait in [0, computed], so clients don't retry in lockstep. */
  jitter?: "full" | "equal" | "none";
}

/** Retries for an object store's transient failures. */
export interface StorageRetryOptions {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /** A function gets the attempt that just failed (1-based) and its error. */
  backoff?:
    StorageBackoffOptions | ((attempt: number, error: unknown) => Duration);
  /** Asked about every failure that would be retried; return `false` to stop. */
  retryIf?: (error: unknown, attempt: number) => boolean;
}

/** App-served signed URLs, for disks that can't presign on their own (`LocalDisk`, `InMemoryDisk`). */
export interface StorageSignedUrlOptions {
  baseUrl: string | URL;
  keys: (string | Buffer)[];
}

/** What an app-served signed URL grants, as `verifySignedUrl()` returns it. */
export interface StorageSignedUrlClaims {
  key: string;
  method: "GET" | "PUT";
  expiresAt: Date;
  contentType?: string;
  contentLength?: number;
  contentDisposition?: string;
}

/** Options every disk takes. */
export interface StorageDiskOptions {
  publicUrl?: string | URL;
  signedUrls?: StorageSignedUrlOptions;
}

export interface LocalDiskOptions extends StorageDiskOptions {
  root: string;
}

export type InMemoryDiskOptions = StorageDiskOptions;

/** AWS credentials. A session token comes with temporary credentials (STS, SSO, IRSA). */
export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3DiskOptions extends Omit<StorageDiskOptions, "signedUrls"> {
  bucket: string;
  region?: string;
  endpoint?: string | URL;
  forcePathStyle?: boolean;
  credentials?: S3Credentials | (() => S3Credentials | Promise<S3Credentials>);
  prefix?: string;
  serverSideEncryption?: "AES256" | "aws:kms" | "aws:kms:dsse";
  kmsKeyId?: string;
  multipart?: {
    partSize?: number;
    concurrency?: number;
  };
  retry?: number | false | StorageRetryOptions;
  timeout?: Duration;
  batchDelete?: boolean;
  fetch?: typeof globalThis.fetch;
}

/** What `put()` accepts. */
export type StorageBody =
  | Buffer
  | Uint8Array
  | string
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

/** A file's metadata, as `stat()` returns it and `get()` returns it next to the body. */
export interface StorageFile {
  key: string;
  size: number;
  contentType: string;
  lastModified: Date;
  etag?: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata: Record<string, string>;
}

/** What `put()`, `copy()` and `move()` resolve to. */
export interface StorageWriteResult {
  key: string;
  size: number;
  contentType: string;
  etag?: string;
}

/** A byte range to read: `{ start, end }` (inclusive) or the last `suffix` bytes. */
export type StorageRange =
  | {
      start: number;
      end?: number;
    }
  | {
      suffix: number;
    };

/** What `get()` resolves to: the metadata and the body as a Web `ReadableStream<Uint8Array>`. */
export interface StorageDownload extends StorageFile {
  body: ReadableStream<Uint8Array>;
  range?: {
    start: number;
    end: number;
  };
}

/** Accepted by every disk operation that does I/O. */
export interface StorageSignalOptions {
  signal?: AbortSignal;
}

export interface StoragePutOptions extends StorageSignalOptions {
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
  contentLength?: number;
  signal?: AbortSignal;
}

export interface StorageGetOptions extends StorageSignalOptions {
  range?: StorageRange;
}

export interface StorageListOptions extends StorageSignalOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
}

/** One file in a listing. */
export interface StorageListEntry {
  key: string;
  size: number;
  lastModified: Date;
  etag?: string;
}

export interface StorageListPage {
  entries: StorageListEntry[];
  cursor?: string;
}

export interface StorageSignedUrlRequest {
  expiresIn?: Duration;
  filename?: string;
  disposition?: "attachment" | "inline";
}

export interface StorageSignedUploadRequest {
  contentType: string;
  contentLength?: number;
  expiresIn?: Duration;
}

/** What `signedUpload()` returns. */
export interface StorageSignedUpload {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: Date;
}

/** What a disk's `writeObject()` receives besides the body: validated, with defaults applied. */
export interface StorageObjectWrite {
  contentType: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata: Record<string, string>;
  contentLength?: number;
  explicitContentType: boolean;
  signal?: AbortSignal;
}

export interface ServeFileOptions {
  req?: unknown;
  res: unknown;
  disposition?: "attachment" | "inline";
  filename?: string;
  cacheControl?: string;
}

export interface ServeSignedUrlOptions extends Omit<
  ServeFileOptions,
  "filename" | "disposition"
> {
  req: unknown;
}

export interface ReceiveSignedUploadOptions {
  req: unknown;
  res?: unknown;
  maxSize?: number;
}

export interface UploadFileInfo {
  fieldname: string;
  originalname: string;
  mimetype: string;
  contentType: string | undefined;
  extension: string;
}

export interface StoredUpload {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  key: string;
  disk?: string;
  contentType: string;
  etag?: string;
}

export interface UploadStorageEngine {
  _handleFile(
    req: unknown,
    file: unknown,
    callback: (error?: unknown, info?: Partial<StoredUpload>) => void,
  ): void;
  _removeFile(
    req: unknown,
    file: unknown,
    callback: (error: Error | null) => void,
  ): void;
}
