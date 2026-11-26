import { describe, expect, it } from "bun:test";
import {
  ensureDir,
  join,
  readDirSyncNames,
  removePath,
  resolve,
  statSyncPath,
} from "../../packages/core/src/common/index";
import {
  rewriteExportsForPublish,
  withPublishableManifest,
  type PublishableManifest,
} from "../../scripts/publish-manifest";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

describe("publish-manifest", () => {
  it("rewrites exports[*].bun from ./src/*.ts to ./dist/*.js across all 19 packages while preserving types", async () => {
    const pkgDirs = readDirSyncNames(PACKAGES_DIR)
      .map((name) => join(PACKAGES_DIR, name))
      .filter((dir) => statSyncPath(dir).isDirectory());

    expect(pkgDirs.length).toBe(19);

    for (const dir of pkgDirs) {
      const pkg = (await Bun.file(
        join(dir, "package.json"),
      ).json()) as PublishableManifest;
      const rewritten = rewriteExportsForPublish(pkg);
      expect(rewritten.exports).toBeDefined();

      for (const [subpath, entry] of Object.entries(rewritten.exports ?? {})) {
        if (subpath === "./package.json" || typeof entry === "string") continue;
        expect(entry.bun).toBe(entry.import);
        expect(entry.bun?.startsWith("./dist/")).toBe(true);
        expect(entry.types?.startsWith("./src/")).toBe(true);
      }
    }
  });

  it("restores the exact original package.json even when the publish callback throws", async () => {
    const tmpBase = Bun.env.TMPDIR ?? Bun.env.TEMP ?? Bun.env.TMP ?? "/tmp";
    const tmpDir = join(tmpBase, `bunest-publish-manifest-${crypto.randomUUID()}`);
    await ensureDir(tmpDir);
    const pkgPath = join(tmpDir, "package.json");
    const original = JSON.stringify(
      {
        name: "@bunest/dummy",
        version: "0.1.0",
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
      expect(await Bun.file(pkgPath).text()).toBe(original);
    } finally {
      await removePath(tmpDir, { recursive: true, force: true });
    }
  });
});
