import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { GeneratedFile } from "../types";
import { resolveSafeChildPath } from "./naming";

export interface PlannedFile {
  readonly relativePath: string;
  readonly content: string;
}

export interface WriteFilesOptions {
  readonly baseDir: string;
  readonly files: readonly PlannedFile[];
  readonly dryRun?: boolean;
  readonly force?: boolean;
}

export class FileCollisionError extends Error {
  constructor(public readonly collidingPaths: readonly string[]) {
    super(
      `Refusing to overwrite existing file(s): ${collidingPaths.join(", ")}. Pass --force to overwrite.`,
    );
    this.name = "FileCollisionError";
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically checks for file collisions before writing any files.
 * Supports `--dry-run` preview mode and `--force` overwrite mode.
 */
export async function writePlannedFiles(
  options: WriteFilesOptions,
): Promise<GeneratedFile[]> {
  const { baseDir, files, dryRun = false, force = false } = options;

  const resolvedEntries = files.map((file) => ({
    ...file,
    fullPath: resolveSafeChildPath(baseDir, file.relativePath),
  }));

  const collisions: string[] = [];
  const existsMap = new Map<string, boolean>();

  for (const entry of resolvedEntries) {
    const exists = await pathExists(entry.fullPath);
    existsMap.set(entry.fullPath, exists);
    if (exists && !force) {
      collisions.push(entry.relativePath);
    }
  }

  if (collisions.length > 0) {
    throw new FileCollisionError(collisions);
  }

  const results: GeneratedFile[] = [];

  for (const entry of resolvedEntries) {
    const existed = existsMap.get(entry.fullPath) ?? false;

    if (dryRun) {
      results.push({
        path: entry.fullPath,
        relativePath: entry.relativePath,
        content: entry.content,
        action: "dry-run",
      });
      continue;
    }

    await mkdir(dirname(entry.fullPath), { recursive: true });
    await Bun.write(entry.fullPath, entry.content);

    results.push({
      path: entry.fullPath,
      relativePath: entry.relativePath,
      content: entry.content,
      action: existed ? "overwrite" : "create",
    });
  }

  return results;
}
