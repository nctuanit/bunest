import { join } from "../packages/core/src/common/index";

export interface PublishableManifest {
  exports?: Record<
    string,
    string | { types?: string; bun?: string; import?: string; default?: string }
  >;
  [key: string]: unknown;
}

/**
 * Rewrites conditional `exports[*].bun` entries from raw `./src/*.ts` to the
 * pre-built `./dist/*.js` artifact (`entry.import`) for npm publishing/packing.
 *
 * Inside the monorepo, `"bun": "./src/..."` lets workspace tests run directly
 * against TypeScript sources without a prior build. Outside the monorepo (e.g.
 * `bunx @bunest/cli new my-app` in an empty directory with no `tsconfig.json`),
 * resolving raw `.ts` files in `node_modules/@bunest/*` causes Bun to transpile
 * them with TC39 Stage 3 decorators instead of legacy decorators, crashing at
 * import time. Pointing published `bun` exports at `./dist/*.js` eliminates that
 * failure while keeping `"types": "./src/..."` intact for typechecking.
 */
export function rewriteExportsForPublish<T extends PublishableManifest>(
  pkg: T,
): T {
  if (!pkg.exports || typeof pkg.exports !== "object") {
    return pkg;
  }

  const nextExports: Record<
    string,
    string | { types?: string; bun?: string; import?: string; default?: string }
  > = {};

  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof entry.bun === "string" &&
      typeof entry.import === "string"
    ) {
      nextExports[subpath] = {
        ...entry,
        bun: entry.import,
      };
    } else {
      nextExports[subpath] = entry;
    }
  }

  return {
    ...pkg,
    exports: nextExports,
  };
}

/**
 * Temporarily rewrites `<pkgDir>/package.json` with dist-backed `bun` exports
 * for the duration of `fn` (e.g. `bun publish` or `bun pm pack`), and always
 * restores the exact original `package.json` bytes afterward.
 */
export async function withPublishableManifest<R>(
  pkgDir: string,
  fn: () => Promise<R>,
): Promise<R> {
  const pkgPath = join(pkgDir, "package.json");
  const originalText = await Bun.file(pkgPath).text();
  const parsed = JSON.parse(originalText) as PublishableManifest;
  const rewritten = rewriteExportsForPublish(parsed);
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
