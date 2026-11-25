import { afterEach, beforeEach, expect, it } from "bun:test";
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
  resolveSchematicType,
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

const expectedDecoratorSource = (kebab: string, pascal: string): string =>
  'import { SetMetadata } from "@bunest/core";\n' +
  "\n" +
  `export const ${pascal.toUpperCase()}_KEY = "${kebab}";\n` +
  "\n" +
  `export const ${pascal} = (...args: string[]) =>\n` +
  `  SetMetadata(${pascal.toUpperCase()}_KEY, args);\n`;

describeConformance(
  "Decorator Schematic Factory",
  {
    upstreamPath: "schematics/src/lib/decorator/decorator.factory.test.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Ports upstream @nestjs/schematics decorator factory tests to Bunest CLI decorator schematic (SetMetadata from @bunest/core, Bun-only TypeScript).",
  },
  () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = makeTempDir("bunest-cli-conf-dec-");
    });

    afterEach(async () => {
      await removePath(tempDir, { recursive: true, force: true });
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name only",
      async () => {
        const planned = buildSchematicFiles(
          "decorator",
          parseSchematicName("foo"),
          { flat: false, spec: true },
        );
        expect(planned.map((f) => f.relativePath)).toEqual([
          "foo/foo.decorator.ts",
        ]);
        expect(planned[0]?.content).toEqual(
          expectedDecoratorSource("foo", "Foo"),
        );

        const result = await generateSchematic({
          schematic: "decorator",
          name: "foo",
          dir: ".",
          flat: false,
          cwd: tempDir,
        });

        expect(
          result.files.find((f) => f.relativePath === "foo/foo.decorator.ts"),
        ).toBeDefined();
        expect(
          readTextSync(join(tempDir, "foo/foo.decorator.ts")),
        ).toEqual(expectedDecoratorSource("foo", "Foo"));
      },
      "Bunest decorator template uses SetMetadata from @bunest/core with exported metadata key",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name as a path",
      async () => {
        const result = await generateSchematic({
          schematic: "decorator",
          name: "bar/foo",
          dir: ".",
          flat: false,
          cwd: tempDir,
        });

        expect(
          result.files.find(
            (f) => f.relativePath === "bar/foo/foo.decorator.ts",
          ),
        ).toBeDefined();
        expect(
          readTextSync(join(tempDir, "bar/foo/foo.decorator.ts")),
        ).toEqual(expectedDecoratorSource("foo", "Foo"));
      },
      "Bunest decorator template uses SetMetadata from @bunest/core",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name and path",
      async () => {
        const result = await generateSchematic({
          schematic: "decorator",
          name: "foo",
          dir: "baz",
          flat: false,
          cwd: tempDir,
        });

        expect(
          result.files.find((f) => f.relativePath === "foo/foo.decorator.ts"),
        ).toBeDefined();
        expect(
          readTextSync(join(tempDir, "baz/foo/foo.decorator.ts")),
        ).toEqual(expectedDecoratorSource("foo", "Foo"));
      },
      "Bunest uses dir option for base directory",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name to normalize",
      async () => {
        const result = await generateSchematic({
          schematic: "decorator",
          name: "fooBar",
          dir: ".",
          flat: false,
          cwd: tempDir,
        });

        expect(
          result.files.find(
            (f) => f.relativePath === "foo-bar/foo-bar.decorator.ts",
          ),
        ).toBeDefined();
        expect(
          readTextSync(join(tempDir, "foo-bar/foo-bar.decorator.ts")),
        ).toEqual(expectedDecoratorSource("foo-bar", "FooBar"));
      },
      "Normalizes camelCase decorator name to kebab-case filename and PascalCase symbol",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage path to normalize",
      async () => {
        const result = await generateSchematic({
          schematic: "decorator",
          name: "barBaz/foo",
          dir: ".",
          flat: false,
          cwd: tempDir,
        });

        expect(
          result.files.find(
            (f) => f.relativePath === "bar-baz/foo/foo.decorator.ts",
          ),
        ).toBeDefined();
        expect(
          readTextSync(join(tempDir, "bar-baz/foo/foo.decorator.ts")),
        ).toEqual(expectedDecoratorSource("foo", "Foo"));
      },
      "Normalizes camelCase path segments to kebab-case",
    );

    it("should keep underscores on decorator's path and name", async () => {
      const result = await generateSchematic({
        schematic: "decorator",
        name: "_bar/_foo",
        dir: ".",
        flat: false,
        cwd: tempDir,
      });

      expect(
        result.files.find(
          (f) => f.relativePath === "_bar/_foo/_foo.decorator.ts",
        ),
      ).toBeDefined();
      expect(
        readTextSync(join(tempDir, "_bar/_foo/_foo.decorator.ts")),
      ).toEqual(expectedDecoratorSource("foo", "Foo"));
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "generates TypeScript decorator only, supports flat mode and 'd' alias (no language: js)",
      () => {
        expect(resolveSchematicType("d")).toBe("decorator");

        const flatFiles = buildSchematicFiles(
          "decorator",
          parseSchematicName("foo"),
          { flat: true, spec: true },
        );
        expect(flatFiles.map((f) => f.relativePath)).toEqual([
          "foo.decorator.ts",
        ]);
        expect(flatFiles.some((f) => f.relativePath.endsWith(".js"))).toBe(
          false,
        );
      },
      "Bunest targets TypeScript natively on Bun without JS output templates",
    );

    it("should default to flat: true when flat option is omitted", async () => {
      const result = await generateSchematic({
        schematic: "decorator",
        name: "foo",
        dir: ".",
        cwd: tempDir,
      });

      expect(result.files.map((f) => f.relativePath)).toEqual([
        "foo.decorator.ts",
      ]);
    });
  },
);
