import { mkdir, stat as fsStat, unlink } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import {
  StoragePathTraversalException,
  assertSafeStorageKey,
  toUint8Array,
  type StorageAdapter,
  type StorageBodyInput,
  type StorageObject,
  type StoragePutOptions,
  type StorageStat,
} from "./storage.interface";

export interface LocalStorageAdapterOptions {
  rootDir: string;
}

const IS_WINDOWS = process.platform === "win32";

/**
 * Local filesystem `StorageAdapter` built on `Bun.file()` / `Bun.write()`
 * with strict two-layer path-traversal containment.
 */
export class LocalStorageAdapter implements StorageAdapter {
  private readonly rootDir: string;
  private readonly rootPrefix: string;

  constructor(options: LocalStorageAdapterOptions | string) {
    const rawRoot = typeof options === "string" ? options : options.rootDir;
    if (!rawRoot || typeof rawRoot !== "string") {
      throw new Error("LocalStorageAdapter requires a valid rootDir");
    }
    this.rootDir = resolve(rawRoot);
    const withSep = this.rootDir.endsWith(sep)
      ? this.rootDir
      : `${this.rootDir}${sep}`;
    this.rootPrefix = IS_WINDOWS ? withSep.toLowerCase() : withSep;
  }

  getRootDir(): string {
    return this.rootDir;
  }

  resolveSafePath(key: string): { safeKey: string; fullPath: string } {
    const safeKey = assertSafeStorageKey(key);
    const fullPath = resolve(this.rootDir, safeKey);
    const comparable = IS_WINDOWS ? fullPath.toLowerCase() : fullPath;

    if (!comparable.startsWith(this.rootPrefix)) {
      throw new StoragePathTraversalException(
        key,
        "Resolved path escapes storage root directory",
      );
    }

    return { safeKey, fullPath };
  }

  async put(
    key: string,
    data: StorageBodyInput,
    options?: StoragePutOptions,
  ): Promise<StorageStat> {
    const { safeKey, fullPath } = this.resolveSafePath(key);
    await mkdir(dirname(fullPath), { recursive: true });
    const bytes = await toUint8Array(data);
    await Bun.write(fullPath, bytes);

    const fileStat = await fsStat(fullPath);
    return {
      key: safeKey,
      size: fileStat.size,
      contentType: options?.contentType,
      lastModified: fileStat.mtime,
      metadata: options?.metadata ? { ...options.metadata } : undefined,
    };
  }

  async get(key: string): Promise<StorageObject | null> {
    const { safeKey, fullPath } = this.resolveSafePath(key);
    const file = Bun.file(fullPath);
    if (!(await file.exists())) {
      return null;
    }
    const ab = await file.arrayBuffer();
    const body = new Uint8Array(ab);
    return {
      key: safeKey,
      body,
      size: body.byteLength,
      contentType: file.type || undefined,
    };
  }

  async delete(key: string): Promise<boolean> {
    const { fullPath } = this.resolveSafePath(key);
    const file = Bun.file(fullPath);
    if (!(await file.exists())) {
      return false;
    }
    try {
      await unlink(fullPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    const { fullPath } = this.resolveSafePath(key);
    return Bun.file(fullPath).exists();
  }

  async stat(key: string): Promise<StorageStat | null> {
    const { safeKey, fullPath } = this.resolveSafePath(key);
    const file = Bun.file(fullPath);
    if (!(await file.exists())) {
      return null;
    }
    const info = await fsStat(fullPath);
    return {
      key: safeKey,
      size: info.size,
      contentType: file.type || undefined,
      lastModified: info.mtime,
    };
  }
}
