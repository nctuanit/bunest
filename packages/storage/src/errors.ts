/**
 * Base class of every error a disk raises itself. Errors from the body you pass to `put()`
 * (a stream that fails mid-way) and a caller's abort (`signal.reason`) propagate unchanged.
 */
export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The body passed to `put()` didn't match `contentLength`, or went over a disk's limit.
 * Nothing was written. Status 400.
 */
export class StorageBodyLengthError extends StorageError {
  readonly expected: number;
  readonly received: number;
  readonly status = 400;

  constructor(expected: number, received: number) {
    super(
      `Storage body length mismatch: expected ${expected} bytes, received ${received} bytes`,
    );
    this.expected = expected;
    this.received = received;
  }
}

/** No file at `key`. Carries `status` 404, so other packages treat it as the caller's mistake. */
export class StorageFileNotFoundError extends StorageError {
  readonly key: string;
  readonly status = 404;

  constructor(key: string) {
    super(`Storage file not found: ${key}`);
    this.key = key;
  }
}

/**
 * The key can't be used on any disk: empty, longer than 1024 bytes, absolute, with a `.`,
 * `..` or empty segment, a backslash, or a control character. Status 400.
 */
export class StorageInvalidKeyError extends StorageError {
  readonly reason: string;
  readonly status = 400;

  constructor(reason: string) {
    super(`Invalid storage key: ${reason}`);
    this.reason = reason;
  }
}

/**
 * A local disk can't hold both `a` and `a/b`: one of them would have to be a file and a
 * directory at once. Status 409.
 */
export class StorageKeyConflictError extends StorageError {
  readonly key: string;
  readonly status = 409;

  constructor(key: string) {
    super(`Storage key conflict at "${key}"`);
    this.key = key;
  }
}

/**
 * The requested byte range starts beyond the end of the file (or asks for zero bytes).
 * Status 416. `size` is the file's size, for a `Content-Range: bytes *\/size` header.
 */
export class StorageRangeNotSatisfiableError extends StorageError {
  readonly key: string;
  readonly size: number | undefined;
  readonly status = 416;

  constructor(key: string, size: number | undefined) {
    super(
      `Range not satisfiable for "${key}"${size !== undefined ? ` (size ${size})` : ""}`,
    );
    this.key = key;
    this.size = size;
  }
}

/**
 * An object store refused a request or couldn't be reached: access denied, a missing
 * bucket, throttling that outlasted the retries, a network failure or a timeout.
 */
export class StorageServiceError extends StorageError {
  readonly code: string;
  readonly upstreamStatus: number | undefined;
  readonly requestId: string | undefined;
  readonly operation: string;

  constructor(init: {
    operation: string;
    code: string;
    message?: string;
    upstreamStatus?: number;
    requestId?: string;
    cause?: unknown;
  }) {
    const detail = init.message ?? init.code;
    super(`Storage ${init.operation} failed (${init.code}): ${detail}`, {
      cause: init.cause,
    });
    this.operation = init.operation;
    this.code = init.code;
    this.upstreamStatus = init.upstreamStatus;
    this.requestId = init.requestId;
  }
}

/** Why an app-served signed URL was refused. */
export type StorageSignedUrlFailure =
  | "missing"
  | "invalid"
  | "expired"
  | "method";

/**
 * An app-served signed URL that is missing its parameters, was tampered with, has expired,
 * or is used with another method. Status 403.
 */
export class StorageSignedUrlError extends StorageError {
  readonly reason: StorageSignedUrlFailure;
  readonly status = 403;

  constructor(reason: StorageSignedUrlFailure) {
    super(`Invalid signed storage URL: ${reason}`);
    this.reason = reason;
  }
}
