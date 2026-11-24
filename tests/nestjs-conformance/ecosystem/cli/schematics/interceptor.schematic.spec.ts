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

const expectedInterceptorSource = (pascal: string): string =>
  "import {\n" +
  "  Injectable,\n" +
  "  type BunestInterceptor,\n" +
  "  type CallHandler,\n" +
  "  type ExecutionContext,\n" +
  '} from "@bunest/core";\n' +
  "\n" +
  "@Injectable()\n" +
  `export class ${pascal}Interceptor<T = unknown>\n` +
  "  implements BunestInterceptor<T, T>\n" +
  "{\n" +
  "  async intercept(\n" +
  "    _context: ExecutionContext,\n" +
  "    next: CallHandler<T>,\n" +
  "  ): Promise<T> {\n" +
  "    return await next.handle();\n" +
  "  }\n" +
  "}\n";

describeConformance(
  "Interceptor Schematic Factory",
  {
    upstreamPath: "schematics/src/lib/interceptor/interceptor.factory.test.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002", "ADR-008"],
    notes:
      "Ports upstream @nestjs/schematics interceptor factory tests to Bunest CLI interceptor schematic (BunestInterceptor, Promise onion pipeline with zero RxJS per ADR-008, verbatimModuleSyntax type imports, bun:test specs).",
  },
  () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = makeTempDir("bunest-cli-conf-itc-");
    });

    afterEach(async () => {
      await removePath(tempDir, { recursive: true, force: true });
    });

    itAdapted(
      ["ADR-001", "ADR-002", "ADR-008"],
      "should manage name only",
      async () => {
        const planned = buildSchematicFiles(
          "interceptor",
          parseSchematicName("foo"),
          { flat: true, spec: false },
        );
        expect(planned.map((f) => f.relativePath)).toEqual([
          "foo.interceptor.ts",
        ]);
        expect(planned[0]?.content).toEqual(expectedInterceptorSource("Foo"));
        expect(planned[0]?.content).not.toContain("rxjs");

        const result = await generateSchematic({
          schematic: "interceptor",
          name: "foo",
          dir: ".",
          flat: true,
          cwd: tempDir,
        });

        expect(
          result.files.find((f) => f.relativePath === "foo.interceptor.ts"),
        ).toBeDefined();
        expect(
          readTextSync(join(tempDir, "foo.interceptor.ts")),
        ).toEqual(expectedInterceptorSource("Foo"));
      },
      "Bunest interceptor implements BunestInterceptor with async Promise<T> and type imports",
    );

    itAdapted(
      ["ADR-001", "ADR-002", "ADR-008"],
      "should manage name as a path",
      async () => {
        const result = await generateSchematic({
          schematic: "interceptor",
          name: "bar/foo",
          dir: ".",
          flat: true,
          cwd: tempDir,
        });

        expect(
          result.files.find((f) => f.relativePath === "bar/foo.interceptor.ts"),
        ).toBeDefined();
        expect(
          readTextSync(join(tempDir, "bar/foo.interceptor.ts")),
        ).toEqual(expectedInterceptorSource("Foo"));
      },
      "Bunest interceptor uses Promise-based BunestInterceptor",
    );

    itAdapted(
      ["ADR-001", "ADR-002", "ADR-008"],
      "should manage name and path",
      async () => {
        const result = await generateSchematic({
          schematic: "interceptor",
          name: "foo",
          dir: "baz",
          flat: true,
          cwd: tempDir,
        });

        expect(
          result.files.find((f) => f.relativePath === "foo.interceptor.ts"),
        ).toBeDefined();
        expect(
          readTextSync(join(tempDir, "baz/foo.interceptor.ts")),
        ).toEqual(expectedInterceptorSource("Foo"));
      },
      "Bunest uses dir option for base directory",
    );

    itAdapted(
      ["ADR-001", "ADR-002", "ADR-008"],
      "should manage name to normalize",
      async () => {
        const result = await generateSchematic({
          schematic: "interceptor",
          name: "fooBar",
          dir: ".",
          flat: true,
          cwd: tempDir,
        });

        expect(
          result.files.find((f) => f.relativePath === "foo-bar.interceptor.ts"),
        ).toBeDefined();
        expect(
          readTextSync(join(tempDir, "foo-bar.interceptor.ts")),
        ).toEqual(expectedInterceptorSource("FooBar"));
      },
      "Normalizes camelCase interceptor name to kebab-case filename and PascalCase class",
    );

    it("should keep underscores in interceptor's path and file name", async () => {
      const result = await generateSchematic({
        schematic: "interceptor",
        name: "_bar/_foo",
        dir: ".",
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "_bar/_foo.interceptor.ts"),
      ).toBeDefined();
      expect(
        readTextSync(join(tempDir, "_bar/_foo.interceptor.ts")),
      ).toEqual(expectedInterceptorSource("Foo"));
    });

    itAdapted(
      ["ADR-001", "ADR-002", "ADR-008"],
      "should manage path to normalize",
      async () => {
        const result = await generateSchematic({
          schematic: "interceptor",
          name: "barBaz/foo",
          dir: ".",
          flat: true,
          cwd: tempDir,
        });

        expect(
          result.files.find(
            (f) => f.relativePath === "bar-baz/foo.interceptor.ts",
          ),
        ).toBeDefined();
        expect(
          readTextSync(join(tempDir, "bar-baz/foo.interceptor.ts")),
        ).toEqual(expectedInterceptorSource("Foo"));
      },
      "Normalizes camelCase path segment to kebab-case",
    );

    itAdapted(
      ["ADR-001", "ADR-002", "ADR-008"],
      "generates TypeScript Promise interceptor without JS/RxJS and resolves 'itc'/'in' aliases",
      () => {
        expect(resolveSchematicType("itc")).toBe("interceptor");
        expect(resolveSchematicType("in")).toBe("interceptor");

        const nestedFiles = buildSchematicFiles(
          "interceptor",
          parseSchematicName("foo"),
          { flat: false, spec: false },
        );
        expect(nestedFiles.map((f) => f.relativePath)).toEqual([
          "foo/foo.interceptor.ts",
        ]);
        expect(nestedFiles[0]?.content).toContain("type BunestInterceptor");
        expect(nestedFiles[0]?.content).toContain("type CallHandler");
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
        schematic: "interceptor",
        name: "foo",
        dir: ".",
        spec: true,
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.interceptor.spec.ts"),
      ).toBeDefined();
      expect(existsSyncPath(join(tempDir, "foo.interceptor.spec.ts"))).toBe(true);
    });

    it("should create a spec file with custom file suffix", async () => {
      const result = await generateSchematic({
        schematic: "interceptor",
        name: "foo",
        dir: ".",
        spec: true,
        specFileSuffix: "test",
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.interceptor.spec.ts"),
      ).toBeUndefined();
      expect(
        result.files.find((f) => f.relativePath === "foo.interceptor.test.ts"),
      ).toBeDefined();
      expect(existsSyncPath(join(tempDir, "foo.interceptor.spec.ts"))).toBe(false);
      expect(existsSyncPath(join(tempDir, "foo.interceptor.test.ts"))).toBe(true);
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
          schematic: "interceptor",
          name: "foo",
          spec: true,
          flat: true,
          cwd: tempDir,
        });

        const specContent = readTextSync(join(tempDir, "src/foo.interceptor.spec.ts"));
        expect(specContent).not.toContain('import "reflect-metadata";');
        expect(specContent).toContain(
          'import { describe, expect, it } from "bun:test";',
        );
        expect(specContent).toContain("createMockCallHandler");
        expect(specContent).toContain("createMockExecutionContext");
        expect(specContent).toContain('from "@bunest/testing"');
        expect(specContent).toContain(
          'import { FooInterceptor } from "./foo.interceptor";',
        );
      },
      "Bunest generates bun:test interceptor spec with extensionless bundler imports",
    );

    it("should default to flat: true when flat option is omitted", async () => {
      const result = await generateSchematic({
        schematic: "interceptor",
        name: "foo",
        dir: ".",
        spec: false,
        cwd: tempDir,
      });

      expect(result.files.map((f) => f.relativePath)).toEqual([
        "foo.interceptor.ts",
      ]);
    });
  },
);
