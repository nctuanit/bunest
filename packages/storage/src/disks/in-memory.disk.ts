import {
  base64UrlDecode,
  base64UrlEncode,
  definedOnly,
  md5,
} from "@bunest/core/common";
import {
  StorageFileNotFoundError,
  StorageRangeNotSatisfiableError,
} from "../errors";
import type {
  InMemoryDiskOptions,
  StorageDownload,
  StorageFile,
  StorageListEntry,
  StorageListPage,
  StorageObjectWrite,
  StorageRange,
  StorageWriteResult,
} from "../interfaces/storage-types";
import { bytesToReadableStream, readAll } from "../utils/body.util";
import { resolveRange, StorageDisk } from "./storage.disk";

interface StoredObject {
  data: Buffer;
  contentType: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata: Record<string, string>;
  lastModified: Date;
  etag: string;
}

/** S3 lists keys in UTF-8 byte order, which isn't JavaScript's UTF-16 order for every character. */
export function compareKeys(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function encodeCursor(key: string): string {
  return base64UrlEncode(key);
}

export function decodeCursor(cursor: string): string {
  return base64UrlDecode(cursor);
}

function md5Etag(data: Buffer): string {
  return `"${md5(data)}"`;
}

/**
 * Keeps files in a `Map`, for tests. It behaves like the other disks: the same key rules,
 * S3's range and listing semantics, metadata, public and (app-served) signed URLs.
 */
export class InMemoryDisk extends StorageDisk {
  private readonly objects = new Map<string, StoredObject>();

  constructor(options?: InMemoryDiskOptions) {
    super(options);
  }

  /** The stored keys, sorted. For assertions in tests. */
  keys(): string[] {
    return [...this.objects.keys()].sort(compareKeys);
  }

  clear(): void {
    this.objects.clear();
  }

  protected override async writeObject(
    key: string,
    body: AsyncIterable<Buffer>,
    file: StorageObjectWrite,
  ): Promise<StorageWriteResult> {
    const data = await readAll(body);
    const etag = md5Etag(data);
    this.objects.set(key, {
      data,
      contentType: file.contentType,
      ...definedOnly({
        cacheControl: file.cacheControl,
        contentDisposition: file.contentDisposition,
      }),
      metadata: { ...file.metadata },
      lastModified: new Date(),
      etag,
    });
    return {
      key,
      size: data.byteLength,
      contentType: file.contentType,
      etag,
    };
  }

  protected override async readObject(
    key: string,
    range: StorageRange | undefined,
  ): Promise<StorageDownload> {
    const entry = this.require(key);
    const info = this.describe(key, entry);
    if (range === undefined) {
      return {
        ...info,
        body: bytesToReadableStream(Buffer.from(entry.data)),
      };
    }
    const resolved = resolveRange(range, entry.data.byteLength);
    if (!resolved) {
      throw new StorageRangeNotSatisfiableError(key, entry.data.byteLength);
    }
    const slice = Buffer.from(
      entry.data.subarray(resolved.start, resolved.end + 1),
    );
    return {
      ...info,
      body: bytesToReadableStream(slice),
      range: resolved,
    };
  }

  protected override async headObject(key: string): Promise<StorageFile> {
    const entry = this.require(key);
    return this.describe(key, entry);
  }

  protected override async deleteObjects(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.objects.delete(key);
    }
  }

  protected override async listObjects(options: {
    prefix: string;
    cursor?: string;
    limit: number;
  }): Promise<StorageListPage> {
    const after =
      options.cursor !== undefined ? decodeCursor(options.cursor) : undefined;
    const matched: StorageListEntry[] = [];
    for (const key of this.keys()) {
      if (options.prefix && !key.startsWith(options.prefix)) {
        continue;
      }
      if (after !== undefined && compareKeys(key, after) <= 0) {
        continue;
      }
      const entry = this.objects.get(key)!;
      matched.push({
        key,
        size: entry.data.byteLength,
        lastModified: new Date(entry.lastModified.getTime()),
        etag: entry.etag,
      });
    }
    const hasMore = matched.length > options.limit;
    const entries = hasMore ? matched.slice(0, options.limit) : matched;
    const last = entries[entries.length - 1];
    return {
      entries,
      ...(hasMore && last ? { cursor: encodeCursor(last.key) } : {}),
    };
  }

  protected override async copyObject(
    from: string,
    to: string,
  ): Promise<StorageWriteResult> {
    const entry = this.require(from);
    const copied: StoredObject = {
      data: Buffer.from(entry.data),
      contentType: entry.contentType,
      ...definedOnly({
        cacheControl: entry.cacheControl,
        contentDisposition: entry.contentDisposition,
      }),
      metadata: { ...entry.metadata },
      lastModified: new Date(),
      etag: entry.etag,
    };
    this.objects.set(to, copied);
    return {
      key: to,
      size: copied.data.byteLength,
      contentType: copied.contentType,
      etag: copied.etag,
    };
  }

  protected override async moveObject(
    from: string,
    to: string,
  ): Promise<StorageWriteResult> {
    const result = await this.copyObject(from, to);
    if (from !== to) {
      this.objects.delete(from);
    }
    return result;
  }

  private require(key: string): StoredObject {
    const entry = this.objects.get(key);
    if (!entry) {
      throw new StorageFileNotFoundError(key);
    }
    return entry;
  }

  private describe(key: string, entry: StoredObject): StorageFile {
    return {
      key,
      size: entry.data.byteLength,
      contentType: entry.contentType,
      lastModified: new Date(entry.lastModified.getTime()),
      etag: entry.etag,
      ...definedOnly({
        cacheControl: entry.cacheControl,
        contentDisposition: entry.contentDisposition,
      }),
      metadata: { ...entry.metadata },
    };
  }
}
