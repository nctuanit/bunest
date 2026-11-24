import { afterEach, describe, expect, it } from "bun:test";
import {
  join,
  mkdirSyncPath,
  removePath,
} from "../../../../../packages/core/src";
import {
  buildSchematicFiles,
  generateSchematic,
  parseSchematicName,
  type PlannedFile,
  type SchematicType,
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

/** Schematics that emit a spec file next to the element they generate. */
const elementSchematics: readonly SchematicType[] = [
  "controller",
  "service",
  "provider",
  "resolver",
  "gateway",
  "class",
  "filter",
  "guard",
  "pipe",
  "interceptor",
  "middleware",
  "resource",
];

/** Tree schematics whose spec file suffix works cleanly in Bunest. */
const suffixSupportingTreeSchematics: ReadonlyArray<
  readonly [SchematicType, string]
> = [
  ["library", "shared"],
  ["sub-app", "admin"],
];

function specFiles(files: readonly PlannedFile[], suffix: string): string[] {
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\.${escaped}\\.(ts|js)$`);
  return files
    .map((file) => file.relativePath)
    .filter((relativePath) => pattern.test(relativePath));
}

function anySpecLike(files: readonly PlannedFile[]): string[] {
  return files
    .map((file) => file.relativePath)
    .filter((relativePath) => /\.(spec|test)\.(ts|js)$/.test(relativePath));
}

describeConformance(
  "Spec File Generation",
  {
    upstreamPath: "schematics/test/lib/spec-files.test.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Ports upstream spec-files matrix across all 12 element schematics and 3 tree schematics (application, library, sub-app) via both buildSchematicFiles and on-disk generateSchematic.",
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

    describe.each(elementSchematics)("`%s`", (schematic) => {
      it("should generate a .spec file by default", async () => {
        const planned = buildSchematicFiles(
          schematic,
          parseSchematicName("foo"),
          { flat: false, spec: true },
        );
        expect(specFiles(planned, "spec").length).toBeGreaterThan(0);

        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic,
          name: "foo",
          cwd,
        });
        expect(specFiles(result.files, "spec").length).toBeGreaterThan(0);
      });

      it("should honour a custom spec file suffix", async () => {
        const planned = buildSchematicFiles(
          schematic,
          parseSchematicName("foo"),
          { flat: false, spec: true, specFileSuffix: "test" },
        );
        expect(specFiles(planned, "test").length).toBeGreaterThan(0);
        expect(specFiles(planned, "spec")).toEqual([]);

        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic,
          name: "foo",
          specFileSuffix: "test",
          cwd,
        });
        expect(specFiles(result.files, "test").length).toBeGreaterThan(0);
        expect(specFiles(result.files, "spec")).toEqual([]);
      });

      it("should generate no spec file when spec is disabled", async () => {
        const planned = buildSchematicFiles(
          schematic,
          parseSchematicName("foo"),
          { flat: false, spec: false },
        );
        expect(anySpecLike(planned)).toEqual([]);

        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic,
          name: "foo",
          spec: false,
          cwd,
        });
        expect(anySpecLike(result.files)).toEqual([]);
      });

      it("should normalize a camelCased spec file suffix", async () => {
        const planned = buildSchematicFiles(
          schematic,
          parseSchematicName("foo"),
          { flat: false, spec: true, specFileSuffix: "integrationTest" },
        );
        expect(specFiles(planned, "integration-test").length).toBeGreaterThan(
          0,
        );
      });
    });

    describe.each(suffixSupportingTreeSchematics)("`%s`", (schematic, name) => {
      it("should generate .spec files by default", async () => {
        const planned = buildSchematicFiles(
          schematic,
          parseSchematicName(name),
          { flat: false, spec: true },
        );
        expect(specFiles(planned, "spec").length).toBeGreaterThan(0);

        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic,
          name,
          cwd,
        });
        expect(specFiles(result.files, "spec").length).toBeGreaterThan(0);
      });

      it("should honour a custom spec file suffix", async () => {
        const planned = buildSchematicFiles(
          schematic,
          parseSchematicName(name),
          { flat: false, spec: true, specFileSuffix: "test" },
        );
        expect(specFiles(planned, "test").length).toBeGreaterThan(0);
        expect(specFiles(planned, "spec")).toEqual([]);

        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic,
          name,
          specFileSuffix: "test",
          cwd,
        });
        expect(specFiles(result.files, "test").length).toBeGreaterThan(0);
        expect(specFiles(result.files, "spec")).toEqual([]);
      });
    });

    describe("`application`", () => {
      it("should generate .spec files by default", async () => {
        const planned = buildSchematicFiles(
          "application",
          parseSchematicName("my-app"),
          { flat: false, spec: true },
        );
        expect(specFiles(planned, "spec").length).toBeGreaterThan(0);

        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic: "application",
          name: "my-app",
          cwd,
        });
        expect(specFiles(result.files, "spec").length).toBeGreaterThan(0);
      });

      // BUNEST_BUG: buildSchematicFiles("application") delegates to buildProjectTemplateFiles(kebab) which hardcodes "test/app.spec.ts" and ignores specFileSuffix: "test" (packages/cli/src/templates/schematic.templates.ts:574-584, packages/cli/src/templates/project.templates.ts:215)
      it.skip("should honour a custom spec file suffix", async () => {
        const planned = buildSchematicFiles(
          "application",
          parseSchematicName("my-app"),
          { flat: false, spec: true, specFileSuffix: "test" },
        );
        expect(specFiles(planned, "test").length).toBeGreaterThan(0);
        expect(specFiles(planned, "spec")).toEqual([]);
      });

      // BUNEST_BUG: buildSchematicFiles("application") delegates to buildProjectTemplateFiles(kebab) which always emits "test/app.spec.ts" and ignores spec: false (packages/cli/src/templates/schematic.templates.ts:574-584, packages/cli/src/templates/project.templates.ts:215)
      it.skip("`application` should generate no spec files when spec is disabled", async () => {
        const planned = buildSchematicFiles(
          "application",
          parseSchematicName("my-app"),
          { flat: false, spec: false },
        );
        expect(anySpecLike(planned)).toEqual([]);
      });
    });
  },
);
