import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSyncPath,
  join,
  mkdirSyncPath,
  removePath,
  writeTextSync,
} from "../../../../../packages/core/src";
import { buildProject } from "../../../../../packages/cli/src";
import { describeConformance } from "../../../_helpers/index";

function makeTempDir(prefix: string): string {
  const dir = join(
    Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
    `${prefix}${crypto.randomUUID()}`,
  );
  mkdirSyncPath(dir, { recursive: true });
  return dir;
}

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
      tmpDir = makeTempDir("bunest-cli-conf-delout-");
      projectDir = join(tmpDir, "app");
      mkdirSyncPath(join(projectDir, "src"), { recursive: true });
      mkdirSyncPath(join(projectDir, "dist"), { recursive: true });
      writeTextSync(join(projectDir, "src", "main.ts"), `export const version = 1;\n`);
      writeTextSync(join(projectDir, "dist", "stale.js"), "// stale\n");
      mkdirSyncPath(join(projectDir, "dist", "nested"), { recursive: true });
      writeTextSync(join(projectDir, "dist", "nested", "old.js"), "// old\n");
    });

    afterEach(async () => {
      await removePath(tmpDir, { recursive: true, force: true });
    });

    it("should not delete anything when deleteOutDir is disabled by default", async () => {
      const res = await buildProject({ cwd: projectDir });

      expect(res.success).toBe(true);
      expect(existsSyncPath(join(projectDir, "dist", "stale.js"))).toBe(true);
      expect(existsSyncPath(join(projectDir, "dist", "nested", "old.js"))).toBe(
        true,
      );
      expect(existsSyncPath(join(projectDir, "dist", "main.js"))).toBe(true);
    });

    it("should not delete anything when deleteOutDir is explicitly false in bunest.json", async () => {
      writeTextSync(join(projectDir, "bunest.json"), JSON.stringify({ compilerOptions: { deleteOutDir: false } }));

      const res = await buildProject({ cwd: projectDir });

      expect(res.success).toBe(true);
      expect(existsSyncPath(join(projectDir, "dist", "stale.js"))).toBe(true);
      expect(existsSyncPath(join(projectDir, "dist", "main.js"))).toBe(true);
    });

    it("should delete the output directory before building when deleteOutDir is enabled via CLI option", async () => {
      const res = await buildProject({ cwd: projectDir, deleteOutDir: true });

      expect(res.success).toBe(true);
      expect(existsSyncPath(join(projectDir, "dist", "stale.js"))).toBe(false);
      expect(existsSyncPath(join(projectDir, "dist", "nested", "old.js"))).toBe(
        false,
      );
      expect(existsSyncPath(join(projectDir, "dist", "main.js"))).toBe(true);
    });

    it("should delete the output directory when enabled in bunest.json compilerOptions.deleteOutDir", async () => {
      writeTextSync(join(projectDir, "bunest.json"), JSON.stringify({ compilerOptions: { deleteOutDir: true } }));

      const res = await buildProject({ cwd: projectDir });

      expect(res.success).toBe(true);
      expect(existsSyncPath(join(projectDir, "dist", "stale.js"))).toBe(false);
      expect(existsSyncPath(join(projectDir, "dist", "main.js"))).toBe(true);
    });

    it("should allow explicit CLI deleteOutDir: false to override bunest.json deleteOutDir: true", async () => {
      writeTextSync(join(projectDir, "bunest.json"), JSON.stringify({ compilerOptions: { deleteOutDir: true } }));

      const res = await buildProject({ cwd: projectDir, deleteOutDir: false });

      expect(res.success).toBe(true);
      expect(existsSyncPath(join(projectDir, "dist", "stale.js"))).toBe(true);
      expect(existsSyncPath(join(projectDir, "dist", "main.js"))).toBe(true);
    });

    it("should delete a custom outdir inside the project when deleteOutDir is enabled", async () => {
      const customOut = join(projectDir, "build", "out");
      mkdirSyncPath(customOut, { recursive: true });
      writeTextSync(join(customOut, "legacy.js"), "// legacy\n");

      const res = await buildProject({
        cwd: projectDir,
        outdir: "build/out",
        deleteOutDir: true,
      });

      expect(res.success).toBe(true);
      expect(existsSyncPath(join(customOut, "legacy.js"))).toBe(false);
      expect(existsSyncPath(join(customOut, "main.js"))).toBe(true);
    });

    it("should succeed cleanly when deleteOutDir is enabled and outdir does not exist yet", async () => {
      await removePath(join(projectDir, "dist"), { recursive: true, force: true });

      const res = await buildProject({ cwd: projectDir, deleteOutDir: true });

      expect(res.success).toBe(true);
      expect(existsSyncPath(join(projectDir, "dist", "main.js"))).toBe(true);
    });

    it("should not delete outdir if entry file validation fails beforehand", async () => {
      await expect(
        buildProject({
          cwd: projectDir,
          entry: "src/nonexistent.ts",
          deleteOutDir: true,
        }),
      ).rejects.toThrow(/Build entry file not found/);

      expect(existsSyncPath(join(projectDir, "dist", "stale.js"))).toBe(true);
    });

    describe("path confinement", () => {
      it("should refuse to delete an outDir outside the project by default", async () => {
        const outsideDir = join(tmpDir, "outside-dist");
        mkdirSyncPath(outsideDir, { recursive: true });
        writeTextSync(join(outsideDir, "keep.txt"), "precious");

        await expect(
          buildProject({
            cwd: projectDir,
            outdir: "../outside-dist",
            deleteOutDir: true,
          }),
        ).rejects.toThrow(
          /outside of or equal to the project directory|Unsafe/,
        );

        expect(existsSyncPath(join(outsideDir, "keep.txt"))).toBe(true);
      });

      it("should refuse to delete the project directory itself when outdir is '.'", async () => {
        await expect(
          buildProject({
            cwd: projectDir,
            outdir: ".",
            deleteOutDir: true,
          }),
        ).rejects.toThrow(
          /outside of or equal to the project directory|Unsafe/,
        );

        expect(existsSyncPath(join(projectDir, "src", "main.ts"))).toBe(true);
      });

      it("should allow deleting an outside outdir when compilerOptions.allowOutsidePaths is enabled", async () => {
        const outsideDir = join(tmpDir, "outside-dist");
        mkdirSyncPath(outsideDir, { recursive: true });
        writeTextSync(join(outsideDir, "old.js"), "// old");
        writeTextSync(join(projectDir, "bunest.json"), JSON.stringify({
            compilerOptions: {
              deleteOutDir: true,
              allowOutsidePaths: true,
            },
          }));

        const res = await buildProject({
          cwd: projectDir,
          outdir: "../outside-dist",
        });

        expect(res.success).toBe(true);
        expect(existsSyncPath(join(outsideDir, "old.js"))).toBe(false);
        expect(existsSyncPath(join(outsideDir, "main.js"))).toBe(true);
      });

      it("should delete tsBuildInfoFile when deleteOutDir is enabled", async () => {
        const infoPath = join(projectDir, "tsconfig.tsbuildinfo");
        writeTextSync(infoPath, "{}");
        writeTextSync(join(projectDir, "tsconfig.json"), JSON.stringify({
            compilerOptions: {
              incremental: true,
              tsBuildInfoFile: "./tsconfig.tsbuildinfo",
            },
          }));

        await buildProject({ cwd: projectDir, deleteOutDir: true });
        expect(existsSyncPath(infoPath)).toBe(false);
      });
    });
  },
);
