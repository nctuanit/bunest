import { StorageDisk } from "../disks/storage.disk";
import { StorageFileNotFoundError } from "../errors";
import type {
  StorageDiskOptions,
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
import { bytesToReadableStream, readAll } from "../utils/body.util";
import { DEFAULT_CONTENT_TYPE } from "../utils/content-type.util";
import { assertValidPrefix } from "../utils/keys.util";

export interface BunS3FileLike {
  stream?(): ReadableStream<Uint8Array>;
  slice?(start?: number, end?: number): BunS3FileLike;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes?(): Promise<Uint8Array>;
  exists(): Promise<boolean>;
  delete(): Promise<void>;
  stat?(): Promise<{
    size: number;
    type?: string;
    lastModified?: Date;
    etag?: string;
  }>;
  presign?(options?: {
    expiresIn?: number;
    method?: string;
    type?: string;
  }): string;
  readonly size?: number;
  readonly type?: string;
}

/**
 * Structural contract compatible with Bun's native `Bun.S3Client` (`Bun.s3`)
 * and lightweight mocks for unit testing.
 */
export interface BunS3ClientLike {
  file(key: string): BunS3FileLike;
  write(
    key: string,
    data: Uint8Array | ArrayBuffer | Blob | string,
    options?: { type?: string },
  ): Promise<number>;
  delete?(key: string): Promise<void>;
  exists?(key: string): Promise<boolean>;
  stat?(key: string): Promise<{
    size: number;
    type?: string;
    lastModified?: Date;
    etag?: string;
  }>;
  list?(options?: {
    prefix?: string;
    maxKeys?: number;
    continuationToken?: string;
  }): Promise<{
    contents?: Array<{
      key: string;
      size?: number;
      lastModified?: Date | string;
      eTag?: string;
      etag?: string;
    }>;
    isTruncated?: boolean;
    nextContinuationToken?: string;
  }>;
  presign?(
    key: string,
    options?: { expiresIn?: number; method?: string; type?: string },
  ): string;
}

export interface BunS3DiskOptions extends Omit<StorageDiskOptions, "signedUrls"> {
  /**
   * An existing `Bun.S3Client` (such as `Bun.s3` or `new Bun.S3Client(...)`) or
   * S3 connection options used to instantiate `new Bun.S3Client(...)`.
   */
  client?: BunS3ClientLike;
  bucket?: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  virtualHostedStyle?: boolean;
  prefix?: string;
}

/**
 * Native Bun `Bun.S3Client` / `Bun.s3`-backed `StorageDisk` for AWS S3,
 * Cloudflare R2, MinIO, and S3-compatible object stores with zero SigV4 JS overhead.
 */
export class BunS3Disk extends StorageDisk {
  readonly client: BunS3ClientLike;
  private readonly prefix: string;

  constructor(options: BunS3DiskOptions = {}) {
    super({ publicUrl: options.publicUrl });
    if (options.client) {
      this.client = options.client;
    } else if (
      options.bucket ||
      options.endpoint ||
      options.accessKeyId ||
      options.secretAccessKey ||
      options.region
    ) {
      this.client = new Bun.S3Client({
        ...(options.bucket ? { bucket: options.bucket } : {}),
        ...(options.region ? { region: options.region } : {}),
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        ...(options.accessKeyId ? { accessKeyId: options.accessKeyId } : {}),
        ...(options.secretAccessKey
          ? { secretAccessKey: options.secretAccessKey }
          : {}),
        ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
        ...(options.virtualHostedStyle !== undefined
          ? { virtualHostedStyle: options.virtualHostedStyle }
          : {}),
      }) as unknown as BunS3ClientLike;
    } else {
      this.client = Bun.s3 as unknown as BunS3ClientLike;
    }

    const prefix = options.prefix ?? "";
    if (prefix) {
      assertValidPrefix(prefix);
    }
    this.prefix = prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
  }

  private fullKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  protected override async writeObject(
    key: string,
    body: AsyncIterable<Buffer>,
    file: StorageObjectWrite,
  ): Promise<StorageWriteResult> {
    file.signal?.throwIfAborted();
    const data = await readAll(body);
    const full = this.fullKey(key);
    await this.client.write(full, new Uint8Array(data), {
      type: file.contentType,
    });
    let etag: string | undefined;
    try {
      const st = await this.statFull(full);
      etag = st?.etag;
    } catch {
      // Optional stat after write
    }
    return {
      key,
      size: data.byteLength,
      contentType: file.contentType,
      ...(etag !== undefined ? { etag } : {}),
    };
  }

  protected override async copyObject(
    from: string,
    to: string,
    options?: StorageSignalOptions,
  ): Promise<StorageWriteResult> {
    options?.signal?.throwIfAborted();
    const srcInfo = await this.headObject(from, options);
    const s3File = this.client.file(this.fullKey(from));
    const buf = new Uint8Array(await s3File.arrayBuffer());
    await this.client.write(this.fullKey(to), buf, {
      type: srcInfo.contentType,
    });
    return {
      key: to,
      size: buf.byteLength,
      contentType: srcInfo.contentType,
    };
  }

  protected override async deleteObjects(
    keys: string[],
    options?: StorageSignalOptions,
  ): Promise<void> {
    for (const key of keys) {
      options?.signal?.throwIfAborted();
      const full = this.fullKey(key);
      if (typeof this.client.delete === "function") {
        await this.client.delete(full);
      } else {
        await this.client.file(full).delete();
      }
    }
  }

  protected override async readObject(
    key: string,
    range: StorageRange | undefined,
    options?: StorageSignalOptions,
  ): Promise<StorageDownload> {
    options?.signal?.throwIfAborted();
    const full = this.fullKey(key);
    const exists =
      typeof this.client.exists === "function"
        ? await this.client.exists(full)
        : await this.client.file(full).exists();
    if (!exists) {
      throw new StorageFileNotFoundError(key);
    }

    const info = await this.headObject(key, options);
    const s3File = this.client.file(full);

    let resolvedRange: { start: number; end: number } | undefined;
    let targetFile = s3File;
    if (range !== undefined) {
      const start =
        "suffix" in range ? Math.max(0, info.size - range.suffix) : range.start;
      const end =
        "suffix" in range
          ? Math.max(0, info.size - 1)
          : range.end !== undefined
            ? Math.min(range.end, Math.max(0, info.size - 1))
            : Math.max(0, info.size - 1);
      resolvedRange = { start, end };
      if (typeof s3File.slice === "function") {
        targetFile = s3File.slice(start, end + 1);
      }
    }

    let body: ReadableStream<Uint8Array>;
    if (typeof targetFile.stream === "function") {
      body = targetFile.stream();
    } else {
      const buf = Buffer.from(await targetFile.arrayBuffer());
      const sliced =
        resolvedRange && typeof s3File.slice !== "function"
          ? buf.subarray(resolvedRange.start, resolvedRange.end + 1)
          : buf;
      body = bytesToReadableStream(sliced);
    }

    return {
      ...info,
      body,
      ...(resolvedRange ? { range: resolvedRange } : {}),
    };
  }

  protected override async headObject(
    key: string,
    options?: StorageSignalOptions,
  ): Promise<StorageFile> {
    options?.signal?.throwIfAborted();
    const full = this.fullKey(key);
    const exists =
      typeof this.client.exists === "function"
        ? await this.client.exists(full)
        : await this.client.file(full).exists();
    if (!exists) {
      throw new StorageFileNotFoundError(key);
    }
    const st = await this.statFull(full);
    return {
      key,
      size: st?.size ?? 0,
      contentType: st?.type ?? DEFAULT_CONTENT_TYPE,
      lastModified: st?.lastModified ?? new Date(),
      ...(st?.etag !== undefined ? { etag: st.etag } : {}),
      metadata: {},
    };
  }

  protected override async listObjects(options: {
    prefix: string;
    cursor?: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<StorageListPage> {
    options.signal?.throwIfAborted();
    if (typeof this.client.list !== "function") {
      return { entries: [] };
    }
    const res = await this.client.list({
      prefix: `${this.prefix}${options.prefix}`,
      maxKeys: options.limit,
      ...(options.cursor ? { continuationToken: options.cursor } : {}),
    });
    const entries: StorageListEntry[] = [];
    for (const item of res.contents ?? []) {
      const key =
        this.prefix && item.key.startsWith(this.prefix)
          ? item.key.slice(this.prefix.length)
          : item.key;
      const etag = item.etag ?? item.eTag;
      entries.push({
        key,
        size: item.size ?? 0,
        lastModified:
          item.lastModified instanceof Date
            ? item.lastModified
            : item.lastModified
              ? new Date(item.lastModified)
              : new Date(),
        ...(etag !== undefined ? { etag } : {}),
      });
    }
    return {
      entries,
      ...(res.isTruncated && res.nextContinuationToken
        ? { cursor: res.nextContinuationToken }
        : {}),
    };
  }

  protected override async presignGet(
    key: string,
    expiresAt: Date,
  ): Promise<string> {
    const expiresIn = Math.max(
      1,
      Math.floor((expiresAt.getTime() - Date.now()) / 1000),
    );
    const full = this.fullKey(key);
    if (typeof this.client.presign === "function") {
      return this.client.presign(full, { expiresIn, method: "GET" });
    }
    const file = this.client.file(full);
    if (typeof file.presign === "function") {
      return file.presign({ expiresIn, method: "GET" });
    }
    throw new Error("BunS3Disk client does not support presign()");
  }

  protected override async presignPut(
    key: string,
    expiresAt: Date,
    request: StorageSignedUploadRequest,
  ): Promise<StorageSignedUpload> {
    const expiresIn = Math.max(
      1,
      Math.floor((expiresAt.getTime() - Date.now()) / 1000),
    );
    const full = this.fullKey(key);
    let url: string;
    if (typeof this.client.presign === "function") {
      url = this.client.presign(full, {
        expiresIn,
        method: "PUT",
        type: request.contentType,
      });
    } else {
      const file = this.client.file(full);
      if (typeof file.presign !== "function") {
        throw new Error("BunS3Disk client does not support presign()");
      }
      url = file.presign({
        expiresIn,
        method: "PUT",
        type: request.contentType,
      });
    }
    return {
      url,
      method: "PUT",
      headers: { "Content-Type": request.contentType },
      expiresAt,
    };
  }

  private async statFull(full: string): Promise<
    | {
        size: number;
        type?: string;
        lastModified?: Date;
        etag?: string;
      }
    | undefined
  > {
    if (typeof this.client.stat === "function") {
      return await this.client.stat(full);
    }
    const file = this.client.file(full);
    if (typeof file.stat === "function") {
      return await file.stat();
    }
    return {
      size: file.size ?? 0,
      type: file.type,
    };
  }
}
