import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  join,
  mkdirSyncPath,
  removePath,
  writeTextSync,
} from "../../../../../packages/core/src";
import {
  parseCliArgs,
  runCli,
  upgradeProject,
  type CliIO,
  type SpawnFn,
  type UpgradeProjectResult,
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
  "Upgrade Command (bunest upgrade / update)",
  {
    upstreamPath: "nest-cli/test/actions/upgrade.action.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts NestJS UpgradeAction (schematics-based upgrade) to Bunest's native bunest upgrade/update command (`upgradeProject` / `runCli`).",
  },
  () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = makeTempDir("bunest-cli-conf-upgrade-");
    });

    afterEach(async () => {
      await removePath(tmpDir, { recursive: true, force: true });
    });

    const writePackageJson = (pkg: Record<string, unknown>) => {
      writeTextSync(join(tmpDir, "package.json"), JSON.stringify(pkg, null, 2));
    };

    describe("dependency discovery & upgrade execution", () => {
      it("discovers, deduplicates, and sorts @bunest/* packages across dependencies and devDependencies", async () => {
        writePackageJson({
          name: "upgrade-demo",
          dependencies: {
            "@bunest/swagger": "^0.1.0",
            "@bunest/core": "^0.1.0",
            "reflect-metadata": "^0.2.2",
          },
          devDependencies: {
            "@bunest/testing": "^0.1.0",
            "@bunest/core": "^0.1.0",
            typescript: "^7.0.2",
          },
        });

        const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));
        const result = await upgradeProject({ cwd: tmpDir, spawn: spawnSpy });

        expect(result.upgraded).toBe(true);
        expect(result.dryRun).toBe(false);
        expect(result.exitCode).toBe(0);
        expect(result.packages).toEqual([
          "@bunest/core",
          "@bunest/swagger",
          "@bunest/testing",
        ]);
        expect(result.command).toEqual([
          "bun",
          "update",
          "@bunest/core",
          "@bunest/swagger",
          "@bunest/testing",
        ]);
        expect(spawnSpy.calledOnce).toBe(true);
        expect(spawnSpy.firstCall?.args[0]).toEqual([
          process.execPath,
          "update",
          "@bunest/core",
          "@bunest/swagger",
          "@bunest/testing",
        ]);
        expect(spawnSpy.firstCall?.args[1].cwd).toBe(tmpDir);
      });

      it("falls back to plain `bun update` when package.json is absent", async () => {
        const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));
        const result = await upgradeProject({ cwd: tmpDir, spawn: spawnSpy });

        expect(result.packages).toEqual([]);
        expect(result.upgraded).toBe(true);
        expect(result.command).toEqual(["bun", "update"]);
        expect(spawnSpy.firstCall?.args[0]).toEqual([
          process.execPath,
          "update",
        ]);
      });

      it("falls back to plain `bun update` when package.json has no @bunest/* dependencies", async () => {
        writePackageJson({
          name: "no-bunest-deps",
          dependencies: { "reflect-metadata": "^0.2.2" },
        });

        const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));
        const result = await upgradeProject({ cwd: tmpDir, spawn: spawnSpy });

        expect(result.packages).toEqual([]);
        expect(result.command).toEqual(["bun", "update"]);
        expect(spawnSpy.calledOnce).toBe(true);
      });

      it("supports both `upgrade` and `update` command aliases via runCli", async () => {
        writePackageJson({
          name: "alias-demo",
          dependencies: { "@bunest/core": "^0.1.0" },
        });

        const upgCap = createCapturedIO(tmpDir);
        const upgRes = await runCli(["upgrade", "--dry-run"], upgCap.io);
        expect(upgRes.exitCode).toBe(0);
        expect((upgRes.output as UpgradeProjectResult).packages).toEqual([
          "@bunest/core",
        ]);

        const updCap = createCapturedIO(tmpDir);
        const updRes = await runCli(["update", "-d"], updCap.io);
        expect(updRes.exitCode).toBe(0);
        expect((updRes.output as UpgradeProjectResult).packages).toEqual([
          "@bunest/core",
        ]);
      });
    });

    describe("collection selection", () => {
      it("parses --collection and -c flags for upgrade/update", () => {
        const longParsed = parseCliArgs([
          "upgrade",
          "--collection",
          "@acme/schematics",
        ]);
        expect(longParsed.command).toBe("upgrade");
        expect(longParsed.flags.collection).toBe("@acme/schematics");

        const shortParsed = parseCliArgs(["update", "-c", "@other/schematics"]);
        expect(shortParsed.command).toBe("update");
        expect(shortParsed.flags.collection).toBe("@other/schematics");
      });

      // BUNEST_BUG: UpgradeProjectOptions declares `collection?: string` and runner.ts forwards `--collection`, but upgradeProject() never reads `options.collection` or `bunest.json`/`nest-cli.json` `collection` (packages/cli/src/commands/upgrade.ts)
      it.skip("uses the collection from bunest.json when configured and prefers explicit --collection", async () => {
        writeTextSync(join(tmpDir, "bunest.json"), JSON.stringify({ collection: "@acme/schematics" }));
        const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));
        const result = await upgradeProject({
          cwd: tmpDir,
          collection: "@other/schematics",
          spawn: spawnSpy,
        });
        expect(result.command.join(" ")).toContain("@other/schematics");
      });
    });

    describe("options (--skip-install, --tag, --dry-run)", () => {
      beforeEach(() => {
        writePackageJson({
          name: "opts-demo",
          dependencies: {
            "@bunest/core": "^0.1.0",
            "@bunest/cache": "^0.1.0",
          },
        });
      });

      it("forwards --skip-install without spawning a subprocess", async () => {
        const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));
        const cap = createCapturedIO(tmpDir);
        const result = await upgradeProject(
          { cwd: tmpDir, skipInstall: true, spawn: spawnSpy },
          cap.io,
        );

        expect(spawnSpy.notCalled).toBe(true);
        expect(result.upgraded).toBe(false);
        expect(result.dryRun).toBe(false);
        expect(result.exitCode).toBe(0);
        expect(cap.stdout.join("\n")).toContain("[skip-install]");
        expect(cap.stdout.join("\n")).toContain("@bunest/cache, @bunest/core");
      });

      it("forwards --tag by switching to `bun add <pkg>@<tag>`", async () => {
        const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));
        const result = await upgradeProject({
          cwd: tmpDir,
          tag: "next",
          spawn: spawnSpy,
        });

        expect(result.upgraded).toBe(true);
        expect(result.command).toEqual([
          "bun",
          "add",
          "@bunest/cache@next",
          "@bunest/core@next",
        ]);
        expect(spawnSpy.firstCall?.args[0]).toEqual([
          process.execPath,
          "add",
          "@bunest/cache@next",
          "@bunest/core@next",
        ]);
      });

      it("forwards --tag with -t short alias in runCli --dry-run", async () => {
        const cap = createCapturedIO(tmpDir);
        const res = await runCli(["upgrade", "-d", "-t", "canary"], cap.io);

        expect(res.exitCode).toBe(0);
        const out = res.output as UpgradeProjectResult;
        expect(out.dryRun).toBe(true);
        expect(out.command).toEqual([
          "bun",
          "add",
          "@bunest/cache@canary",
          "@bunest/core@canary",
        ]);
        expect(cap.stdout.join("\n")).toContain("@bunest/core@canary");
      });

      it("forwards --dry-run without spawning or modifying files", async () => {
        const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));
        const cap = createCapturedIO(tmpDir);
        const result = await upgradeProject(
          { cwd: tmpDir, dryRun: true, spawn: spawnSpy },
          cap.io,
        );

        expect(spawnSpy.notCalled).toBe(true);
        expect(result.upgraded).toBe(false);
        expect(result.dryRun).toBe(true);
        expect(result.exitCode).toBe(0);
      });
    });

    describe("observe option", () => {
      it("parses --observe and --no-observe flags cleanly in parseCliArgs", () => {
        expect(parseCliArgs(["upgrade", "--observe"]).flags.observe).toBe(true);
        expect(parseCliArgs(["upgrade", "--no-observe"]).flags.observe).toBe(
          false,
        );
        expect(parseCliArgs(["upgrade"]).flags.observe).toBeUndefined();
      });

      // BUNEST_BUG: UpgradeProjectOptions declares `observe?: boolean` and runner.ts forwards `--observe`/`--no-observe`, but upgradeProject() ignores `options.observe` completely (packages/cli/src/commands/upgrade.ts)
      it.skip("handles --observe opt-in by including @bunest/observability in upgrade targets", async () => {
        writePackageJson({
          name: "observe-demo",
          dependencies: { "@bunest/core": "^0.1.0" },
        });
        const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));
        const result = await upgradeProject({
          cwd: tmpDir,
          observe: true,
          spawn: spawnSpy,
        });
        expect(result.command).toContain("@bunest/observability");
      });

      itAdapted(
        ["ADR-001"],
        "stays non-interactive without commercial @nestjs/observe SaaS link prompts on dry-run and skip-install",
        async () => {
          writePackageJson({
            name: "no-saas-demo",
            dependencies: {
              "@bunest/core": "^0.1.0",
              "@bunest/observability": "^0.1.0",
            },
          });

          const cap = createCapturedIO(tmpDir);
          const res = await upgradeProject(
            { cwd: tmpDir, dryRun: true },
            cap.io,
          );
          expect(res.packages).toEqual([
            "@bunest/core",
            "@bunest/observability",
          ]);
          expect(cap.stdout.join("\n")).not.toContain("@nestjs/observe");
        },
      );
    });

    describe("output", () => {
      beforeEach(() => {
        writePackageJson({
          name: "output-demo",
          dependencies: { "@bunest/core": "^0.1.0" },
        });
      });

      it("announces the upgrade before spawning and prints completion message after", async () => {
        const cap = createCapturedIO(tmpDir);
        const events: string[] = [];
        const io: CliIO = {
          cwd: tmpDir,
          stdout: (msg) => {
            events.push(`stdout:${msg}`);
            cap.stdout.push(msg);
          },
          stderr: (msg) => cap.stderr.push(msg),
        };
        const spawnSpy = createSpy<SpawnFn>(async () => {
          events.push("spawn");
          return { exitCode: 0 };
        });

        await upgradeProject({ cwd: tmpDir, spawn: spawnSpy }, io);

        expect(events[0]).toContain("Upgrading Bunest dependencies");
        expect(events[1]).toBe("spawn");
        expect(events[2]).toContain("Dependencies upgraded successfully");
      });

      it("prints the dry-run notice instead of the live upgrade progress banner", async () => {
        const cap = createCapturedIO(tmpDir);
        await upgradeProject({ cwd: tmpDir, dryRun: true }, cap.io);

        const joined = cap.stdout.join("\n");
        expect(joined).toContain("[dry-run] Would upgrade: @bunest/core");
        expect(joined).toContain("[dry-run] Command: bun update @bunest/core");
        expect(joined).not.toContain("Dependencies upgraded successfully");
      });

      it("prints '(all project dependencies)' in dry-run when no @bunest/* deps are listed", async () => {
        const emptyDir = makeTempDir("bunest-cli-conf-empty-");
        try {
          const cap = createCapturedIO(emptyDir);
          await upgradeProject({ cwd: emptyDir, dryRun: true }, cap.io);
          expect(cap.stdout.join("\n")).toContain("(all project dependencies)");
        } finally {
          await removePath(emptyDir, { recursive: true, force: true });
        }
      });
    });

    describe("failures", () => {
      it("throws a descriptive error when the package manager exits non-zero and omits success output", async () => {
        writePackageJson({
          name: "fail-demo",
          dependencies: { "@bunest/core": "^0.1.0" },
        });
        const cap = createCapturedIO(tmpDir);
        const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 2 }));

        await expect(
          upgradeProject({ cwd: tmpDir, spawn: spawnSpy }, cap.io),
        ).rejects.toThrow(/Upgrade failed.*exited with code 2/);
        expect(cap.stdout.join("\n")).not.toContain(
          "Dependencies upgraded successfully",
        );
      });

      it("rethrows non-Error spawn rejections untouched", async () => {
        const spawnSpy = createSpy<SpawnFn>(async () => {
          throw "unexpected-failure";
        });

        let caught: unknown;
        try {
          await upgradeProject({ cwd: tmpDir, spawn: spawnSpy });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBe("unexpected-failure");
      });
    });
  },
);
