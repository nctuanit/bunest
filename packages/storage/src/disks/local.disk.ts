import {
  dirname,
  ensureDir,
  type FsStats,
  join,
  lstatPath,
  mkdirSyncPath,
  openFileHandle,
  readDirEntries,
  readDirNames,
  realpathOf,
  realpathSyncOf,
  relative,
  removeEmptyDir,
  removePath,
  renamePath,
  resolve,
  sep,
  statPath,
} from "@bunest/core";
import {
  StorageError,
  StorageFileNotFoundError,
  StorageInvalidKeyError,
  StorageKeyConflictError,
  StorageRangeNotSatisfiableError,
} from "../errors";
import type {
  LocalDiskOptions,
  StorageDownload,
  StorageFile,
  StorageListEntry,
  StorageListPage,
  StorageObjectWrite,
  StorageRange,
  StorageSignalOptions,
  StorageWriteResult,
} from "../interfaces/storage-types";
import { bytesToReadableStream } from "../utils/body.util";
import { contentTypeFromKey } from "../utils/content-type.util";
import { assertValidKey } from "../utils/keys.util";
import { compareKeys, decodeCursor, encodeCursor } from "./in-memory.disk";
import { resolveRange, StorageDisk } from "./storage.disk";

const INTERNAL_DIR = ".nest-storage";

interface SidecarMetadata {
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
}

function fileEtag(stats: { size: number; mtimeMs: number }): string {
  const hash = new Bun.CryptoHasher("sha256")
    .update(`${stats.size}:${Math.trunc(stats.mtimeMs)}`)
    .digest("hex")
    .slice(0, 32);
  return `"${hash}"`;
}

function hasErrCode(err: unknown, ...codes: string[]): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    codes.includes(String((err as { code?: unknown }).code))
  );
}

/**
 * Files in a local directory, using atomic temp-file writes, symlink & path-traversal
 * confinement, NTFS Alternate Data Stream (`:`) rejection, and per-version JSON sidecars.
 */
export class LocalDisk extends StorageDisk {
  readonly root: string;
  private readonly realRoot: string;
  private readonly tmpDir: string;
  private readonly metaDir: string;

  constructor(options: LocalDiskOptions) {
    super(options);
    if (!options?.root || typeof options.root !== "string") {
      throw new TypeError("LocalDisk requires a non-empty `root` directory");
    }
    this.root = resolve(options.root);
    mkdirSyncPath(this.root, { recursive: true });
    this.realRoot = realpathSyncOf(this.root);
    this.tmpDir = join(this.realRoot, INTERNAL_DIR, "tmp");
    this.metaDir = join(this.realRoot, INTERNAL_DIR, "meta");
    mkdirSyncPath(this.tmpDir, { recursive: true });
    mkdirSyncPath(this.metaDir, { recursive: true });
  }

  /** The absolute path of a key's file, for tools that need a path. */
  path(key: string): string {
    assertValidKey(key);
    this.checkKey(key);
    return this.pathOf(key);
  }

  protected override async writeObject(
    key: string,
    body: AsyncIterable<Buffer>,
    file: StorageObjectWrite,
  ): Promise<StorageWriteResult> {
    this.checkKey(key);
    await ensureDir(this.tmpDir, { recursive: true });
    const tempPath = join(this.tmpDir, `${Bun.randomUUIDv7()}.tmp`);
    const fh = await openFileHandle(tempPath, "wx");
    let size = 0;
    try {
      for await (const chunk of body) {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const slice = offset === 0 ? chunk : chunk.subarray(offset);
          const { bytesWritten } = await fh.write(slice);
          if (bytesWritten <= 0) {
            throw new StorageError("LocalDisk write made no progress");
          }
          offset += bytesWritten;
        }
        size += chunk.byteLength;
      }
      await fh.sync();
    } catch (err) {
      await fh.close().catch(() => {});
      await Bun.file(tempPath).delete().catch(() => {});
      throw err;
    }
    await fh.close();

