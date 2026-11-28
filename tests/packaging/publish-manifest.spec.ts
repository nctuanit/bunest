import { describe, expect, it } from "bun:test";
import {
  ensureDir,
  existsSyncPath,
  join,
  readDirSyncNames,
  removePath,
  resolve,
  statSyncPath,
} from "../../packages/core/src/common/index";
import {
  rewriteExportsForPublish,
  toDistDtsPath,
  withPublishableManifest,
  type PublishableManifest,
} from "../../scripts/publish-manifest";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

describe("publish-manifest", () => {
  it("rewrites exports[*].bun -> ./dist/*.js and exports[*].types -> ./dist/**/*.d.ts across all 19 packages and verifies .d.ts targets exist", async () => {
    const pkgDirs = readDirSyncNames(PACKAGES_DIR)
      .map((name) => join(PACKAGES_DIR, name))
      .filter((dir) => statSyncPath(dir).isDirectory())
      .sort();

    expect(pkgDirs.length).toBe(19);

    let totalSubpaths = 0;
    let totalDtsSubpaths = 0;

    for (const dir of pkgDirs) {
      const pkg = (await Bun.file(
        join(dir, "package.json"),
      ).json()) as PublishableManifest;
      const rewritten = rewriteExportsForPublish(pkg, dir);
      expect(rewritten.exports).toBeDefined();

      if (typeof rewritten.types === "string") {
        expect(rewritten.types.startsWith("./dist/")).toBe(true);
        expect(rewritten.types.endsWith(".d.ts")).toBe(true);
        const topDtsPath = resolve(dir, rewritten.types);
        expect(existsSyncPath(topDtsPath)).toBe(true);
        expect(statSyncPath(topDtsPath).size).toBeGreaterThan(0);
      }

      for (const [subpath, entry] of Object.entries(rewritten.exports ?? {})) {
        totalSubpaths++;
        if (subpath === "./package.json" || typeof entry === "string") continue;
        expect(entry.bun).toBe(entry.import);
        expect(entry.bun?.startsWith("./dist/")).toBe(true);
        expect(entry.types?.startsWith("./dist/")).toBe(true);
        expect(entry.types?.endsWith(".d.ts")).toBe(true);

        const dtsPath = resolve(dir, entry.types!);
        expect(existsSyncPath(dtsPath)).toBe(true);
        expect(statSyncPath(dtsPath).size).toBeGreaterThan(0);
        totalDtsSubpaths++;
      }
    }

    expect(totalSubpaths).toBeGreaterThanOrEqual(100);
    expect(totalDtsSubpaths).toBe(81);
  });

  it("falls back safely to original types path when pkgDir has no emitted .d.ts", async () => {
    const tmpBase = Bun.env.TMPDIR ?? Bun.env.TEMP ?? Bun.env.TMP ?? "/tmp";
    const tmpDir = join(tmpBase, `bunest-dts-fallback-${crypto.randomUUID()}`);
    await ensureDir(tmpDir);

    try {
      const manifest: PublishableManifest = {
        types: "./src/index.ts",
        exports: {
          ".": {
            types: "./src/index.ts",
            bun: "./src/index.ts",
            import: "./dist/index.js",
            default: "./dist/index.js",
          },
        },
      };

      expect(toDistDtsPath("./src/analyzer/index.ts")).toBe(
        "./dist/analyzer/index.d.ts",
      );

      // Without emitted dist/index.d.ts, pkgDir check falls back safely to ./src/index.ts
      const fallback = rewriteExportsForPublish(manifest, tmpDir);
      expect(fallback.types).toBe("./src/index.ts");
      const dotFallback = fallback.exports?.["."];
      expect(typeof dotFallback === "object" && dotFallback?.bun).toBe(
        "./dist/index.js",
      );
      expect(typeof dotFallback === "object" && dotFallback?.types).toBe(
        "./src/index.ts",
      );

      // Once dist/index.d.ts exists, rewrite points types to ./dist/index.d.ts
      await ensureDir(join(tmpDir, "dist"));
      await Bun.write(join(tmpDir, "dist", "index.d.ts"), "export {};\n");
      const withDts = rewriteExportsForPublish(manifest, tmpDir);
      expect(withDts.types).toBe("./dist/index.d.ts");
      const dotWithDts = withDts.exports?.["."];
      expect(typeof dotWithDts === "object" && dotWithDts?.types).toBe(
        "./dist/index.d.ts",
      );
    } finally {
      await removePath(tmpDir, { recursive: true, force: true });
    }
  });

  it("restores the exact original package.json even when the publish callback throws", async () => {
    const tmpBase = Bun.env.TMPDIR ?? Bun.env.TEMP ?? Bun.env.TMP ?? "/tmp";
    const tmpDir = join(tmpBase, `bunest-publish-manifest-${crypto.randomUUID()}`);
    await ensureDir(join(tmpDir, "dist"));
    await Bun.write(join(tmpDir, "dist", "index.d.ts"), "export {};\n");
    const pkgPath = join(tmpDir, "package.json");
    const original = JSON.stringify(
      {
        name: "@bunest/dummy",
        version: "0.1.0",
        types: "./src/index.ts",
        exports: {
          ".": {
            types: "./src/index.ts",
            bun: "./src/index.ts",
            import: "./dist/index.js",
            default: "./dist/index.js",
          },
        },
      },
      null,
      2,
    ) + "\n";

    try {
      await Bun.write(pkgPath, original);

      let seenDuringCallback: PublishableManifest | undefined;
      await expect(
        withPublishableManifest(tmpDir, async () => {
          seenDuringCallback = (await Bun.file(
            pkgPath,
          ).json()) as PublishableManifest;
          throw new Error("simulated publish failure");
        }),
      ).rejects.toThrow("simulated publish failure");

      const dotExport = seenDuringCallback?.exports?.["."];
      expect(typeof dotExport === "object" && dotExport?.bun).toBe(
        "./dist/index.js",
      );
      expect(typeof dotExport === "object" && dotExport?.types).toBe(
        "./dist/index.d.ts",
      );
      expect(seenDuringCallback?.types).toBe("./dist/index.d.ts");
      expect(await Bun.file(pkgPath).text()).toBe(original);
    } finally {
      await removePath(tmpDir, { recursive: true, force: true });
    }
  });
});
