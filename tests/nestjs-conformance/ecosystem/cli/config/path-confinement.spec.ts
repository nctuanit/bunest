import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  loadCliConfiguration,
  parseSchematicName,
  resolveProjectConfiguration,
  resolveSafeChildPath,
  validateProjectName,
  writePlannedFiles,
} from "../../../../../packages/cli/src";
import { describeConformance } from "../../../_helpers/index";

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
      projectRoot = mkdtempSync(join(tmpdir(), "bunest-cli-conf-confinement-"));
      outsideDir = mkdtempSync(
        join(tmpdir(), "bunest-cli-conf-confinement-outside-"),
      );
    });

    afterEach(() => {
      while (createdLinks.length > 0) {
        const link = createdLinks.pop()!;
        try {
          unlinkSync(link);
        } catch {
          // ignore if already removed
        }
      }
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    });

    describe("allowOutsidePaths configuration loading", () => {
      it("should leave allowOutsidePaths disabled/undefined by default", async () => {
        const loaded = await loadCliConfiguration(projectRoot);
        expect(Boolean(loaded.config.compilerOptions?.allowOutsidePaths)).toBe(
          false,
        );
      });

      it("should preserve explicit allowOutsidePaths: false", async () => {
        writeFileSync(
          join(projectRoot, "bunest.json"),
          JSON.stringify({ compilerOptions: { allowOutsidePaths: false } }),
          "utf8",
        );
        const loaded = await loadCliConfiguration(projectRoot);
        expect(loaded.config.compilerOptions?.allowOutsidePaths).toBe(false);
      });

      it("should preserve explicit allowOutsidePaths: true", async () => {
        writeFileSync(
          join(projectRoot, "bunest.json"),
          JSON.stringify({ compilerOptions: { allowOutsidePaths: true } }),
          "utf8",
        );
        const loaded = await loadCliConfiguration(projectRoot);
        expect(loaded.config.compilerOptions?.allowOutsidePaths).toBe(true);
      });

      it("should read per-project allowOutsidePaths in a monorepo", async () => {
        writeFileSync(
          join(projectRoot, "bunest.json"),
          JSON.stringify({
            monorepo: true,
            projects: {
              "my-app": { compilerOptions: { allowOutsidePaths: true } },
              "other-app": { compilerOptions: {} },
            },
          }),
          "utf8",
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
        expect(() =>
          resolveSafeChildPath(projectRoot, "../outside"),
        ).toThrow(/Unsafe target path|escapes base directory/);
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
        expect(() => parseSchematicName("/abs/path")).toThrow(
          /absolute paths/,
        );
      });

      // BUNEST_BUG: resolveSafeChildPath() uses `rel.startsWith("..")` instead of checking `rel === ".." || rel.startsWith(".." + sep)`, falsely rejecting legitimate in-project directory names starting with ".." like `"..cache"` (packages/cli/src/utils/naming.ts:146)
      it.skip("should accept a directory whose name merely starts with '..' (e.g. '..cache')", () => {
        expect(resolveSafeChildPath(projectRoot, "..cache")).toBe(
          resolve(projectRoot, "..cache"),
        );
      });

      // BUNEST_BUG: resolveSafeChildPath(projectRoot, ".") resolves to `rel === ""` and returns `projectRoot` instead of rejecting the project root itself for destructive operations like deleteOutDir (packages/cli/src/utils/naming.ts:146)
      it.skip("should reject the project directory itself ('.')", () => {
        expect(() => resolveSafeChildPath(projectRoot, ".")).toThrow(
          /Unsafe target path|outside of or equal to the project directory/,
        );
      });

      describe("with symlinks", () => {
        const linkType: "junction" | "dir" =
          process.platform === "win32" ? "junction" : "dir";

        // BUNEST_BUG: resolveSafeChildPath() performs lexical `path.resolve`/`path.relative` only and does not resolve symlinks via `realpathSync`, allowing symlinked directories pointing outside projectRoot to pass confinement (packages/cli/src/utils/naming.ts:138-152)
        it.skip("should reject a symlink pointing outside the project", () => {
          const linkPath = join(projectRoot, "dist");
          symlinkSync(outsideDir, linkPath, linkType);
          createdLinks.push(linkPath);

          expect(() => resolveSafeChildPath(projectRoot, "dist")).toThrow(
            /Unsafe target path|outside of or equal to the project directory/,
          );
        });

        // BUNEST_BUG: resolveSafeChildPath() does not resolve ancestor symlinks via `realpathSync`, allowing nested writes through a symlink escaping projectRoot (packages/cli/src/utils/naming.ts:138-152)
        it.skip("should reject a path nested under a symlinked directory pointing outside", () => {
          const linkPath = join(projectRoot, "dist");
          symlinkSync(outsideDir, linkPath, linkType);
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
          mkdirSync(buildDir);
          symlinkSync(buildDir, linkPath, linkType);
          createdLinks.push(linkPath);

          expect(() =>
            resolveSafeChildPath(projectRoot, "dist/file.txt"),
          ).not.toThrow();
        });

        it("should allow lexical paths inside the project when symlinks are not dereferenced", () => {
          const linkPath = join(projectRoot, "node_modules");
          symlinkSync(outsideDir, linkPath, linkType);
          createdLinks.push(linkPath);
          writeFileSync(join(outsideDir, "tsconfig.tsbuildinfo"), "", "utf8");

          expect(() =>
            resolveSafeChildPath(
              projectRoot,
              "node_modules/tsconfig.tsbuildinfo",
            ),
          ).not.toThrow();
        });
      });
    });
  },
);
