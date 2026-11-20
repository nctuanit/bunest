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

interface StoredEntry {
  body: Uint8Array;
  contentType?: string;
  lastModified: Date;
  metadata?: Record<string, string>;
}

/**
 * In-memory `StorageAdapter` ideal for fast isolated unit and integration tests.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private readonly store = new Map<string, StoredEntry>();

  async put(
    key: string,
    data: StorageBodyInput,
    options?: StoragePutOptions,
  ): Promise<StorageStat> {
    const safeKey = assertSafeStorageKey(key);
    const body = await toUint8Array(data);
    const lastModified = new Date();
    const metadata = options?.metadata ? { ...options.metadata } : undefined;

    this.store.set(safeKey, {
      body,
      contentType: options?.contentType,
      lastModified,
      metadata,
    });

    return {
      key: safeKey,
      size: body.byteLength,
      contentType: options?.contentType,
      lastModified,
      metadata: metadata ? { ...metadata } : undefined,
    };
  }

  async get(key: string): Promise<StorageObject | null> {
    const safeKey = assertSafeStorageKey(key);
    const entry = this.store.get(safeKey);
    if (!entry) {
      return null;
    }
    const copy = new Uint8Array(entry.body.byteLength);
    copy.set(entry.body);
    return {
      key: safeKey,
      body: copy,
      size: copy.byteLength,
      contentType: entry.contentType,
      metadata: entry.metadata ? { ...entry.metadata } : undefined,
    };
  }

  async delete(key: string): Promise<boolean> {
    const safeKey = assertSafeStorageKey(key);
    return this.store.delete(safeKey);
  }

  async exists(key: string): Promise<boolean> {
    const safeKey = assertSafeStorageKey(key);
    return this.store.has(safeKey);
  }

  async stat(key: string): Promise<StorageStat | null> {
    const safeKey = assertSafeStorageKey(key);
    const entry = this.store.get(safeKey);
    if (!entry) {
      return null;
    }
    return {
      key: safeKey,
      size: entry.body.byteLength,
      contentType: entry.contentType,
      lastModified: entry.lastModified,
      metadata: entry.metadata ? { ...entry.metadata } : undefined,
    };
  }

  async getSignedUrl(key: string, options?: SignedUrlOptions): Promise<string> {
    const safeKey = assertSafeStorageKey(key);
    const method = options?.method ?? "GET";
    const expires = options?.expiresInSeconds ?? 300;
    return `memory://storage/${safeKey}?method=${method}&expires=${expires}`;
  }

  clear(): void {
    this.store.clear();
  }

  listKeys(): string[] {
    return [...this.store.keys()];
  }
}
