/**
 * Removes stale `dist/` directories across all workspace packages before building
 * so `bun build --splitting` never accumulates old hashed chunk files in published tarballs.
 */
import {
  existsSyncPath,
  join,
  readDirSyncNames,
  removePath,
  resolve,
  statSyncPath,
} from "../packages/core/src/common/index";

const ROOT = resolve(import.meta.dir, "..");
const PACKAGES_DIR = join(ROOT, "packages");

let cleaned = 0;
for (const entry of readDirSyncNames(PACKAGES_DIR)) {
  const pkgDir = join(PACKAGES_DIR, entry);
  try {
    if (!statSyncPath(pkgDir).isDirectory()) continue;
  } catch {
    continue;
  }
  const distDir = join(pkgDir, "dist");
  if (existsSyncPath(distDir)) {
    await removePath(distDir, { recursive: true, force: true });
    cleaned++;
  }
}

console.log(`[clean-dist] Cleaned ${cleaned} package dist/ directories.`);
