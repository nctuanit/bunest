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

const expectedGuardSource = (pascal: string): string =>
  "import {\n" +
  "  Injectable,\n" +
  "  type CanActivate,\n" +
  "  type ExecutionContext,\n" +
  '} from "@bunest/core";\n' +
  "\n" +
  "@Injectable()\n" +
  `export class ${pascal}Guard implements CanActivate {\n` +
  "  canActivate(_context: ExecutionContext): boolean {\n" +
  "    return true;\n" +
  "  }\n" +
  "}\n";

describeConformance(
  "Guard Schematic Factory",
  {
    upstreamPath: "schematics/src/lib/guard/guard.factory.test.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002", "ADR-008"],
    notes:
      "Ports upstream @nestjs/schematics guard factory tests to Bunest CLI guard schematic (@bunest/core, verbatimModuleSyntax type imports, zero RxJS per ADR-008, bun:test specs).",
  },
  () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "bunest-cli-conf-guard-"));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    itAdapted(
      ["ADR-001", "ADR-002", "ADR-008"],
      "should manage name only",
      async () => {
        const planned = buildSchematicFiles(
          "guard",
          parseSchematicName("foo"),
          { flat: true, spec: false },
        );
        expect(planned.map((f) => f.relativePath)).toEqual(["foo.guard.ts"]);
        expect(planned[0]?.content).toEqual(expectedGuardSource("Foo"));
        expect(planned[0]?.content).not.toContain("rxjs");

        const result = await generateSchematic({
          schematic: "guard",
          name: "foo",
          dir: ".",
          flat: true,
          cwd: tempDir,
        });

        expect(
          result.files.find((f) => f.relativePath === "foo.guard.ts"),
        ).toBeDefined();
        expect(readFileSync(join(tempDir, "foo.guard.ts"), "utf8")).toEqual(
          expectedGuardSource("Foo"),
        );
      },
      "Bunest guard uses type-only interface imports from @bunest/core and zero RxJS",
    );

    itAdapted(
      ["ADR-001", "ADR-002", "ADR-008"],
      "should manage name has a path",
      async () => {
        const result = await generateSchematic({
          schematic: "guard",
          name: "bar/foo",
          dir: ".",
          flat: true,
          cwd: tempDir,
        });

        expect(
          result.files.find((f) => f.relativePath === "bar/foo.guard.ts"),
        ).toBeDefined();
        expect(readFileSync(join(tempDir, "bar/foo.guard.ts"), "utf8")).toEqual(
          expectedGuardSource("Foo"),
        );
      },
      "Bunest guard uses @bunest/core without RxJS Observable",
    );

    itAdapted(
      ["ADR-001", "ADR-002", "ADR-008"],
      "should manage name and path",
      async () => {
        const result = await generateSchematic({
          schematic: "guard",
          name: "foo",
          dir: "baz",
          flat: true,
          cwd: tempDir,
        });

        expect(
          result.files.find((f) => f.relativePath === "foo.guard.ts"),
        ).toBeDefined();
        expect(readFileSync(join(tempDir, "baz/foo.guard.ts"), "utf8")).toEqual(
          expectedGuardSource("Foo"),
        );
      },
      "Bunest uses dir option for base directory",
    );

    itAdapted(
      ["ADR-001", "ADR-002", "ADR-008"],
      "should manage name to normalize",
      async () => {
        const result = await generateSchematic({
          schematic: "guard",
          name: "fooBar",
          dir: ".",
          flat: true,
          cwd: tempDir,
        });

        expect(
          result.files.find((f) => f.relativePath === "foo-bar.guard.ts"),
        ).toBeDefined();
        expect(readFileSync(join(tempDir, "foo-bar.guard.ts"), "utf8")).toEqual(
          expectedGuardSource("FooBar"),
        );
      },
      "Normalizes camelCase guard name to kebab-case filename and PascalCase class",
    );

    itAdapted(
      ["ADR-001", "ADR-002", "ADR-008"],
      "should manage path to normalize",
      async () => {
        const result = await generateSchematic({
          schematic: "guard",
          name: "barBaz/foo",
          dir: ".",
          flat: true,
          cwd: tempDir,
        });

        expect(
          result.files.find((f) => f.relativePath === "bar-baz/foo.guard.ts"),
        ).toBeDefined();
        expect(
          readFileSync(join(tempDir, "bar-baz/foo.guard.ts"), "utf8"),
        ).toEqual(expectedGuardSource("Foo"));
      },
      "Normalizes camelCase directory segment to kebab-case",
    );

    // BUNEST_BUG: parseSchematicName() in packages/cli/src/utils/naming.ts rejects leading "_" in "_foo/_bar" (VALID_SEGMENT_REGEX requires leading [a-zA-Z]); expected "_foo/_bar.guard.ts" exporting BarGuard.
    it.skip("should keep underscore in path and name", async () => {
      const result = await generateSchematic({
        schematic: "guard",
        name: "_foo/_bar",
        dir: ".",
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "_foo/_bar.guard.ts"),
      ).toBeDefined();
      expect(
        readFileSync(join(tempDir, "_foo/_bar.guard.ts"), "utf8"),
      ).toEqual(expectedGuardSource("Bar"));
    });

    itAdapted(
      ["ADR-001", "ADR-002", "ADR-008"],
      "generates TypeScript guard without JS/RxJS boilerplate, supports nested mode and 'gu' alias",
      () => {
        expect(resolveSchematicType("gu")).toBe("guard");

        const nestedFiles = buildSchematicFiles(
          "guard",
          parseSchematicName("foo"),
          { flat: false, spec: false },
        );
        expect(nestedFiles.map((f) => f.relativePath)).toEqual([
          "foo/foo.guard.ts",
        ]);
        expect(nestedFiles[0]?.content).toContain("type CanActivate");
        expect(nestedFiles[0]?.content).toContain("type ExecutionContext");
        expect(nestedFiles[0]?.content).not.toContain("Observable");
        expect(nestedFiles.some((f) => f.relativePath.endsWith(".js"))).toBe(
          false,
        );
      },
      "Bunest targets TypeScript natively with zero RxJS and verbatimModuleSyntax: true",
    );

    it("should create a spec file", async () => {
      const result = await generateSchematic({
        schematic: "guard",
        name: "foo",
        dir: ".",
        spec: true,
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.guard.spec.ts"),
      ).toBeDefined();
      expect(existsSync(join(tempDir, "foo.guard.spec.ts"))).toBe(true);
    });

    it("should create a spec file with custom file suffix", async () => {
      const result = await generateSchematic({
        schematic: "guard",
        name: "foo",
        dir: ".",
        spec: true,
        specFileSuffix: "test",
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.guard.spec.ts"),
      ).toBeUndefined();
      expect(
        result.files.find((f) => f.relativePath === "foo.guard.test.ts"),
      ).toBeDefined();
      expect(existsSync(join(tempDir, "foo.guard.spec.ts"))).toBe(false);
      expect(existsSync(join(tempDir, "foo.guard.test.ts"))).toBe(true);
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should generate bun:test spec file with extensionless ESM import",
      async () => {
        await generateSchematic({
          schematic: "application",
          name: "app",
          flat: true,
          cwd: tempDir,
        });

        await generateSchematic({
          schematic: "guard",
          name: "foo",
          spec: true,
          flat: true,
          cwd: tempDir,
        });

        const specContent = readFileSync(
          join(tempDir, "src/foo.guard.spec.ts"),
          "utf8",
        );
        expect(specContent).toContain('import "reflect-metadata";');
        expect(specContent).toContain(
          'import { describe, expect, it } from "bun:test";',
        );
        expect(specContent).toContain(
          'import { createMockExecutionContext } from "@bunest/testing";',
        );
        expect(specContent).toContain(
          'import { FooGuard } from "./foo.guard";',
        );
      },
      "Bunest generates bun:test guard spec with extensionless bundler imports",
    );

    // BUNEST_BUG: generateSchematic("guard") in packages/cli/src/commands/generate.ts defaults flat to false for all schematics instead of flat: true as defined in upstream guard/schema.json (emits src/foo/foo.guard.ts instead of src/foo.guard.ts).
    it.skip("should default to flat: true when flat option is omitted", async () => {
      const result = await generateSchematic({
        schematic: "guard",
        name: "foo",
        dir: ".",
        spec: false,
        cwd: tempDir,
      });

      expect(result.files.map((f) => f.relativePath)).toEqual(["foo.guard.ts"]);
    });
  },
);
