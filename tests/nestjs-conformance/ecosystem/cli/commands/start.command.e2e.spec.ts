import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseCliArgs,
  runCli,
  runDevServer,
  runStartCommand,
  type CliIO,
  type SpawnFn,
  type StartCommandResult,
} from "../../../../../packages/cli/src";
import {
  createSpy,
  describeConformance,
  itAdapted,
} from "../../../_helpers/index";

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
  "Start Command (e2e)",
  {
    upstreamPath: "nest-cli/test/e2e/start.command.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts NestJS `nest start` e2e specs (CJS/ESM, --watch, --debug, --exec, --env-file, monorepo, -no- CLI path) to Bunest's native Bun runtime `runStartCommand` / `runDevServer` / `runCli`.",
  },
  () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "bunest-cli-conf-start-"));
      mkdirSync(join(tmpDir, "src"), { recursive: true });
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({ name: "start-app", type: "module" }),
        "utf8",
      );
      writeFileSync(
        join(tmpDir, "src", "main.ts"),
        `export const booted = true;\n`,
        "utf8",
      );
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    describe("CLI command & flag forwarding", () => {
      it("should start the application with default entrypoint src/main.ts", async () => {
        const cap = createCapturedIO(tmpDir);
        const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));

        const result = await runStartCommand(
          { cwd: tmpDir, spawn: spawnSpy },
          cap.io,
        );

        expect(result.exitCode).toBe(0);
        expect(result.watch).toBe(false);
        expect(result.entry).toBe(resolve(tmpDir, "src", "main.ts"));
        expect(result.command).toEqual([
          "bun",
          resolve(tmpDir, "src", "main.ts"),
        ]);
        expect(spawnSpy.calledOnce).toBe(true);
        expect(spawnSpy.firstCall?.args[0]).toEqual([
          process.execPath,
          resolve(tmpDir, "src", "main.ts"),
        ]);
        expect(cap.stdout.join("\n")).toContain("Starting Bunest application");
      });

      it("should start with --debug flag (boolean and host:port forms)", async () => {
        const spawnBool = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));
        const resBool = await runStartCommand({
          cwd: tmpDir,
          debug: true,
          spawn: spawnBool,
        });
        expect(resBool.debug).toBe(true);
        expect(spawnBool.firstCall?.args[0]).toContain("--inspect");

        const spawnHostPort = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));
        const resHostPort = await runStartCommand({
          cwd: tmpDir,
          debug: "127.0.0.1:9229",
          spawn: spawnHostPort,
        });
        expect(resHostPort.debug).toBe("127.0.0.1:9229");
        expect(spawnHostPort.firstCall?.args[0]).toContain(
          "--inspect=127.0.0.1:9229",
        );

        const parsedFlagOnly = parseCliArgs(["start", "-d"]);
        expect(parsedFlagOnly.flags.debug).toBe(true);
        const parsedWithAddr = parseCliArgs(["start", "-d", "0.0.0.0:9229"]);
        expect(parsedWithAddr.flags.debug).toBe("0.0.0.0:9229");
      });

      it("should start with --exec flag or config.exec", async () => {
        const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));
        const result = await runStartCommand({
          cwd: tmpDir,
          exec: "node",
          watch: true,
          debug: true,
          spawn: spawnSpy,
        });

        expect(result.command[0]).toBe("node");
        expect(result.command).toContain("--watch");
        expect(result.command).toContain("--inspect");
        expect(spawnSpy.firstCall?.args[0][0]).toBe("node");

        writeFileSync(
          join(tmpDir, "bunest.json"),
          JSON.stringify({ exec: "custom-runtime" }),
          "utf8",
        );
        const cfgSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));
        const cfgResult = await runStartCommand({
          cwd: tmpDir,
          spawn: cfgSpy,
        });
        expect(cfgResult.command[0]).toBe("custom-runtime");
      });

      it("should start in --watch mode with --preserveWatchOutput and --silent", async () => {
        const cap = createCapturedIO(tmpDir);
        const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));

        const result = await runStartCommand(
          {
            cwd: tmpDir,
            watch: true,
            preserveWatchOutput: true,
            silent: true,
            spawn: spawnSpy,
          },
          cap.io,
        );

        expect(result.watch).toBe(true);
        expect(cap.stdout).toHaveLength(0);
        expect(spawnSpy.firstCall?.args[0]).toContain("--watch");
        expect(
          spawnSpy.firstCall?.args[1].env?.BUNEST_PRESERVE_WATCH_OUTPUT,
        ).toBe("1");
      });

      it("should forward repeatable --env-file paths resolved against cwd", async () => {
        const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));
        const result = await runStartCommand({
          cwd: tmpDir,
          envFile: [".env", ".env.local"],
          spawn: spawnSpy,
        });

        expect(result.envFiles).toEqual([".env", ".env.local"]);
        const cmd = spawnSpy.firstCall?.args[0] ?? [];
        expect(cmd).toContain("--env-file");
        expect(cmd).toContain(resolve(tmpDir, ".env"));
        expect(cmd).toContain(resolve(tmpDir, ".env.local"));
      });

      it("should respect --entryFile, --sourceRoot, --config, and --port validation", async () => {
        mkdirSync(join(tmpDir, "server"), { recursive: true });
        writeFileSync(
          join(tmpDir, "server", "boot.ts"),
          `export const ok = 1;\n`,
          "utf8",
        );
        writeFileSync(
          join(tmpDir, "custom.json"),
          JSON.stringify({ sourceRoot: "server", entryFile: "boot" }),
          "utf8",
        );

        const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));
        const result = await runStartCommand({
          cwd: tmpDir,
          config: "custom.json",
          port: 0,
          spawn: spawnSpy,
        });

        expect(result.entry).toBe(resolve(tmpDir, "server", "boot.ts"));
        expect(spawnSpy.firstCall?.args[1].env?.PORT).toBe("0");

        await expect(
          runStartCommand({ cwd: tmpDir, port: -1, spawn: spawnSpy }),
        ).rejects.toThrow(/Invalid port/);
        await expect(
          runStartCommand({ cwd: tmpDir, port: 70000, spawn: spawnSpy }),
        ).rejects.toThrow(/Invalid port/);
        await expect(
          runStartCommand({
            cwd: tmpDir,
            entry: "src/missing.ts",
            spawn: spawnSpy,
          }),
        ).rejects.toThrow(/Start entry file not found/);
      });

      it("supports `bunest dev` via runDevServer with --watch and PORT env", async () => {
        const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));
        const res = await runDevServer({
          cwd: tmpDir,
          port: 0,
          spawn: spawnSpy,
        });

        expect(res.exitCode).toBe(0);
        expect(spawnSpy.firstCall?.args[0]).toContain("--watch");
        expect(spawnSpy.firstCall?.args[1].env?.PORT).toBe("0");
      });
    });

    describe("real Bun ESM execution & HTTP response (ephemeral port)", () => {
      itAdapted(
        ["ADR-001"],
        "should execute an ESM project with top-level await and serve HTTP on an ephemeral port",
        async () => {
          const resultFile = join(tmpDir, "probe-result.json");
          const entryPath = join(tmpDir, "src", "main.ts");
          writeFileSync(
            entryPath,
            `const greeting = await Promise.resolve("Hello World!");
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch() {
    return new Response(greeting, { status: 200 });
  },
});
try {
  const res = await fetch(\`http://127.0.0.1:\${server.port}/\`);
  const body = await res.text();
  await Bun.write(${JSON.stringify(resultFile)}, JSON.stringify({ status: res.status, body }));
} finally {
  server.stop(true);
}
`,
            "utf8",
          );

          const cap = createCapturedIO(tmpDir);
          const cliRes = await runCli(["start", "--silent"], cap.io);

          expect(cliRes.exitCode).toBe(0);
          const out = cliRes.output as StartCommandResult;
          expect(out.entry).toBe(entryPath);

          const probe = JSON.parse(readFileSync(resultFile, "utf8")) as {
            status: number;
            body: string;
          };
          expect(probe.status).toBe(200);
          expect(probe.body).toBe("Hello World!");
        },
      );

      itAdapted(
        ["ADR-001"],
        "handles project and entry paths containing '-no-' without misparsing flags",
        async () => {
          const noDir = join(tmpDir, "bunest-no-test-cli");
          mkdirSync(join(noDir, "src"), { recursive: true });
          const entryPath = join(noDir, "src", "main-no-flag.ts");
          writeFileSync(entryPath, `export const ok = true;\n`, "utf8");

          const parsed = parseCliArgs([
            "start",
            "--entry",
            "src/main-no-flag.ts",
            "--silent",
          ]);
          expect(parsed.command).toBe("start");
          expect(parsed.flags.entry).toBe("src/main-no-flag.ts");

          const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));
          const res = await runStartCommand({
            cwd: noDir,
            entry: "src/main-no-flag.ts",
            silent: true,
            spawn: spawnSpy,
          });
          expect(res.exitCode).toBe(0);
          expect(res.entry).toBe(entryPath);
        },
      );
    });

    describe("monorepo project start", () => {
      // BUNEST_BUG: `runCli(["start", "<projectName>"])` ignores positional project names and runStartCommand() never calls resolveProjectConfiguration() for monorepo sub-apps (packages/cli/src/runner.ts, packages/cli/src/commands/start.ts)
      it.skip("should start a specific sub-app by name in monorepo mode", async () => {
        mkdirSync(join(tmpDir, "apps", "worker", "src"), { recursive: true });
        writeFileSync(
          join(tmpDir, "apps", "worker", "src", "main.ts"),
          `export const worker = true;\n`,
          "utf8",
        );
        writeFileSync(
          join(tmpDir, "bunest.json"),
          JSON.stringify({
            monorepo: true,
            projects: {
              worker: {
                type: "application",
                root: "apps/worker",
                entryFile: "main",
                sourceRoot: "apps/worker/src",
              },
            },
          }),
          "utf8",
        );

        const cap = createCapturedIO(tmpDir);
        const res = await runCli(["start", "worker", "--silent"], cap.io);
        expect(res.exitCode).toBe(0);
        expect((res.output as StartCommandResult).entry).toBe(
          resolve(tmpDir, "apps", "worker", "src", "main.ts"),
        );
      });
    });
  },
);
