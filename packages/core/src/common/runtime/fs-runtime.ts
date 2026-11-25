/**
 * Quarantined POSIX directory, symlink, statfs, watch, and exclusive-open FS
 * kernel adapter (2 of 2 allowed `node:*` adapter files in the entire Bunest
 * monorepo).
 *
 * File-level read/write/delete/stat/glob operations use Bun-native APIs (`Bun.file`,
 * `Bun.write`, `Bun.Glob`) directly; only OS syscalls lacking a Bun global API
 * in Bun 1.4.5 are exposed here behind structural, runtime-neutral interfaces.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  statfs,
  writeFile,
} from "node:fs/promises";

export interface FsStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly size: number;
  readonly mtimeMs: number;
  readonly mtime: Date;
  readonly birthtimeMs: number;
  readonly birthtime: Date;
  readonly mode: number;
  readonly dev: number;
  readonly ino: number;
}

export interface FsDirent {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface FsWatcher {
  close(): void;
  on(event: string, listener: (...args: any[]) => void): FsWatcher;
  off?(event: string, listener: (...args: any[]) => void): FsWatcher;
  unref?(): FsWatcher;
  ref?(): FsWatcher;
}

export interface FsStatFs {
  readonly type: number;
  readonly bsize: number;
  readonly blocks: number;
  readonly bfree: number;
  readonly bavail: number;
  readonly files: number;
  readonly ffree: number;
}

export interface FsFileHandle {
  write(data: Uint8Array | string): Promise<{ bytesWritten: number }>;
  writeFile(data: Uint8Array | string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
  stat(): Promise<FsStats>;
}

export interface FsWatchOptions {
  readonly recursive?: boolean;
  readonly persistent?: boolean;
  readonly signal?: AbortSignal;
}

export interface FsRemoveOptions {
  readonly recursive?: boolean;
  readonly force?: boolean;
}

export interface FsMkdirOptions {
  readonly recursive?: boolean;
  readonly mode?: number;
}

export function ensureDir(
  path: string,
  options: FsMkdirOptions = { recursive: true },
): Promise<string | undefined> {
  return mkdir(path, { recursive: options.recursive ?? true, mode: options.mode });
}

export function removePath(
  path: string,
  options?: FsRemoveOptions,
): Promise<void> {
  return rm(path, options);
}

export function removeEmptyDir(path: string): Promise<void> {
  return rmdir(path);
}

export async function readDirEntries(path: string): Promise<FsDirent[]> {
  return (await readdir(path, { withFileTypes: true })) as unknown as FsDirent[];
}

export function readDirNames(path: string): Promise<string[]> {
  return readdir(path);
}

export async function statPath(path: string): Promise<FsStats> {
  if (typeof Bun !== "undefined") {
    return (await Bun.file(path).stat()) as unknown as FsStats;
  }
  return statSync(path) as unknown as FsStats;
}

export async function lstatPath(path: string): Promise<FsStats> {
  return (await lstat(path)) as unknown as FsStats;
}

function normalizeRealpath(p: string): string {
  // Strip Windows extended-length drive prefix (`\\?\C:\...`) so realpathOf and realpathSyncOf
  // produce canonical paths compatible with `relative()` / `resolve()`.
  if (p.startsWith("\\\\?\\") && p.length >= 6 && p[5] === ":") {
    return p.slice(4);
  }
  return p;
}

export async function realpathOf(path: string): Promise<string> {
  return normalizeRealpath(await realpath(path));
}

export function realpathSyncOf(path: string): string {
  const fn =
    typeof realpathSync.native === "function"
      ? realpathSync.native
      : realpathSync;
  return normalizeRealpath(fn(path));
}

export function renamePath(oldPath: string, newPath: string): Promise<void> {
  return rename(oldPath, newPath);
}

export async function statFs(path: string): Promise<FsStatFs> {
  return (await statfs(path)) as unknown as FsStatFs;
}

export function watchPath(
  path: string,
  optionsOrListener?:
    | FsWatchOptions
    | ((eventType: string, filename: string | null) => void),
  listener?: (eventType: string, filename: string | null) => void,
): FsWatcher {
  if (typeof optionsOrListener === "function") {
    return watch(path, optionsOrListener) as unknown as FsWatcher;
  }
  return watch(
    path,
    optionsOrListener ?? {},
    listener,
  ) as unknown as FsWatcher;
}

export function writeExclusiveFile(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  return writeFile(path, data, { flag: "wx" });
}

export function mkdirSyncPath(
  path: string,
  options: FsMkdirOptions = { recursive: true },
): string | undefined {
  return mkdirSync(path, {
    recursive: options.recursive ?? true,
    mode: options.mode,
  });
}

export function existsSyncPath(path: string): boolean {
  return existsSync(path);
}

export function statSyncPath(path: string): FsStats {
  return statSync(path) as unknown as FsStats;
}

export function readDirSyncEntries(path: string): FsDirent[] {
  return readdirSync(path, { withFileTypes: true }) as unknown as FsDirent[];
}

export function readDirSyncNames(path: string): string[] {
  return readdirSync(path);
}

export function readTextSync(path: string): string {
  return readFileSync(path, "utf8");
}

export function writeTextSync(
  path: string,
  content: string | Uint8Array,
): void {
  writeFileSync(path, content);
}

export async function openFileHandle(
  path: string,
  flags: string | number = "r",
  mode?: number,
): Promise<FsFileHandle> {
  return (await open(path, flags, mode)) as unknown as FsFileHandle;
}