    const sidecar: SidecarMetadata | undefined =
      file.explicitContentType ||
      file.cacheControl !== undefined ||
      file.contentDisposition !== undefined ||
      Object.keys(file.metadata).length > 0
        ? {
            ...(file.explicitContentType
              ? { contentType: file.contentType }
              : {}),
            ...(file.cacheControl !== undefined
              ? { cacheControl: file.cacheControl }
              : {}),
            ...(file.contentDisposition !== undefined
              ? { contentDisposition: file.contentDisposition }
              : {}),
            ...(Object.keys(file.metadata).length > 0
              ? { metadata: file.metadata }
              : {}),
          }
        : undefined;

    try {
      const target = this.pathOf(key);
      const stats = await this.commit(key, tempPath, target, sidecar);
      return {
        key,
        size: stats.size ?? size,
        contentType: file.contentType,
        etag: fileEtag(stats),
      };
    } catch (err) {
      await Bun.file(tempPath).delete().catch(() => {});
      throw err;
    }
  }

  protected override async copyObject(
    from: string,
    to: string,
    options?: StorageSignalOptions,
  ): Promise<StorageWriteResult> {
    this.checkKey(from);
    this.checkKey(to);
    options?.signal?.throwIfAborted();
    const srcInfo = await this.headObject(from);
    const srcPath = await this.assertSafeFilePath(from);
    await ensureDir(this.tmpDir, { recursive: true });
    const tempPath = join(this.tmpDir, `${Bun.randomUUIDv7()}.tmp`);
    try {
      await Bun.write(tempPath, Bun.file(srcPath));
      const explicitCt = srcInfo.contentType !== contentTypeFromKey(to);
      const sidecar: SidecarMetadata | undefined =
        explicitCt ||
        srcInfo.cacheControl !== undefined ||
        srcInfo.contentDisposition !== undefined ||
        Object.keys(srcInfo.metadata).length > 0
          ? {
              ...(explicitCt ? { contentType: srcInfo.contentType } : {}),
              ...(srcInfo.cacheControl !== undefined
                ? { cacheControl: srcInfo.cacheControl }
                : {}),
              ...(srcInfo.contentDisposition !== undefined
                ? { contentDisposition: srcInfo.contentDisposition }
                : {}),
              ...(Object.keys(srcInfo.metadata).length > 0
                ? { metadata: srcInfo.metadata }
                : {}),
            }
          : undefined;
      const stats = await this.commit(to, tempPath, this.pathOf(to), sidecar);
      return {
        key: to,
        size: stats.size,
        contentType: srcInfo.contentType,
        etag: fileEtag(stats),
      };
    } catch (err) {
      await Bun.file(tempPath).delete().catch(() => {});
      throw err;
    }
  }

  protected override async moveObject(
    from: string,
    to: string,
    options?: StorageSignalOptions,
  ): Promise<StorageWriteResult> {
    this.checkKey(from);
    this.checkKey(to);
    options?.signal?.throwIfAborted();
    const srcInfo = await this.headObject(from);
    const srcPath = await this.assertSafeFilePath(from);
    const target = this.pathOf(to);
    const explicitCt = srcInfo.contentType !== contentTypeFromKey(to);
    const sidecar: SidecarMetadata | undefined =
      explicitCt ||
      srcInfo.cacheControl !== undefined ||
      srcInfo.contentDisposition !== undefined ||
      Object.keys(srcInfo.metadata).length > 0
        ? {
            ...(explicitCt ? { contentType: srcInfo.contentType } : {}),
            ...(srcInfo.cacheControl !== undefined
              ? { cacheControl: srcInfo.cacheControl }
              : {}),
            ...(srcInfo.contentDisposition !== undefined
              ? { contentDisposition: srcInfo.contentDisposition }
              : {}),
            ...(Object.keys(srcInfo.metadata).length > 0
              ? { metadata: srcInfo.metadata }
              : {}),
          }
        : undefined;
    const stats = await this.commit(to, srcPath, target, sidecar);
    await removePath(this.sidecarDir(from), {
      recursive: true,
      force: true,
    }).catch(() => {});
    await this.prune(dirname(srcPath));
    return {
      key: to,
      size: stats.size,
      contentType: srcInfo.contentType,
      etag: fileEtag(stats),
    };
  }

  protected override async readObject(
    key: string,
    range: StorageRange | undefined,
  ): Promise<StorageDownload> {
    this.checkKey(key);
    const filePath = await this.assertSafeFilePath(key);
    const info = await this.headObject(key);

    if (range === undefined) {
      const body: ReadableStream<Uint8Array> =
        info.size === 0
          ? bytesToReadableStream()
          : Bun.file(filePath).stream();
      return { ...info, body };
    }

    const resolved = resolveRange(range, info.size);
    if (!resolved) {
      throw new StorageRangeNotSatisfiableError(key, info.size);
    }
    const body: ReadableStream<Uint8Array> = Bun.file(filePath)
      .slice(resolved.start, resolved.end + 1)
      .stream();
    return {
      ...info,
      body,
      range: resolved,
    };
  }

  protected override async headObject(key: string): Promise<StorageFile> {
    this.checkKey(key);
    const filePath = await this.assertSafeFilePath(key);
    let stats: FsStats;
    try {
      stats = await lstatPath(filePath);
    } catch (err) {
      if (hasErrCode(err, "ENOENT", "ENOTDIR")) {
        throw new StorageFileNotFoundError(key);
      }
      throw err;
    }
    if (stats.isSymbolicLink()) {
      throw new StorageInvalidKeyError(
        "symbolic links are not permitted inside LocalDisk root",
      );
    }
    if (stats.isDirectory()) {
      throw new StorageFileNotFoundError(key);
    }
    const sidecar = await this.readSidecar(key, stats);
    return this.describe(key, stats, sidecar);
  }

  protected override async deleteObjects(
    keys: string[],
    options?: StorageSignalOptions,
  ): Promise<void> {
    const dirsToPrune = new Set<string>();
    for (const key of keys) {
      options?.signal?.throwIfAborted();
      this.checkKey(key);
      const target = this.pathOf(key);
      try {
        const parentOk = await this.parentInside(target);
        if (!parentOk) {
          throw new StorageInvalidKeyError(
            "path escapes LocalDisk root via symbolic link",
          );
        }
        const st = await lstatPath(target);
        if (st.isSymbolicLink()) {
          throw new StorageInvalidKeyError(
            "symbolic links are not permitted inside LocalDisk root",
          );
        }
        if (st.isFile()) {
          await Bun.file(target).delete();
          dirsToPrune.add(dirname(target));
        }
      } catch (err) {
        if (!hasErrCode(err, "ENOENT", "ENOTDIR")) {
          throw err;
        }
      }
      await removePath(this.sidecarDir(key), {
        recursive: true,
        force: true,
      }).catch(() => {});
    }
    const sortedDirs = [...dirsToPrune].sort((a, b) => b.length - a.length);
    for (const dir of sortedDirs) {
      await this.prune(dir);
    }
  }

  protected override async listObjects(options: {
    prefix: string;
    cursor?: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<StorageListPage> {
    const entries: StorageListEntry[] = [];
    await this.walk(this.realRoot, "", options.prefix, entries, options.signal);
    entries.sort((a, b) => compareKeys(a.key, b.key));
    const after =
      options.cursor !== undefined ? decodeCursor(options.cursor) : undefined;
    const filtered =
      after === undefined
        ? entries
        : entries.filter((e) => compareKeys(e.key, after) > 0);
    const hasMore = filtered.length > options.limit;
    const pageEntries = hasMore ? filtered.slice(0, options.limit) : filtered;
    const last = pageEntries[pageEntries.length - 1];
    return {
      entries: pageEntries,
      ...(hasMore && last ? { cursor: encodeCursor(last.key) } : {}),
    };
  }

  private async walk(
    dirPath: string,
    relPrefix: string,
    filterPrefix: string,
    out: StorageListEntry[],
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    let dirEntries;
    try {
      dirEntries = await readDirEntries(dirPath);
    } catch (err) {
      if (hasErrCode(err, "ENOENT")) {
        return;
      }
      throw err;
    }
    for (const entry of dirEntries) {
      if (relPrefix === "" && entry.name.toLowerCase() === INTERNAL_DIR) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const key = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (
          filterPrefix &&
          !key.startsWith(filterPrefix) &&
          !filterPrefix.startsWith(`${key}/`)
        ) {
          continue;
        }
        await this.walk(fullPath, key, filterPrefix, out, signal);
      } else if (entry.isFile()) {
        if (filterPrefix && !key.startsWith(filterPrefix)) {
          continue;
        }
        try {
          const st = await lstatPath(fullPath);
          if (st.isFile()) {
            out.push({
              key,
              size: st.size,
              lastModified: st.mtime,
              etag: fileEtag(st),
            });
          }
        } catch (err) {
          if (!hasErrCode(err, "ENOENT")) {
            throw err;
          }
        }
      }
    }
  }

  private async commit(
    key: string,
    fromPath: string,
    targetPath: string,
    sidecar: SidecarMetadata | undefined,
  ): Promise<FsStats> {
    await this.ensureParent(key, targetPath);
    const srcStats = await statPath(fromPath);
    const ver = this.versionKey(srcStats);
    if (sidecar) {
      await this.writeSidecar(key, ver, sidecar);
    }
    await this.place(key, fromPath, targetPath);
    const finalStats = await lstatPath(targetPath);
    const finalVer = this.versionKey(finalStats);
    if (sidecar && finalVer !== ver) {
      await this.writeSidecar(key, finalVer, sidecar);
    }
    await this.removeStaleSidecars(key, sidecar ? finalVer : undefined);
    return finalStats;
  }

  private async writeSidecar(
    key: string,
    version: string,
    sidecar: SidecarMetadata,
  ): Promise<void> {
    const dir = this.sidecarDir(key);
    await ensureDir(dir, { recursive: true });
    const tmp = join(this.tmpDir, `meta-${Bun.randomUUIDv7()}.json`);
    const dest = join(dir, `${version}.json`);
    await Bun.write(tmp, JSON.stringify(sidecar));
    await renamePath(tmp, dest);
  }

  private async removeStaleSidecars(
    key: string,
    keepVersion: string | undefined,
  ): Promise<void> {
    const dir = this.sidecarDir(key);
    let files: string[];
    try {
      files = await readDirNames(dir);
    } catch {
      return;
    }
    const keepFile = keepVersion ? `${keepVersion}.json` : undefined;
    for (const file of files) {
      if (file !== keepFile) {
        await Bun.file(join(dir, file)).delete().catch(() => {});
      }
    }
    if (!keepFile) {
      await removeEmptyDir(dir).catch(() => {});
    }
  }

  private async place(
    key: string,
    fromPath: string,
    targetPath: string,
  ): Promise<void> {
    try {
      const existing = await lstatPath(targetPath);
      if (existing.isSymbolicLink()) {
        throw new StorageInvalidKeyError(
          "cannot overwrite a symbolic link inside LocalDisk root",
        );
      }
      if (existing.isDirectory()) {
        try {
          await removeEmptyDir(targetPath);
        } catch {
          throw new StorageKeyConflictError(key);
        }
      }
    } catch (err) {
      if (err instanceof StorageError) {
        throw err;
      }
      if (!hasErrCode(err, "ENOENT")) {
        throw err;
      }
    }

    try {
      await renamePath(fromPath, targetPath);
    } catch (err) {
      if (hasErrCode(err, "EISDIR", "ENOTDIR", "EEXIST")) {
        throw new StorageKeyConflictError(key);
      }
      throw err;
    }
  }

  private async prune(startDir: string): Promise<void> {
    let current = resolve(startDir);
    while (current !== this.realRoot && this.inside(current)) {
      try {
        await removeEmptyDir(current);
      } catch {
        break;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  private checkKey(key: string): void {
    const segments = key.split("/");
    if (segments[0]?.toLowerCase() === INTERNAL_DIR) {
      throw new StorageInvalidKeyError(
        `keys under "${INTERNAL_DIR}" are reserved`,
      );
    }
    // Block Windows NTFS Alternate Data Streams and drive-letter prefixes
    for (const seg of segments) {
      if (seg.includes(":")) {
        throw new StorageInvalidKeyError(
          'a key segment cannot contain ":" on LocalDisk',
        );
      }
    }
  }

  private pathOf(key: string): string {
    return join(this.realRoot, ...key.split("/"));
  }

  private sidecarDir(key: string): string {
    const hash = new Bun.CryptoHasher("sha256").update(key).digest("hex");
    return join(this.metaDir, hash);
  }

  private versionKey(stats: {
    size: number;
    mtimeMs: number;
    ino: number;
  }): string {
    return `${stats.size}-${Math.trunc(stats.mtimeMs)}-${stats.ino}`;
  }

  private async assertSafeFilePath(key: string): Promise<string> {
    const target = this.pathOf(key);
    const parentOk = await this.parentInside(target);
    if (!parentOk) {
      throw new StorageInvalidKeyError(
        "path escapes LocalDisk root via symbolic link",
      );
    }
    let st: FsStats;
    try {
      st = await lstatPath(target);
    } catch (err) {
      if (hasErrCode(err, "ENOENT", "ENOTDIR")) {
        throw new StorageFileNotFoundError(key);
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new StorageInvalidKeyError(
        "symbolic links are not permitted inside LocalDisk root",
      );
    }
    return target;
  }

  private async parentInside(targetPath: string): Promise<boolean> {
    let dir = dirname(targetPath);
    while (true) {
      try {
        const resolved = await realpathOf(dir);
        return this.inside(resolved);
      } catch (err) {
        if (hasErrCode(err, "ENOENT")) {
          const parent = dirname(dir);
          if (parent === dir) {
            return false;
          }
          dir = parent;
          continue;
        }
        if (hasErrCode(err, "ENOTDIR")) {
          return true;
        }
        throw err;
      }
    }
  }

  private inside(candidate: string): boolean {
    const rel = relative(this.realRoot, candidate);
    if (rel === "") return true;
    return !rel.startsWith("..") && !rel.startsWith(sep) && !rel.includes(":");
  }

  private async ensureParent(key: string, targetPath: string): Promise<void> {
    const parentOk = await this.parentInside(targetPath);
    if (!parentOk) {
      throw new StorageInvalidKeyError(
        "path escapes LocalDisk root via symbolic link",
      );
    }
    const segments = key.split("/").slice(0, -1);
    let current = this.realRoot;
    for (const seg of segments) {
      current = join(current, seg);
      try {
        const st = await lstatPath(current);
        if (st.isSymbolicLink()) {
          throw new StorageInvalidKeyError(
            "symbolic links are not permitted inside LocalDisk root",
          );
        }
        if (!st.isDirectory()) {
          throw new StorageKeyConflictError(key);
        }
      } catch (err) {
        if (err instanceof StorageError) {
          throw err;
        }
        if (hasErrCode(err, "ENOENT")) {
          await ensureDir(current, { recursive: false });
        } else {
          throw err;
        }
      }
    }
  }

  private async readSidecar(
    key: string,
    stats: FsStats,
  ): Promise<SidecarMetadata | undefined> {
    const dir = this.sidecarDir(key);
    const exact = join(dir, `${this.versionKey(stats)}.json`);
    try {
      const text = await Bun.file(exact).text();
      return JSON.parse(text) as SidecarMetadata;
    } catch {
      // Fallback: match by size-mtime prefix if inode changed
      const prefix = `${stats.size}-${Math.trunc(stats.mtimeMs)}-`;
      try {
        const entries = await readDirNames(dir);
        const match = entries.find(
          (f) => f.startsWith(prefix) && f.endsWith(".json"),
        );
        if (match) {
          const text = await Bun.file(join(dir, match)).text();
          return JSON.parse(text) as SidecarMetadata;
        }
      } catch {
        // No sidecar
      }
      return undefined;
    }
  }

  private describe(
    key: string,
    stats: FsStats,
    sidecar: SidecarMetadata | undefined,
  ): StorageFile {
    return {
      key,
      size: stats.size,
      contentType: sidecar?.contentType ?? contentTypeFromKey(key),
      lastModified: stats.mtime,
      etag: fileEtag(stats),
      ...(sidecar?.cacheControl !== undefined
        ? { cacheControl: sidecar.cacheControl }
        : {}),
      ...(sidecar?.contentDisposition !== undefined
        ? { contentDisposition: sidecar.contentDisposition }
        : {}),
      metadata: sidecar?.metadata ? { ...sidecar.metadata } : {},
    };
  }
}
