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
        expect(readTextSync(join(cwd, "src/foo.ts"))).toEqual(
          expectedProviderSource("Foo"),
        );
      },
      "emits @bunest/core @Injectable provider with explicit flat: true",
    );

    it("should default flat to true for provider schematic when flat option is omitted", async () => {
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
        expect(readTextSync(join(cwd, "src/bar/foo.ts"))).toEqual(
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
        expect(readTextSync(join(cwd, "bar/foo.ts"))).toEqual(
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
        expect(readTextSync(join(cwd, "src/bar-foo.ts"))).toEqual(
          expectedProviderSource("BarFoo"),
        );
      },
      "normalizes kebab-case provider name to PascalCase class",
    );

    it("should keep underscores in provider's file name", () => {
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
        expect(planned.every((file) => file.relativePath.endsWith(".ts"))).toBe(
          true,
        );
        expect(findFile(planned, "foo.js")).toBeUndefined();
        expect(findFile(planned, "foo.spec.js")).toBeUndefined();
        expect(findFile(planned, "foo.ts")?.content).toEqual(
          expectedProviderSource("Foo"),
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
        schematic: "provider",
        name: "foo",
        flat: true,
        cwd,
      });

      const appModule = readTextSync(join(cwd, "src/app.module.ts"));
      expect(appModule).toContain('import { Foo } from "./foo";');
      expect(appModule).toContain("providers: [AppService, Foo]");
    });

    it("should manage declaration in foo module", async () => {
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

      const fooModule = readTextSync(join(cwd, "src/foo/foo.module.ts"));
      expect(fooModule).toContain('import { Foo } from "./foo";');
      expect(fooModule).toContain("providers: [Foo]");
    });

    it("should remove . from name", () => {
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

    it("should manage declaration in app module for ESM projects", async () => {
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

      const appModule = readTextSync(join(cwd, "src/app.module.ts"));
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

        expect(readTextSync(join(cwd, "src/foo.spec.ts"))).toEqual(
          `import { describe, expect, it } from "bun:test";
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
