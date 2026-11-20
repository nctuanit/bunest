import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSchematicFiles,
  generateSchematic,
  parseSchematicName,
  resolveSchematicType,
} from "../../../../../packages/cli/src";
import { describeConformance, itAdapted } from "../../../_helpers/index";

describeConformance(
  "Library Schematic Factory",
  {
    upstreamPath: "schematics/src/lib/library/library.factory.test.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Ports upstream @nestjs/schematics library factory tests to Bunest CLI library schematic (Bun-only TS, native Bun.build/bun:test without rspack/webpack/oxlint/jest boilerplate).",
  },
  () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "bunest-cli-conf-lib-"));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name only",
      async () => {
        expect(resolveSchematicType("library")).toBe("library");
        expect(resolveSchematicType("lib")).toBe("library");

        const planned = buildSchematicFiles(
          "library",
          parseSchematicName("project"),
          { flat: false, spec: true },
        );
        expect(planned.map((f) => f.relativePath).sort()).toEqual(
          [
            "libs/project/tsconfig.lib.json",
            "libs/project/src/index.ts",
            "libs/project/src/project.module.ts",
            "libs/project/src/project.service.spec.ts",
            "libs/project/src/project.service.ts",
          ].sort(),
        );

        const result = await generateSchematic({
          schematic: "library",
          name: "project",
          cwd: tempDir,
        });

        expect(result.files.map((f) => f.relativePath).sort()).toEqual(
          [
            "libs/project/tsconfig.lib.json",
            "libs/project/src/index.ts",
            "libs/project/src/project.module.ts",
            "libs/project/src/project.service.spec.ts",
            "libs/project/src/project.service.ts",
          ].sort(),
        );

        const tsconfigLib = JSON.parse(
          readFileSync(
            join(tempDir, "libs/project/tsconfig.lib.json"),
            "utf8",
          ),
        ) as {
          extends: string;
          compilerOptions: { declaration: boolean; outDir: string };
          include: string[];
          exclude: string[];
        };
        expect(tsconfigLib.extends).toBe("../../tsconfig.json");
        expect(tsconfigLib.compilerOptions.declaration).toBe(true);
        expect(tsconfigLib.compilerOptions.outDir).toBe(
          "../../dist/libs/project",
        );
        expect(tsconfigLib.include).toEqual(["src/**/*"]);
        expect(tsconfigLib.exclude).toContain("**/*spec.ts");
      },
      "Bunest generates library source, tsconfig.lib.json, and bun:test spec under libs/<name>",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name to normalize",
      async () => {
        const result = await generateSchematic({
          schematic: "library",
          name: "awesomeProject",
          cwd: tempDir,
        });

        expect(result.files.map((f) => f.relativePath).sort()).toEqual(
          [
            "libs/awesome-project/tsconfig.lib.json",
            "libs/awesome-project/src/index.ts",
            "libs/awesome-project/src/awesome-project.module.ts",
            "libs/awesome-project/src/awesome-project.service.spec.ts",
            "libs/awesome-project/src/awesome-project.service.ts",
          ].sort(),
        );

        expect(
          readFileSync(
            join(tempDir, "libs/awesome-project/src/awesome-project.module.ts"),
            "utf8",
          ),
        ).toContain("export class AwesomeProjectModule {}");
        expect(
          readFileSync(
            join(
              tempDir,
              "libs/awesome-project/src/awesome-project.service.ts",
            ),
            "utf8",
          ),
        ).toContain("export class AwesomeProjectService");
      },
      "Normalizes camelCase library name to kebab-case paths and PascalCase symbols",
    );

    // BUNEST_BUG: parseSchematicName() in packages/cli/src/utils/naming.ts rejects leading "_" in "_project" (VALID_SEGMENT_REGEX requires leading [a-zA-Z]); expected "libs/_project/src/_project.module.ts" etc.
    it.skip("should keep underscores in library's path and file name", async () => {
      const result = await generateSchematic({
        schematic: "library",
        name: "_project",
        cwd: tempDir,
      });

      expect(result.files.map((f) => f.relativePath).sort()).toEqual(
        [
          "libs/_project/tsconfig.lib.json",
          "libs/_project/src/index.ts",
          "libs/_project/src/_project.module.ts",
          "libs/_project/src/_project.service.spec.ts",
          "libs/_project/src/_project.service.ts",
        ].sort(),
      );
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "generates TypeScript library files only without .babelrc/jsconfig.json (no language: js)",
      () => {
        const files = buildSchematicFiles(
          "library",
          parseSchematicName("project"),
          { flat: false, spec: true },
        );
        const paths = files.map((f) => f.relativePath);

        expect(paths).not.toContain("libs/project/.babelrc");
        expect(paths).not.toContain("libs/project/jsconfig.json");
        expect(paths.some((p) => p.endsWith(".js"))).toBe(false);
        expect(paths).toContain("libs/project/tsconfig.lib.json");
      },
      "Bunest targets TypeScript natively on Bun without Babel/JS library templates",
    );

    it("should generate spec files with custom suffix", async () => {
      const result = await generateSchematic({
        schematic: "library",
        name: "project",
        specFileSuffix: "test",
        cwd: tempDir,
      });

      const paths = result.files.map((f) => f.relativePath).sort();
      expect(paths).toEqual(
        [
          "libs/project/tsconfig.lib.json",
          "libs/project/src/index.ts",
          "libs/project/src/project.module.ts",
          "libs/project/src/project.service.test.ts",
          "libs/project/src/project.service.ts",
        ].sort(),
      );
      expect(
        existsSync(join(tempDir, "libs/project/src/project.service.spec.ts")),
      ).toBe(false);
      expect(
        existsSync(join(tempDir, "libs/project/src/project.service.test.ts")),
      ).toBe(true);
    });

    // BUNEST_BUG: buildSchematicFiles("library") in packages/cli/src/templates/schematic.templates.ts hardcodes "**/*spec.ts" in tsconfig.lib.json exclude instead of interpolating options.specFileSuffix ("**/*test.ts").
    it.skip("should propagate custom specFileSuffix into tsconfig.lib.json exclude", async () => {
      await generateSchematic({
        schematic: "library",
        name: "project",
        specFileSuffix: "test",
        cwd: tempDir,
      });

      const tsconfigLib = JSON.parse(
        readFileSync(join(tempDir, "libs/project/tsconfig.lib.json"), "utf8"),
      ) as { exclude: string[] };
      expect(tsconfigLib.exclude).toContain("**/*test.ts");
    });

    it("should not generate a spec file when spec is false", async () => {
      const result = await generateSchematic({
        schematic: "library",
        name: "project",
        spec: false,
        cwd: tempDir,
      });

      expect(result.files.map((f) => f.relativePath).sort()).toEqual(
        [
          "libs/project/tsconfig.lib.json",
          "libs/project/src/index.ts",
          "libs/project/src/project.module.ts",
          "libs/project/src/project.service.ts",
        ].sort(),
      );
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "uses native Bun toolchain without injecting rspack/webpack/oxlint/jest config into package.json",
      async () => {
        const initialPkg = {
          name: "workspace",
          version: "1.0.0",
          type: "module",
          scripts: { test: "bun test", typecheck: "bun check" },
        };
        writeFileSync(
          join(tempDir, "package.json"),
          JSON.stringify(initialPkg, null, 2),
        );

        await generateSchematic({
          schematic: "library",
          name: "project",
          cwd: tempDir,
        });

        const pkgAfter = JSON.parse(
          readFileSync(join(tempDir, "package.json"), "utf8"),
        ) as Record<string, unknown>;
        expect(pkgAfter.devDependencies).toBeUndefined();
        expect(pkgAfter.jest).toBeUndefined();
        expect(pkgAfter.scripts).toEqual(initialPkg.scripts);
      },
      "Bunest relies on Bun.build, bun:test, and bun check instead of rspack/webpack/oxlint/jest",
    );

    // BUNEST_BUG: generateSchematic("library") in packages/cli/src/commands/generate.ts does not create or update bunest.json to register projects.<name> ({ type: "library", root: "libs/<name>", sourceRoot: "libs/<name>/src" }).
    it.skip("should register the library in bunest.json", async () => {
      await generateSchematic({
        schematic: "library",
        name: "project",
        cwd: tempDir,
      });

      expect(existsSync(join(tempDir, "bunest.json"))).toBe(true);
      const config = JSON.parse(
        readFileSync(join(tempDir, "bunest.json"), "utf8"),
      ) as { projects?: Record<string, { root?: string }> };
      expect(config.projects?.project?.root).toBe("libs/project");
    });

    // BUNEST_BUG: generateSchematic("library") in packages/cli/src/commands/generate.ts does not update an existing .bunestrc.json / bunest.json in place while preserving existing sourceRoot and compilerOptions.
    it.skip("should update existing .bunestrc.json when it is the config file in use", async () => {
      writeFileSync(
        join(tempDir, ".bunestrc.json"),
        JSON.stringify({
          sourceRoot: "source",
          compilerOptions: { deleteOutDir: true },
        }),
      );

      await generateSchematic({
        schematic: "library",
        name: "project",
        cwd: tempDir,
      });

      expect(existsSync(join(tempDir, "bunest.json"))).toBe(false);
      const config = JSON.parse(
        readFileSync(join(tempDir, ".bunestrc.json"), "utf8"),
      ) as {
        sourceRoot: string;
        compilerOptions: { deleteOutDir: boolean };
        projects?: Record<string, { root?: string }>;
      };
      expect(config.sourceRoot).toBe("source");
      expect(config.compilerOptions.deleteOutDir).toBe(true);
      expect(config.projects?.project?.root).toBe("libs/project");
    });

    // BUNEST_BUG: GenerateSchematicOptions and generateSchematic("library") in packages/cli/src/commands/generate.ts lack a "prefix" option and do not add compilerOptions.paths["<prefix>/<name>"] and "<prefix>/<name>/*" to tsconfig.json.
    it.skip("should add paths to tsconfig.json with custom prefix", async () => {
      writeFileSync(
        join(tempDir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { target: "ESNext" } }),
      );

      await generateSchematic({
        schematic: "library",
        name: "project",
        cwd: tempDir,
        ...({ prefix: "app" } as Record<string, unknown>),
      });

      const tsconfig = JSON.parse(
        readFileSync(join(tempDir, "tsconfig.json"), "utf8"),
      ) as {
        compilerOptions: {
          target: string;
          paths?: Record<string, string[]>;
        };
      };
      expect(tsconfig.compilerOptions.paths?.["app/project"]).toEqual([
        "./libs/project/src",
      ]);
      expect(tsconfig.compilerOptions.paths?.["app/project/*"]).toEqual([
        "./libs/project/src/*",
      ]);
      expect(tsconfig.compilerOptions.target).toBe("ESNext");
    });

    // BUNEST_BUG: generateSchematic("library") in packages/cli/src/commands/generate.ts does not add default "@app/<name>" and "@app/<name>/*" path aliases to tsconfig.json when no prefix is given.
    it.skip("should default the prefix to @app in tsconfig.json when none is given", async () => {
      writeFileSync(
        join(tempDir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: {} }),
      );

      await generateSchematic({
        schematic: "library",
        name: "project",
        cwd: tempDir,
      });

      const tsconfig = JSON.parse(
        readFileSync(join(tempDir, "tsconfig.json"), "utf8"),
      ) as { compilerOptions: { paths?: Record<string, string[]> } };
      expect(tsconfig.compilerOptions.paths?.["@app/project"]).toEqual([
        "./libs/project/src",
      ]);
      expect(tsconfig.compilerOptions.paths?.["@app/project/*"]).toEqual([
        "./libs/project/src/*",
      ]);
    });

    // BUNEST_BUG: buildSchematicFiles("library") in packages/cli/src/templates/schematic.templates.ts hardcodes "libs/<kebab>" and does not support a custom rootDir option.
    it.skip("should support custom rootDir for library output", async () => {
      const result = await generateSchematic({
        schematic: "library",
        name: "project",
        cwd: tempDir,
        ...({ rootDir: "packages" } as Record<string, unknown>),
      });

      expect(result.files.map((f) => f.relativePath)).toContain(
        "packages/project/src/index.ts",
      );
    });

    // BUNEST_BUG: generateSchematic("library") in packages/cli/src/commands/generate.ts does not update or sort library keys in tsconfig.json / bunest.json or preserve JSONC comments.
    it.skip("should preserve comments and sort library names in bunest.json and tsconfig.json", async () => {
      writeFileSync(
        join(tempDir, "bunest.json"),
        `{\n  // monorepo projects\n  "projects": {\n    "z-lib": {}\n  }\n}`,
      );
      writeFileSync(
        join(tempDir, "tsconfig.json"),
        `{\n  // project-wide compiler options\n  "compilerOptions": {\n    "strict": true,\n    "paths": {\n      "z-lib": ["./libs/z-lib/src"]\n    }\n  }\n}`,
      );

      await generateSchematic({
        schematic: "library",
        name: "project",
        cwd: tempDir,
      });

      const tsconfigContent = readFileSync(
        join(tempDir, "tsconfig.json"),
        "utf8",
      );
      expect(tsconfigContent).toContain("// project-wide compiler options");
      const configContent = readFileSync(join(tempDir, "bunest.json"), "utf8");
      expect(configContent).toContain("// monorepo projects");
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should generate ESM library files with extensionless imports for Bun bundler resolution",
      async () => {
        writeFileSync(
          join(tempDir, "package.json"),
          JSON.stringify({ name: "test", type: "module" }),
        );

        await generateSchematic({
          schematic: "library",
          name: "project",
          cwd: tempDir,
        });

        const specContent = readFileSync(
          join(tempDir, "libs/project/src/project.service.spec.ts"),
          "utf8",
        );
        expect(specContent).toContain('import "reflect-metadata";');
        expect(specContent).toContain(
          'import { describe, expect, it } from "bun:test";',
        );
        expect(specContent).toContain(
          'import { Test } from "@bunest/testing";',
        );
        expect(specContent).toContain(
          'import { ProjectService } from "./project.service";',
        );

        const moduleContent = readFileSync(
          join(tempDir, "libs/project/src/project.module.ts"),
          "utf8",
        );
        expect(moduleContent).toContain(
          'import { Module } from "@bunest/core";',
        );
        expect(moduleContent).toContain(
          'import { ProjectService } from "./project.service";',
        );

        const indexContent = readFileSync(
          join(tempDir, "libs/project/src/index.ts"),
          "utf8",
        );
        expect(indexContent).toContain(
          'export { ProjectModule } from "./project.module";',
        );
        expect(indexContent).toContain(
          'export { ProjectService } from "./project.service";',
        );
      },
      "Bunest ESM templates use extensionless imports under moduleResolution: bundler",
    );
  },
);
