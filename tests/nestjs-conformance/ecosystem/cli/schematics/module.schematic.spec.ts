import { afterEach, expect, it } from "bun:test";
import {
  join,
  mkdirSyncPath,
  readTextSync,
  removePath,
} from "../../../../../packages/core/src";
import {
  buildSchematicFiles,
  generateSchematic,
  parseSchematicName,
  type PlannedFile,
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
          readTextSync(join(cwd, "src/foo/foo.module.ts")),
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
          readTextSync(join(cwd, "src/bar/foo/foo.module.ts")),
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
          readTextSync(join(cwd, "bar/foo/foo.module.ts")),
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
          readTextSync(join(cwd, "src/foo-bar/foo-bar.module.ts")),
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
        expect(
          readTextSync(join(cwd, "src/foo-bar.module.ts")),
        ).toEqual(expectedModuleSource("FooBar"));
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
          readTextSync(join(cwd, "src/bar-baz/foo/foo.module.ts")),
        ).toEqual(expectedModuleSource("Foo"));
      },
      "normalizes camelCase directory segment to kebab-case",
    );

    it("should keep underscores in module's path and file name", () => {
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
        expect(planned.every((file) => file.relativePath.endsWith(".ts"))).toBe(
          true,
        );
        expect(findFile(planned, "foo/foo.module.js")).toBeUndefined();
        expect(findFile(planned, "foo/foo.module.ts")?.content).toEqual(
          expectedModuleSource("Foo"),
        );
      },
      "Bunest is Bun-only native TypeScript with no JavaScript template variant",
    );

    it("should manage declaration in app module", async () => {
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

      const appModule = readTextSync(join(cwd, "src/app.module.ts"));
      expect(appModule).toContain(
        'import { FooModule } from "./foo/foo.module";',
      );
      expect(appModule).toContain("imports: [FooModule]");
    });

    it("should manage declaration in bar module", async () => {
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

      const barModule = readTextSync(join(cwd, "src/bar/bar.module.ts"));
      expect(barModule).toContain(
        'import { FooModule } from "./foo/foo.module";',
      );
      expect(barModule).toContain("imports: [FooModule]");
    });

    it("should manage declaration in app module for ESM projects", async () => {
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

      const appModule = readTextSync(join(cwd, "src/app.module.ts"));
      expect(appModule).toContain(
        'import { FooModule } from "./foo/foo.module";',
      );
      expect(appModule).toContain("imports: [FooModule]");
    });
  },
);
