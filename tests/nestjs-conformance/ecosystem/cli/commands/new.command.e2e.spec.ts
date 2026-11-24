import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSyncPath,
  join,
  mkdirSyncPath,
  readTextSync,
  removePath,
  writeTextSync,
} from "../../../../../packages/core/src";
import {
  FileCollisionError,
  createProject,
  runCli,
  type CliIO,
  type CreateProjectResult,
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
  "New Command (e2e)",
  {
    upstreamPath: "nest-cli/test/e2e/new.command.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts NestJS `nest new` e2e specs to Bunest's native TypeScript-only ESM project scaffolder (`createProject` / `runCli`).",
  },
  () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = makeTempDir("bunest-cli-conf-new-");
    });

    afterEach(async () => {
      await removePath(tmpDir, { recursive: true, force: true });
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should generate a new TypeScript Bunest project",
      async () => {
        const cap = createCapturedIO(tmpDir);
        const res = await runCli(
          ["new", "my-app", "--skip-install", "--skip-git"],
          cap.io,
        );
        expect(res.exitCode).toBe(0);
        const appPath = join(tmpDir, "my-app");

        expect(existsSyncPath(join(appPath, "package.json"))).toBe(true);
        expect(existsSyncPath(join(appPath, "tsconfig.json"))).toBe(true);
        expect(existsSyncPath(join(appPath, ".gitignore"))).toBe(true);
        expect(existsSyncPath(join(appPath, "README.md"))).toBe(true);

        expect(existsSyncPath(join(appPath, "src", "main.ts"))).toBe(true);
        expect(existsSyncPath(join(appPath, "src", "app.module.ts"))).toBe(true);
        expect(existsSyncPath(join(appPath, "src", "app.controller.ts"))).toBe(
          true,
        );
        expect(existsSyncPath(join(appPath, "src", "app.service.ts"))).toBe(true);
        expect(existsSyncPath(join(appPath, "test", "app.spec.ts"))).toBe(true);

        const pkg = JSON.parse(
          readTextSync(join(appPath, "package.json")),
        ) as {
          name: string;
          type: string;
          dependencies: Record<string, string>;
          devDependencies: Record<string, string>;
        };
        expect(pkg.name).toBe("my-app");
        expect(pkg.type).toBe("module");
        expect(pkg.dependencies["@bunest/core"]).toBeDefined();
        expect(pkg.dependencies["reflect-metadata"]).toBeUndefined();
        expect(pkg.devDependencies["@bunest/testing"]).toBeDefined();

        const tsconfig = JSON.parse(
          readTextSync(join(appPath, "tsconfig.json")),
        ) as { compilerOptions: Record<string, unknown> };
        expect(tsconfig.compilerOptions.verbatimModuleSyntax).toBe(true);
        expect(tsconfig.compilerOptions.experimentalDecorators).toBe(true);
        expect(tsconfig.compilerOptions.emitDecoratorMetadata).toBe(true);
        expect(tsconfig.compilerOptions.types).toEqual(["bun"]);
      },
    );

    it("should respect --dir flag", async () => {
      const cap = createCapturedIO(tmpDir);
      const res = await runCli(
        [
          "new",
          "my-app",
          "--skip-install",
          "--skip-git",
          "-p",
          "npm",
          "--dir",
          "custom-dir",
        ],
        cap.io,
      );
      expect(res.exitCode).toBe(0);
      const appPath = join(tmpDir, "custom-dir");

      expect(existsSyncPath(join(appPath, "package.json"))).toBe(true);
      expect(existsSyncPath(join(appPath, "src", "main.ts"))).toBe(true);
      const pkg = JSON.parse(
        readTextSync(join(appPath, "package.json")),
      ) as { name: string };
      expect(pkg.name).toBe("my-app");
    });

    it("should respect NestJS --directory flag alias", async () => {
      const cap = createCapturedIO(tmpDir);
      const res = await runCli(
        [
          "new",
          "my-app",
          "--skip-install",
          "--skip-git",
          "--directory",
          "custom-dir",
        ],
        cap.io,
      );
      expect(res.exitCode).toBe(0);
      expect(existsSyncPath(join(tmpDir, "custom-dir", "package.json"))).toBe(true);
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "always scaffolds native TypeScript ESM instead of JavaScript (--language js is not used on Bun)",
      async () => {
        const created = await createProject({
          projectName: "ts-only-app",
          cwd: tmpDir,
          skipInstall: true,
          skipGit: true,
        });
        expect(existsSyncPath(join(created.targetDir, "tsconfig.json"))).toBe(true);
        expect(existsSyncPath(join(created.targetDir, "src", "main.ts"))).toBe(
          true,
        );
        expect(existsSyncPath(join(created.targetDir, "jsconfig.json"))).toBe(
          false,
        );
      },
    );

    it("should enable strict mode with --strict and allow disabling with --no-strict", async () => {
      const strictCap = createCapturedIO(tmpDir);
      const strictRes = await runCli(
        ["new", "strict-app", "--skip-install", "--skip-git", "--strict"],
        strictCap.io,
      );
      expect(strictRes.exitCode).toBe(0);
      const strictTs = JSON.parse(
        readTextSync(join(tmpDir, "strict-app", "tsconfig.json")),
      ) as {
        compilerOptions: {
          strict: boolean;
          noUncheckedIndexedAccess: boolean;
          noImplicitOverride: boolean;
        };
      };
      expect(strictTs.compilerOptions.strict).toBe(true);
      expect(strictTs.compilerOptions.noUncheckedIndexedAccess).toBe(true);
      expect(strictTs.compilerOptions.noImplicitOverride).toBe(true);

      const looseCap = createCapturedIO(tmpDir);
      const looseRes = await runCli(
        ["new", "loose-app", "--skip-install", "--skip-git", "--no-strict"],
        looseCap.io,
      );
      expect(looseRes.exitCode).toBe(0);
      const looseTs = JSON.parse(
        readTextSync(join(tmpDir, "loose-app", "tsconfig.json")),
      ) as { compilerOptions: { strict: boolean } };
      expect(looseTs.compilerOptions.strict).toBe(false);
    });

    it("should produce dry-run output without creating files or directory", async () => {
      const cap = createCapturedIO(tmpDir);
      const res = await runCli(
        ["new", "dry-app", "--skip-install", "--skip-git", "--dry-run"],
        cap.io,
      );

      expect(res.exitCode).toBe(0);
      expect(existsSyncPath(join(tmpDir, "dry-app"))).toBe(false);
      expect(cap.stdout.join("\n")).toContain("DRY-RUN");
      expect(cap.stdout.join("\n")).toContain("[dry-run] Planned");
    });

    it("should skip git initialization with --skip-git and invoke `git init` when skipGit is false", async () => {
      const noGit = await createProject({
        projectName: "no-git-app",
        cwd: tmpDir,
        skipInstall: true,
        skipGit: true,
      });
      expect(noGit.gitInitialized).toBe(false);
      expect(existsSyncPath(join(noGit.targetDir, ".git"))).toBe(false);

      const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));
      const withGit = await createProject({
        projectName: "with-git-app",
        cwd: tmpDir,
        skipInstall: true,
        skipGit: false,
        spawn: spawnSpy,
      });
      expect(withGit.gitInitialized).toBe(true);
      expect(spawnSpy.calledOnce).toBe(true);
      expect(spawnSpy.firstCall?.args[0]).toEqual(["git", "init"]);
    });

    it("should generate bunest.json configuration file", async () => {
      const created = await createProject({
        projectName: "cfg-app",
        cwd: tmpDir,
        skipInstall: true,
        skipGit: true,
      });
      const cfgPath = join(created.targetDir, "bunest.json");
      expect(existsSyncPath(cfgPath)).toBe(true);
      const cfg = JSON.parse(readTextSync(cfgPath)) as {
        collection: string;
        sourceRoot: string;
      };
      expect(cfg.collection).toBe("@bunest/schematics");
      expect(cfg.sourceRoot).toBe("src");
    });

    it("should set standard scripts in package.json and support bun/npm/yarn/pnpm package managers", async () => {
      const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));
      const created = await createProject({
        projectName: "pm-app",
        cwd: tmpDir,
        skipInstall: false,
        skipGit: true,
        packageManager: "pnpm",
        spawn: spawnSpy,
      });

      expect(created.installed).toBe(true);
      expect(created.packageManager).toBe("pnpm");
      expect(spawnSpy.firstCall?.args[0]).toEqual(["pnpm", "install"]);

      const pkg = JSON.parse(
        readTextSync(join(created.targetDir, "package.json")),
      ) as { scripts: Record<string, string> };
      expect(pkg.scripts.build).toBeDefined();
      expect(pkg.scripts.start).toBeDefined();
      expect(pkg.scripts.test).toBeDefined();
      expect(pkg.scripts.dev).toBeDefined();
      expect(pkg.scripts.typecheck).toBeDefined();

      await expect(
        createProject({
          projectName: "bad-pm",
          cwd: tmpDir,
          packageManager: "cargo",
          skipInstall: true,
        }),
      ).rejects.toThrow(/Invalid package manager/);
    });

    describe("in a directory that already has files", () => {
      it("should generate around files the project does not include when targeting --dir .", async () => {
        writeTextSync(join(tmpDir, "SPEC.md"), "# What to build");
        mkdirSyncPath(join(tmpDir, "notes"), { recursive: true });
        writeTextSync(join(tmpDir, "notes", "todo.md"), "- ship");

        const res = await createProject({
          projectName: "existing-app",
          dir: ".",
          cwd: tmpDir,
          skipInstall: true,
          skipGit: true,
        });

        expect(res.targetDir).toBe(tmpDir);
        expect(readTextSync(join(tmpDir, "SPEC.md"))).toBe(
          "# What to build",
        );
        expect(readTextSync(join(tmpDir, "notes", "todo.md"))).toBe(
          "- ship",
        );
        expect(existsSyncPath(join(tmpDir, "package.json"))).toBe(true);
        expect(existsSyncPath(join(tmpDir, "src", "main.ts"))).toBe(true);
      });

      it("should allow scaffolding in current directory via `bunest new .`", async () => {
        const cap = createCapturedIO(tmpDir);
        const res = await runCli(
          ["new", ".", "--skip-install", "--skip-git"],
          cap.io,
        );
        expect(res.exitCode).toBe(0);
        expect(existsSyncPath(join(tmpDir, "package.json"))).toBe(true);
      });

      it("should atomically refuse to overwrite a file the project includes", async () => {
        writeTextSync(join(tmpDir, "package.json"), '{ "name": "mine" }');

        await expect(
          createProject({
            projectName: "existing-app",
            dir: ".",
            cwd: tmpDir,
            skipInstall: true,
            skipGit: true,
          }),
        ).rejects.toBeInstanceOf(FileCollisionError);

        expect(readTextSync(join(tmpDir, "package.json"))).toBe(
          '{ "name": "mine" }',
        );
        expect(existsSyncPath(join(tmpDir, "src", "main.ts"))).toBe(false);
      });
    });

    describe("without a TTY", () => {
      itAdapted(
        ["ADR-001"],
        "defaults cleanly to bun package manager and ESM without blocking on interactive prompts",
        async () => {
          const cap = createCapturedIO(tmpDir);
          const res = await runCli(
            ["new", "prompts-app", "--skip-install", "--skip-git"],
            cap.io,
          );
          expect(res.exitCode).toBe(0);
          const out = res.output as CreateProjectResult;
          expect(out.packageManager).toBe("bun");
          expect(cap.stdout.join("\n")).toContain("bun install");
          expect(cap.stdout.join("\n")).toContain("bun run dev");
        },
      );

      itAdapted(
        ["ADR-001"],
        "uses native bun:test ESM instead of CJS/Jest configs",
        async () => {
          const created = await createProject({
            projectName: "esm-test-app",
            cwd: tmpDir,
            skipInstall: true,
            skipGit: true,
          });
          const specText = readTextSync(join(created.targetDir, "test", "app.spec.ts"));
          expect(specText).toContain('from "bun:test"');
          expect(existsSyncPath(join(created.targetDir, "jest.config.ts"))).toBe(
            false,
          );
        },
      );
    });
  },
);
