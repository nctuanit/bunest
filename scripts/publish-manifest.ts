import {
  existsSyncPath,
  join,
  resolve,
} from "../packages/core/src/common/index";

export interface PublishableManifest {
  types?: string;
  exports?: Record<
    string,
    string | { types?: string; bun?: string; import?: string; default?: string }
  >;
  [key: string]: unknown;
}

/**
 * Maps a source TypeScript declaration entry (e.g. `./src/analyzer/index.ts`)
 * to its emitted `.d.ts` artifact in `dist/` (e.g. `./dist/analyzer/index.d.ts`).
 */
export function toDistDtsPath(typesPath: string): string {
  if (/^\.\/src\/.+\.tsx?$/.test(typesPath)) {
    return typesPath.replace(/^\.\/src\//, "./dist/").replace(/\.tsx?$/, ".d.ts");
  }
  return typesPath;
}

function resolvePublishTypesPath(typesPath: string, pkgDir?: string): string {
  const candidate = toDistDtsPath(typesPath);
  if (candidate === typesPath) {
    return typesPath;
  }
  if (pkgDir && !existsSyncPath(resolve(pkgDir, candidate))) {
    return typesPath;
  }
  return candidate;
}

/**
 * Rewrites conditional `exports[*].bun` entries from raw `./src/*.ts` to the
 * pre-built `./dist/*.js` artifact (`entry.import`) and `exports[*].types`
 * (plus top-level `types`) to emitted `./dist/<path>.d.ts` declarations for npm
 * publishing/packing.
 *
 * Inside the monorepo, `"bun": "./src/..."` and `"types": "./src/..."` let
 * workspace tests and typechecking run directly against TypeScript sources
 * without a prior build. Outside the monorepo, pointing published `bun` exports
 * at `./dist/*.js` avoids TC39 Stage 3 decorator crashes and pointing `types`
 * at `./dist/<path>.d.ts` satisfies strict TypeScript consumers (including
 * `skipLibCheck: false` and `moduleResolution: "nodenext"`).
 *
 * When `pkgDir` is provided, a `.d.ts` rewrite is applied only when the target
 * `.d.ts` file exists on disk, falling back safely to the original `types` path
 * otherwise.
 */
export function rewriteExportsForPublish<T extends PublishableManifest>(
  pkg: T,
  pkgDir?: string,
): T {
  const nextTopTypes =
    typeof pkg.types === "string"
      ? resolvePublishTypesPath(pkg.types, pkgDir)
      : pkg.types;

  if (!pkg.exports || typeof pkg.exports !== "object") {
    return nextTopTypes !== pkg.types ? { ...pkg, types: nextTopTypes } : pkg;
  }

  const nextExports: Record<
    string,
    string | { types?: string; bun?: string; import?: string; default?: string }
  > = {};

  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    if (entry && typeof entry === "object") {
      const nextEntry = { ...entry };
      if (typeof entry.bun === "string" && typeof entry.import === "string") {
        nextEntry.bun = entry.import;
      }
      if (typeof entry.types === "string") {
        nextEntry.types = resolvePublishTypesPath(entry.types, pkgDir);
      }
      nextExports[subpath] = nextEntry;
    } else {
      nextExports[subpath] = entry;
    }
  }

  return {
    ...pkg,
    ...(typeof nextTopTypes === "string" ? { types: nextTopTypes } : {}),
    exports: nextExports,
  };
}

/**
 * Temporarily rewrites `<pkgDir>/package.json` with dist-backed `bun` and
 * `.d.ts` `types` exports for the duration of `fn` (e.g. `bun publish` or
 * `bun pm pack`), and always restores the exact original `package.json` bytes
 * afterward.
 */
export async function withPublishableManifest<R>(
  pkgDir: string,
  fn: () => Promise<R>,
): Promise<R> {
  const pkgPath = join(pkgDir, "package.json");
  const originalText = await Bun.file(pkgPath).text();
  const parsed = JSON.parse(originalText) as PublishableManifest;
  const rewritten = rewriteExportsForPublish(parsed, pkgDir);
  const lineEnding = originalText.includes("\r\n") ? "\r\n" : "\n";
  const rewrittenText =
    JSON.stringify(rewritten, null, 2).replace(/\n/g, lineEnding) + lineEnding;

  await Bun.write(pkgPath, rewrittenText);
  try {
    return await fn();
  } finally {
    await Bun.write(pkgPath, originalText);
  }
}
