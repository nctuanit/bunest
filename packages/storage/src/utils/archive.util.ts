import { StorageError, StorageInvalidKeyError } from "../errors";
import type { StorageDisk } from "../disks/storage.disk";
import type { StorageWriteResult } from "../interfaces/storage-types";
import { assertValidKey, assertValidPrefix } from "./keys.util";

export interface TarArchiveCreateOptions {
  /** Optional compression algorithm (`"gzip"` produces `.tar.gz`). */
  readonly compress?: "gzip";
  /** Optional gzip compression level (`1`–`9`). */
  readonly level?: number;
}

export interface ArchiveDiskPrefixOptions extends TarArchiveCreateOptions {
  /** Maximum number of objects to include in the archive (default `1000`). */
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface ExtractArchiveToDiskOptions {
  /** Optional key prefix prepended to every extracted archive entry. */
  readonly prefix?: string;
  readonly signal?: AbortSignal;
}

interface BunArchiveInstance {
  bytes(): Promise<Uint8Array>;
  blob(): Promise<Blob>;
  files(): Promise<Map<string, File>>;
}

type BunArchiveCtor = new (
  input:
    | Record<string, string | Uint8Array | ArrayBuffer | Blob>
    | Uint8Array
    | ArrayBuffer
    | Blob,
  options?: { compress?: "gzip"; level?: number },
) => BunArchiveInstance;

function getBunArchiveCtor(): BunArchiveCtor {
  const ctor = (Bun as unknown as { Archive?: BunArchiveCtor }).Archive;
  if (typeof ctor !== "function") {
    throw new StorageError(
      "Bun.Archive is unavailable in the current runtime (requires Bun >= 1.4.5).",
    );
  }
  return ctor;
}

// C0 controls, DEL, and C1 controls
// eslint-disable-next-line no-control-regex
const ARCHIVE_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

function sanitizeArchiveEntryPath(rawPath: string): string {
  if (ARCHIVE_CONTROL_RE.test(rawPath)) {
    throw new StorageInvalidKeyError(
      `Unsafe archive entry path rejected: "${rawPath}"`,
    );
  }
  const normalized = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    WINDOWS_DRIVE_RE.test(normalized) ||
    normalized
      .split("/")
      .some((seg) => seg === "" || seg === ".." || seg === ".")
  ) {
    throw new StorageInvalidKeyError(
      `Unsafe archive entry path rejected: "${rawPath}"`,
    );
  }
  return normalized;
}

/**
 * Creates a `.tar` (or `.tar.gz` when `compress: "gzip"`) byte buffer from an
 * in-memory map of relative paths to contents using Bun's native `Bun.Archive`.
 */
export async function createTarArchive(
  entries: Readonly<
    Record<string, string | Uint8Array | ArrayBuffer | Blob>
  >,
  options?: TarArchiveCreateOptions,
): Promise<Uint8Array> {
  const ArchiveCtor = getBunArchiveCtor();
  const safeEntries: Record<string, string | Uint8Array | ArrayBuffer | Blob> =
    {};
  for (const [name, content] of Object.entries(entries)) {
    const safeName = sanitizeArchiveEntryPath(name);
    safeEntries[safeName] = content;
  }
  const archive = new ArchiveCtor(
    safeEntries,
    options?.compress
      ? {
          compress: options.compress,
          ...(options.level !== undefined ? { level: options.level } : {}),
        }
      : undefined,
  );
  return await archive.bytes();
}

/**
 * Extracts entries from a `.tar` or `.tar.gz` archive using Bun's native
 * `Bun.Archive`, rejecting any path-traversal (`..`, leading `/`, NUL) entries.
 */
export async function extractTarArchive(
  input: Uint8Array | ArrayBuffer | Blob,
): Promise<Map<string, File>> {
  const ArchiveCtor = getBunArchiveCtor();
  const archive = new ArchiveCtor(input);
  const rawFiles = await archive.files();
  const safe = new Map<string, File>();
  for (const [name, file] of rawFiles.entries()) {
    const clean = sanitizeArchiveEntryPath(name);
    safe.set(clean, file);
  }
  return safe;
}

/**
 * Archives all objects under `prefix` from a `StorageDisk` into a `.tar` or `.tar.gz`
 * byte buffer via `Bun.Archive`.
 */
export async function archiveDiskPrefix(
  disk: StorageDisk,
  prefix = "",
  options: ArchiveDiskPrefixOptions = {},
): Promise<Uint8Array> {
  if (prefix) {
    assertValidPrefix(prefix);
  }
  const maxObjects = options.limit ?? 1000;
  const entries: Record<string, Uint8Array> = {};
  let cursor: string | undefined;
  let collected = 0;
  const normalizedPrefix = prefix
    ? prefix.endsWith("/")
      ? prefix
      : `${prefix}/`
    : "";

  while (collected < maxObjects) {
    options.signal?.throwIfAborted();
    const page = await disk.list({
      prefix: normalizedPrefix || undefined,
      cursor,
      limit: Math.min(200, maxObjects - collected),
      signal: options.signal,
    });
    for (const item of page.entries) {
      if (collected >= maxObjects) break;
      if (normalizedPrefix && !item.key.startsWith(normalizedPrefix)) {
        continue;
      }
      const bytes = await disk.getBuffer(item.key, { signal: options.signal });
      const relKey = normalizedPrefix
        ? item.key.slice(normalizedPrefix.length)
        : item.key;
      if (relKey) {
        entries[relKey] = new Uint8Array(bytes);
        collected += 1;
      }
    }
    if (!page.cursor || page.entries.length === 0) {
      break;
    }
    cursor = page.cursor;
  }

  return createTarArchive(entries, options);
}

/**
 * Extracts a `.tar` or `.tar.gz` archive into a `StorageDisk` (optionally under
 * `options.prefix`) with strict key/path-traversal validation.
 */
export async function extractArchiveToDisk(
  disk: StorageDisk,
  archiveBytes: Uint8Array | ArrayBuffer | Blob,
  options: ExtractArchiveToDiskOptions = {},
): Promise<StorageWriteResult[]> {
  const prefix = options.prefix
    ? options.prefix.replace(/\/+$/, "") + "/"
    : "";
  if (prefix) {
    assertValidPrefix(prefix);
  }
  const files = await extractTarArchive(archiveBytes);
  const results: StorageWriteResult[] = [];

  for (const [relPath, file] of files.entries()) {
    options.signal?.throwIfAborted();
    const key = `${prefix}${relPath}`;
    assertValidKey(key);
    const bytes = await file.bytes();
    const written = await disk.put(key, bytes, {
      contentType: file.type || undefined,
      signal: options.signal,
    });
    results.push(written);
  }

  return results;
}
