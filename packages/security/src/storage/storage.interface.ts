import { BadRequestException, Inject } from "@bunest/common";

export const STORAGE_ADAPTER = Symbol.for("bunest:security:storage_adapter");
export const STORAGE_OPTIONS = Symbol.for("bunest:security:storage_options");

export interface StoragePutOptions {
  contentType?: string;
  metadata?: Record<string, string>;
  cacheControl?: string;
}

export interface StorageStat {
  readonly key: string;
  readonly size: number;
  readonly contentType?: string;
  readonly lastModified?: Date;
  readonly etag?: string;
  readonly metadata?: Record<string, string>;
}

export interface StorageObject {
  readonly key: string;
  readonly body: Uint8Array;
  readonly size: number;
  readonly contentType?: string;
  readonly metadata?: Record<string, string>;
}

export interface SignedUrlOptions {
  expiresInSeconds?: number;
  method?: "GET" | "PUT";
}

export type StorageBodyInput = Uint8Array | ArrayBuffer | Blob | string;

export interface StorageAdapter {
  put(
    key: string,
    data: StorageBodyInput,
    options?: StoragePutOptions,
  ): Promise<StorageStat>;
  get(key: string): Promise<StorageObject | null>;
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
  stat(key: string): Promise<StorageStat | null>;
  getSignedUrl?(key: string, options?: SignedUrlOptions): Promise<string>;
}

export class StoragePathTraversalException extends BadRequestException {
  constructor(key: string, reason = "Invalid storage key") {
    super(`${reason}: "${key}"`);
  }
}

export const InjectStorage = () => Inject(STORAGE_ADAPTER);

const CONTROL_CHAR_REGEX = /[\u0000-\u001F\u007F]/;
const WINDOWS_DRIVE_REGEX = /^[A-Za-z]:/;

/**
 * Strictly validates and normalizes a storage key, rejecting null bytes,
 * control characters, leading slashes, Windows drive/UNC prefixes, and `.`/`..` traversal segments.
 */
export function assertSafeStorageKey(key: string): string {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new StoragePathTraversalException(
      String(key),
      "Storage key must be a non-empty string",
    );
  }

  if (CONTROL_CHAR_REGEX.test(key)) {
    throw new StoragePathTraversalException(
      key,
      "Storage key contains forbidden control or null bytes",
    );
  }

  if (
    key.startsWith("/") ||
    key.startsWith("\\") ||
    WINDOWS_DRIVE_REGEX.test(key)
  ) {
    throw new StoragePathTraversalException(
      key,
      "Storage key must be a relative path without leading slash or drive letter",
    );
  }

  // Split on both POSIX and Windows separators to prevent mixed-separator traversal
  const rawSegments = key.split(/[\\/]+/);
  const cleanSegments: string[] = [];

  for (const segment of rawSegments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new StoragePathTraversalException(
        key,
        "Storage key contains forbidden path traversal or empty segment",
      );
    }
    if (segment.includes(":")) {
      throw new StoragePathTraversalException(
        key,
        "Storage key contains forbidden colon character (NTFS ADS / drive prefix)",
      );
    }
    cleanSegments.push(segment);
  }

  return cleanSegments.join("/");
}

export async function toUint8Array(
  data: StorageBodyInput,
): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof data === "string") {
    const encoded = new TextEncoder().encode(data);
    const copy = new Uint8Array(encoded.byteLength);
    copy.set(encoded);
    return copy;
  }
  if (data instanceof Uint8Array) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return copy;
  }
  if (data instanceof ArrayBuffer) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(new Uint8Array(data));
    return copy;
  }
  const ab = await data.arrayBuffer();
  const copy = new Uint8Array(ab.byteLength);
  copy.set(new Uint8Array(ab));
  return copy;
}
