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

function expectedMiddlewareSource(pascal: string): string {
  return `import {
  Injectable,
  type BunestMiddleware,
  type NextFunction,
  type ResponseContext,
} from "@bunest/core";

@Injectable()
export class ${pascal}Middleware implements BunestMiddleware {
  async use(
    _req: Request,
    _res: ResponseContext,
    next: NextFunction,
  ): Promise<Response | void> {
    return await next();
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
  "Middleware Schematic",
  {
    upstreamPath: "schematics/src/lib/middleware/middleware.factory.test.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts @nestjs/schematics middleware factory tests to Bunest CLI (BunestMiddleware, native Web Request/ResponseContext, verbatimModuleSyntax type imports, bun:test specs).",
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
          "middleware",
          parseSchematicName("foo"),
          { flat: false, spec: true },
        );
        const file = findFile(planned, "foo/foo.middleware.ts");
        expect(file).toBeDefined();
        expect(file?.content).toEqual(expectedMiddlewareSource("Foo"));

        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic: "middleware",
          name: "foo",
          flat: false,
          cwd,
        });
        expect(
          result.files.find((f) => f.relativePath === "foo/foo.middleware.ts"),
        ).toBeDefined();
        expect(
          readTextSync(join(cwd, "src/foo/foo.middleware.ts")),
        ).toEqual(expectedMiddlewareSource("Foo"));
      },
      "emits BunestMiddleware with import type under verbatimModuleSyntax",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name as a path",
      async () => {
        const planned = buildSchematicFiles(
          "middleware",
          parseSchematicName("bar/foo"),
          { flat: false, spec: true },
        );
        const file = findFile(planned, "bar/foo/foo.middleware.ts");
        expect(file).toBeDefined();
        expect(file?.content).toEqual(expectedMiddlewareSource("Foo"));

        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic: "middleware",
          name: "bar/foo",
          flat: false,
          cwd,
        });
        expect(
          result.files.find(
            (f) => f.relativePath === "bar/foo/foo.middleware.ts",
          ),
        ).toBeDefined();
        expect(
          readTextSync(join(cwd, "src/bar/foo/foo.middleware.ts")),
        ).toEqual(expectedMiddlewareSource("Foo"));
      },
      "emits BunestMiddleware under nested folder path",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name and path",
      async () => {
        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic: "middleware",
          name: "foo",
          dir: "baz",
          flat: false,
          cwd,
        });
        expect(
          result.files.find((f) => f.relativePath === "foo/foo.middleware.ts"),
        ).toBeDefined();
        expect(
          readTextSync(join(cwd, "baz/foo/foo.middleware.ts")),
        ).toEqual(expectedMiddlewareSource("Foo"));
      },
      "writes middleware into custom target dir",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name to normalize",
      async () => {
        const planned = buildSchematicFiles(
          "middleware",
          parseSchematicName("fooBar"),
          { flat: false, spec: true },
        );
        const file = findFile(planned, "foo-bar/foo-bar.middleware.ts");
        expect(file).toBeDefined();
        expect(file?.content).toEqual(expectedMiddlewareSource("FooBar"));

        const cwd = createTempDir();
        await generateSchematic({
          schematic: "middleware",
          name: "fooBar",
          flat: false,
          cwd,
        });
        expect(
          readTextSync(join(cwd, "src/foo-bar/foo-bar.middleware.ts")),
        ).toEqual(expectedMiddlewareSource("FooBar"));
      },
      "normalizes camelCase name to kebab-case file and PascalCase class",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage path to normalize",
      async () => {
        const planned = buildSchematicFiles(
          "middleware",
          parseSchematicName("barBaz/foo"),
          { flat: false, spec: true },
        );
        const file = findFile(planned, "bar-baz/foo/foo.middleware.ts");
        expect(file).toBeDefined();
        expect(file?.content).toEqual(expectedMiddlewareSource("Foo"));

        const cwd = createTempDir();
        await generateSchematic({
          schematic: "middleware",
          name: "barBaz/foo",
          flat: false,
          cwd,
        });
        expect(
          readTextSync(join(cwd, "src/bar-baz/foo/foo.middleware.ts")),
        ).toEqual(expectedMiddlewareSource("Foo"));
      },
      "normalizes camelCase directory segment to kebab-case",
    );

    it("should keep underscores in middleware's path and file name", async () => {
      const planned = buildSchematicFiles(
        "middleware",
        parseSchematicName("_bar/_foo"),
        { flat: false, spec: true },
      );
      const file = findFile(planned, "_bar/_foo/_foo.middleware.ts");
      expect(file).toBeDefined();
      expect(file?.content).toEqual(expectedMiddlewareSource("Foo"));
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should emit TypeScript middleware only (no language: 'js' mode on Bun)",
      () => {
        const planned = buildSchematicFiles(
          "middleware",
          parseSchematicName("foo"),
          { flat: false, spec: true },
        );
        expect(planned.every((file) => file.relativePath.endsWith(".ts"))).toBe(
          true,
        );
        expect(findFile(planned, "foo/foo.middleware.js")).toBeUndefined();
        expect(findFile(planned, "foo/foo.middleware.ts")?.content).toEqual(
          expectedMiddlewareSource("Foo"),
        );
      },
      "Bunest is Bun-only native TypeScript with no JavaScript template variant",
    );

    it("should create a spec file", async () => {
      const cwd = createTempDir();
      const result = await generateSchematic({
        schematic: "middleware",
        name: "foo",
        spec: true,
        flat: true,
        cwd,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.middleware.spec.ts"),
      ).toBeDefined();
    });

    it("should create a spec file with custom file suffix", async () => {
      const cwd = createTempDir();
      const result = await generateSchematic({
        schematic: "middleware",
        name: "foo",
        spec: true,
        specFileSuffix: "test",
        flat: true,
        cwd,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.middleware.spec.ts"),
      ).toBeUndefined();
      expect(
        result.files.find((f) => f.relativePath === "foo.middleware.test.ts"),
      ).toBeDefined();
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
          schematic: "middleware",
          name: "foo",
          spec: true,
          flat: true,
          cwd,
        });

        expect(
          readTextSync(join(cwd, "src/foo.middleware.spec.ts")),
        ).toEqual(
          `import { describe, expect, it } from "bun:test";
import { HttpResponseContext } from "@bunest/core";
import { createMockRequest } from "@bunest/testing";
import { FooMiddleware } from "./foo.middleware";

describe("FooMiddleware", () => {
  it("invokes next()", async () => {
    const middleware = new FooMiddleware();
    let called = false;
    await middleware.use(
      createMockRequest("/foo"),
      new HttpResponseContext(),
      () => {
        called = true;
      },
    );
    expect(called).toBe(true);
  });
});
`,
        );
      },
      "Bun moduleResolution: 'bundler' uses extensionless TS imports and bun:test",
    );
  },
);
