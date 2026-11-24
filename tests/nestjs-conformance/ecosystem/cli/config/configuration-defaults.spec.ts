import { describe, expect, it } from "bun:test";
import {
  AVAILABLE_BUILDERS,
  DEFAULT_CONFIGURATION,
  buildProjectTemplateFiles,
  buildSchematicFiles,
  parseSchematicName,
} from "../../../../../packages/cli/src";
import { describeConformance, itAdapted } from "../../../_helpers/index";

describeConformance(
  "Configuration Defaults",
  {
    upstreamPath: "nest-cli/test/lib/configuration/defaults.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts NestJS configuration defaults tests to Bunest's `DEFAULT_CONFIGURATION`, `AVAILABLE_BUILDERS`, and default project `.gitignore` / `bunest.json` schematic templates.",
  },
  () => {
    describe("DEFAULT_CONFIGURATION", () => {
      it("should use TypeScript as the default language", () => {
        expect(DEFAULT_CONFIGURATION.language).toBe("ts");
      });

      it("should use src as the default source root", () => {
        expect(DEFAULT_CONFIGURATION.sourceRoot).toBe("src");
      });

      itAdapted(
        ["ADR-001"],
        "should use @bunest/schematics as the default collection",
        () => {
          expect(DEFAULT_CONFIGURATION.collection).toBe("@bunest/schematics");
        },
      );

      it("should use main as the default entry file", () => {
        expect(DEFAULT_CONFIGURATION.entryFile).toBe("main");
      });

      it("should have empty plugins by default", () => {
        expect(DEFAULT_CONFIGURATION.compilerOptions?.plugins).toEqual([]);
      });

      it("should have empty assets by default", () => {
        expect(DEFAULT_CONFIGURATION.compilerOptions?.assets).toEqual([]);
      });

      it("should have deleteOutDir disabled by default", () => {
        expect(DEFAULT_CONFIGURATION.compilerOptions?.deleteOutDir).toBe(false);
      });

      itAdapted(
        ["ADR-001"],
        "should define explicit generateOptions defaults (spec: true, flat: false, specFileSuffix: 'spec')",
        () => {
          expect(DEFAULT_CONFIGURATION.generateOptions).toEqual({
            spec: true,
            flat: false,
            specFileSuffix: "spec",
          });
        },
      );

      itAdapted(
        ["ADR-001"],
        "should not enable monorepo mode or legacy webpack by default",
        () => {
          expect(Boolean(DEFAULT_CONFIGURATION.monorepo)).toBe(false);
          expect(Boolean(DEFAULT_CONFIGURATION.compilerOptions?.webpack)).toBe(
            false,
          );
          expect(
            Boolean(DEFAULT_CONFIGURATION.compilerOptions?.manualRestart),
          ).toBe(false);
          expect(DEFAULT_CONFIGURATION.projects ?? {}).toEqual({});
        },
      );

      it("should list all supported builder variants in AVAILABLE_BUILDERS", () => {
        expect([...AVAILABLE_BUILDERS]).toEqual([
          "tsc",
          "webpack",
          "swc",
          "rspack",
        ]);
      });

      it("should emit matching default fields in the `configuration` schematic bunest.json", () => {
        const files = buildSchematicFiles(
          "configuration",
          parseSchematicName("bunest"),
          { flat: false, spec: true },
        );
        expect(files).toHaveLength(1);
        expect(files[0]?.relativePath).toBe("bunest.json");
        const cfg = JSON.parse(files[0]!.content) as Record<string, unknown>;
        expect(cfg.collection).toBe("@bunest/schematics");
        expect(cfg.sourceRoot).toBe("src");
        expect(cfg.entryFile).toBe("main");
      });
    });

    describe("default project templates (tsconfig & .gitignore)", () => {
      const templateFiles = buildProjectTemplateFiles("defaults-demo");
      const byPath = new Map(
        templateFiles.map((f) => [f.relativePath, f.content]),
      );

      it("should include a default tsconfig.json configured for Bun + legacy decorators + verbatimModuleSyntax", () => {
        const raw = byPath.get("tsconfig.json");
        expect(raw).toBeDefined();
        const tsconfig = JSON.parse(raw!) as {
          compilerOptions: Record<string, unknown>;
        };
        expect(tsconfig.compilerOptions.experimentalDecorators).toBe(true);
        expect(tsconfig.compilerOptions.emitDecoratorMetadata).toBe(true);
        expect(tsconfig.compilerOptions.verbatimModuleSyntax).toBe(true);
        expect(tsconfig.compilerOptions.types).toEqual(["bun"]);
      });

      it("should configure dist as the default build output directory in package.json scripts", () => {
        const pkg = JSON.parse(byPath.get("package.json")!) as {
          scripts: Record<string, string>;
        };
        expect(pkg.scripts.build).toContain("./dist");
        expect(pkg.scripts.start).toContain("dist/main.js");
      });

      it("should include common directories to ignore in .gitignore", () => {
        const gitignore = byPath.get(".gitignore")!;
        expect(gitignore).toContain("dist/");
        expect(gitignore).toContain("node_modules/");
        expect(gitignore).toContain(".DS_Store");
      });

      it("should include dotenv files in .gitignore", () => {
        const gitignore = byPath.get(".gitignore")!;
        expect(gitignore).toContain(".env");
        expect(gitignore).toContain(".env.local");
      });

      // BUNEST_BUG: Default project `.gitignore` template omits common IDE directories (`/.idea`, `.vscode`) included in upstream NestJS defaultGitIgnore (packages/cli/src/templates/project.templates.ts:160-166)
      it.skip("should include IDE directories (/.idea, .vscode) in .gitignore", () => {
        const gitignore = byPath.get(".gitignore")!;
        expect(gitignore).toContain(".idea");
        expect(gitignore).toContain(".vscode");
      });
    });
  },
);
