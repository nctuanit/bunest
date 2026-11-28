import { describe, expect, it } from "bun:test";
import { ensureDir, existsSyncPath, join, removePath } from "@bunest/core";
import { buildProject, generateSchematic } from "../src";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = join(
    import.meta.dir,
    `.tmp-worker-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await ensureDir(dir);
  try {
    await fn(dir);
  } finally {
    await removePath(dir, { recursive: true, force: true });
  }
}

describe("@bunest/cli — Bun Workers generate & build integration", () => {
  it("generates a worker and spec via generateSchematic('worker' | 'w')", async () => {
    await withTempDir(async (cwd) => {
      await ensureDir(join(cwd, "src"));
      const result = await generateSchematic({
        schematic: "w",
        name: "image-resize",
        cwd,
      });

      expect(result.schematic).toBe("worker");
      expect(result.files).toHaveLength(2);
      const workerFile = result.files.find((f) =>
        f.relativePath.endsWith("image-resize.worker.ts"),
      );
      const specFile = result.files.find((f) =>
        f.relativePath.endsWith("image-resize.worker.spec.ts"),
      );
      expect(workerFile).toBeDefined();
      expect(specFile).toBeDefined();
      expect(workerFile!.content).toContain("defineWorker");
      expect(workerFile!.content).toContain("defineWorkerContract");
      expect(existsSyncPath(workerFile!.path)).toBe(true);
    });
  });

  it("auto-discovers *.worker.ts in buildProject and passes them to bun build --compile", async () => {
    await withTempDir(async (cwd) => {
      await ensureDir(join(cwd, "src", "workers"));
      await Bun.write(
        join(cwd, "src", "main.ts"),
        `export const workerUrl = new URL("./workers/hash.worker.ts", import.meta.url);\nconsole.log(workerUrl.href);\n`,
      );
      await Bun.write(
        join(cwd, "src", "workers", "hash.worker.ts"),
        `self.onmessage = (e: MessageEvent) => self.postMessage(e.data);\n`,
      );
      // Spec file must be ignored by worker auto-discovery
      await Bun.write(
        join(cwd, "src", "workers", "hash.worker.spec.ts"),
        `export const ignored = true;\n`,
      );

      // 1. Standard bundle build
      const bundleResult = await buildProject({
        cwd,
        entry: "src/main.ts",
        outdir: "dist",
        silent: true,
      });
      expect(bundleResult.success).toBe(true);
      expect(bundleResult.workerEntries).toHaveLength(1);
      expect(bundleResult.workerEntries![0]).toEndWith("hash.worker.ts");
      expect(existsSyncPath(join(cwd, "dist", "main.js"))).toBe(true);
      expect(existsSyncPath(join(cwd, "dist", "workers", "hash.worker.js"))).toBe(
        true,
      );

      // 2. Standalone --compile invocation passes main + discovered worker entries
      let capturedCmd: string[] = [];
      const compileResult = await buildProject({
        cwd,
        entry: "src/main.ts",
        outdir: "dist-bin",
        compile: true,
        silent: true,
        spawn: async (cmd) => {
          capturedCmd = cmd;
          return { exitCode: 0 };
        },
      });
      expect(compileResult.success).toBe(true);
      expect(compileResult.workerEntries).toHaveLength(1);
      expect(capturedCmd).toContain("--compile");
      expect(capturedCmd.some((arg) => arg.endsWith("src/main.ts"))).toBe(true);
      expect(
        capturedCmd.some((arg) => arg.endsWith("src/workers/hash.worker.ts")),
      ).toBe(true);
    });
  });
});
