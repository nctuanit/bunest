import {
  assertSafeStorageKey,
  toUint8Array,
  type SignedUrlOptions,
  type StorageAdapter,
  type StorageBodyInput,
  type StorageObject,
  type StoragePutOptions,
  type StorageStat,
} from "./storage.interface";

export interface S3FileLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  exists(): Promise<boolean>;
  delete(): Promise<void>;
  stat?(): Promise<{
    size: number;
    type?: string;
    lastModified?: Date;
    etag?: string;
  }>;
  presign?(options?: { expiresIn?: number; method?: string }): string;
  readonly size?: number;
  readonly type?: string;
}

/**
 * Structural S3 client contract compatible with Bun's built-in `S3Client` (`Bun.s3`)
 * and S3-compatible object stores (Cloudflare R2, MinIO, AWS S3).
 */
export interface S3ClientLike {
  file(key: string): S3FileLike;
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
  presign?(
    key: string,
    options?: { expiresIn?: number; method?: string },
  ): string;
}

export interface S3StorageAdapterOptions {
  client: S3ClientLike;
  prefix?: string;
}

export class S3StorageAdapter implements StorageAdapter {
  private readonly client: S3ClientLike;
  private readonly prefix: string;

  constructor(options: S3StorageAdapterOptions) {
    this.client = options.client;
    this.prefix = options.prefix
      ? `${assertSafeStorageKey(options.prefix)}/`
      : "";
  }

  private resolveKey(key: string): { safeKey: string; remoteKey: string } {
    const safeKey = assertSafeStorageKey(key);
    return { safeKey, remoteKey: `${this.prefix}${safeKey}` };
  }

  async put(
    key: string,
    data: StorageBodyInput,
    options?: StoragePutOptions,
  ): Promise<StorageStat> {
    const { safeKey, remoteKey } = this.resolveKey(key);
    const bytes = await toUint8Array(data);
    await this.client.write(
      remoteKey,
      bytes,
      options?.contentType ? { type: options.contentType } : undefined,
    );
    return {
      key: safeKey,
      size: bytes.byteLength,
      contentType: options?.contentType,
      lastModified: new Date(),
      metadata: options?.metadata ? { ...options.metadata } : undefined,
    };
  }

  async get(key: string): Promise<StorageObject | null> {
    const { safeKey, remoteKey } = this.resolveKey(key);
    const file = this.client.file(remoteKey);
    if (!(await file.exists())) {
      return null;
    }
    const ab = await file.arrayBuffer();
    const body = new Uint8Array(ab);
    return {
      key: safeKey,
      body,
      size: body.byteLength,
      contentType: file.type,
    };
  }

  async delete(key: string): Promise<boolean> {
    const { remoteKey } = this.resolveKey(key);
    const exists = this.client.exists
      ? await this.client.exists(remoteKey)
      : await this.client.file(remoteKey).exists();
    if (!exists) {
      return false;
    }
    if (this.client.delete) {
      await this.client.delete(remoteKey);
    } else {
      await this.client.file(remoteKey).delete();
    }
    return true;
  }

  async exists(key: string): Promise<boolean> {
    const { remoteKey } = this.resolveKey(key);
    if (this.client.exists) {
      return this.client.exists(remoteKey);
    }
    return this.client.file(remoteKey).exists();
  }

  async stat(key: string): Promise<StorageStat | null> {
    const { safeKey, remoteKey } = this.resolveKey(key);
    if (!(await this.exists(key))) {
      return null;
    }
    if (this.client.stat) {
      const s = await this.client.stat(remoteKey);
      return {
        key: safeKey,
        size: s.size,
        contentType: s.type,
        lastModified: s.lastModified,
        etag: s.etag,
      };
    }
    const file = this.client.file(remoteKey);
    if (file.stat) {
      const s = await file.stat();
      return {
        key: safeKey,
        size: s.size,
        contentType: s.type,
        lastModified: s.lastModified,
        etag: s.etag,
      };
    }
    return {
      key: safeKey,
      size: file.size ?? 0,
      contentType: file.type,
    };
  }

  async getSignedUrl(key: string, options?: SignedUrlOptions): Promise<string> {
    const { remoteKey } = this.resolveKey(key);
    const presignOpts = {
      expiresIn: options?.expiresInSeconds ?? 300,
      method: options?.method ?? "GET",
    };

    if (this.client.presign) {
      return this.client.presign(remoteKey, presignOpts);
    }
    const file = this.client.file(remoteKey);
    if (file.presign) {
      return file.presign(presignOpts);
    }
    throw new Error("Configured S3 client does not support presigned URLs");
  }
}
