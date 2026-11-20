import "reflect-metadata";
import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSchematicFiles,
  generateSchematic,
  parseSchematicName,
  type PlannedFile,
} from "../../../../../packages/cli/src";
import { describeConformance, itAdapted } from "../../../_helpers/index";

function expectedModuleSource(pascal: string): string {
  return `import { Module } from "@bunest/core";

@Module({
  imports: [],
  controllers: [],
  providers: [],
  exports: [],
})
export class ${pascal}Module {}
`;
}

function findFile(
  files: readonly PlannedFile[],
  relativePath: string,
): PlannedFile | undefined {
  return files.find((file) => file.relativePath === relativePath);
}

describeConformance(
  "Module Schematic",
  {
    upstreamPath: "schematics/src/lib/module/module.factory.test.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts @nestjs/schematics module factory tests to Bunest CLI (@bunest/core imports, TypeScript-only runtime).",
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
          "module",
          parseSchematicName("foo"),
          { flat: false, spec: true },
        );
        expect(planned).toHaveLength(1);
        const file = findFile(planned, "foo/foo.module.ts");
        expect(file).toBeDefined();
        expect(file?.content).toEqual(expectedModuleSource("Foo"));

        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic: "module",
          name: "foo",
          cwd,
        });
        expect(
          result.files.find((f) => f.relativePath === "foo/foo.module.ts"),
        ).toBeDefined();
        expect(
          readFileSync(join(cwd, "src/foo/foo.module.ts"), "utf8"),
        ).toEqual(expectedModuleSource("Foo"));
      },
      "emits @bunest/core @Module decorator template",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name as a path",
      async () => {
        const planned = buildSchematicFiles(
          "module",
          parseSchematicName("bar/foo"),
          { flat: false, spec: true },
        );
        const file = findFile(planned, "bar/foo/foo.module.ts");
        expect(file).toBeDefined();
        expect(file?.content).toEqual(expectedModuleSource("Foo"));

        const cwd = createTempDir();
        await generateSchematic({
          schematic: "module",
          name: "bar/foo",
          cwd,
        });
        expect(
          readFileSync(join(cwd, "src/bar/foo/foo.module.ts"), "utf8"),
        ).toEqual(expectedModuleSource("Foo"));
      },
      "emits @bunest/core module under nested folder path",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name and path",
      async () => {
        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic: "module",
          name: "foo",
          dir: "bar",
          cwd,
        });
        expect(
          result.files.find((f) => f.relativePath === "foo/foo.module.ts"),
        ).toBeDefined();
        expect(
          readFileSync(join(cwd, "bar/foo/foo.module.ts"), "utf8"),
        ).toEqual(expectedModuleSource("Foo"));
      },
      "writes module into custom target dir",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name to normalize",
      async () => {
        const planned = buildSchematicFiles(
          "module",
          parseSchematicName("fooBar"),
          { flat: false, spec: true },
        );
        const file = findFile(planned, "foo-bar/foo-bar.module.ts");
        expect(file).toBeDefined();
        expect(file?.content).toEqual(expectedModuleSource("FooBar"));

        const cwd = createTempDir();
        await generateSchematic({
          schematic: "module",
          name: "fooBar",
          cwd,
        });
        expect(
          readFileSync(join(cwd, "src/foo-bar/foo-bar.module.ts"), "utf8"),
        ).toEqual(expectedModuleSource("FooBar"));
      },
      "normalizes camelCase name to kebab-case file and PascalCase module class",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      'should not create a directory if "flat" is true',
      async () => {
        const planned = buildSchematicFiles(
          "module",
          parseSchematicName("fooBar"),
          { flat: true, spec: true },
        );
        const file = findFile(planned, "foo-bar.module.ts");
        expect(file).toBeDefined();
        expect(file?.content).toEqual(expectedModuleSource("FooBar"));

        const cwd = createTempDir();
        await generateSchematic({
          schematic: "module",
          name: "fooBar",
          flat: true,
          cwd,
        });
        expect(readFileSync(join(cwd, "src/foo-bar.module.ts"), "utf8")).toEqual(
          expectedModuleSource("FooBar"),
        );
      },
      "places module directly inside target dir when flat: true",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage path to normalize",
      async () => {
        const planned = buildSchematicFiles(
          "module",
          parseSchematicName("barBaz/foo"),
          { flat: false, spec: true },
        );
        const file = findFile(planned, "bar-baz/foo/foo.module.ts");
        expect(file).toBeDefined();
        expect(file?.content).toEqual(expectedModuleSource("Foo"));

        const cwd = createTempDir();
        await generateSchematic({
          schematic: "module",
          name: "barBaz/foo",
          cwd,
        });
        expect(
          readFileSync(join(cwd, "src/bar-baz/foo/foo.module.ts"), "utf8"),
        ).toEqual(expectedModuleSource("Foo"));
      },
      "normalizes camelCase directory segment to kebab-case",
    );

    // BUNEST_BUG: parseSchematicName rejects leading underscore segments ("_bar/_foo") instead of preserving underscores in path and filename while normalizing class name to FooModule (packages/cli/src/utils/naming.ts: VALID_SEGMENT_REGEX and toKebabCase)
    it.skip("should keep underscores in module's path and file name", () => {
      const planned = buildSchematicFiles(
        "module",
        parseSchematicName("_bar/_foo"),
        { flat: false, spec: true },
      );
      const file = findFile(planned, "_bar/_foo/_foo.module.ts");
      expect(file).toBeDefined();
      expect(file?.content).toEqual(expectedModuleSource("Foo"));
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should emit TypeScript module only (no language: 'js' mode on Bun)",
      () => {
        const planned = buildSchematicFiles(
          "module",
          parseSchematicName("foo"),
          { flat: false, spec: true },
        );
        expect(
          planned.every((file) => file.relativePath.endsWith(".ts")),
        ).toBe(true);
        expect(findFile(planned, "foo/foo.module.js")).toBeUndefined();
        expect(findFile(planned, "foo/foo.module.ts")?.content).toEqual(
          expectedModuleSource("Foo"),
        );
      },
      "Bunest is Bun-only native TypeScript with no JavaScript template variant",
    );

    // BUNEST_BUG: generateSchematic("module", ...) does not auto-import generated modules into parent src/app.module.ts (missing AST module declaration updater and skipImport option in packages/cli/src/commands/generate.ts)
    it.skip("should manage declaration in app module", async () => {
      const cwd = createTempDir();
      await generateSchematic({
        schematic: "application",
        name: "my-app",
        flat: true,
        cwd,
      });
      await generateSchematic({
        schematic: "module",
        name: "foo",
        cwd,
      });

      const appModule = readFileSync(join(cwd, "src/app.module.ts"), "utf8");
      expect(appModule).toContain('import { FooModule } from "./foo/foo.module";');
      expect(appModule).toContain("imports: [FooModule]");
    });

    // BUNEST_BUG: generateSchematic("module", ...) does not auto-import nested child modules into nearest parent module src/bar/bar.module.ts (missing module finder & declaration updater in packages/cli/src/commands/generate.ts)
    it.skip("should manage declaration in bar module", async () => {
      const cwd = createTempDir();
      await generateSchematic({
        schematic: "application",
        name: "my-app",
        flat: true,
        cwd,
      });
      await generateSchematic({
        schematic: "module",
        name: "bar",
        cwd,
      });
      await generateSchematic({
        schematic: "module",
        name: "bar/foo",
        cwd,
      });

      const barModule = readFileSync(
        join(cwd, "src/bar/bar.module.ts"),
        "utf8",
      );
      expect(barModule).toContain('import { FooModule } from "./foo/foo.module";');
      expect(barModule).toContain("imports: [FooModule]");
    });

    // BUNEST_BUG: generateSchematic("module", ...) does not auto-declare FooModule in src/app.module.ts for ESM projects (missing module declaration updater in packages/cli/src/commands/generate.ts)
    it.skip("should manage declaration in app module for ESM projects", async () => {
      const cwd = createTempDir();
      await generateSchematic({
        schematic: "application",
        name: "my-app",
        flat: true,
        cwd,
      });
      await generateSchematic({
        schematic: "module",
        name: "foo",
        cwd,
      });

      const appModule = readFileSync(join(cwd, "src/app.module.ts"), "utf8");
      expect(appModule).toContain('import { FooModule } from "./foo/foo.module";');
      expect(appModule).toContain("imports: [FooModule]");
    });
  },
);
