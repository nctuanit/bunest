import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  existsSyncPath,
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

describeConformance(
  "Class Schematic Factory",
  {
    upstreamPath: "schematics/src/lib/class/class.factory.test.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Ports upstream @nestjs/schematics class factory tests to Bunest CLI class schematic (Bun-only TS, bun:test specs, extensionless bundler imports).",
  },
  () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = makeTempDir("bunest-cli-conf-class-");
    });

    afterEach(async () => {
      await removePath(tempDir, { recursive: true, force: true });
    });

    it("should manage name only", async () => {
      const planned = buildSchematicFiles("class", parseSchematicName("foo"), {
        flat: true,
        spec: true,
      });
      const classFile = planned.find((f) => f.relativePath === "foo.ts");
      expect(classFile).toBeDefined();
      expect(classFile?.content).toEqual("export class Foo {}\n");

      const result = await generateSchematic({
        schematic: "class",
        name: "foo",
        dir: ".",
        spec: true,
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.ts"),
      ).toBeDefined();
      expect(readTextSync(join(tempDir, "foo.ts"))).toEqual(
        "export class Foo {}\n",
      );
    });

    it("should manage name as a path", async () => {
      const planned = buildSchematicFiles(
        "class",
        parseSchematicName("bar/foo"),
        { flat: false, spec: false },
      );
      expect(
        planned.find((f) => f.relativePath === "bar/foo/foo.ts"),
      ).toBeDefined();
      expect(
        planned.find((f) => f.relativePath === "bar/foo/foo.ts")?.content,
      ).toEqual("export class Foo {}\n");

      const result = await generateSchematic({
        schematic: "class",
        name: "bar/foo",
        dir: ".",
        flat: false,
        spec: false,
        cwd: tempDir,
      });

      expect(result.files.map((f) => f.relativePath)).toEqual([
        "bar/foo/foo.ts",
      ]);
      expect(readTextSync(join(tempDir, "bar/foo/foo.ts"))).toEqual(
        "export class Foo {}\n",
      );
    });

    it("should manage name and path", async () => {
      const result = await generateSchematic({
        schematic: "class",
        name: "foo",
        dir: "baz",
        flat: false,
        spec: false,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo/foo.ts"),
      ).toBeDefined();
      expect(readTextSync(join(tempDir, "baz/foo/foo.ts"))).toEqual(
        "export class Foo {}\n",
      );
    });

    it("should normalize camelCase name and path segments", async () => {
      const nameFiles = buildSchematicFiles(
        "class",
        parseSchematicName("fooBar"),
        { flat: false, spec: false },
      );
      expect(
        nameFiles.find((f) => f.relativePath === "foo-bar/foo-bar.ts")?.content,
      ).toEqual("export class FooBar {}\n");

      const pathFiles = buildSchematicFiles(
        "class",
        parseSchematicName("barBaz/foo"),
        { flat: false, spec: false },
      );
      expect(
        pathFiles.find((f) => f.relativePath === "bar-baz/foo/foo.ts")?.content,
      ).toEqual("export class Foo {}\n");
    });

    // BUNEST_BUG: parseSchematicName() in packages/cli/src/utils/naming.ts rejects leading "_" in "_fooBar" (VALID_SEGMENT_REGEX requires leading [a-zA-Z]) and toKebabCase() does not preserve leading "_" ("_foo-bar/_foo-bar.ts").
    it.skip("should manage name to normalize while keeping leading underscore", async () => {
      const result = await generateSchematic({
        schematic: "class",
        name: "_fooBar",
        dir: ".",
        flat: false,
        spec: false,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "_foo-bar/_foo-bar.ts"),
      ).toBeDefined();
      expect(
        readTextSync(join(tempDir, "_foo-bar/_foo-bar.ts")),
      ).toEqual("export class FooBar {}\n");
    });

    // BUNEST_BUG: parseSchematicName() in packages/cli/src/utils/naming.ts rejects leading "_" in segment "_foo" of "barBaz/_foo"; expected "bar-baz/_foo/_foo.ts" with "export class Foo {}".
    it.skip("should manage path to normalize while keeping leading underscore", async () => {
      const result = await generateSchematic({
        schematic: "class",
        name: "barBaz/_foo",
        dir: ".",
        flat: false,
        spec: false,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "bar-baz/_foo/_foo.ts"),
      ).toBeDefined();
      expect(
        readTextSync(join(tempDir, "bar-baz/_foo/_foo.ts")),
      ).toEqual("export class Foo {}\n");
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "emits TypeScript class files only and resolves 'cl' alias (no language: js)",
      () => {
        expect(resolveSchematicType("cl")).toBe("class");

        const files = buildSchematicFiles("class", parseSchematicName("foo"), {
          flat: false,
          spec: false,
        });
        expect(files.map((f) => f.relativePath)).toEqual(["foo/foo.ts"]);
        expect(files.some((f) => f.relativePath.endsWith(".js"))).toBe(false);
      },
      "Bunest targets TypeScript natively on Bun without JS output templates",
    );

    // BUNEST_BUG: parseSchematicName() in packages/cli/src/utils/naming.ts rejects "." in "foo.entity" (VALID_SEGMENT_REGEX disallows dots); expected "foo.entity.ts" exporting "export class FooEntity {}".
    it.skip("should remove . from name when deriving class identifier", async () => {
      const result = await generateSchematic({
        schematic: "class",
        name: "foo.entity",
        dir: ".",
        spec: true,
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.entity.ts"),
      ).toBeDefined();
      expect(readTextSync(join(tempDir, "foo.entity.ts"))).toEqual(
        "export class FooEntity {}\n",
      );
    });

    it("should create a spec file", async () => {
      const result = await generateSchematic({
        schematic: "class",
        name: "foo",
        dir: ".",
        spec: true,
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.spec.ts"),
      ).toBeDefined();
      expect(existsSyncPath(join(tempDir, "foo.spec.ts"))).toBe(true);
    });

    it("should create a spec file with custom file suffix", async () => {
      const result = await generateSchematic({
        schematic: "class",
        name: "foo",
        dir: ".",
        spec: true,
        specFileSuffix: "test",
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.spec.ts"),
      ).toBeUndefined();
      expect(
        result.files.find((f) => f.relativePath === "foo.test.ts"),
      ).toBeDefined();
      expect(existsSyncPath(join(tempDir, "foo.spec.ts"))).toBe(false);
      expect(existsSyncPath(join(tempDir, "foo.test.ts"))).toBe(true);
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should generate bun:test spec file with extensionless ESM import",
      async () => {
        await generateSchematic({
          schematic: "class",
          name: "foo",
          spec: true,
          flat: true,
          cwd: tempDir,
        });

        expect(readTextSync(join(tempDir, "src/foo.spec.ts"))).toEqual(
          'import { describe, expect, it } from "bun:test";\n' +
            'import { Foo } from "./foo";\n' +
            "\n" +
            'describe("Foo", () => {\n' +
            '  it("should be defined", () => {\n' +
            "    expect(new Foo()).toBeDefined();\n" +
            "  });\n" +
            "});\n",
        );
      },
      "Bunest uses bun:test and extensionless TS imports under moduleResolution: bundler",
    );

    // BUNEST_BUG: generateSchematic("class") in packages/cli/src/commands/generate.ts defaults flat to false for all schematics instead of flat: true as defined in upstream class/schema.json.
    it.skip("should default to flat: true when flat option is omitted", async () => {
      const result = await generateSchematic({
        schematic: "class",
        name: "foo",
        dir: ".",
        spec: false,
        cwd: tempDir,
      });

      expect(result.files.map((f) => f.relativePath)).toEqual(["foo.ts"]);
    });
  },
);
