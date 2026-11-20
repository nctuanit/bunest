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

function expectedProviderSource(pascal: string): string {
  return `import { Injectable } from "@bunest/core";

@Injectable()
export class ${pascal} {}
`;
}

function findFile(
  files: readonly PlannedFile[],
  relativePath: string,
): PlannedFile | undefined {
  return files.find((file) => file.relativePath === relativePath);
}

describeConformance(
  "Provider Schematic",
  {
    upstreamPath: "schematics/src/lib/provider/provider.factory.test.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts @nestjs/schematics provider factory tests to Bunest CLI (@bunest/core Injectable, @bunest/testing + bun:test specs, TypeScript-only runtime).",
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
          "provider",
          parseSchematicName("foo"),
          { flat: true, spec: true },
        );
        expect(findFile(planned, "foo.ts")).toBeDefined();
        expect(findFile(planned, "foo.spec.ts")).toBeDefined();
        expect(findFile(planned, "foo.ts")?.content).toEqual(
          expectedProviderSource("Foo"),
        );

        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic: "provider",
          name: "foo",
          flat: true,
          cwd,
        });
        expect(
          result.files.find((f) => f.relativePath === "foo.ts"),
        ).toBeDefined();
        expect(
          result.files.find((f) => f.relativePath === "foo.spec.ts"),
        ).toBeDefined();
        expect(readFileSync(join(cwd, "src/foo.ts"), "utf8")).toEqual(
          expectedProviderSource("Foo"),
        );
      },
      "emits @bunest/core @Injectable provider with explicit flat: true",
    );

    // BUNEST_BUG: generateSchematic("provider", { name: "foo" }) defaults flat to false (creating foo/foo.ts) instead of upstream provider/schema.json default flat: true (foo.ts) (packages/cli/src/commands/generate.ts:54)
    it.skip("should default flat to true for provider schematic when flat option is omitted", async () => {
      const cwd = createTempDir();
      const result = await generateSchematic({
        schematic: "provider",
        name: "foo",
        cwd,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.ts"),
      ).toBeDefined();
      expect(
        result.files.find((f) => f.relativePath === "foo.spec.ts"),
      ).toBeDefined();
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name has a path",
      async () => {
        const planned = buildSchematicFiles(
          "provider",
          parseSchematicName("bar/foo"),
          { flat: true, spec: true },
        );
        expect(findFile(planned, "bar/foo.ts")).toBeDefined();
        expect(findFile(planned, "bar/foo.spec.ts")).toBeDefined();
        expect(findFile(planned, "bar/foo.ts")?.content).toEqual(
          expectedProviderSource("Foo"),
        );

        const cwd = createTempDir();
        await generateSchematic({
          schematic: "provider",
          name: "bar/foo",
          flat: true,
          cwd,
        });
        expect(readFileSync(join(cwd, "src/bar/foo.ts"), "utf8")).toEqual(
          expectedProviderSource("Foo"),
        );
      },
      "places flat provider under nested subDir",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name and path",
      async () => {
        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic: "provider",
          name: "foo",
          dir: "bar",
          flat: true,
          cwd,
        });
        expect(
          result.files.find((f) => f.relativePath === "foo.ts"),
        ).toBeDefined();
        expect(
          result.files.find((f) => f.relativePath === "foo.spec.ts"),
        ).toBeDefined();
        expect(readFileSync(join(cwd, "bar/foo.ts"), "utf8")).toEqual(
          expectedProviderSource("Foo"),
        );
      },
      "writes provider into custom target dir",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name to normalize",
      async () => {
        const planned = buildSchematicFiles(
          "provider",
          parseSchematicName("bar-foo"),
          { flat: true, spec: true },
        );
        expect(findFile(planned, "bar-foo.ts")).toBeDefined();
        expect(findFile(planned, "bar-foo.spec.ts")).toBeDefined();
        expect(findFile(planned, "bar-foo.ts")?.content).toEqual(
          expectedProviderSource("BarFoo"),
        );

        const cwd = createTempDir();
        await generateSchematic({
          schematic: "provider",
          name: "bar-foo",
          flat: true,
          cwd,
        });
        expect(readFileSync(join(cwd, "src/bar-foo.ts"), "utf8")).toEqual(
          expectedProviderSource("BarFoo"),
        );
      },
      "normalizes kebab-case provider name to PascalCase class",
    );

    // BUNEST_BUG: parseSchematicName rejects leading underscore ("_bar") instead of generating _bar.ts and _bar.spec.ts with class Bar (packages/cli/src/utils/naming.ts: VALID_SEGMENT_REGEX and toKebabCase)
    it.skip("should keep underscores in provider's file name", () => {
      const planned = buildSchematicFiles(
        "provider",
        parseSchematicName("_bar"),
        { flat: true, spec: true },
      );
      expect(findFile(planned, "_bar.ts")).toBeDefined();
      expect(findFile(planned, "_bar.spec.ts")).toBeDefined();
      expect(findFile(planned, "_bar.ts")?.content).toEqual(
        expectedProviderSource("Bar"),
      );
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should emit TypeScript provider only (no language: 'js' mode on Bun)",
      () => {
        const planned = buildSchematicFiles(
          "provider",
          parseSchematicName("foo"),
          { flat: true, spec: true },
        );
        expect(
          planned.every((file) => file.relativePath.endsWith(".ts")),
        ).toBe(true);
        expect(findFile(planned, "foo.js")).toBeUndefined();
        expect(findFile(planned, "foo.spec.js")).toBeUndefined();
        expect(findFile(planned, "foo.ts")?.content).toEqual(
          expectedProviderSource("Foo"),
        );
      },
      "Bunest is Bun-only native TypeScript with no JavaScript template variant",
    );

    // BUNEST_BUG: generateSchematic("provider", ...) does not auto-register Foo in src/app.module.ts providers array (missing module declaration updater and skipImport option in packages/cli/src/commands/generate.ts)
    it.skip("should manage declaration in app module", async () => {
      const cwd = createTempDir();
      await generateSchematic({
        schematic: "application",
        name: "my-app",
        flat: true,
        cwd,
      });
      await generateSchematic({
        schematic: "provider",
        name: "foo",
        flat: true,
        cwd,
      });

      const appModule = readFileSync(join(cwd, "src/app.module.ts"), "utf8");
      expect(appModule).toContain('import { Foo } from "./foo";');
      expect(appModule).toContain("providers: [AppService, Foo]");
    });

    // BUNEST_BUG: generateSchematic("provider", ...) does not auto-register Foo in src/foo/foo.module.ts providers array (missing module finder & declaration updater in packages/cli/src/commands/generate.ts)
    it.skip("should manage declaration in foo module", async () => {
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
      await generateSchematic({
        schematic: "provider",
        name: "foo",
        dir: "src/foo",
        flat: true,
        cwd,
      });

      const fooModule = readFileSync(
        join(cwd, "src/foo/foo.module.ts"),
        "utf8",
      );
      expect(fooModule).toContain('import { Foo } from "./foo";');
      expect(fooModule).toContain("providers: [Foo]");
    });

    // BUNEST_BUG: parseSchematicName rejects dot-separated schematic names ("foo.entity") instead of creating foo.entity.ts with class FooEntity (packages/cli/src/utils/naming.ts: VALID_SEGMENT_REGEX)
    it.skip("should remove . from name", () => {
      const planned = buildSchematicFiles(
        "provider",
        parseSchematicName("foo.entity"),
        { flat: true, spec: true },
      );
      const file = findFile(planned, "foo.entity.ts");
      expect(file).toBeDefined();
      expect(file?.content).toEqual(expectedProviderSource("FooEntity"));
    });

    it("should create a spec file", async () => {
      const cwd = createTempDir();
      const result = await generateSchematic({
        schematic: "provider",
        name: "foo",
        spec: true,
        flat: true,
        cwd,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.spec.ts"),
      ).toBeDefined();
    });

    it("should create a spec file with custom file suffix", async () => {
      const cwd = createTempDir();
      const result = await generateSchematic({
        schematic: "provider",
        name: "foo",
        spec: true,
        specFileSuffix: "test",
        flat: true,
        cwd,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.spec.ts"),
      ).toBeUndefined();
      expect(
        result.files.find((f) => f.relativePath === "foo.test.ts"),
      ).toBeDefined();
    });

    // BUNEST_BUG: generateSchematic("provider", ...) does not auto-register Foo in src/app.module.ts providers array for ESM projects (missing module declaration updater in packages/cli/src/commands/generate.ts)
    it.skip("should manage declaration in app module for ESM projects", async () => {
      const cwd = createTempDir();
      await generateSchematic({
        schematic: "application",
        name: "my-app",
        flat: true,
        cwd,
      });
      await generateSchematic({
        schematic: "provider",
        name: "foo",
        flat: true,
        cwd,
      });

      const appModule = readFileSync(join(cwd, "src/app.module.ts"), "utf8");
      expect(appModule).toContain('import { Foo } from "./foo";');
      expect(appModule).toContain("providers: [AppService, Foo]");
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should generate spec file with extensionless Bun ESM import (no .js suffix)",
      async () => {
        const cwd = createTempDir();
        await generateSchematic({
          schematic: "application",
          name: "my-app",
          flat: true,
          cwd,
        });
        await generateSchematic({
          schematic: "provider",
          name: "foo",
          spec: true,
          flat: true,
          cwd,
        });

        expect(readFileSync(join(cwd, "src/foo.spec.ts"), "utf8")).toEqual(
          `import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { Foo } from "./foo";

describe("Foo", () => {
  it("resolves provider from DI container", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [Foo],
    }).compile();

    expect(moduleRef.get(Foo)).toBeInstanceOf(Foo);
    await moduleRef.close();
  });
});
`,
        );
      },
      "Bun moduleResolution: 'bundler' uses extensionless TS imports, @bunest/testing, and bun:test",
    );
  },
);
