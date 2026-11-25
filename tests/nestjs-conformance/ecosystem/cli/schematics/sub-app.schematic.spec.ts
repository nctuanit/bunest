import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSyncPath,
  join,
  mkdirSyncPath,
  readTextSync,
  removePath,
  writeTextSync,
} from "../../../../../packages/core/src";
import {
  buildSchematicFiles,
  generateSchematic,
  parseSchematicName,
  type GenerateSchematicOptions,
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

type ExtendedSubAppOptions = GenerateSchematicOptions & {
  readonly rootDir?: string;
};

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readTextSync(filePath)) as Record<string, unknown>;
}

describeConformance(
  "SubApp Schematic",
  {
    upstreamPath: "schematics/src/lib/sub-app/sub-app.factory.test.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts @nestjs/schematics sub-app factory tests to Bunest CLI (BunestFactory, bun:test, Bun-native bundler with no rspack/webpack/Jest/oxlint). Missing monorepo bunest.json updates, tsconfig project references, custom rootDir, and underscore support are documented via BUNEST_BUG skips.",
  },
  () => {
    const tempDirs: string[] = [];

    function createTempDir(): string {
      const dir = makeTempDir("bunest-cli-conf-");
      tempDirs.push(dir);
      return dir;
    }

    afterEach(async () => {
      while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
          await removePath(dir, { recursive: true, force: true });
        }
      }
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name only",
      async () => {
        const planned = buildSchematicFiles(
          "sub-app",
          parseSchematicName("project"),
          { flat: false, spec: true },
        );
        expect(planned.map((f) => f.relativePath).sort()).toEqual(
          [
            "apps/project/tsconfig.app.json",
            "apps/project/src/main.ts",
            "apps/project/src/project.controller.spec.ts",
            "apps/project/src/project.controller.ts",
            "apps/project/src/project.module.ts",
            "apps/project/src/project.service.ts",
          ].sort(),
        );

        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic: "sub-app",
          name: "project",
          cwd,
        });
        expect(result.files.map((f) => f.relativePath).sort()).toEqual(
          [
            "apps/project/tsconfig.app.json",
            "apps/project/src/main.ts",
            "apps/project/src/project.controller.spec.ts",
            "apps/project/src/project.controller.ts",
            "apps/project/src/project.module.ts",
            "apps/project/src/project.service.ts",
          ].sort(),
        );
        expect(existsSyncPath(join(cwd, "apps/project/src/main.ts"))).toBe(true);
      },
      "scaffolds apps/<name> Bunest sub-app without Jest e2e config",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name to normalize",
      async () => {
        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic: "sub-app",
          name: "awesomeProject",
          cwd,
        });

        expect(result.files.map((f) => f.relativePath).sort()).toEqual(
          [
            "apps/awesome-project/tsconfig.app.json",
            "apps/awesome-project/src/main.ts",
            "apps/awesome-project/src/awesome-project.controller.spec.ts",
            "apps/awesome-project/src/awesome-project.controller.ts",
            "apps/awesome-project/src/awesome-project.module.ts",
            "apps/awesome-project/src/awesome-project.service.ts",
          ].sort(),
        );
        const tsconfig = readJson(
          join(cwd, "apps/awesome-project/tsconfig.app.json"),
        );
        expect(
          (tsconfig["compilerOptions"] as Record<string, unknown>)["outDir"],
        ).toBe("../../dist/apps/awesome-project");
      },
      "normalizes camelCase sub-app name to kebab-case paths and PascalCase symbols",
    );

    it("should keep underscores in sub-app's path and file name", () => {
      const planned = buildSchematicFiles(
        "sub-app",
        parseSchematicName("_project"),
        { flat: false, spec: true },
      );
      expect(planned.map((f) => f.relativePath).sort()).toEqual(
        [
          "apps/_project/tsconfig.app.json",
          "apps/_project/src/main.ts",
          "apps/_project/src/_project.controller.spec.ts",
          "apps/_project/src/_project.controller.ts",
          "apps/_project/src/_project.module.ts",
          "apps/_project/src/_project.service.ts",
        ].sort(),
      );
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should emit TypeScript sub-app files only (no language: 'js' or .babelrc/jsconfig.json)",
      () => {
        const planned = buildSchematicFiles(
          "sub-app",
          parseSchematicName("project"),
          { flat: false, spec: true },
        );
        const paths = planned.map((f) => f.relativePath);
        expect(paths.some((p) => p.endsWith(".js"))).toBe(false);
        expect(paths.some((p) => p.includes(".babelrc"))).toBe(false);
        expect(paths.some((p) => p.includes("jsconfig.json"))).toBe(false);
        expect(paths).toContain("apps/project/tsconfig.app.json");
        expect(paths).toContain("apps/project/src/main.ts");
      },
      "Bunest is Bun-only native TypeScript with no Babel/JavaScript sub-app variant",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should generate spec files with custom suffix",
      async () => {
        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic: "sub-app",
          name: "project",
          specFileSuffix: "test",
          cwd,
        });

        expect(result.files.map((f) => f.relativePath).sort()).toEqual(
          [
            "apps/project/tsconfig.app.json",
            "apps/project/src/main.ts",
            "apps/project/src/project.controller.test.ts",
            "apps/project/src/project.controller.ts",
            "apps/project/src/project.module.ts",
            "apps/project/src/project.service.ts",
          ].sort(),
        );
      },
      "honours specFileSuffix for sub-app controller spec",
    );

    itAdapted(
      ["ADR-001"],
      "should not inject rspack/webpack builder packages into package.json (Bun-native bundler)",
      async () => {
        const cwd = createTempDir();
        const pkgPath = join(cwd, "package.json");
        writeTextSync(pkgPath, JSON.stringify({ name: "test", version: "1.0.0" }));

        await generateSchematic({
          schematic: "sub-app",
          name: "project",
          cwd,
        });

        const pkg = readJson(pkgPath);
        expect(pkg["devDependencies"]).toBeUndefined();
      },
      "Bunest uses native Bun.build rather than @rspack/core or webpack plugins",
    );

    it("should create or update bunest.json with monorepo: true and register sub-app", async () => {
      const cwd = createTempDir();
      await generateSchematic({
        schematic: "sub-app",
        name: "project",
        cwd,
      });

      const configPath = join(cwd, "bunest.json");
      expect(existsSyncPath(configPath)).toBe(true);
      const config = readJson(configPath);
      expect(config["monorepo"]).toBe(true);
      const projects = config["projects"] as Record<
        string,
        Record<string, unknown>
      >;
      expect(projects["project"]?.["root"]).toBe("apps/project");
    });

    it("should sort sub-app names in bunest.json", async () => {
      const cwd = createTempDir();
      const configPath = join(cwd, "bunest.json");
      writeTextSync(configPath, JSON.stringify({ monorepo: true, projects: {} }));

      for (const name of ["c", "a", "b"]) {
        await generateSchematic({ schematic: "sub-app", name, cwd });
      }

      const config = readJson(configPath);
      const projects = config["projects"] as Record<string, unknown>;
      expect(Object.keys(projects)).toEqual(["a", "b", "c"]);
    });

    it("should update .bunestrc.json when it is the config file in use", async () => {
      const cwd = createTempDir();
      const rcPath = join(cwd, ".bunestrc.json");
      writeTextSync(rcPath, JSON.stringify({ compilerOptions: { deleteOutDir: true } }));

      await generateSchematic({
        schematic: "sub-app",
        name: "project",
        cwd,
      });

      expect(existsSyncPath(join(cwd, "bunest.json"))).toBe(false);
      const config = readJson(rcPath);
      expect(config["monorepo"]).toBe(true);
      expect(
        (config["compilerOptions"] as Record<string, unknown>)["deleteOutDir"],
      ).toBe(true);
    });

    it("should support custom rootDir option for sub-app", async () => {
      const cwd = createTempDir();
      const options: ExtendedSubAppOptions = {
        schematic: "sub-app",
        name: "project",
        rootDir: "services",
        cwd,
      };
      const result = await generateSchematic(options);
      expect(
        result.files.find(
          (f) => f.relativePath === "services/project/src/main.ts",
        ),
      ).toBeDefined();
    });

    it("should convert tsconfig.json to solution-style with project references and tsconfig.spec.json", async () => {
      const cwd = createTempDir();
      const tsconfigPath = join(cwd, "tsconfig.json");
      writeTextSync(tsconfigPath, JSON.stringify({
          compilerOptions: {
            baseUrl: "./",
            paths: { "@app/*": ["src/*"] },
            target: "ESNext",
          },
          include: ["src"],
        }));

      await generateSchematic({
        schematic: "sub-app",
        name: "project",
        cwd,
      });

      const tsconfig = readJson(tsconfigPath);
      expect(tsconfig["files"]).toEqual([]);
      expect(tsconfig["references"]).toContainEqual({
        path: "./apps/project/tsconfig.app.json",
      });
      expect(existsSyncPath(join(cwd, "tsconfig.spec.json"))).toBe(true);
    });

    itAdapted(
      ["ADR-001"],
      "should not rewrite oxlint/eslint scripts in package.json (Bunest uses bun check)",
      async () => {
        const cwd = createTempDir();
        const pkgPath = join(cwd, "package.json");
        const initialPkg = {
          name: "test",
          scripts: { typecheck: "bun check", test: "bun test" },
        };
        writeTextSync(pkgPath, JSON.stringify(initialPkg));

        await generateSchematic({
          schematic: "sub-app",
          name: "project",
          cwd,
        });

        expect(readJson(pkgPath)).toEqual(initialPkg);
      },
      "Bunest standardizes on bun check and bun test instead of oxlint/eslint",
    );

    it("should warn about ignored legacy nest.json config file when creating monorepo config", async () => {
      const cwd = createTempDir();
      writeTextSync(join(cwd, "nest.json"), JSON.stringify({ sourceRoot: "source" }));
      const stderr: string[] = [];

      await generateSchematic(
        { schematic: "sub-app", name: "project", cwd },
        {
          cwd,
          stdout: () => {},
          stderr: (msg) => stderr.push(msg),
        },
      );

      expect(stderr.some((msg) => msg.includes("nest.json"))).toBe(true);
      expect(existsSyncPath(join(cwd, "bunest.json"))).toBe(true);
    });

    describe("the e2e config of the app", () => {
      itAdapted(
        ["ADR-001"],
        "should never generate jest-e2e.json (Bunest uses native bun test)",
        async () => {
          const cwd = createTempDir();
          writeTextSync(join(cwd, "package.json"), JSON.stringify({
              name: "test",
              type: "module",
              scripts: { test: "bun test" },
            }));
          const result = await generateSchematic({
            schematic: "sub-app",
            name: "project",
            cwd,
          });
          const paths = result.files.map((f) => f.relativePath);
          expect(paths.some((p) => p.includes("jest-e2e.json"))).toBe(false);
          expect(paths).toContain(
            "apps/project/src/project.controller.spec.ts",
          );
        },
        "Bunest uses native bun:test without Jest or Vitest config scaffolding",
      );
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should generate files with extensionless Bun ESM imports (no .js suffix)",
      async () => {
        const cwd = createTempDir();
        writeTextSync(join(cwd, "package.json"), JSON.stringify({ name: "test", type: "module" }));
        await generateSchematic({
          schematic: "sub-app",
          name: "project",
          cwd,
        });

        const specContent = readTextSync(join(cwd, "apps/project/src/project.controller.spec.ts"));
        expect(specContent).toContain(
          'import { ProjectModule } from "./project.module"',
        );
        expect(specContent).not.toMatch(/\.js["']/);

        const moduleContent = readTextSync(join(cwd, "apps/project/src/project.module.ts"));
        expect(moduleContent).toContain(
          'import { ProjectController } from "./project.controller"',
        );
        expect(moduleContent).toContain(
          'import { ProjectService } from "./project.service"',
        );
        expect(moduleContent).not.toMatch(/\.js["']/);

        const controllerContent = readTextSync(join(cwd, "apps/project/src/project.controller.ts"));
        expect(controllerContent).toContain(
          'import { ProjectService } from "./project.service"',
        );
        expect(controllerContent).not.toMatch(/\.js["']/);

        const mainContent = readTextSync(join(cwd, "apps/project/src/main.ts"));
        expect(mainContent).toContain(
          'import { ProjectModule } from "./project.module"',
        );
        expect(mainContent).not.toMatch(/\.js["']/);
      },
      "Bun moduleResolution: 'bundler' uses extensionless TS imports across all sub-app files",
    );
  },
);
