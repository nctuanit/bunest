import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  join,
  mkdirSyncPath,
  removePath,
  resolve,
  writeTextSync,
} from "../../../../../packages/core/src";
import {
  buildProjectTemplateFiles,
  generateSchematic,
  resolveProjectConfiguration,
  type Configuration,
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
  "Project Utilities & Generate Option Precedence",
  {
    upstreamPath: "nest-cli/test/lib/utils/project-utils.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts NestJS project-utils specs (`shouldAskForProject`, `shouldGenerateSpec`, `shouldGenerateFlat`, `getSpecFileSuffix`, `moveDefaultProjectToStart`, `hasTestingPackage`) to Bunest's `generateSchematic()` option precedence and `resolveProjectConfiguration()`.",
  },
  () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = makeTempDir("bunest-cli-conf-projutils-");
    });

    afterEach(async () => {
      await removePath(tmpDir, { recursive: true, force: true });
    });

    const writeBunestConfig = (config: Configuration) => {
      writeTextSync(join(tmpDir, "bunest.json"), JSON.stringify(config, null, 2));
    };

    describe("workspace-root vs project-scoped schematics", () => {
      it("always targets workspace root for app/sub-app/library/lib/configuration/application schematics", async () => {
        writeBunestConfig({
          sourceRoot: "src",
          monorepo: true,
          projects: {
            myApp: { type: "application", sourceRoot: "apps/my-app/src" },
            myLib: { type: "library", sourceRoot: "libs/my-lib/src" },
          },
        });

        for (const [schematic, name] of [
          ["app", "billing"],
          ["sub-app", "worker"],
          ["library", "shared"],
          ["lib", "common-lib"],
          ["configuration", "bunest"],
          ["application", "portal"],
        ] as const) {
          const res = await generateSchematic({
            schematic,
            name,
            cwd: tmpDir,
            dryRun: true,
            force: true,
          });
          expect(res.targetDir).toBe(resolve(tmpDir));
        }
      });

      it("targets project sourceRoot when --project is specified for service/controller schematics", async () => {
        writeBunestConfig({
          sourceRoot: "src",
          monorepo: true,
          projects: {
            myApp: { type: "application", sourceRoot: "apps/my-app/src" },
            myLib: { type: "library", sourceRoot: "libs/my-lib/src" },
          },
        });

        const svcRes = await generateSchematic({
          schematic: "service",
          name: "auth",
          project: "myApp",
          cwd: tmpDir,
          dryRun: true,
        });
        expect(svcRes.targetDir).toBe(resolve(tmpDir, "apps/my-app/src"));

        const ctrlRes = await generateSchematic({
          schematic: "controller",
          name: "users",
          project: "myLib",
          cwd: tmpDir,
          dryRun: true,
        });
        expect(ctrlRes.targetDir).toBe(resolve(tmpDir, "libs/my-lib/src"));
      });

      it("falls back to root sourceRoot when no project is provided or projects are empty", async () => {
        writeBunestConfig({ sourceRoot: "custom-src", projects: {} });
        const res = await generateSchematic({
          schematic: "service",
          name: "billing",
          cwd: tmpDir,
          dryRun: true,
        });
        expect(res.targetDir).toBe(resolve(tmpDir, "custom-src"));
      });

      it("throws a helpful error listing available projects when an unknown --project is passed", async () => {
        const cfg: Configuration = {
          sourceRoot: "src",
          projects: {
            app1: { type: "application" },
            app2: { type: "application" },
            lib1: { type: "library" },
          },
        };
        expect(resolveProjectConfiguration(cfg, "app1")).toEqual({
          type: "application",
        });
        expect(() => resolveProjectConfiguration(cfg, "missing")).toThrow(
          /Available projects: app1, app2, lib1/,
        );
        expect(() =>
          resolveProjectConfiguration({ sourceRoot: "src" }, "missing"),
        ).toThrow(/No projects are defined/);
      });
    });

    describe("spec generation precedence (CLI > project config > root config > default)", () => {
      it("uses explicit CLI spec: true / spec: false with highest priority", async () => {
        writeBunestConfig({ generateOptions: { spec: false } });
        const enabled = await generateSchematic({
          schematic: "service",
          name: "alpha",
          spec: true,
          cwd: tmpDir,
          dryRun: true,
        });
        expect(
          enabled.files.some((f) => f.relativePath.endsWith(".spec.ts")),
        ).toBe(true);

        writeBunestConfig({ generateOptions: { spec: true } });
        const disabled = await generateSchematic({
          schematic: "service",
          name: "alpha",
          spec: false,
          cwd: tmpDir,
          dryRun: true,
        });
        expect(
          disabled.files.some((f) => f.relativePath.endsWith(".spec.ts")),
        ).toBe(false);
      });

      it("uses root configuration boolean generateOptions.spec when CLI omits spec", async () => {
        writeBunestConfig({ generateOptions: { spec: false } });
        const resOff = await generateSchematic({
          schematic: "service",
          name: "beta",
          cwd: tmpDir,
          dryRun: true,
        });
        expect(
          resOff.files.some((f) => f.relativePath.endsWith(".spec.ts")),
        ).toBe(false);

        writeBunestConfig({ generateOptions: { spec: true } });
        const resOn = await generateSchematic({
          schematic: "service",
          name: "beta",
          cwd: tmpDir,
          dryRun: true,
        });
        expect(
          resOn.files.some((f) => f.relativePath.endsWith(".spec.ts")),
        ).toBe(true);
      });

      it("uses schematic-specific generateOptions.spec map and defaults unlisted schematics to true", async () => {
        writeBunestConfig({
          generateOptions: {
            spec: {
              service: false,
              controller: true,
            },
          },
        });

        const svc = await generateSchematic({
          schematic: "service",
          name: "gamma",
          cwd: tmpDir,
          dryRun: true,
        });
        expect(svc.files.some((f) => f.relativePath.endsWith(".spec.ts"))).toBe(
          false,
        );

        const ctrl = await generateSchematic({
          schematic: "controller",
          name: "gamma",
          cwd: tmpDir,
          dryRun: true,
        });
        expect(
          ctrl.files.some((f) => f.relativePath.endsWith(".spec.ts")),
        ).toBe(true);

        const guard = await generateSchematic({
          schematic: "guard",
          name: "gamma",
          cwd: tmpDir,
          dryRun: true,
        });
        expect(
          guard.files.some((f) => f.relativePath.endsWith(".spec.ts")),
        ).toBe(true);
      });

      it("uses project-specific generateOptions.spec and falls back to global spec map when project omits it", async () => {
        writeBunestConfig({
          monorepo: true,
          generateOptions: {
            spec: { service: false },
          },
          projects: {
            myApp: {
              sourceRoot: "apps/my-app/src",
              compilerOptions: {},
            },
            specApp: {
              sourceRoot: "apps/spec-app/src",
              generateOptions: { spec: true },
            },
          },
        });

        const inherited = await generateSchematic({
          schematic: "service",
          name: "delta",
          project: "myApp",
          cwd: tmpDir,
          dryRun: true,
        });
        expect(
          inherited.files.some((f) => f.relativePath.endsWith(".spec.ts")),
        ).toBe(false);

        const overridden = await generateSchematic({
          schematic: "service",
          name: "delta",
          project: "specApp",
          cwd: tmpDir,
          dryRun: true,
        });
        expect(
          overridden.files.some((f) => f.relativePath.endsWith(".spec.ts")),
        ).toBe(true);
      });
    });

    describe("flat option precedence", () => {
      it("gives CLI flat option highest priority over configuration", async () => {
        writeBunestConfig({ generateOptions: { flat: false } });
        const cliFlat = await generateSchematic({
          schematic: "service",
          name: "users",
          flat: true,
          cwd: tmpDir,
          dryRun: true,
        });
        expect(cliFlat.files[0]?.relativePath).toBe("users.service.ts");

        writeBunestConfig({ generateOptions: { flat: true } });
        const cliNested = await generateSchematic({
          schematic: "service",
          name: "users",
          flat: false,
          cwd: tmpDir,
          dryRun: true,
        });
        expect(cliNested.files[0]?.relativePath).toBe("users/users.service.ts");
      });

      it("uses configuration generateOptions.flat when CLI omits flat and defaults to false", async () => {
        writeBunestConfig({ generateOptions: { flat: true } });
        const cfgFlat = await generateSchematic({
          schematic: "service",
          name: "users",
          cwd: tmpDir,
          dryRun: true,
        });
        expect(cfgFlat.files[0]?.relativePath).toBe("users.service.ts");

        writeBunestConfig({ generateOptions: { flat: false } });
        const cfgNested = await generateSchematic({
          schematic: "service",
          name: "users",
          cwd: tmpDir,
          dryRun: true,
        });
        expect(cfgNested.files[0]?.relativePath).toBe("users/users.service.ts");
      });
    });

    describe("specFileSuffix precedence", () => {
      it("gives CLI specFileSuffix highest priority over configuration", async () => {
        writeBunestConfig({
          generateOptions: { specFileSuffix: "integration" },
        });
        const res = await generateSchematic({
          schematic: "service",
          name: "billing",
          specFileSuffix: "test",
          cwd: tmpDir,
          dryRun: true,
        });
        expect(res.files[1]?.relativePath).toBe(
          "billing/billing.service.test.ts",
        );
      });

      it("uses configuration specFileSuffix when CLI omits it and defaults to 'spec'", async () => {
        writeBunestConfig({
          generateOptions: { specFileSuffix: "integration" },
        });
        const fromCfg = await generateSchematic({
          schematic: "service",
          name: "billing",
          cwd: tmpDir,
          dryRun: true,
        });
        expect(fromCfg.files[1]?.relativePath).toBe(
          "billing/billing.service.integration.ts",
        );

        const defaultDir = makeTempDir("bunest-cli-conf-defsuf-");
        try {
          const fromDef = await generateSchematic({
            schematic: "service",
            name: "billing",
            cwd: defaultDir,
            dryRun: true,
          });
          expect(fromDef.files[1]?.relativePath).toBe(
            "billing/billing.service.spec.ts",
          );
        } finally {
          await removePath(defaultDir, { recursive: true, force: true });
        }
      });

      it("allows project-level specFileSuffix to override root config", async () => {
        writeBunestConfig({
          generateOptions: { specFileSuffix: "spec" },
          projects: {
            billing: {
              sourceRoot: "apps/billing/src",
              generateOptions: { specFileSuffix: "e2e" },
            },
          },
        });
        const res = await generateSchematic({
          schematic: "controller",
          name: "invoices",
          project: "billing",
          cwd: tmpDir,
          dryRun: true,
        });
        expect(res.files[1]?.relativePath).toBe(
          "invoices/invoices.controller.e2e.ts",
        );
      });
    });

    describe("testing package presence (hasTestingPackage parity)", () => {
      itAdapted(
        ["ADR-001"],
        "includes @bunest/testing in scaffolded project devDependencies and still generates specs cleanly when package.json is absent or malformed",
        async () => {
          const tpl = buildProjectTemplateFiles("test-pkg-demo");
          const pkg = JSON.parse(
            tpl.find((f) => f.relativePath === "package.json")!.content,
          ) as { devDependencies: Record<string, string> };
          expect(pkg.devDependencies["@bunest/testing"]).toBeDefined();

          // No package.json -> generateSchematic does not break
          const noPkgRes = await generateSchematic({
            schematic: "service",
            name: "health",
            cwd: tmpDir,
            dryRun: true,
          });
          expect(
            noPkgRes.files.some((f) => f.relativePath.endsWith(".spec.ts")),
          ).toBe(true);

          // Malformed package.json -> generateSchematic still does not break
          writeTextSync(join(tmpDir, "package.json"), "not json");
          const badPkgRes = await generateSchematic({
            schematic: "service",
            name: "health",
            cwd: tmpDir,
            dryRun: true,
          });
          expect(
            badPkgRes.files.some((f) => f.relativePath.endsWith(".spec.ts")),
          ).toBe(true);
        },
      );
    });
  },
);
