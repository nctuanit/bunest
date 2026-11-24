import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSyncPath,
  join,
  mkdirSyncPath,
  removePath,
  writeTextSync,
} from "../../../../../packages/core/src";
import {
  deployProject,
  runCli,
  type CliIO,
  type DeployProjectResult,
  type SpawnFn,
} from "../../../../../packages/cli/src";
import {
  createSpy,
  describeConformance,
  itAdapted,
} from "../../../_helpers/index";

function makeTempDir(prefix: string): string {
  const dir = join(
    Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
    `${prefix}${crypto.randomUUID()}`,
  );
  mkdirSyncPath(dir, { recursive: true });
  return dir;
}

function createCapturedIO(cwd: string): {
  io: CliIO;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      cwd,
      stdout: (msg) => stdout.push(msg),
      stderr: (msg) => stderr.push(msg),
    },
  };
}

describeConformance(
  "Deploy Command (e2e)",
  {
    upstreamPath: "nest-cli/test/e2e/deploy.command.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts NestJS `nest deploy` (@nestjs/mau pass-through) specs to Bunest's native `bunest deploy` (custom deploy command in bunest.json, standalone `--compile`, or minified production bundle).",
  },
  () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = makeTempDir("bunest-cli-conf-deploy-");
      writeTextSync(join(tmpDir, "package.json"), JSON.stringify({ name: "deploy-e2e", version: "1.0.0" }));
    });

    afterEach(async () => {
      await removePath(tmpDir, { recursive: true, force: true });
    });

    describe("when a custom deploy command is configured in bunest.json", () => {
      itAdapted(
        ["ADR-001"],
        "invokes the configured deploy command and forwards arguments verbatim",
        async () => {
          writeTextSync(join(tmpDir, "bunest.json"), JSON.stringify({
              deploy: {
                command: ["my-deploy", "deploy", "--force", "--env=production"],
              },
            }));
          const cap = createCapturedIO(tmpDir);
          const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));

          const result = await deployProject(
            { cwd: tmpDir, spawn: spawnSpy },
            cap.io,
          );

          expect(result.success).toBe(true);
          expect(result.exitCode).toBe(0);
          expect(result.dryRun).toBe(false);
          expect(result.target).toBe("custom");
          expect(result.command).toEqual([
            "my-deploy",
            "deploy",
            "--force",
            "--env=production",
          ]);
          expect(spawnSpy.calledOnce).toBe(true);
          expect(spawnSpy.firstCall?.args[0]).toEqual([
            "my-deploy",
            "deploy",
            "--force",
            "--env=production",
          ]);
        },
      );

      it("previews custom deploy command without spawning on --dry-run", async () => {
        writeTextSync(join(tmpDir, "bunest.json"), JSON.stringify({ deploy: { command: ["flyctl", "deploy"] } }));
        const cap = createCapturedIO(tmpDir);
        const res = await runCli(["deploy", "--dry-run"], cap.io);

        expect(res.exitCode).toBe(0);
        const out = res.output as DeployProjectResult;
        expect(out.dryRun).toBe(true);
        expect(out.target).toBe("custom");
        expect(out.command).toEqual(["flyctl", "deploy"]);
        expect(cap.stdout.join("\n")).toContain(
          "[dry-run] Would execute deploy command: flyctl deploy",
        );
      });

      it("propagates non-zero exit code when custom deploy hook fails", async () => {
        writeTextSync(join(tmpDir, "bunest.json"), JSON.stringify({ deploy: { command: ["failing-deploy"] } }));
        const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 42 }));
        const result = await deployProject({ cwd: tmpDir, spawn: spawnSpy });

        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(42);
      });
    });

    describe("when no custom deploy hook is configured", () => {
      itAdapted(
        ["ADR-001"],
        "exits non-zero when entrypoint is missing instead of hanging",
        async () => {
          const cap = createCapturedIO(tmpDir);
          const res = await runCli(["deploy"], cap.io);

          expect(res.exitCode).toBe(1);
          expect(cap.stderr.join("\n")).toContain("Build entry file not found");
        },
      );

      itAdapted(
        ["ADR-001"],
        "produces a minified production bundle by default and supports --compile and --dry-run",
        async () => {
          mkdirSyncPath(join(tmpDir, "src"), { recursive: true });
          writeTextSync(join(tmpDir, "src", "main.ts"), `export const deployed = true;\n`);

          const dryCap = createCapturedIO(tmpDir);
          const dryRes = await runCli(["deploy", "--compile", "-d"], dryCap.io);
          expect(dryRes.exitCode).toBe(0);
          expect((dryRes.output as DeployProjectResult).target).toBe("compile");
          expect(dryCap.stdout.join("\n")).toContain("mode=compile");

          const bundleCap = createCapturedIO(tmpDir);
          const bundleRes = await runCli(
            ["deploy", "--outdir", "release"],
            bundleCap.io,
          );
          expect(bundleRes.exitCode).toBe(0);
          expect((bundleRes.output as DeployProjectResult).target).toBe(
            "bundle",
          );
          expect(existsSyncPath(join(tmpDir, "release", "main.js"))).toBe(true);

          const compileSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));
          const compileRes = await deployProject({
            cwd: tmpDir,
            compile: true,
            spawn: compileSpy,
          });
          expect(compileRes.success).toBe(true);
          expect(compileRes.target).toBe("compile");
          expect(compileSpy.firstCall?.args[0]).toContain("--compile");
        },
      );
    });

    it("is listed in the CLI help output", async () => {
      const cap = createCapturedIO(tmpDir);
      const res = await runCli(["--help"], cap.io);

      expect(res.exitCode).toBe(0);
      expect(cap.stdout.join("\n")).toContain("deploy");
    });
  },
);
