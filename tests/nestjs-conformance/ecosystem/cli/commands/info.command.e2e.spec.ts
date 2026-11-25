import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  join,
  mkdirSyncPath,
  removePath,
  writeTextSync,
} from "../../../../../packages/core/src";
import {
  CLI_VERSION,
  formatEnvironmentInfo,
  getEnvironmentInfo,
  runCli,
  type CliIO,
  type EnvironmentInfo,
} from "../../../../../packages/cli/src";
import { describeConformance, itAdapted } from "../../../_helpers/index";

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
  "Info Command (e2e)",
  {
    upstreamPath: "nest-cli/test/e2e/info.command.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts NestJS `nest info` system & platform inspection specs to Bunest's `getEnvironmentInfo`, `formatEnvironmentInfo`, and `runCli(['info'])`.",
  },
  () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = makeTempDir("bunest-cli-conf-info-");
    });

    afterEach(async () => {
      await removePath(tmpDir, { recursive: true, force: true });
    });

    describe("without installed dependencies", () => {
      itAdapted(
        ["ADR-001"],
        "should display system information, Bun runtime version, and Bunest CLI version",
        async () => {
          const cap = createCapturedIO(tmpDir);
          const res = await runCli(["info"], cap.io);

          expect(res.exitCode).toBe(0);
          const info = res.output as EnvironmentInfo;
          expect(info.bunestVersion).toBe(CLI_VERSION);
          expect(info.bunVersion).toBe(Bun.version);
          expect(info.cpuCores).toBeGreaterThan(0);
          expect(info.totalMemoryBytes).toBeGreaterThan(0);
          expect(info.freeMemoryBytes).toBeGreaterThanOrEqual(0);

          const output = cap.stdout.join("\n");
          expect(output).toMatch(/Bunest Environment Info/);
          expect(output).toMatch(/Bunest CLI\s*:/);
          expect(output).toMatch(/Bun\s*:/);
          expect(output).toMatch(/OS\s*:/);
          expect(output).toMatch(/CPU\s*:/);
          expect(output).toMatch(/Memory\s*:.*GiB free \/ .*GiB total/);
        },
      );

      it("formats deterministic EnvironmentInfo payloads cleanly", () => {
        const snapshot = getEnvironmentInfo();
        const formatted = formatEnvironmentInfo({
          ...snapshot,
          bunestVersion: "0.1.0",
          bunVersion: "1.4.3",
          bunRevision: "abcdef1234567890",
          platform: "linux",
          osRelease: "6.8.0",
          arch: "x64",
          cpuModel: "Test CPU",
          cpuCores: 8,
          totalMemoryBytes: 16 * 1024 * 1024 * 1024,
          freeMemoryBytes: 8 * 1024 * 1024 * 1024,
        });

        expect(formatted).toContain("Bunest CLI : v0.1.0");
        expect(formatted).toContain("Bun        : v1.4.3 (abcdef12)");
        expect(formatted).toContain("OS         : linux 6.8.0 (x64)");
        expect(formatted).toContain("CPU        : Test CPU (8 cores)");
        expect(formatted).toContain(
          "Memory     : 8.00 GiB free / 16.00 GiB total",
        );
      });
    });

    describe("with installed dependencies", () => {
      it("should display installed @bunest/* package versions", async () => {
        writeTextSync(
          join(tmpDir, "package.json"),
          JSON.stringify({
            name: "info-deps-app",
            dependencies: {
              "@bunest/core": "^0.1.0",
              "@bunest/validation": "^0.1.0",
            },
          }),
        );

        const cap = createCapturedIO(tmpDir);
        const res = await runCli(["info"], cap.io);
        const output = cap.stdout.join("\n");

        expect(res.exitCode).toBe(0);
        expect(output).toMatch(/common version/i);
        expect(output).toMatch(/core version/i);
      });
    });
  },
);
