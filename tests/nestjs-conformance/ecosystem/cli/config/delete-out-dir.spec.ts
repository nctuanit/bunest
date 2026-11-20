import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProject } from "../../../../../packages/cli/src";
import { describeConformance } from "../../../_helpers/index";

describeConformance(
  "deleteOutDir behavior in buildProject",
  {
    upstreamPath: "nest-cli/test/lib/compiler/helpers/delete-out-dir.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts NestJS deleteOutDirIfEnabled unit tests to Bunest's `buildProject()` deleteOutDir option and `bunest.json` `compilerOptions.deleteOutDir`.",
  },
  () => {
    let tmpDir: string;
    let projectDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "bunest-cli-conf-delout-"));
      projectDir = join(tmpDir, "app");
      mkdirSync(join(projectDir, "src"), { recursive: true });
      mkdirSync(join(projectDir, "dist"), { recursive: true });
      writeFileSync(
        join(projectDir, "src", "main.ts"),
        `export const version = 1;\n`,
        "utf8",
      );
      writeFileSync(join(projectDir, "dist", "stale.js"), "// stale\n", "utf8");
      mkdirSync(join(projectDir, "dist", "nested"), { recursive: true });
      writeFileSync(
        join(projectDir, "dist", "nested", "old.js"),
        "// old\n",
        "utf8",
      );
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should not delete anything when deleteOutDir is disabled by default", async () => {
      const res = await buildProject({ cwd: projectDir });

      expect(res.success).toBe(true);
      expect(existsSync(join(projectDir, "dist", "stale.js"))).toBe(true);
      expect(existsSync(join(projectDir, "dist", "nested", "old.js"))).toBe(
        true,
      );
      expect(existsSync(join(projectDir, "dist", "main.js"))).toBe(true);
    });

    it("should not delete anything when deleteOutDir is explicitly false in bunest.json", async () => {
      writeFileSync(
        join(projectDir, "bunest.json"),
        JSON.stringify({ compilerOptions: { deleteOutDir: false } }),
        "utf8",
      );

      const res = await buildProject({ cwd: projectDir });

      expect(res.success).toBe(true);
      expect(existsSync(join(projectDir, "dist", "stale.js"))).toBe(true);
      expect(existsSync(join(projectDir, "dist", "main.js"))).toBe(true);
    });

    it("should delete the output directory before building when deleteOutDir is enabled via CLI option", async () => {
      const res = await buildProject({ cwd: projectDir, deleteOutDir: true });

      expect(res.success).toBe(true);
      expect(existsSync(join(projectDir, "dist", "stale.js"))).toBe(false);
      expect(existsSync(join(projectDir, "dist", "nested", "old.js"))).toBe(
        false,
      );
      expect(existsSync(join(projectDir, "dist", "main.js"))).toBe(true);
    });

    it("should delete the output directory when enabled in bunest.json compilerOptions.deleteOutDir", async () => {
      writeFileSync(
        join(projectDir, "bunest.json"),
        JSON.stringify({ compilerOptions: { deleteOutDir: true } }),
        "utf8",
      );

      const res = await buildProject({ cwd: projectDir });

      expect(res.success).toBe(true);
      expect(existsSync(join(projectDir, "dist", "stale.js"))).toBe(false);
      expect(existsSync(join(projectDir, "dist", "main.js"))).toBe(true);
    });

    it("should allow explicit CLI deleteOutDir: false to override bunest.json deleteOutDir: true", async () => {
      writeFileSync(
        join(projectDir, "bunest.json"),
        JSON.stringify({ compilerOptions: { deleteOutDir: true } }),
        "utf8",
      );

      const res = await buildProject({ cwd: projectDir, deleteOutDir: false });

      expect(res.success).toBe(true);
      expect(existsSync(join(projectDir, "dist", "stale.js"))).toBe(true);
      expect(existsSync(join(projectDir, "dist", "main.js"))).toBe(true);
    });

    it("should delete a custom outdir inside the project when deleteOutDir is enabled", async () => {
      const customOut = join(projectDir, "build", "out");
      mkdirSync(customOut, { recursive: true });
      writeFileSync(join(customOut, "legacy.js"), "// legacy\n", "utf8");

      const res = await buildProject({
        cwd: projectDir,
        outdir: "build/out",
        deleteOutDir: true,
      });

      expect(res.success).toBe(true);
      expect(existsSync(join(customOut, "legacy.js"))).toBe(false);
      expect(existsSync(join(customOut, "main.js"))).toBe(true);
    });

    it("should succeed cleanly when deleteOutDir is enabled and outdir does not exist yet", async () => {
      rmSync(join(projectDir, "dist"), { recursive: true, force: true });

      const res = await buildProject({ cwd: projectDir, deleteOutDir: true });

      expect(res.success).toBe(true);
      expect(existsSync(join(projectDir, "dist", "main.js"))).toBe(true);
    });

    it("should not delete outdir if entry file validation fails beforehand", async () => {
      await expect(
        buildProject({
          cwd: projectDir,
          entry: "src/nonexistent.ts",
          deleteOutDir: true,
        }),
      ).rejects.toThrow(/Build entry file not found/);

      expect(existsSync(join(projectDir, "dist", "stale.js"))).toBe(true);
    });

    describe("path confinement", () => {
      // BUNEST_BUG: buildProject() calls `rm(outdir, { recursive: true, force: true })` without checking path confinement against `cwd` or honoring `compilerOptions.allowOutsidePaths` (packages/cli/src/commands/build.ts:103-105)
      it.skip("should refuse to delete an outDir outside the project by default", async () => {
        const outsideDir = join(tmpDir, "outside-dist");
        mkdirSync(outsideDir, { recursive: true });
        writeFileSync(join(outsideDir, "keep.txt"), "precious", "utf8");

        await expect(
          buildProject({
            cwd: projectDir,
            outdir: "../outside-dist",
            deleteOutDir: true,
          }),
        ).rejects.toThrow(/outside of or equal to the project directory|Unsafe/);

        expect(existsSync(join(outsideDir, "keep.txt"))).toBe(true);
      });

      // BUNEST_BUG: buildProject() does not refuse `outdir: "."` when `deleteOutDir: true`, which would wipe the project root itself (packages/cli/src/commands/build.ts:103-105)
      it.skip("should refuse to delete the project directory itself when outdir is '.'", async () => {
        await expect(
          buildProject({
            cwd: projectDir,
            outdir: ".",
            deleteOutDir: true,
          }),
        ).rejects.toThrow(/outside of or equal to the project directory|Unsafe/);

        expect(existsSync(join(projectDir, "src", "main.ts"))).toBe(true);
      });

      it("should allow deleting an outside outdir when compilerOptions.allowOutsidePaths is enabled", async () => {
        const outsideDir = join(tmpDir, "outside-dist");
        mkdirSync(outsideDir, { recursive: true });
        writeFileSync(join(outsideDir, "old.js"), "// old", "utf8");
        writeFileSync(
          join(projectDir, "bunest.json"),
          JSON.stringify({
            compilerOptions: {
              deleteOutDir: true,
              allowOutsidePaths: true,
            },
          }),
          "utf8",
        );

        const res = await buildProject({
          cwd: projectDir,
          outdir: "../outside-dist",
        });

        expect(res.success).toBe(true);
        expect(existsSync(join(outsideDir, "old.js"))).toBe(false);
        expect(existsSync(join(outsideDir, "main.js"))).toBe(true);
      });

      // BUNEST_BUG: buildProject() does not inspect tsconfig `tsBuildInfoFile` / `incremental` to delete stale buildinfo files when `deleteOutDir: true` (packages/cli/src/commands/build.ts)
      it.skip("should delete tsBuildInfoFile when deleteOutDir is enabled", async () => {
        const infoPath = join(projectDir, "tsconfig.tsbuildinfo");
        writeFileSync(infoPath, "{}", "utf8");
        writeFileSync(
          join(projectDir, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              incremental: true,
              tsBuildInfoFile: "./tsconfig.tsbuildinfo",
            },
          }),
          "utf8",
        );

        await buildProject({ cwd: projectDir, deleteOutDir: true });
        expect(existsSync(infoPath)).toBe(false);
      });
    });
  },
);
