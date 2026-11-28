/**
 * Utilities for inspecting and resolving assets bundled into single-file
 * executables created with `bun build --compile` (`Bun.isStandaloneExecutable`
 * and `Bun.embeddedFiles`).
 */

function normalizeAssetPath(raw: string): string | undefined {
  if (raw.includes("\0")) {
    return undefined;
  }
  const parts = raw.replace(/\\/g, "/").split("/");
  const clean: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]!;
    if (seg.length === 0 || seg === ".") {
      continue;
    }
    if (seg === "..") {
      return undefined;
    }
    clean.push(seg);
  }
  return clean.length > 0 ? clean.join("/") : undefined;
}

/**
 * Returns `true` when the current process is running as a standalone executable
 * compiled via `bun build --compile` (`Bun.isStandaloneExecutable`).
 */
export function isStandaloneExecutable(): boolean {
  if (typeof Bun === "undefined") {
    return false;
  }
  return Boolean(
    (Bun as unknown as { isStandaloneExecutable?: boolean })
      .isStandaloneExecutable,
  );
}

/**
 * Returns all `Blob` / `File` entries embedded into the current standalone
 * executable via `Bun.embeddedFiles` (empty array when not compiled).
 */
export function listEmbeddedFiles(): readonly Blob[] {
  if (typeof Bun === "undefined") {
    return [];
  }
  const files = (Bun as unknown as { embeddedFiles?: Iterable<Blob> })
    .embeddedFiles;
  if (!files) {
    return [];
  }
  return Array.isArray(files) ? files : Array.from(files);
}

/**
 * Resolves an embedded file by relative path (matching exact normalized path or
 * clean `/<relativePath>` suffix) from `Bun.embeddedFiles` (or an explicit list
 * for unit testing).
 */
export function findEmbeddedFile(
  relativePath: string,
  embeddedFiles: readonly Blob[] = listEmbeddedFiles(),
): Blob | undefined {
  const target = normalizeAssetPath(relativePath);
  if (!target || embeddedFiles.length === 0) {
    return undefined;
  }

  let suffixMatch: Blob | undefined;
  const suffixNeedle = `/${target}`;

  for (let i = 0; i < embeddedFiles.length; i++) {
    const blob = embeddedFiles[i];
    if (!blob) continue;
    const rawName = (blob as Blob & { name?: string }).name;
    if (typeof rawName !== "string" || rawName.length === 0) continue;
    const normalized = normalizeAssetPath(rawName);
    if (!normalized) continue;
    if (normalized === target) {
      return blob;
    }
    if (suffixMatch === undefined && normalized.endsWith(suffixNeedle)) {
      suffixMatch = blob;
    }
  }

  return suffixMatch;
}
