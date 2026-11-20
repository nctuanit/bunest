import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSchematicFiles,
  generateSchematic,
  parseSchematicName,
  resolveSchematicType,
} from "../../../../../packages/cli/src";
import { describeConformance, itAdapted } from "../../../_helpers/index";

const expectedControllerSource = (kebab: string, pascal: string): string =>
  `import { Controller, Get } from "@bunest/core";\n` +
  "\n" +
  `@Controller("/${kebab}")\n` +
  `export class ${pascal}Controller {\n` +
  "  @Get()\n" +
  "  findAll(): { resource: string; items: unknown[] } {\n" +
  `    return { resource: "${kebab}", items: [] };\n` +
  "  }\n" +
  "}\n";

describeConformance(
  "Controller Schematic Factory",
  {
    upstreamPath: "schematics/src/lib/controller/controller.factory.test.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Ports upstream @nestjs/schematics controller factory tests to Bunest CLI controller schematic (@bunest/core, @bunest/testing, bun:test, extensionless ESM imports).",
  },
  () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "bunest-cli-conf-ctrl-"));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name only",
      async () => {
        const planned = buildSchematicFiles(
          "controller",
          parseSchematicName("foo"),
          { flat: false, spec: false },
        );
        expect(
          planned.find((f) => f.relativePath === "foo/foo.controller.ts"),
        ).toBeDefined();
        expect(
          planned.find((f) => f.relativePath === "foo/foo.controller.spec.ts"),
        ).toBeUndefined();
        expect(
          planned.find((f) => f.relativePath === "foo/foo.controller.ts")
            ?.content,
        ).toEqual(expectedControllerSource("foo", "Foo"));

        const result = await generateSchematic({
          schematic: "controller",
          name: "foo",
          dir: ".",
          spec: false,
          flat: false,
          cwd: tempDir,
        });

        expect(
          result.files.find((f) => f.relativePath === "foo/foo.controller.ts"),
        ).toBeDefined();
        expect(
          result.files.find(
            (f) => f.relativePath === "foo/foo.controller.spec.ts",
          ),
        ).toBeUndefined();
        expect(
          readFileSync(join(tempDir, "foo/foo.controller.ts"), "utf8"),
        ).toEqual(expectedControllerSource("foo", "Foo"));
      },
      "Bunest controller imports from @bunest/core with starter @Get() handler",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name has a path",
      async () => {
        const result = await generateSchematic({
          schematic: "controller",
          name: "bar/foo",
          dir: ".",
          cwd: tempDir,
        });

        expect(
          result.files.find(
            (f) => f.relativePath === "bar/foo/foo.controller.ts",
          ),
        ).toBeDefined();
        expect(
          result.files.find(
            (f) => f.relativePath === "bar/foo/foo.controller.spec.ts",
          ),
        ).toBeDefined();
        expect(
          readFileSync(join(tempDir, "bar/foo/foo.controller.ts"), "utf8"),
        ).toEqual(expectedControllerSource("foo", "Foo"));
      },
      "Bunest controller template uses @bunest/core and bun:test spec",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name and path",
      async () => {
        const result = await generateSchematic({
          schematic: "controller",
          name: "foo",
          dir: "bar",
          cwd: tempDir,
        });

        expect(
          result.files.find((f) => f.relativePath === "foo/foo.controller.ts"),
        ).toBeDefined();
        expect(
          result.files.find(
            (f) => f.relativePath === "foo/foo.controller.spec.ts",
          ),
        ).toBeDefined();
        expect(
          readFileSync(join(tempDir, "bar/foo/foo.controller.ts"), "utf8"),
        ).toEqual(expectedControllerSource("foo", "Foo"));
      },
      "Bunest uses dir option for base directory",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name to normalize",
      async () => {
        const result = await generateSchematic({
          schematic: "controller",
          name: "fooBar",
          dir: ".",
          cwd: tempDir,
        });

        expect(
          result.files.find(
            (f) => f.relativePath === "foo-bar/foo-bar.controller.ts",
          ),
        ).toBeDefined();
        expect(
          result.files.find(
            (f) => f.relativePath === "foo-bar/foo-bar.controller.spec.ts",
          ),
        ).toBeDefined();
        expect(
          readFileSync(join(tempDir, "foo-bar/foo-bar.controller.ts"), "utf8"),
        ).toEqual(expectedControllerSource("foo-bar", "FooBar"));
      },
      "Normalizes camelCase controller name to kebab-case path and PascalCase class",
    );

    // BUNEST_BUG: parseSchematicName() in packages/cli/src/utils/naming.ts rejects leading "_" in path segment "_bar" of "_bar/foo" (VALID_SEGMENT_REGEX requires leading [a-zA-Z]); expected "_bar/foo/foo.controller.ts".
    it.skip("manage keep underscores in path", async () => {
      const result = await generateSchematic({
        schematic: "controller",
        name: "_bar/foo",
        dir: ".",
        cwd: tempDir,
      });

      expect(
        result.files.find(
          (f) => f.relativePath === "_bar/foo/foo.controller.ts",
        ),
      ).toBeDefined();
      expect(
        result.files.find(
          (f) => f.relativePath === "_bar/foo/foo.controller.spec.ts",
        ),
      ).toBeDefined();
      expect(
        readFileSync(join(tempDir, "_bar/foo/foo.controller.ts"), "utf8"),
      ).toEqual(expectedControllerSource("foo", "Foo"));
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should normalize camelCase directory segment in controller path",
      async () => {
        const result = await generateSchematic({
          schematic: "controller",
          name: "barBaz/foo",
          dir: ".",
          cwd: tempDir,
        });

        expect(
          result.files.find(
            (f) => f.relativePath === "bar-baz/foo/foo.controller.ts",
          ),
        ).toBeDefined();
        expect(
          result.files.find(
            (f) => f.relativePath === "bar-baz/foo/foo.controller.spec.ts",
          ),
        ).toBeDefined();
        expect(
          readFileSync(join(tempDir, "bar-baz/foo/foo.controller.ts"), "utf8"),
        ).toEqual(expectedControllerSource("foo", "Foo"));
      },
      "Ports upstream barBaz/foo controller path normalization test",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "generates TypeScript controller only and resolves 'co' alias (no language: js)",
      () => {
        expect(resolveSchematicType("co")).toBe("controller");
        const files = buildSchematicFiles(
          "controller",
          parseSchematicName("foo"),
          { flat: false, spec: true },
        );
        expect(files.map((f) => f.relativePath)).toEqual([
          "foo/foo.controller.ts",
          "foo/foo.controller.spec.ts",
        ]);
        expect(files.some((f) => f.relativePath.endsWith(".js"))).toBe(false);
      },
      "Bunest targets TypeScript natively on Bun without JS output templates",
    );

    // BUNEST_BUG: generateSchematic("controller") in packages/cli/src/commands/generate.ts does not auto-register generated controllers in src/app.module.ts (and GenerateSchematicOptions lacks skipImport/module options).
    it.skip("should manage declaration in app module", async () => {
      await generateSchematic({
        schematic: "application",
        name: "app",
        flat: true,
        cwd: tempDir,
      });

      await generateSchematic({
        schematic: "controller",
        name: "foo",
        cwd: tempDir,
      });

      const appModule = readFileSync(
        join(tempDir, "src/app.module.ts"),
        "utf8",
      );
      expect(appModule).toContain(
        'import { FooController } from "./foo/foo.controller";',
      );
      expect(appModule).toContain(
        "controllers: [AppController, FooController]",
      );
    });

    // BUNEST_BUG: generateSchematic("controller") in packages/cli/src/commands/generate.ts does not locate and update the nearest module (src/foo/foo.module.ts) to import and declare FooController in controllers[].
    it.skip("should manage declaration in foo module", async () => {
      await generateSchematic({
        schematic: "application",
        name: "app",
        flat: true,
        cwd: tempDir,
      });
      await generateSchematic({
        schematic: "module",
        name: "foo",
        cwd: tempDir,
      });
      await generateSchematic({
        schematic: "controller",
        name: "foo",
        cwd: tempDir,
      });

      const fooModule = readFileSync(
        join(tempDir, "src/foo/foo.module.ts"),
        "utf8",
      );
      expect(fooModule).toContain(
        'import { FooController } from "./foo.controller";',
      );
      expect(fooModule).toContain("controllers: [FooController]");
    });

    it("should create a spec file", async () => {
      const result = await generateSchematic({
        schematic: "controller",
        name: "foo",
        dir: ".",
        spec: true,
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.controller.spec.ts"),
      ).toBeDefined();
      expect(existsSync(join(tempDir, "foo.controller.spec.ts"))).toBe(true);
    });

    it("should create a spec file with custom file suffix", async () => {
      const result = await generateSchematic({
        schematic: "controller",
        name: "foo",
        dir: ".",
        spec: true,
        specFileSuffix: "test",
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.controller.spec.ts"),
      ).toBeUndefined();
      expect(
        result.files.find((f) => f.relativePath === "foo.controller.test.ts"),
      ).toBeDefined();
      expect(existsSync(join(tempDir, "foo.controller.spec.ts"))).toBe(false);
      expect(existsSync(join(tempDir, "foo.controller.test.ts"))).toBe(true);
    });

    // BUNEST_BUG: generateSchematic("controller") in packages/cli/src/commands/generate.ts does not auto-register FooController into src/app.module.ts for ESM projects.
    it.skip("should manage declaration in app module for ESM projects", async () => {
      await generateSchematic({
        schematic: "application",
        name: "app",
        flat: true,
        cwd: tempDir,
      });
      await generateSchematic({
        schematic: "controller",
        name: "foo",
        cwd: tempDir,
      });

      const appModule = readFileSync(
        join(tempDir, "src/app.module.ts"),
        "utf8",
      );
      expect(appModule).toContain("FooController");
    });

    // BUNEST_BUG: generateSchematic("controller") in packages/cli/src/commands/generate.ts does not auto-register FooController into src/foo/foo.module.ts for ESM projects.
    it.skip("should manage declaration in foo module for ESM projects", async () => {
      await generateSchematic({
        schematic: "application",
        name: "app",
        flat: true,
        cwd: tempDir,
      });
      await generateSchematic({
        schematic: "module",
        name: "foo",
        cwd: tempDir,
      });
      await generateSchematic({
        schematic: "controller",
        name: "foo",
        cwd: tempDir,
      });

      const fooModule = readFileSync(
        join(tempDir, "src/foo/foo.module.ts"),
        "utf8",
      );
      expect(fooModule).toContain("FooController");
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should generate bun:test spec file with reflect-metadata and extensionless ESM import",
      async () => {
        await generateSchematic({
          schematic: "application",
          name: "app",
          flat: true,
          cwd: tempDir,
        });

        await generateSchematic({
          schematic: "controller",
          name: "foo",
          spec: true,
          flat: true,
          cwd: tempDir,
        });

        const specContent = readFileSync(
          join(tempDir, "src/foo.controller.spec.ts"),
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
          'import { FooController } from "./foo.controller";',
        );
        expect(specContent).toContain("Test.createTestingModule");
        expect(specContent).toContain("controllers: [FooController]");
      },
      "Bunest generates bun:test spec with @bunest/testing and extensionless bundler imports",
    );
  },
);
