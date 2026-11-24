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
import { describeConformance } from "../../../_helpers/index";

function makeTempDir(prefix: string): string {
  const dir = join(
    Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
    `${prefix}${crypto.randomUUID()}`,
  );
  mkdirSyncPath(dir, { recursive: true });
  return dir;
}

describeConformance(
  "Interface Schematic Factory",
  {
    upstreamPath: "schematics/src/lib/interface/interface.factory.test.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Ports upstream @nestjs/schematics interface factory tests to Bunest CLI interface schematic.",
  },
  () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = makeTempDir("bunest-cli-conf-itf-");
    });

    afterEach(async () => {
      await removePath(tempDir, { recursive: true, force: true });
    });

    it("should manage name only", async () => {
      const planned = buildSchematicFiles(
        "interface",
        parseSchematicName("foo"),
        { flat: true, spec: true },
      );
      expect(planned.map((f) => f.relativePath)).toEqual(["foo.interface.ts"]);
      expect(planned[0]?.content).toEqual("export interface Foo {}\n");

      const result = await generateSchematic({
        schematic: "interface",
        name: "foo",
        dir: ".",
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.interface.ts"),
      ).toBeDefined();
      expect(readTextSync(join(tempDir, "foo.interface.ts"))).toEqual(
        "export interface Foo {}\n",
      );
    });

    it("should manage name as a path", async () => {
      const result = await generateSchematic({
        schematic: "interface",
        name: "bar/foo",
        dir: ".",
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "bar/foo.interface.ts"),
      ).toBeDefined();
      expect(
        readTextSync(join(tempDir, "bar/foo.interface.ts")),
      ).toEqual("export interface Foo {}\n");
    });

    it("should manage name and path", async () => {
      const result = await generateSchematic({
        schematic: "interface",
        name: "foo",
        dir: "baz",
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.interface.ts"),
      ).toBeDefined();
      expect(
        readTextSync(join(tempDir, "baz/foo.interface.ts")),
      ).toEqual("export interface Foo {}\n");
    });

    it("should manage name to normalize", async () => {
      const result = await generateSchematic({
        schematic: "interface",
        name: "fooBar",
        dir: ".",
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo-bar.interface.ts"),
      ).toBeDefined();
      expect(
        readTextSync(join(tempDir, "foo-bar.interface.ts")),
      ).toEqual("export interface FooBar {}\n");
    });

    it("should manage path to normalize", async () => {
      const result = await generateSchematic({
        schematic: "interface",
        name: "barBaz/foo",
        dir: ".",
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "bar-baz/foo.interface.ts"),
      ).toBeDefined();
      expect(
        readTextSync(join(tempDir, "bar-baz/foo.interface.ts")),
      ).toEqual("export interface Foo {}\n");
    });

    // BUNEST_BUG: parseSchematicName() in packages/cli/src/utils/naming.ts rejects leading "_" in "_bar/_foo" (VALID_SEGMENT_REGEX requires leading [a-zA-Z]); expected "_bar/_foo.interface.ts" containing "export interface Foo {}".
    it.skip("should keep underscores in interface's path and file names", async () => {
      const result = await generateSchematic({
        schematic: "interface",
        name: "_bar/_foo",
        dir: ".",
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "_bar/_foo.interface.ts"),
      ).toBeDefined();
      expect(
        readTextSync(join(tempDir, "_bar/_foo.interface.ts")),
      ).toEqual("export interface Foo {}\n");
    });

    it("supports nested mode (flat: false) and resolves 'itf' alias", () => {
      expect(resolveSchematicType("itf")).toBe("interface");

      const nested = buildSchematicFiles(
        "interface",
        parseSchematicName("foo"),
        { flat: false, spec: true },
      );
      expect(nested.map((f) => f.relativePath)).toEqual([
        "foo/foo.interface.ts",
      ]);
      expect(nested[0]?.content).toEqual("export interface Foo {}\n");
    });

    // BUNEST_BUG: generateSchematic("interface") in packages/cli/src/commands/generate.ts defaults flat to false for all schematics instead of flat: true as defined in upstream interface/schema.json (emits src/foo/foo.interface.ts instead of src/foo.interface.ts).
    it.skip("should default to flat: true when flat option is omitted", async () => {
      const result = await generateSchematic({
        schematic: "interface",
        name: "foo",
        dir: ".",
        cwd: tempDir,
      });

      expect(result.files.map((f) => f.relativePath)).toEqual([
        "foo.interface.ts",
      ]);
    });
  },
);
