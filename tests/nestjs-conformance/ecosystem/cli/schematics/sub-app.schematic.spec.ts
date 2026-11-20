import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSchematicFiles,
  generateSchematic,
  parseSchematicName,
  type GenerateSchematicOptions,
} from "../../../../../packages/cli/src";
import { describeConformance, itAdapted } from "../../../_helpers/index";

type ExtendedSubAppOptions = GenerateSchematicOptions & {
  readonly rootDir?: string;
};

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
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
      const dir = mkdtempSync(join(tmpdir(), "bunest-cli-conf-"));
      tempDirs.push(dir);
      return dir;
    }

    afterEach(() => {
      while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
          rmSync(dir, { recursive: true, force: true });
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
        expect(
          existsSync(join(cwd, "apps/project/src/main.ts")),
        ).toBe(true);
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

    // BUNEST_BUG: parseSchematicName rejects leading underscore ("_project") instead of creating apps/_project with _project.* files (packages/cli/src/utils/naming.ts: VALID_SEGMENT_REGEX and toKebabCase)
    it.skip("should keep underscores in sub-app's path and file name", () => {
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
        writeFileSync(
          pkgPath,
          JSON.stringify({ name: "test", version: "1.0.0" }),
        );

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

    // BUNEST_BUG: generateSchematic("sub-app", ...) does not create or update bunest.json (or .bunestrc.json) with monorepo: true and registered project metadata (packages/cli/src/commands/generate.ts, packages/cli/src/templates/schematic.templates.ts:470-572)
    it.skip("should create or update bunest.json with monorepo: true and register sub-app", async () => {
      const cwd = createTempDir();
      await generateSchematic({
        schematic: "sub-app",
        name: "project",
        cwd,
      });

      const configPath = join(cwd, "bunest.json");
      expect(existsSync(configPath)).toBe(true);
      const config = readJson(configPath);
      expect(config["monorepo"]).toBe(true);
      const projects = config["projects"] as Record<
        string,
        Record<string, unknown>
      >;
      expect(projects["project"]?.["root"]).toBe("apps/project");
    });

    // BUNEST_BUG: generateSchematic("sub-app", ...) does not sort or register sub-app project entries in bunest.json (packages/cli/src/commands/generate.ts, packages/cli/src/templates/schematic.templates.ts:470-572)
    it.skip("should sort sub-app names in bunest.json", async () => {
      const cwd = createTempDir();
      const configPath = join(cwd, "bunest.json");
      writeFileSync(configPath, JSON.stringify({ monorepo: true, projects: {} }));

      for (const name of ["c", "a", "b"]) {
        await generateSchematic({ schematic: "sub-app", name, cwd });
      }

      const config = readJson(configPath);
      const projects = config["projects"] as Record<string, unknown>;
      expect(Object.keys(projects)).toEqual(["a", "b", "c"]);
    });

    // BUNEST_BUG: generateSchematic("sub-app", ...) does not update existing .bunestrc.json when it is the active config file (packages/cli/src/commands/generate.ts)
    it.skip("should update .bunestrc.json when it is the config file in use", async () => {
      const cwd = createTempDir();
      const rcPath = join(cwd, ".bunestrc.json");
      writeFileSync(
        rcPath,
        JSON.stringify({ compilerOptions: { deleteOutDir: true } }),
      );

      await generateSchematic({
        schematic: "sub-app",
        name: "project",
        cwd,
      });

      expect(existsSync(join(cwd, "bunest.json"))).toBe(false);
      const config = readJson(rcPath);
      expect(config["monorepo"]).toBe(true);
      expect(
        (config["compilerOptions"] as Record<string, unknown>)["deleteOutDir"],
      ).toBe(true);
    });

    // BUNEST_BUG: GenerateSchematicOptions and buildSchematicFiles("sub-app") hardcode "apps/<kebab>" and do not support a custom rootDir option (packages/cli/src/types.ts, packages/cli/src/templates/schematic.templates.ts:471)
    it.skip("should support custom rootDir option for sub-app", async () => {
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

    // BUNEST_BUG: generateSchematic("sub-app", ...) does not convert root tsconfig.json to solution-style project references or create tsconfig.spec.json (packages/cli/src/commands/generate.ts, packages/cli/src/templates/schematic.templates.ts:470-572)
    it.skip("should convert tsconfig.json to solution-style with project references and tsconfig.spec.json", async () => {
      const cwd = createTempDir();
      const tsconfigPath = join(cwd, "tsconfig.json");
      writeFileSync(
        tsconfigPath,
        JSON.stringify({
          compilerOptions: {
            baseUrl: "./",
            paths: { "@app/*": ["src/*"] },
            target: "ESNext",
          },
          include: ["src"],
        }),
      );

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
      expect(existsSync(join(cwd, "tsconfig.spec.json"))).toBe(true);
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
        writeFileSync(pkgPath, JSON.stringify(initialPkg));

        await generateSchematic({
          schematic: "sub-app",
          name: "project",
          cwd,
        });

        expect(readJson(pkgPath)).toEqual(initialPkg);
      },
      "Bunest standardizes on bun check and bun test instead of oxlint/eslint",
    );

    // BUNEST_BUG: generateSchematic("sub-app", ...) does not warn about ignored legacy config files (nest.json) or update bunest.json (packages/cli/src/commands/generate.ts)
    it.skip("should warn about ignored legacy nest.json config file when creating monorepo config", async () => {
      const cwd = createTempDir();
      writeFileSync(
        join(cwd, "nest.json"),
        JSON.stringify({ sourceRoot: "source" }),
      );
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
      expect(existsSync(join(cwd, "bunest.json"))).toBe(true);
    });

    describe("the e2e config of the app", () => {
      itAdapted(
        ["ADR-001"],
        "should never generate jest-e2e.json (Bunest uses native bun test)",
        async () => {
          const cwd = createTempDir();
          writeFileSync(
            join(cwd, "package.json"),
            JSON.stringify({
              name: "test",
              type: "module",
              scripts: { test: "bun test" },
            }),
          );
          const result = await generateSchematic({
            schematic: "sub-app",
            name: "project",
            cwd,
          });
          const paths = result.files.map((f) => f.relativePath);
          expect(paths.some((p) => p.includes("jest-e2e.json"))).toBe(false);
          expect(paths).toContain("apps/project/src/project.controller.spec.ts");
        },
        "Bunest uses native bun:test without Jest or Vitest config scaffolding",
      );
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should generate files with extensionless Bun ESM imports (no .js suffix)",
      async () => {
        const cwd = createTempDir();
        writeFileSync(
          join(cwd, "package.json"),
          JSON.stringify({ name: "test", type: "module" }),
        );
        await generateSchematic({
          schematic: "sub-app",
          name: "project",
          cwd,
        });

        const specContent = readFileSync(
          join(cwd, "apps/project/src/project.controller.spec.ts"),
          "utf8",
        );
        expect(specContent).toContain(
          'import { ProjectModule } from "./project.module"',
        );
        expect(specContent).not.toMatch(/\.js["']/);

        const moduleContent = readFileSync(
          join(cwd, "apps/project/src/project.module.ts"),
          "utf8",
        );
        expect(moduleContent).toContain(
          'import { ProjectController } from "./project.controller"',
        );
        expect(moduleContent).toContain(
          'import { ProjectService } from "./project.service"',
        );
        expect(moduleContent).not.toMatch(/\.js["']/);

        const controllerContent = readFileSync(
          join(cwd, "apps/project/src/project.controller.ts"),
          "utf8",
        );
        expect(controllerContent).toContain(
          'import { ProjectService } from "./project.service"',
        );
        expect(controllerContent).not.toMatch(/\.js["']/);

        const mainContent = readFileSync(
          join(cwd, "apps/project/src/main.ts"),
          "utf8",
        );
        expect(mainContent).toContain(
          'import { ProjectModule } from "./project.module"',
        );
        expect(mainContent).not.toMatch(/\.js["']/);
      },
      "Bun moduleResolution: 'bundler' uses extensionless TS imports across all sub-app files",
    );
  },
);
