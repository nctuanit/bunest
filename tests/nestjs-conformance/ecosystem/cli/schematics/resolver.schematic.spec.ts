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

function expectedResolverSource(
  pascal: string,
  camel: string,
  kebab: string,
): string {
  return `import { Query, Resolver } from "@bunest/graphql";

@Resolver()
export class ${pascal}Resolver {
  @Query(() => String)
  ${camel}(): string {
    return "${kebab}:ok";
  }
}
`;
}

function findFile(
  files: readonly PlannedFile[],
  relativePath: string,
): PlannedFile | undefined {
  return files.find((file) => file.relativePath === relativePath);
}

describeConformance(
  "Resolver Schematic",
  {
    upstreamPath: "schematics/src/lib/resolver/resolver.factory.test.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts @nestjs/schematics resolver factory tests to Bunest CLI (@bunest/graphql @Resolver/@Query template, bun:test specs, TypeScript-only runtime).",
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
          "resolver",
          parseSchematicName("foo"),
          { flat: false, spec: true },
        );
        const file = findFile(planned, "foo/foo.resolver.ts");
        expect(file).toBeDefined();
        expect(file?.content).toEqual(
          expectedResolverSource("Foo", "foo", "foo"),
        );

        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic: "resolver",
          name: "foo",
          flat: false,
          cwd,
        });
        expect(
          result.files.find((f) => f.relativePath === "foo/foo.resolver.ts"),
        ).toBeDefined();
        expect(
          readFileSync(join(cwd, "src/foo/foo.resolver.ts"), "utf8"),
        ).toEqual(expectedResolverSource("Foo", "foo", "foo"));
      },
      "emits @bunest/graphql @Resolver with starter @Query method",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name as a path",
      async () => {
        const planned = buildSchematicFiles(
          "resolver",
          parseSchematicName("bar/foo"),
          { flat: false, spec: true },
        );
        const file = findFile(planned, "bar/foo/foo.resolver.ts");
        expect(file).toBeDefined();
        expect(file?.content).toEqual(
          expectedResolverSource("Foo", "foo", "foo"),
        );

        const cwd = createTempDir();
        await generateSchematic({
          schematic: "resolver",
          name: "bar/foo",
          flat: false,
          cwd,
        });
        expect(
          readFileSync(join(cwd, "src/bar/foo/foo.resolver.ts"), "utf8"),
        ).toEqual(expectedResolverSource("Foo", "foo", "foo"));
      },
      "emits resolver under nested folder path",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name and path",
      async () => {
        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic: "resolver",
          name: "foo",
          dir: "baz",
          flat: false,
          cwd,
        });
        expect(
          result.files.find((f) => f.relativePath === "foo/foo.resolver.ts"),
        ).toBeDefined();
        expect(
          readFileSync(join(cwd, "baz/foo/foo.resolver.ts"), "utf8"),
        ).toEqual(expectedResolverSource("Foo", "foo", "foo"));
      },
      "writes resolver into custom target dir",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name to normalize",
      async () => {
        const planned = buildSchematicFiles(
          "resolver",
          parseSchematicName("fooBar"),
          { flat: false, spec: true },
        );
        const file = findFile(planned, "foo-bar/foo-bar.resolver.ts");
        expect(file).toBeDefined();
        expect(file?.content).toEqual(
          expectedResolverSource("FooBar", "fooBar", "foo-bar"),
        );

        const cwd = createTempDir();
        await generateSchematic({
          schematic: "resolver",
          name: "fooBar",
          flat: false,
          cwd,
        });
        expect(
          readFileSync(
            join(cwd, "src/foo-bar/foo-bar.resolver.ts"),
            "utf8",
          ),
        ).toEqual(expectedResolverSource("FooBar", "fooBar", "foo-bar"));
      },
      "normalizes camelCase name to kebab-case file, PascalCase class, and camelCase query",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage path to normalize",
      async () => {
        const planned = buildSchematicFiles(
          "resolver",
          parseSchematicName("barBaz/foo"),
          { flat: false, spec: true },
        );
        const file = findFile(planned, "bar-baz/foo/foo.resolver.ts");
        expect(file).toBeDefined();
        expect(file?.content).toEqual(
          expectedResolverSource("Foo", "foo", "foo"),
        );

        const cwd = createTempDir();
        await generateSchematic({
          schematic: "resolver",
          name: "barBaz/foo",
          flat: false,
          cwd,
        });
        expect(
          readFileSync(
            join(cwd, "src/bar-baz/foo/foo.resolver.ts"),
            "utf8",
          ),
        ).toEqual(expectedResolverSource("Foo", "foo", "foo"));
      },
      "normalizes camelCase directory segment to kebab-case",
    );

    // BUNEST_BUG: parseSchematicName rejects leading underscore segments ("_bar/_foo") instead of preserving underscores in path and filename while normalizing class name to FooResolver (packages/cli/src/utils/naming.ts: VALID_SEGMENT_REGEX and toKebabCase)
    it.skip("should keep underscores in resolver's path and file name", () => {
      const planned = buildSchematicFiles(
        "resolver",
        parseSchematicName("_bar/_foo"),
        { flat: false, spec: true },
      );
      const file = findFile(planned, "_bar/_foo/_foo.resolver.ts");
      expect(file).toBeDefined();
      expect(file?.content).toEqual(
        expectedResolverSource("Foo", "foo", "_foo"),
      );
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should emit TypeScript resolver only (no language: 'js' mode on Bun)",
      () => {
        const planned = buildSchematicFiles(
          "resolver",
          parseSchematicName("foo"),
          { flat: false, spec: true },
        );
        expect(
          planned.every((file) => file.relativePath.endsWith(".ts")),
        ).toBe(true);
        expect(findFile(planned, "foo/foo.resolver.js")).toBeUndefined();
        expect(findFile(planned, "foo/foo.resolver.ts")?.content).toEqual(
          expectedResolverSource("Foo", "foo", "foo"),
        );
      },
      "Bunest is Bun-only native TypeScript with no JavaScript template variant",
    );

    it("should create a spec file", async () => {
      const cwd = createTempDir();
      const result = await generateSchematic({
        schematic: "resolver",
        name: "foo",
        spec: true,
        flat: true,
        cwd,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.resolver.spec.ts"),
      ).toBeDefined();
    });

    it("should create a spec file with custom file suffix", async () => {
      const cwd = createTempDir();
      const result = await generateSchematic({
        schematic: "resolver",
        name: "foo",
        spec: true,
        specFileSuffix: "test",
        flat: true,
        cwd,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.resolver.spec.ts"),
      ).toBeUndefined();
      expect(
        result.files.find((f) => f.relativePath === "foo.resolver.test.ts"),
      ).toBeDefined();
    });

    // BUNEST_BUG: generateSchematic("resolver", ...) does not auto-register FooResolver in src/app.module.ts providers array (missing module declaration updater and skipImport option in packages/cli/src/commands/generate.ts)
    it.skip("should manage declaration in app module for ESM projects", async () => {
      const cwd = createTempDir();
      await generateSchematic({
        schematic: "application",
        name: "my-app",
        flat: true,
        cwd,
      });
      await generateSchematic({
        schematic: "resolver",
        name: "foo",
        cwd,
      });

      const appModule = readFileSync(join(cwd, "src/app.module.ts"), "utf8");
      expect(appModule).toContain(
        'import { FooResolver } from "./foo/foo.resolver";',
      );
      expect(appModule).toContain("providers: [AppService, FooResolver]");
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
          schematic: "resolver",
          name: "foo",
          spec: true,
          flat: true,
          cwd,
        });

        expect(
          readFileSync(join(cwd, "src/foo.resolver.spec.ts"), "utf8"),
        ).toEqual(
          `import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { FooResolver } from "./foo.resolver";

describe("FooResolver", () => {
  it("resolves query field", () => {
    const resolver = new FooResolver();
    expect(resolver.foo()).toBe("foo:ok");
  });
});
`,
        );
      },
      "Bun moduleResolution: 'bundler' uses extensionless TS imports and bun:test",
    );
  },
);
