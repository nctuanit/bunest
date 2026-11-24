import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  existsSyncPath,
  join,
  mkdirSyncPath,
  readTextSync,
  removePath,
  writeTextSync,
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

const expectedFilterSource = (pascal: string): string =>
  "import {\n" +
  "  Catch,\n" +
  "  HttpException,\n" +
  "  Injectable,\n" +
  "  type ArgumentsHost,\n" +
  "  type ExceptionFilter,\n" +
  '} from "@bunest/core";\n' +
  "\n" +
  "@Catch(HttpException)\n" +
  "@Injectable()\n" +
  `export class ${pascal}Filter implements ExceptionFilter<HttpException> {\n` +
  "  catch(exception: HttpException, host: ArgumentsHost): Response {\n" +
  "    const req = host.switchToHttp().getRequest<Request>();\n" +
  "    const payload = exception.toJSON();\n" +
  "    return Response.json(\n" +
  "      {\n" +
  "        ...payload,\n" +
  "        path: new URL(req.url).pathname,\n" +
  "        timestamp: new Date().toISOString(),\n" +
  "      },\n" +
  "      { status: exception.getStatus(), headers: exception.getHeaders() },\n" +
  "    );\n" +
  "  }\n" +
  "}\n";

describeConformance(
  "Filter Schematic Factory",
  {
    upstreamPath: "schematics/src/lib/filter/filter.factory.test.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Ports upstream @nestjs/schematics filter factory tests to Bunest CLI filter schematic (Web Standard Request/Response, verbatimModuleSyntax type imports, bun:test specs).",
  },
  () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = makeTempDir("bunest-cli-conf-filter-");
    });

    afterEach(async () => {
      await removePath(tempDir, { recursive: true, force: true });
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name only",
      async () => {
        const planned = buildSchematicFiles(
          "filter",
          parseSchematicName("foo"),
          { flat: true, spec: false },
        );
        expect(planned.map((f) => f.relativePath)).toEqual(["foo.filter.ts"]);
        expect(planned[0]?.content).toEqual(expectedFilterSource("Foo"));

        const result = await generateSchematic({
          schematic: "filter",
          name: "foo",
          dir: ".",
          flat: true,
          cwd: tempDir,
        });

        expect(
          result.files.find((f) => f.relativePath === "foo.filter.ts"),
        ).toBeDefined();
        expect(readTextSync(join(tempDir, "foo.filter.ts"))).toEqual(
          expectedFilterSource("Foo"),
        );
      },
      "Bunest filter uses @bunest/core, type-only interface imports, and Web Response.json",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name has a path",
      async () => {
        const result = await generateSchematic({
          schematic: "filter",
          name: "bar/foo",
          dir: ".",
          flat: true,
          cwd: tempDir,
        });

        expect(
          result.files.find((f) => f.relativePath === "bar/foo.filter.ts"),
        ).toBeDefined();
        expect(
          readTextSync(join(tempDir, "bar/foo.filter.ts")),
        ).toEqual(expectedFilterSource("Foo"));
      },
      "Bunest filter template uses @bunest/core and Web Standard Request/Response",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name and path",
      async () => {
        const result = await generateSchematic({
          schematic: "filter",
          name: "foo",
          dir: "baz",
          flat: true,
          cwd: tempDir,
        });

        expect(
          result.files.find((f) => f.relativePath === "foo.filter.ts"),
        ).toBeDefined();
        expect(
          readTextSync(join(tempDir, "baz/foo.filter.ts")),
        ).toEqual(expectedFilterSource("Foo"));
      },
      "Bunest uses dir option for target base directory",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name to normalize",
      async () => {
        const result = await generateSchematic({
          schematic: "filter",
          name: "fooBar",
          dir: ".",
          flat: true,
          cwd: tempDir,
        });

        expect(
          result.files.find((f) => f.relativePath === "foo-bar.filter.ts"),
        ).toBeDefined();
        expect(
          readTextSync(join(tempDir, "foo-bar.filter.ts")),
        ).toEqual(expectedFilterSource("FooBar"));
      },
      "Normalizes camelCase filter name to kebab-case filename and PascalCase class",
    );

    it("should keep underscores on file path only", async () => {
      const result = await generateSchematic({
        schematic: "filter",
        name: "_foo",
        dir: ".",
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "_foo.filter.ts"),
      ).toBeDefined();
      expect(readTextSync(join(tempDir, "_foo.filter.ts"))).toEqual(
        expectedFilterSource("Foo"),
      );
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage path to normalize",
      async () => {
        const result = await generateSchematic({
          schematic: "filter",
          name: "barBaz/foo",
          dir: ".",
          flat: true,
          cwd: tempDir,
        });

        expect(
          result.files.find((f) => f.relativePath === "bar-baz/foo.filter.ts"),
        ).toBeDefined();
        expect(
          readTextSync(join(tempDir, "bar-baz/foo.filter.ts")),
        ).toEqual(expectedFilterSource("Foo"));
      },
      "Normalizes camelCase path segment to kebab-case",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "generates TypeScript filter with verbatimModuleSyntax imports, nested mode, and 'f' alias (no language: js)",
      () => {
        expect(resolveSchematicType("f")).toBe("filter");

        const nestedFiles = buildSchematicFiles(
          "filter",
          parseSchematicName("foo"),
          { flat: false, spec: false },
        );
        expect(nestedFiles.map((f) => f.relativePath)).toEqual([
          "foo/foo.filter.ts",
        ]);
        expect(nestedFiles[0]?.content).toContain("type ArgumentsHost");
        expect(nestedFiles[0]?.content).toContain("type ExceptionFilter");
        expect(nestedFiles.some((f) => f.relativePath.endsWith(".js"))).toBe(
          false,
        );
      },
      "Bunest targets TypeScript natively with verbatimModuleSyntax: true",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should add source root to path",
      async () => {
        writeTextSync(join(tempDir, "bunest.json"), JSON.stringify({ sourceRoot: "src" }));

        await generateSchematic({
          schematic: "filter",
          name: "foo",
          flat: true,
          cwd: tempDir,
        });

        expect(existsSyncPath(join(tempDir, "src/foo.filter.ts"))).toBe(true);
        expect(
          readTextSync(join(tempDir, "src/foo.filter.ts")),
        ).toEqual(expectedFilterSource("Foo"));
      },
      "Resolves sourceRoot from bunest.json and emits TypeScript filter",
    );

    it("should create a spec file", async () => {
      const result = await generateSchematic({
        schematic: "filter",
        name: "foo",
        dir: ".",
        spec: true,
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.filter.spec.ts"),
      ).toBeDefined();
      expect(existsSyncPath(join(tempDir, "foo.filter.spec.ts"))).toBe(true);
    });

    it("should create a spec file with custom file suffix", async () => {
      const result = await generateSchematic({
        schematic: "filter",
        name: "foo",
        dir: ".",
        spec: true,
        specFileSuffix: "test",
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.filter.spec.ts"),
      ).toBeUndefined();
      expect(
        result.files.find((f) => f.relativePath === "foo.filter.test.ts"),
      ).toBeDefined();
      expect(existsSyncPath(join(tempDir, "foo.filter.spec.ts"))).toBe(false);
      expect(existsSyncPath(join(tempDir, "foo.filter.test.ts"))).toBe(true);
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
          schematic: "filter",
          name: "foo",
          spec: true,
          flat: true,
          cwd: tempDir,
        });

        const specContent = readTextSync(join(tempDir, "src/foo.filter.spec.ts"));
        expect(specContent).not.toContain('import "reflect-metadata";');
        expect(specContent).toContain(
          'import { describe, expect, it } from "bun:test";',
        );
        expect(specContent).toContain(
          'import { BadRequestException } from "@bunest/core";',
        );
        expect(specContent).toContain('from "@bunest/testing"');
        expect(specContent).toContain(
          'import { FooFilter } from "./foo.filter";',
        );
      },
      "Bunest generates bun:test filter spec with extensionless bundler imports",
    );

    it("should default to flat: true when flat option is omitted", async () => {
      const result = await generateSchematic({
        schematic: "filter",
        name: "foo",
        dir: ".",
        spec: false,
        cwd: tempDir,
      });

      expect(result.files.map((f) => f.relativePath)).toEqual([
        "foo.filter.ts",
      ]);
    });
  },
);
