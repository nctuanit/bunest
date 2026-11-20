import "reflect-metadata";
import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSchematicFiles,
  generateSchematic,
  parseSchematicName,
  type PlannedFile,
} from "../../../../../packages/cli/src";
import { describeConformance, itAdapted } from "../../../_helpers/index";

function expectedServiceSource(pascal: string, kebab: string): string {
  return `import { Injectable } from "@bunest/core";

@Injectable()
export class ${pascal}Service {
  getStatus(): string {
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
  "Service Schematic",
  {
    upstreamPath: "schematics/src/lib/service/service.factory.test.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts @nestjs/schematics service factory tests to Bunest CLI (@bunest/core @Injectable template with getStatus(), @bunest/testing + bun:test specs, TypeScript-only runtime).",
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
          "service",
          parseSchematicName("foo"),
          { flat: true, spec: true },
        );
        expect(findFile(planned, "foo.service.ts")).toBeDefined();
        expect(findFile(planned, "foo.service.spec.ts")).toBeDefined();
        expect(findFile(planned, "foo.service.ts")?.content).toEqual(
          expectedServiceSource("Foo", "foo"),
        );

        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic: "service",
          name: "foo",
          flat: true,
          cwd,
        });
        expect(
          result.files.find((f) => f.relativePath === "foo.service.ts"),
        ).toBeDefined();
        expect(
          result.files.find((f) => f.relativePath === "foo.service.spec.ts"),
        ).toBeDefined();
        expect(readFileSync(join(cwd, "src/foo.service.ts"), "utf8")).toEqual(
          expectedServiceSource("Foo", "foo"),
        );
      },
      "emits @bunest/core @Injectable service with starter getStatus() method",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name as a path",
      async () => {
        const planned = buildSchematicFiles(
          "service",
          parseSchematicName("bar/foo"),
          { flat: true, spec: true },
        );
        expect(findFile(planned, "bar/foo.service.ts")).toBeDefined();
        expect(findFile(planned, "bar/foo.service.spec.ts")).toBeDefined();
        expect(findFile(planned, "bar/foo.service.ts")?.content).toEqual(
          expectedServiceSource("Foo", "foo"),
        );

        const cwd = createTempDir();
        await generateSchematic({
          schematic: "service",
          name: "bar/foo",
          flat: true,
          cwd,
        });
        expect(
          readFileSync(join(cwd, "src/bar/foo.service.ts"), "utf8"),
        ).toEqual(expectedServiceSource("Foo", "foo"));
      },
      "places flat service under nested subDir",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name and path",
      async () => {
        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic: "service",
          name: "foo",
          dir: "bar",
          flat: true,
          cwd,
        });
        expect(
          result.files.find((f) => f.relativePath === "foo.service.ts"),
        ).toBeDefined();
        expect(
          result.files.find((f) => f.relativePath === "foo.service.spec.ts"),
        ).toBeDefined();
        expect(readFileSync(join(cwd, "bar/foo.service.ts"), "utf8")).toEqual(
          expectedServiceSource("Foo", "foo"),
        );
      },
      "writes service into custom target dir",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name to normalize",
      async () => {
        const planned = buildSchematicFiles(
          "service",
          parseSchematicName("fooBar"),
          { flat: true, spec: true },
        );
        expect(findFile(planned, "foo-bar.service.ts")).toBeDefined();
        expect(findFile(planned, "foo-bar.service.ts")?.content).toEqual(
          expectedServiceSource("FooBar", "foo-bar"),
        );

        const cwd = createTempDir();
        await generateSchematic({
          schematic: "service",
          name: "fooBar",
          flat: true,
          cwd,
        });
        expect(
          readFileSync(join(cwd, "src/foo-bar.service.ts"), "utf8"),
        ).toEqual(expectedServiceSource("FooBar", "foo-bar"));
      },
      "normalizes camelCase name to kebab-case file and PascalCase class",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage path to normalize",
      async () => {
        const planned = buildSchematicFiles(
          "service",
          parseSchematicName("barBaz/foo"),
          { flat: true, spec: true },
        );
        expect(findFile(planned, "bar-baz/foo.service.ts")).toBeDefined();
        expect(findFile(planned, "bar-baz/foo.service.spec.ts")).toBeDefined();
        expect(findFile(planned, "bar-baz/foo.service.ts")?.content).toEqual(
          expectedServiceSource("Foo", "foo"),
        );

        const cwd = createTempDir();
        await generateSchematic({
          schematic: "service",
          name: "barBaz/foo",
          flat: true,
          cwd,
        });
        expect(
          readFileSync(join(cwd, "src/bar-baz/foo.service.ts"), "utf8"),
        ).toEqual(expectedServiceSource("Foo", "foo"));
      },
      "normalizes camelCase directory segment to kebab-case",
    );

    // BUNEST_BUG: parseSchematicName rejects leading underscore segments ("_bar/_foo") instead of preserving underscores in path and filename while normalizing class name to FooService (packages/cli/src/utils/naming.ts: VALID_SEGMENT_REGEX and toKebabCase)
    it.skip("should keep underscores in path and file name", () => {
      const planned = buildSchematicFiles(
        "service",
        parseSchematicName("_bar/_foo"),
        { flat: true, spec: true },
      );
      expect(findFile(planned, "_bar/_foo.service.ts")).toBeDefined();
      expect(findFile(planned, "_bar/_foo.service.spec.ts")).toBeDefined();
      expect(findFile(planned, "_bar/_foo.service.ts")?.content).toEqual(
        expectedServiceSource("Foo", "_foo"),
      );
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should emit TypeScript service only (no language: 'js' mode on Bun)",
      () => {
        const planned = buildSchematicFiles(
          "service",
          parseSchematicName("foo"),
          { flat: true, spec: true },
        );
        expect(
          planned.every((file) => file.relativePath.endsWith(".ts")),
        ).toBe(true);
        expect(findFile(planned, "foo.service.js")).toBeUndefined();
        expect(findFile(planned, "foo.service.spec.js")).toBeUndefined();
        expect(findFile(planned, "foo.service.ts")?.content).toEqual(
          expectedServiceSource("Foo", "foo"),
        );
      },
      "Bunest is Bun-only native TypeScript with no JavaScript template variant",
    );

    // BUNEST_BUG: generateSchematic("service", ...) does not auto-register FooService in src/app.module.ts providers array (missing module declaration updater and skipImport option in packages/cli/src/commands/generate.ts)
    it.skip("should manage declaration in app module", async () => {
      const cwd = createTempDir();
      await generateSchematic({
        schematic: "application",
        name: "my-app",
        flat: true,
        cwd,
      });
      await generateSchematic({
        schematic: "service",
        name: "foo",
        flat: true,
        cwd,
      });

      const appModule = readFileSync(join(cwd, "src/app.module.ts"), "utf8");
      expect(appModule).toContain(
        'import { FooService } from "./foo.service";',
      );
      expect(appModule).toContain("providers: [AppService, FooService]");
    });

    // BUNEST_BUG: generateSchematic("service", ...) does not auto-register FooService in src/foo/foo.module.ts providers array (missing module finder & declaration updater in packages/cli/src/commands/generate.ts)
    it.skip("should manage declaration in foo module", async () => {
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
        schematic: "service",
        name: "foo",
        dir: "src/foo",
        flat: true,
        cwd,
      });

      const fooModule = readFileSync(
        join(cwd, "src/foo/foo.module.ts"),
        "utf8",
      );
      expect(fooModule).toContain(
        'import { FooService } from "./foo.service";',
      );
      expect(fooModule).toContain("providers: [FooService]");
    });

    // BUNEST_BUG: generateSchematic("service", ...) does not select matching users.module.ts over admin.module.ts or auto-register UsersService (missing module finder & declaration updater in packages/cli/src/commands/generate.ts)
    it.skip("should manage declaration in the module matching the name", async () => {
      const cwd = createTempDir();
      await generateSchematic({
        schematic: "application",
        name: "my-app",
        flat: true,
        cwd,
      });
      const usersDir = join(cwd, "src/users");
      mkdirSync(usersDir, { recursive: true });
      const adminModule = `import { Module } from "@bunest/core";\n\n@Module({})\nexport class AdminModule {}\n`;
      writeFileSync(join(usersDir, "admin.module.ts"), adminModule);
      writeFileSync(
        join(usersDir, "users.module.ts"),
        `import { Module } from "@bunest/core";\n\n@Module({})\nexport class UsersModule {}\n`,
      );

      await generateSchematic({
        schematic: "service",
        name: "users",
        cwd,
      });

      expect(readFileSync(join(usersDir, "admin.module.ts"), "utf8")).toEqual(
        adminModule,
      );
      const usersModule = readFileSync(
        join(usersDir, "users.module.ts"),
        "utf8",
      );
      expect(usersModule).toContain(
        'import { UsersService } from "./users.service";',
      );
      expect(usersModule).toContain("providers: [UsersService]");
    });

    it("should create a spec file", async () => {
      const cwd = createTempDir();
      const result = await generateSchematic({
        schematic: "service",
        name: "foo",
        spec: true,
        flat: true,
        cwd,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.service.spec.ts"),
      ).toBeDefined();
    });

    it("should create a spec file with custom file suffix", async () => {
      const cwd = createTempDir();
      const result = await generateSchematic({
        schematic: "service",
        name: "foo",
        spec: true,
        specFileSuffix: "test",
        flat: true,
        cwd,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.service.spec.ts"),
      ).toBeUndefined();
      expect(
        result.files.find((f) => f.relativePath === "foo.service.test.ts"),
      ).toBeDefined();
    });

    // BUNEST_BUG: generateSchematic("service", ...) does not auto-register FooService in src/app.module.ts providers array for ESM projects (missing module declaration updater in packages/cli/src/commands/generate.ts)
    it.skip("should manage declaration in app module for ESM projects", async () => {
      const cwd = createTempDir();
      await generateSchematic({
        schematic: "application",
        name: "my-app",
        flat: true,
        cwd,
      });
      await generateSchematic({
        schematic: "service",
        name: "foo",
        flat: true,
        cwd,
      });

      const appModule = readFileSync(join(cwd, "src/app.module.ts"), "utf8");
      expect(appModule).toContain(
        'import { FooService } from "./foo.service";',
      );
      expect(appModule).toContain("providers: [AppService, FooService]");
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
          schematic: "service",
          name: "foo",
          spec: true,
          flat: true,
          cwd,
        });

        expect(
          readFileSync(join(cwd, "src/foo.service.spec.ts"), "utf8"),
        ).toEqual(
          `import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { FooService } from "./foo.service";

describe("FooService", () => {
  it("resolves from DI container", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [FooService],
    }).compile();

    const service = moduleRef.get(FooService);
    expect(service.getStatus()).toBe("foo:ok");
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
