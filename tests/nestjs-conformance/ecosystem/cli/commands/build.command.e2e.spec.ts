import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildProject,
  runCli,
  type BuildProjectResult,
  type CliIO,
  type SpawnFn,
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

function writeBasicProject(root: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "build-app",
        version: "0.1.0",
        type: "module",
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          lib: ["ESNext"],
          target: "ESNext",
          module: "Preserve",
          moduleResolution: "bundler",
          strict: true,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    join(root, "src", "app.service.ts"),
    `export class AppService {\n  getHello(): string {\n    return "Hello World!";\n  }\n}\n`,
    "utf8",
  );
  writeFileSync(
    join(root, "src", "app.module.ts"),
    `import { AppService } from "./app.service";\nexport class AppModule {\n  static readonly service = AppService;\n}\n`,
    "utf8",
  );
  writeFileSync(
    join(root, "src", "main.ts"),
    `import { AppModule } from "./app.module";\nexport function bootstrap(): string {\n  return new AppModule.service().getHello();\n}\n`,
    "utf8",
  );
}

describeConformance(
  "Build Command (e2e)",
  {
    upstreamPath: "nest-cli/test/e2e/build.command.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts NestJS `nest build` (tsc/SWC/webpack) e2e specs to Bunest's native `Bun.build()` / `bun build --compile` pipeline (`buildProject` / `runCli`).",
  },
  () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "bunest-cli-conf-build-"));
      writeBasicProject(tmpDir);
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    itAdapted(
      ["ADR-001"],
      "should build the project with default Bun.build() bundler into dist/main.js",
      async () => {
        const cap = createCapturedIO(tmpDir);
        const res = await runCli(["build"], cap.io);

        expect(res.exitCode).toBe(0);
        const out = res.output as BuildProjectResult;
        expect(out.success).toBe(true);
        expect(out.outputs.length).toBeGreaterThanOrEqual(1);
        expect(existsSync(join(tmpDir, "dist"))).toBe(true);
        expect(existsSync(join(tmpDir, "dist", "main.js"))).toBe(true);
        expect(cap.stdout.join("\n")).toContain("Built ");
      },
    );

    itAdapted(
      ["ADR-001"],
      "should emit loadable ES modules for a 'type': 'module' project",
      async () => {
        const res = await buildProject({ cwd: tmpDir });
        expect(res.success).toBe(true);

        const distMain = join(tmpDir, "dist", "main.js");
        const mainJs = readFileSync(distMain, "utf8");
        expect(mainJs).not.toMatch(/\bmodule\.exports\b|\brequire\(/);

        const loaded = (await import(
          `${pathToFileURL(distMain).href}?t=${Date.now()}`
        )) as { bootstrap: () => string };
        expect(typeof loaded.bootstrap).toBe("function");
        expect(loaded.bootstrap()).toBe("Hello World!");
      },
    );

    it("should invoke watch mode spawn when --watch is enabled with a spawn handler", async () => {
      const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));
      const res = await buildProject({
        cwd: tmpDir,
        watch: true,
        spawn: spawnSpy,
      });

      expect(res.success).toBe(true);
      expect(existsSync(join(tmpDir, "dist", "main.js"))).toBe(true);
      expect(spawnSpy.calledOnce).toBe(true);
      expect(spawnSpy.firstCall?.args[0]).toContain("--watch");
      expect(spawnSpy.firstCall?.args[0]).toContain("build");
    });

    it("should resolve custom --entryFile, --sourceRoot, --outdir, and bunest.json config", async () => {
      mkdirSync(join(tmpDir, "server"), { recursive: true });
      writeFileSync(
        join(tmpDir, "server", "app-entry.ts"),
        `export const customEntry = 42;\n`,
        "utf8",
      );
      writeFileSync(
        join(tmpDir, "bunest.json"),
        JSON.stringify({ sourceRoot: "server", entryFile: "app-entry" }),
        "utf8",
      );

      const cap = createCapturedIO(tmpDir);
      const res = await runCli(["build", "--outdir", "out-bundle"], cap.io);

      expect(res.exitCode).toBe(0);
      expect(existsSync(join(tmpDir, "out-bundle", "app-entry.js"))).toBe(true);
    });

    it("should support --minify, --sourcemap modes, --target, and --silent", async () => {
      const cap = createCapturedIO(tmpDir);
      const res = await runCli(
        [
          "build",
          "--minify",
          "--sourcemap",
          "external",
          "--target",
          "node",
          "--silent",
        ],
        cap.io,
      );

      expect(res.exitCode).toBe(0);
      expect(cap.stdout).toHaveLength(0);
      expect(existsSync(join(tmpDir, "dist", "main.js"))).toBe(true);
      expect(existsSync(join(tmpDir, "dist", "main.js.map"))).toBe(true);
    });

    it("should support boolean sourcemap=true (linked) and reject invalid target/sourcemap", async () => {
      const linked = await buildProject({ cwd: tmpDir, sourcemap: true });
      expect(linked.success).toBe(true);
      expect(existsSync(join(tmpDir, "dist", "main.js.map"))).toBe(true);

      await expect(
        buildProject({ cwd: tmpDir, target: "invalid" as "bun" }),
      ).rejects.toThrow(/Invalid build target/);
      await expect(
        buildProject({ cwd: tmpDir, sourcemap: "bogus" as "none" }),
      ).rejects.toThrow(/Invalid sourcemap mode/);
    });

    it("should delete stale files in dist when --deleteOutDir is enabled", async () => {
      mkdirSync(join(tmpDir, "dist"), { recursive: true });
      writeFileSync(join(tmpDir, "dist", "stale.js"), "old", "utf8");

      const res = await buildProject({ cwd: tmpDir, deleteOutDir: true });

      expect(res.success).toBe(true);
      expect(existsSync(join(tmpDir, "dist", "stale.js"))).toBe(false);
      expect(existsSync(join(tmpDir, "dist", "main.js"))).toBe(true);
    });

    it("should support standalone executable compilation via --compile", async () => {
      const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));
      const cap = createCapturedIO(tmpDir);

      const res = await buildProject(
        { cwd: tmpDir, compile: true, minify: true, spawn: spawnSpy },
        cap.io,
      );

      expect(res.success).toBe(true);
      expect(res.compiledExecutable).toBeDefined();
      expect(res.outputs[0]?.kind).toBe("executable");
      expect(spawnSpy.calledOnce).toBe(true);
      const args = spawnSpy.firstCall?.args[0] ?? [];
      expect(args).toContain("build");
      expect(args).toContain("--compile");
      expect(args).toContain("--minify");
      expect(args).toContain("--outfile");

      const failSpy = createSpy<SpawnFn>(async () => ({ exitCode: 1 }));
      const failed = await buildProject({
        cwd: tmpDir,
        compile: true,
        spawn: failSpy,
      });
      expect(failed.success).toBe(false);
      expect(failed.logs[0]).toContain("exited with code 1");
    });

    it("should report structured failure logs on syntax errors and throw when entry file is missing", async () => {
      writeFileSync(
        join(tmpDir, "src", "broken.ts"),
        `export const x = {{{;\n`,
        "utf8",
      );
      const cap = createCapturedIO(tmpDir);
      const failed = await buildProject(
        { cwd: tmpDir, entry: "src/broken.ts" },
        cap.io,
      );
      expect(failed.success).toBe(false);
      expect(failed.logs.length).toBeGreaterThan(0);
      expect(cap.stderr.join("\n")).toContain("Build failed");

      await expect(
        buildProject({ cwd: tmpDir, entry: "src/does-not-exist.ts" }),
      ).rejects.toThrow(/Build entry file not found/);
    });

    it("should resolve tsconfig 'paths' without 'baseUrl'", async () => {
      writeFileSync(
        join(tmpDir, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              paths: { "@shared/*": ["./src/shared/*"] },
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      mkdirSync(join(tmpDir, "src", "shared"), { recursive: true });
      writeFileSync(
        join(tmpDir, "src", "shared", "index.ts"),
        `export const shared = 42;\n`,
        "utf8",
      );
      writeFileSync(
        join(tmpDir, "src", "alias-consumer.ts"),
        `import { shared } from "@shared/index";\nexport const value = shared;\n`,
        "utf8",
      );

      const res = await buildProject({
        cwd: tmpDir,
        entry: "src/alias-consumer.ts",
      });
      expect(res.success).toBe(true);
      const consumerJs = join(tmpDir, "dist", "alias-consumer.js");
      expect(existsSync(consumerJs)).toBe(true);
      const mod = (await import(
        `${pathToFileURL(consumerJs).href}?t=${Date.now()}`
      )) as { value: number };
      expect(mod.value).toBe(42);
    });

    it("should not emit .d.ts declaration files without --emit-declarations", async () => {
      const res = await buildProject({ cwd: tmpDir });
      expect(res.success).toBe(true);
      expect(existsSync(join(tmpDir, "dist", "main.js"))).toBe(true);
      expect(existsSync(join(tmpDir, "dist", "main.d.ts"))).toBe(false);
    });

    // BUNEST_BUG: BuildProjectOptions declares `emitDeclarations?: boolean` and runner.ts parses `--emit-declarations`, but buildProject() never invokes declaration emission so zero .d.ts files are written (packages/cli/src/commands/build.ts)
    it.skip("should emit .d.ts declaration files with --emit-declarations", async () => {
      const res = await buildProject({ cwd: tmpDir, emitDeclarations: true });
      expect(res.success).toBe(true);
      expect(existsSync(join(tmpDir, "dist", "main.d.ts"))).toBe(true);
    });

    // BUNEST_BUG: BuildProjectOptions declares `path?: string` and runner.ts forwards `--path`, but buildProject() ignores `options.path` and never passes a custom tsconfig path to Bun.build() (packages/cli/src/commands/build.ts)
    it.skip("should build with a custom tsconfig path outside working directory using --path", async () => {
      mkdirSync(join(tmpDir, "config"), { recursive: true });
      mkdirSync(join(tmpDir, "src", "shared"), { recursive: true });
      writeFileSync(
        join(tmpDir, "config", "tsconfig.build.json"),
        JSON.stringify(
          {
            extends: "../tsconfig.json",
            compilerOptions: {
              paths: { "@custom-alias/*": ["../src/shared/*"] },
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      writeFileSync(
        join(tmpDir, "src", "shared", "val.ts"),
        `export const val = 99;\n`,
        "utf8",
      );
      writeFileSync(
        join(tmpDir, "src", "entry-ext.ts"),
        `import { val } from "@custom-alias/val";\nexport const out = val;\n`,
        "utf8",
      );

      const res = await buildProject({
        cwd: tmpDir,
        entry: "src/entry-ext.ts",
        path: "config/tsconfig.build.json",
      });
      expect(res.success).toBe(true);
      expect(existsSync(join(tmpDir, "dist", "entry-ext.js"))).toBe(true);
    });

    describe("dotfiles in a directory asset (#3522)", () => {
      // BUNEST_BUG: CompilerOptions declares `assets?: Asset[]`, but buildProject() never copies configured assets (bare directory or wildcard, including dotfiles) to outdir (packages/cli/src/commands/build.ts)
      it.skip("should copy a dotfile nested under a bare directory asset", async () => {
        mkdirSync(join(tmpDir, "src", "config", "envs"), { recursive: true });
        writeFileSync(
          join(tmpDir, "src", "config", "envs", ".development"),
          "SECRET=1",
          "utf8",
        );
        writeFileSync(
          join(tmpDir, "src", "config", "envs", "prod.env"),
          "X=1",
          "utf8",
        );
        writeFileSync(
          join(tmpDir, "bunest.json"),
          JSON.stringify({ compilerOptions: { assets: ["config"] } }),
          "utf8",
        );

        const res = await buildProject({ cwd: tmpDir });
        expect(res.success).toBe(true);
        expect(
          existsSync(join(tmpDir, "dist", "config", "envs", ".development")),
        ).toBe(true);
        expect(
          existsSync(join(tmpDir, "dist", "config", "envs", "prod.env")),
        ).toBe(true);
      });

      // BUNEST_BUG: CompilerOptions declares `assets?: Asset[]`, but buildProject() never copies wildcard assets (including dotfiles) to outdir (packages/cli/src/commands/build.ts)
      it.skip("should keep copying dotfiles for the wildcard asset form", async () => {
        mkdirSync(join(tmpDir, "src", "config", "envs"), { recursive: true });
        writeFileSync(
          join(tmpDir, "src", "config", "envs", ".development"),
          "SECRET=1",
          "utf8",
        );
        writeFileSync(
          join(tmpDir, "bunest.json"),
          JSON.stringify({ compilerOptions: { assets: ["config/envs/*"] } }),
          "utf8",
        );

        const res = await buildProject({ cwd: tmpDir });
        expect(res.success).toBe(true);
        expect(
          existsSync(join(tmpDir, "dist", "config", "envs", ".development")),
        ).toBe(true);
      });
    });

    describe("monorepo project builds", () => {
      // BUNEST_BUG: `runCli(["build", "<projectName>"])` ignores positional project arguments and buildProject() never resolves named monorepo projects from `bunest.json` `projects` (packages/cli/src/runner.ts, packages/cli/src/commands/build.ts)
      it.skip("should build a specific sub-app by name in monorepo mode", async () => {
        mkdirSync(join(tmpDir, "apps", "secondary", "src"), {
          recursive: true,
        });
        writeFileSync(
          join(tmpDir, "apps", "secondary", "src", "main.ts"),
          `export const app = "secondary";\n`,
          "utf8",
        );
        writeFileSync(
          join(tmpDir, "bunest.json"),
          JSON.stringify({
            monorepo: true,
            projects: {
              secondary: {
                type: "application",
                root: "apps/secondary",
                entryFile: "main",
                sourceRoot: "apps/secondary/src",
              },
            },
          }),
          "utf8",
        );

        const cap = createCapturedIO(tmpDir);
        const res = await runCli(["build", "secondary"], cap.io);
        expect(res.exitCode).toBe(0);
        expect(
          existsSync(join(tmpDir, "dist", "apps", "secondary", "main.js")),
        ).toBe(true);
      });
    });
  },
);
