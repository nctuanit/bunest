import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  join,
  mkdirSyncPath,
  removePath,
  resolve,
  writeTextSync,
} from "../../../../../packages/core/src";
import {
  loadCliConfiguration,
  parseSchematicName,
  resolveProjectConfiguration,
  resolveSafeChildPath,
  validateProjectName,
  writePlannedFiles,
} from "../../../../../packages/cli/src";
import { describeConformance } from "../../../_helpers/index";

function makeTempDir(prefix: string): string {
  const dir = join(
    Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
    `${prefix}${crypto.randomUUID()}`,
  );
  mkdirSyncPath(dir, { recursive: true });
  return dir;
}

function createSymlink(target: string, linkPath: string): void {
  const cmd =
    process.platform === "win32"
      ? ["cmd", "/c", "mklink", "/J", linkPath, target]
      : ["ln", "-s", target, linkPath];
  const res = Bun.spawnSync(cmd);
  if (res.exitCode !== 0) {
    throw new Error(`Failed to create symlink ${linkPath} -> ${target}`);
  }
}

describeConformance(
  "Path Confinement & Traversal Safety",
  {
    upstreamPath: "nest-cli/test/lib/compiler/helpers/path-confinement.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts NestJS path-confinement specs (`areOutsidePathsAllowed` / `assertPathInsideProject`) to Bunest's `resolveSafeChildPath`, `writePlannedFiles`, `parseSchematicName`, `validateProjectName`, and `allowOutsidePaths` configuration loading.",
  },
  () => {
    let projectRoot: string;
    let outsideDir: string;
    const createdLinks: string[] = [];

    beforeEach(() => {
      projectRoot = makeTempDir("bunest-cli-conf-confinement-");
      outsideDir = makeTempDir("bunest-cli-conf-confinement-outside-");
    });

    afterEach(async () => {
      while (createdLinks.length > 0) {
        const link = createdLinks.pop()!;
        try {
          await removePath(link, { force: true });
        } catch {
          // ignore if already removed
        }
      }
      await removePath(projectRoot, { recursive: true, force: true });
      await removePath(outsideDir, { recursive: true, force: true });
    });

    describe("allowOutsidePaths configuration loading", () => {
      it("should leave allowOutsidePaths disabled/undefined by default", async () => {
        const loaded = await loadCliConfiguration(projectRoot);
        expect(Boolean(loaded.config.compilerOptions?.allowOutsidePaths)).toBe(
          false,
        );
      });

      it("should preserve explicit allowOutsidePaths: false", async () => {
        writeTextSync(
          join(projectRoot, "bunest.json"),
          JSON.stringify({ compilerOptions: { allowOutsidePaths: false } }),
        );
        const loaded = await loadCliConfiguration(projectRoot);
        expect(loaded.config.compilerOptions?.allowOutsidePaths).toBe(false);
      });

      it("should preserve explicit allowOutsidePaths: true", async () => {
        writeTextSync(
          join(projectRoot, "bunest.json"),
          JSON.stringify({ compilerOptions: { allowOutsidePaths: true } }),
        );
        const loaded = await loadCliConfiguration(projectRoot);
        expect(loaded.config.compilerOptions?.allowOutsidePaths).toBe(true);
      });

      it("should read per-project allowOutsidePaths in a monorepo", async () => {
        writeTextSync(
          join(projectRoot, "bunest.json"),
          JSON.stringify({
            monorepo: true,
            projects: {
              "my-app": { compilerOptions: { allowOutsidePaths: true } },
              "other-app": { compilerOptions: {} },
            },
          }),
        );
        const loaded = await loadCliConfiguration(projectRoot);
        expect(
          resolveProjectConfiguration(loaded.config, "my-app")?.compilerOptions
            ?.allowOutsidePaths,
        ).toBe(true);
        expect(
          Boolean(
            resolveProjectConfiguration(loaded.config, "other-app")
              ?.compilerOptions?.allowOutsidePaths,
          ),
        ).toBe(false);
      });
    });

    describe("resolveSafeChildPath", () => {
      it("should accept a path inside the project", () => {
        expect(resolveSafeChildPath(projectRoot, "dist")).toBe(
          resolve(projectRoot, "dist"),
        );
      });

      it("should accept a nested path that does not exist yet", () => {
        expect(resolveSafeChildPath(projectRoot, "dist/nested/deep")).toBe(
          resolve(projectRoot, "dist/nested/deep"),
        );
      });

      it("should reject a path escaping through '..'", () => {
        expect(() => resolveSafeChildPath(projectRoot, "../outside")).toThrow(
          /Unsafe target path|escapes base directory/,
        );
      });

      it("should reject an absolute path outside the project", () => {
        expect(() => resolveSafeChildPath(projectRoot, outsideDir)).toThrow(
          /Unsafe target path|escapes base directory/,
        );
        expect(() => resolveSafeChildPath(projectRoot, "/etc")).toThrow(
          /Unsafe target path|escapes base directory/,
        );
      });

      it("should block path traversal during writePlannedFiles()", async () => {
        await expect(
          writePlannedFiles({
            baseDir: projectRoot,
            files: [{ relativePath: "../escape.ts", content: "bad" }],
          }),
        ).rejects.toThrow(/Unsafe target path|escapes base directory/);
      });

      it("should block path traversal in validateProjectName and parseSchematicName", () => {
        expect(() => validateProjectName("../escape")).toThrow(
          /traversal segments/,
        );
        expect(() => validateProjectName("a/b")).toThrow(/path separators/);
        expect(() => parseSchematicName("../escape")).toThrow(
          /path-traversal segments/,
        );
        expect(() => parseSchematicName("/abs/path")).toThrow(/absolute paths/);
      });

      it("should accept a directory whose name merely starts with '..' (e.g. '..cache')", () => {
        expect(resolveSafeChildPath(projectRoot, "..cache")).toBe(
          resolve(projectRoot, "..cache"),
        );
      });

      it("should reject the project directory itself ('.')", () => {
        expect(() => resolveSafeChildPath(projectRoot, ".")).toThrow(
          /Unsafe target path|outside of or equal to the project directory/,
        );
      });

      describe("with symlinks", () => {
        it("should reject a symlink pointing outside the project", () => {
          const linkPath = join(projectRoot, "dist");
          createSymlink(outsideDir, linkPath);
          createdLinks.push(linkPath);

          expect(() => resolveSafeChildPath(projectRoot, "dist")).toThrow(
            /Unsafe target path|outside of or equal to the project directory/,
          );
        });

        it("should reject a path nested under a symlinked directory pointing outside", () => {
          const linkPath = join(projectRoot, "dist");
          createSymlink(outsideDir, linkPath);
          createdLinks.push(linkPath);

          expect(() =>
            resolveSafeChildPath(projectRoot, "dist/nested/file.txt"),
          ).toThrow(
            /Unsafe target path|outside of or equal to the project directory/,
          );
        });

        it("should accept a symlink that stays inside the project", () => {
          const buildDir = join(projectRoot, "build");
          const linkPath = join(projectRoot, "dist");
          mkdirSyncPath(buildDir);
          createSymlink(buildDir, linkPath);
          createdLinks.push(linkPath);

          expect(() =>
            resolveSafeChildPath(projectRoot, "dist/file.txt"),
          ).not.toThrow();
        });

        it("should reject a symlinked node_modules pointing outside the project once symlinks are dereferenced", () => {
          const linkPath = join(projectRoot, "node_modules");
          createSymlink(outsideDir, linkPath);
          createdLinks.push(linkPath);
          writeTextSync(join(outsideDir, "tsconfig.tsbuildinfo"), "");

          expect(() =>
            resolveSafeChildPath(
              projectRoot,
              "node_modules/tsconfig.tsbuildinfo",
            ),
          ).toThrow(
            /Unsafe target path|outside of or equal to the project directory/,
          );
        });
      });
    });
  },
);
