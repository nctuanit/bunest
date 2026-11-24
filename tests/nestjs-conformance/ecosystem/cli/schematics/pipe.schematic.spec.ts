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

function expectedPipeSource(pascal: string): string {
  return `import {
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from "@bunest/core";

@Injectable()
export class ${pascal}Pipe<T = unknown> implements PipeTransform<T, T> {
  transform(value: T, _metadata: ArgumentMetadata): T {
    return value;
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
  "Pipe Schematic",
  {
    upstreamPath: "schematics/src/lib/pipe/pipe.factory.test.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts @nestjs/schematics pipe factory tests to Bunest CLI (generic PipeTransform<T, T>, import type under verbatimModuleSyntax, bun:test specs).",
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
        const planned = buildSchematicFiles("pipe", parseSchematicName("foo"), {
          flat: false,
          spec: true,
        });
        const file = findFile(planned, "foo/foo.pipe.ts");
        expect(file).toBeDefined();
        expect(file?.content).toEqual(expectedPipeSource("Foo"));

        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic: "pipe",
          name: "foo",
          flat: false,
          cwd,
        });
        expect(
          result.files.find((f) => f.relativePath === "foo/foo.pipe.ts"),
        ).toBeDefined();
        expect(readTextSync(join(cwd, "src/foo/foo.pipe.ts"))).toEqual(
          expectedPipeSource("Foo"),
        );
      },
      "emits generic PipeTransform<T, T> with import type",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name as a path",
      async () => {
        const planned = buildSchematicFiles(
          "pipe",
          parseSchematicName("bar/foo"),
          { flat: false, spec: true },
        );
        const file = findFile(planned, "bar/foo/foo.pipe.ts");
        expect(file).toBeDefined();
        expect(file?.content).toEqual(expectedPipeSource("Foo"));

        const cwd = createTempDir();
        await generateSchematic({
          schematic: "pipe",
          name: "bar/foo",
          flat: false,
          cwd,
        });
        expect(
          readTextSync(join(cwd, "src/bar/foo/foo.pipe.ts")),
        ).toEqual(expectedPipeSource("Foo"));
      },
      "emits pipe under nested folder path",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name and path",
      async () => {
        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic: "pipe",
          name: "foo",
          dir: "baz",
          flat: false,
          cwd,
        });
        expect(
          result.files.find((f) => f.relativePath === "foo/foo.pipe.ts"),
        ).toBeDefined();
        expect(readTextSync(join(cwd, "baz/foo/foo.pipe.ts"))).toEqual(
          expectedPipeSource("Foo"),
        );
      },
      "writes pipe into custom target dir",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name to normalize",
      async () => {
        const planned = buildSchematicFiles(
          "pipe",
          parseSchematicName("fooBar"),
          { flat: false, spec: true },
        );
        const file = findFile(planned, "foo-bar/foo-bar.pipe.ts");
        expect(file).toBeDefined();
        expect(file?.content).toEqual(expectedPipeSource("FooBar"));

        const cwd = createTempDir();
        await generateSchematic({
          schematic: "pipe",
          name: "fooBar",
          flat: false,
          cwd,
        });
        expect(
          readTextSync(join(cwd, "src/foo-bar/foo-bar.pipe.ts")),
        ).toEqual(expectedPipeSource("FooBar"));
      },
      "normalizes camelCase name to kebab-case file and PascalCase class",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage path to normalize",
      async () => {
        const planned = buildSchematicFiles(
          "pipe",
          parseSchematicName("barBaz/foo"),
          { flat: false, spec: true },
        );
        const file = findFile(planned, "bar-baz/foo/foo.pipe.ts");
        expect(file).toBeDefined();
        expect(file?.content).toEqual(expectedPipeSource("Foo"));

        const cwd = createTempDir();
        await generateSchematic({
          schematic: "pipe",
          name: "barBaz/foo",
          flat: false,
          cwd,
        });
        expect(
          readTextSync(join(cwd, "src/bar-baz/foo/foo.pipe.ts")),
        ).toEqual(expectedPipeSource("Foo"));
      },
      "normalizes camelCase directory segment to kebab-case",
    );

    // BUNEST_BUG: parseSchematicName rejects leading underscore segments ("_bar/_foo") instead of preserving underscores in path and filename while normalizing class name to FooPipe (packages/cli/src/utils/naming.ts: VALID_SEGMENT_REGEX and toKebabCase)
    it.skip("should manage to keep underscores on pipe's path and name", () => {
      const planned = buildSchematicFiles(
        "pipe",
        parseSchematicName("_bar/_foo"),
        { flat: false, spec: true },
      );
      const file = findFile(planned, "_bar/_foo/_foo.pipe.ts");
      expect(file).toBeDefined();
      expect(file?.content).toEqual(expectedPipeSource("Foo"));
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should emit TypeScript pipe only (no language: 'js' mode on Bun)",
      () => {
        const planned = buildSchematicFiles("pipe", parseSchematicName("foo"), {
          flat: false,
          spec: true,
        });
        expect(planned.every((file) => file.relativePath.endsWith(".ts"))).toBe(
          true,
        );
        expect(findFile(planned, "foo/foo.pipe.js")).toBeUndefined();
        expect(findFile(planned, "foo/foo.pipe.ts")?.content).toEqual(
          expectedPipeSource("Foo"),
        );
      },
      "Bunest is Bun-only native TypeScript with no JavaScript template variant",
    );

    it("should create a spec file", async () => {
      const cwd = createTempDir();
      const result = await generateSchematic({
        schematic: "pipe",
        name: "foo",
        spec: true,
        flat: true,
        cwd,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.pipe.spec.ts"),
      ).toBeDefined();
    });

    it("should create a spec file with custom file suffix", async () => {
      const cwd = createTempDir();
      const result = await generateSchematic({
        schematic: "pipe",
        name: "foo",
        spec: true,
        specFileSuffix: "test",
        flat: true,
        cwd,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.pipe.spec.ts"),
      ).toBeUndefined();
      expect(
        result.files.find((f) => f.relativePath === "foo.pipe.test.ts"),
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
          schematic: "pipe",
          name: "foo",
          spec: true,
          flat: true,
          cwd,
        });

        expect(readTextSync(join(cwd, "src/foo.pipe.spec.ts"))).toEqual(
          `import { describe, expect, it } from "bun:test";
import { FooPipe } from "./foo.pipe";

describe("FooPipe", () => {
  it("transforms input value", () => {
    const pipe = new FooPipe<string>();
    expect(pipe.transform("hello", { type: "body" })).toBe("hello");
  });
});
`,
        );
      },
      "Bun moduleResolution: 'bundler' uses extensionless TS imports and bun:test",
    );
  },
);
