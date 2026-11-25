import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  basename,
  existsSyncPath,
  join,
  mkdirSyncPath,
  readTextSync,
  removePath,
  writeTextSync,
} from "../../../../../packages/core/src";
import {
  FileCollisionError,
  buildProjectTemplateFiles,
  buildSchematicFiles,
  createProject,
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

const EXPECTED_APP_FILES = (prefix: string): string[] =>
  [
    `${prefix}.gitignore`,
    `${prefix}AGENTS.md`,
    `${prefix}README.md`,
    `${prefix}package.json`,
    `${prefix}tsconfig.json`,
    `${prefix}src/app.controller.ts`,
    `${prefix}src/app.module.ts`,
    `${prefix}src/app.service.ts`,
    `${prefix}src/main.ts`,
    `${prefix}test/app.spec.ts`,
  ].sort();

describeConformance(
  "Application Schematic Factory",
  {
    upstreamPath: "schematics/src/lib/application/application.factory.test.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Ports upstream @nestjs/schematics application factory tests to Bunest CLI application schematic & createProject (Bun-only TS runtime, bun:test, ESM-only, verbatimModuleSyntax: true).",
  },
  () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = makeTempDir("bunest-cli-conf-app-");
    });

    afterEach(async () => {
      await removePath(tempDir, { recursive: true, force: true });
    });

    describe("when only the name is supplied", () => {
      itAdapted(
        ["ADR-001", "ADR-002"],
        "should manage basic (ie., cross-platform) name",
        async () => {
          expect(resolveSchematicType("application")).toBe("application");

          const planned = buildSchematicFiles(
            "application",
            parseSchematicName("project"),
            { flat: false, spec: true },
          );
          expect(planned.map((f) => f.relativePath).sort()).toEqual(
            EXPECTED_APP_FILES("project/"),
          );

          const result = await generateSchematic({
            schematic: "application",
            name: "project",
            cwd: tempDir,
          });

          expect(result.schematic).toBe("application");
          expect(result.name).toBe("project");
          expect(result.files.map((f) => f.relativePath).sort()).toEqual(
            EXPECTED_APP_FILES("project/"),
          );

          const pkg = JSON.parse(
            readTextSync(join(tempDir, "project/package.json")),
          ) as {
            name: string;
            type: string;
            scripts: Record<string, string>;
            dependencies: Record<string, string>;
            devDependencies: Record<string, string>;
          };
          expect(pkg.name).toBe("project");
          expect(pkg.type).toBe("module");
          expect(pkg.scripts.test).toBe("bun test");
          expect(pkg.dependencies["@bunest/core"]).toBeDefined();
          expect(pkg.devDependencies["@bunest/testing"]).toBeDefined();

          const tsconfig = JSON.parse(
            readTextSync(join(tempDir, "project/tsconfig.json")),
          ) as {
            compilerOptions: {
              types: string[];
              experimentalDecorators: boolean;
              emitDecoratorMetadata: boolean;
              verbatimModuleSyntax: boolean;
              strict: boolean;
            };
          };
          expect(tsconfig.compilerOptions.types).toEqual(["bun"]);
          expect(tsconfig.compilerOptions.experimentalDecorators).toBe(true);
          expect(tsconfig.compilerOptions.emitDecoratorMetadata).toBe(true);
          expect(tsconfig.compilerOptions.verbatimModuleSyntax).toBe(true);
          expect(tsconfig.compilerOptions.strict).toBe(true);
        },
        "Bunest generates Bun-native ESM TypeScript scaffold without Jest/Oxlint/Prettier/nest-cli.json",
      );

      itAdapted(
        ["ADR-001", "ADR-002"],
        "createProject manages name with dots in it",
        async () => {
          const result = await createProject({
            projectName: "project.foo.bar",
            cwd: tempDir,
            skipInstall: true,
            skipGit: true,
          });

          expect(result.projectName).toBe("project.foo.bar");
          expect(result.files.map((f) => f.relativePath).sort()).toEqual(
            EXPECTED_APP_FILES(""),
          );
          const pkg = JSON.parse(
            readTextSync(join(tempDir, "project.foo.bar/package.json")),
          ) as { name: string };
          expect(pkg.name).toBe("project.foo.bar");
        },
        "createProject uses validateProjectName which accepts dotted package names",
      );

      it("should manage name with dots in it via application schematic", async () => {
        const result = await generateSchematic({
          schematic: "application",
          name: "project.foo.bar",
          cwd: tempDir,
        });

        expect(result.files.map((f) => f.relativePath).sort()).toEqual(
          EXPECTED_APP_FILES("project.foo.bar/"),
        );
        const pkg = JSON.parse(
          readTextSync(join(tempDir, "project.foo.bar/package.json")),
        ) as { name: string };
        expect(pkg.name).toBe("project.foo.bar");
      });

      itAdapted(
        ["ADR-001", "ADR-002"],
        "should manage name to normalize from camel case name",
        async () => {
          const result = await generateSchematic({
            schematic: "application",
            name: "awesomeProject",
            cwd: tempDir,
          });

          expect(result.files.map((f) => f.relativePath).sort()).toEqual(
            EXPECTED_APP_FILES("awesome-project/"),
          );

          const pkg = JSON.parse(
            readTextSync(join(tempDir, "awesome-project/package.json")),
          ) as { name: string };
          expect(pkg.name).toBe("awesome-project");
        },
        "Normalizes camelCase to kebab-case in Bunest scaffold",
      );

      it("should keep underscores", async () => {
        const result = await generateSchematic({
          schematic: "application",
          name: "_awesomeProject",
          cwd: tempDir,
        });

        expect(result.files.map((f) => f.relativePath).sort()).toEqual(
          EXPECTED_APP_FILES("_awesome-project/"),
        );
        const pkg = JSON.parse(
          readTextSync(join(tempDir, "_awesome-project/package.json")),
        ) as { name: string };
        expect(pkg.name).toBe("_awesome-project");
      });

      it('should manage basic name that has no scope name in it but starts with "@"', async () => {
        const result = await generateSchematic({
          schematic: "application",
          name: "@/package",
          cwd: tempDir,
        });

        expect(result.files.map((f) => f.relativePath).sort()).toEqual(
          EXPECTED_APP_FILES("@/package/"),
        );
        const pkg = JSON.parse(
          readTextSync(join(tempDir, "@/package/package.json")),
        ) as { name: string };
        expect(pkg.name).toBe("package");
      });

      it('should manage the name "." (ie., current working directory)', async () => {
        const result = await generateSchematic({
          schematic: "application",
          name: ".",
          cwd: tempDir,
        });

        expect(result.files.map((f) => f.relativePath).sort()).toEqual(
          EXPECTED_APP_FILES(""),
        );
        const pkg = JSON.parse(
          readTextSync(join(tempDir, "package.json")),
        ) as { name: string };
        expect(pkg.name).toBe(basename(tempDir));
      });

      describe("and it meant to be a scoped package", () => {
        it("should manage basic scoped name", async () => {
          const result = await generateSchematic({
            schematic: "application",
            name: "@scope/package",
            cwd: tempDir,
          });

          expect(result.files.map((f) => f.relativePath).sort()).toEqual(
            EXPECTED_APP_FILES("@scope/package/"),
          );
          const pkg = JSON.parse(
            readTextSync(join(tempDir, "@scope/package/package.json")),
          ) as { name: string };
          expect(pkg.name).toBe("@scope/package");
        });

        it('should manage name with blank space right after the "@" symbol', async () => {
          const result = await generateSchematic({
            schematic: "application",
            name: "@ /package",
            cwd: tempDir,
          });

          expect(result.files.map((f) => f.relativePath).sort()).toEqual(
            EXPECTED_APP_FILES("@-/package/"),
          );
          const pkg = JSON.parse(
            readTextSync(join(tempDir, "@-/package/package.json")),
          ) as { name: string };
          expect(pkg.name).toBe("@-/package");
        });
      });
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "createProject manages numeric project name",
      async () => {
        const result = await createProject({
          projectName: "123",
          cwd: tempDir,
          skipInstall: true,
          skipGit: true,
        });

        expect(result.files.map((f) => f.relativePath).sort()).toEqual(
          EXPECTED_APP_FILES(""),
        );
        const pkg = JSON.parse(
          readTextSync(join(tempDir, "123/package.json")),
        ) as { name: string };
        expect(pkg.name).toBe("123");
      },
      "createProject accepts numeric project names via validateProjectName",
    );

    it("should manage name as number via application schematic", async () => {
      const result = await generateSchematic({
        schematic: "application",
        name: "123",
        cwd: tempDir,
      });

      expect(result.files.map((f) => f.relativePath).sort()).toEqual(
        EXPECTED_APP_FILES("123/"),
      );
      const pkg = JSON.parse(
        readTextSync(join(tempDir, "123/package.json")),
      ) as { name: string };
      expect(pkg.name).toBe("123");
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "generates Bun-native TypeScript application without Babel/JavaScript/Jest boilerplate",
      () => {
        const files = buildSchematicFiles(
          "application",
          parseSchematicName("project"),
          { flat: false, spec: true },
        );
        const paths = files.map((f) => f.relativePath);

        expect(paths.some((p) => p.endsWith(".js"))).toBe(false);
        expect(paths).not.toContain("project/babel.config.json");
        expect(paths).not.toContain("project/nodemon.json");
        expect(paths).not.toContain("project/jest.config.js");
        expect(paths).not.toContain("project/jest.config.ts");
        expect(paths).toContain("project/tsconfig.json");
        expect(paths).toContain("project/src/main.ts");
      },
      "Bunest targets Bun TypeScript natively (no language: js or Babel 8)",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage destination directory via createProject dir and flat application schematic",
      async () => {
        const created = await createProject({
          projectName: "project",
          dir: "app",
          cwd: tempDir,
          skipInstall: true,
          skipGit: true,
        });

        expect(created.targetDir).toBe(join(tempDir, "app"));
        expect(created.files.map((f) => f.relativePath).sort()).toEqual(
          EXPECTED_APP_FILES(""),
        );
        const pkg = JSON.parse(
          readTextSync(join(tempDir, "app/package.json")),
        ) as { name: string };
        expect(pkg.name).toBe("project");

        const flatResult = await generateSchematic({
          schematic: "application",
          name: "project",
          dir: "app-flat",
          flat: true,
          cwd: tempDir,
        });
        expect(flatResult.files.map((f) => f.relativePath).sort()).toEqual(
          EXPECTED_APP_FILES(""),
        );
        const flatPkg = JSON.parse(
          readTextSync(join(tempDir, "app-flat/package.json")),
        ) as { name: string };
        expect(flatPkg.name).toBe("project");
      },
      "createProject supports explicit dir; generateSchematic requires flat: true with dir",
    );

    it("should manage destination directory option on application schematic without flat", async () => {
      const result = await generateSchematic({
        schematic: "application",
        name: "project",
        dir: "app",
        cwd: tempDir,
      });

      expect(existsSyncPath(join(tempDir, "app/package.json"))).toBe(true);
      expect(result.files.map((f) => f.relativePath)).toContain("package.json");
    });

    it("should not create a spec file when spec is false", () => {
      const files = buildSchematicFiles(
        "application",
        parseSchematicName("project"),
        { flat: false, spec: false },
      );

      expect(files.map((f) => f.relativePath)).not.toContain(
        "project/test/app.spec.ts",
      );
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should create a spec file using bun:test and @bunest/testing",
      () => {
        const files = buildSchematicFiles(
          "application",
          parseSchematicName("project"),
          { flat: false, spec: true },
        );

        const specFile = files.find(
          (f) => f.relativePath === "project/test/app.spec.ts",
        );
        expect(specFile).toBeDefined();
        expect(specFile?.content).not.toContain('import "reflect-metadata";');
        expect(specFile?.content).toContain(
          'import { describe, expect, it } from "bun:test";',
        );
        expect(specFile?.content).toContain(
          'import { Test } from "@bunest/testing";',
        );
        expect(specFile?.content).toContain(
          'import { AppModule } from "../src/app.module";',
        );
      },
      "Bunest generates bun:test integration spec instead of Jest/Vitest specs",
    );

    it("should create a spec file with custom file suffix", () => {
      const files = buildSchematicFiles(
        "application",
        parseSchematicName("project"),
        { flat: false, spec: true, specFileSuffix: "test" },
      );
      const paths = files.map((f) => f.relativePath);

      expect(paths).not.toContain("project/test/app.spec.ts");
      expect(paths).toContain("project/test/app.test.ts");
    });

    describe("ESM, tsconfig, and strict mode", () => {
      itAdapted(
        ["ADR-001", "ADR-002"],
        "should generate ESM package.json with type module and bun:test scripts",
        () => {
          const files = buildProjectTemplateFiles("project");
          const pkgFile = files.find((f) => f.relativePath === "package.json");
          expect(pkgFile).toBeDefined();

          const pkg = JSON.parse(pkgFile!.content) as {
            type: string;
            scripts: Record<string, string>;
            dependencies: Record<string, string>;
            devDependencies: Record<string, string>;
          };
          expect(pkg.type).toBe("module");
          expect(pkg.scripts.test).toBe("bun test");
          expect(pkg.scripts.build).toContain("bun build");
          expect(pkg.scripts.build).toContain("--format esm");
          expect(pkg.scripts.typecheck).toBe("bun check");
          expect(pkg.devDependencies).not.toHaveProperty("jest");
          expect(pkg.devDependencies).not.toHaveProperty("vitest");
          expect(pkg.devDependencies).not.toHaveProperty("ts-jest");
          expect(pkg.devDependencies).not.toHaveProperty("eslint");
          expect(pkg.devDependencies).not.toHaveProperty("oxlint");
        },
        "Bunest applications are always native ESM using Bun.build and bun:test",
      );

      itAdapted(
        ["ADR-001", "ADR-002"],
        "should generate ESM source files with extensionless Bun bundler imports",
        () => {
          const files = buildProjectTemplateFiles("project");
          const read = (rel: string) =>
            files.find((f) => f.relativePath === rel)?.content ?? "";

          expect(read("src/main.ts")).not.toContain('import "reflect-metadata";');
          expect(read("src/main.ts")).toContain(
            'import { BunestFactory, ValidationPipe } from "@bunest/core";',
          );
          expect(read("src/main.ts")).toContain(
            'import { AppModule } from "./app.module";',
          );

          expect(read("src/app.module.ts")).toContain(
            'import { AppController } from "./app.controller";',
          );
          expect(read("src/app.module.ts")).toContain(
            'import { AppService } from "./app.service";',
          );

          expect(read("src/app.controller.ts")).toContain(
            'import { AppService } from "./app.service";',
          );

          expect(read("src/app.service.ts")).toContain(
            'return { message: "Hello from project!" };',
          );
        },
        "Bun moduleResolution: bundler uses extensionless TS imports instead of .js",
      );

      itAdapted(
        ["ADR-001", "ADR-002"],
        "should respect strict: false in buildProjectTemplateFiles and createProject",
        async () => {
          const created = await createProject({
            projectName: "loose-app",
            cwd: tempDir,
            strict: false,
            skipInstall: true,
            skipGit: true,
          });
          expect(created.projectName).toBe("loose-app");

          const tsconfig = JSON.parse(
            readTextSync(join(tempDir, "loose-app/tsconfig.json")),
          ) as {
            compilerOptions: {
              strict: boolean;
              noUncheckedIndexedAccess: boolean;
              noImplicitOverride: boolean;
              verbatimModuleSyntax: boolean;
            };
          };
          expect(tsconfig.compilerOptions.strict).toBe(false);
          expect(tsconfig.compilerOptions.noUncheckedIndexedAccess).toBe(false);
          expect(tsconfig.compilerOptions.noImplicitOverride).toBe(false);
          expect(tsconfig.compilerOptions.verbatimModuleSyntax).toBe(true);
        },
        "createProject forwards strict option to tsconfig.json",
      );

      it("should propagate strict and packageManager options through application schematic", async () => {
        await generateSchematic({
          schematic: "application",
          name: "project",
          cwd: tempDir,
          ...({ strict: false, packageManager: "pnpm" } as Record<
            string,
            unknown
          >),
        });

        const tsconfig = JSON.parse(
          readTextSync(join(tempDir, "project/tsconfig.json")),
        ) as { compilerOptions: { strict: boolean } };
        expect(tsconfig.compilerOptions.strict).toBe(false);
      });
    });

    describe("when minimal", () => {
      it("should generate one source file and minimal config when minimal is true", async () => {
        const result = await generateSchematic({
          schematic: "application",
          name: "project",
          cwd: tempDir,
          ...({ minimal: true } as Record<string, unknown>),
        });

        expect(result.files.map((f) => f.relativePath).sort()).toEqual(
          [
            "project/.gitignore",
            "project/package.json",
            "project/src/main.ts",
            "project/tsconfig.json",
          ].sort(),
        );
      });
    });

    describe("in a directory that already has files", () => {
      it("should generate around files the template does not write", async () => {
        const projectDir = join(tempDir, "project");
        mkdirSyncPath(join(projectDir, ".git"), { recursive: true });
        writeTextSync(join(projectDir, "SPEC.md"), "# What to build");
        writeTextSync(join(projectDir, ".git/HEAD"), "ref: refs/heads/main");

        const result = await generateSchematic({
          schematic: "application",
          name: "project",
          cwd: tempDir,
        });

        expect(readTextSync(join(projectDir, "SPEC.md"))).toBe(
          "# What to build",
        );
        expect(readTextSync(join(projectDir, ".git/HEAD"))).toBe(
          "ref: refs/heads/main",
        );
        expect(result.files.map((f) => f.relativePath)).toContain(
          "project/package.json",
        );
        expect(result.files.map((f) => f.relativePath)).toContain(
          "project/src/main.ts",
        );
      });

      it("should keep an existing README.md and .gitignore instead of overwriting them", async () => {
        const projectDir = join(tempDir, "project");
        mkdirSyncPath(projectDir, { recursive: true });
        writeTextSync(join(projectDir, "README.md"), "# My service");
        writeTextSync(join(projectDir, ".gitignore"), "secrets/");

        const result = await generateSchematic({
          schematic: "application",
          name: "project",
          cwd: tempDir,
        });

        expect(readTextSync(join(projectDir, "README.md"))).toBe(
          "# My service",
        );
        expect(readTextSync(join(projectDir, ".gitignore"))).toBe(
          "secrets/",
        );
        expect(result.files.map((f) => f.relativePath)).toContain(
          "project/package.json",
        );
      });

      it("should refuse, naming every file it would overwrite, and write nothing", async () => {
        const projectDir = join(tempDir, "project");
        mkdirSyncPath(projectDir, { recursive: true });
        writeTextSync(join(projectDir, "package.json"), '{ "name": "mine" }');
        writeTextSync(join(projectDir, "tsconfig.json"), "{}");
        writeTextSync(join(projectDir, "SPEC.md"), "# What to build");

        let caught: unknown;
        try {
          await generateSchematic({
            schematic: "application",
            name: "project",
            cwd: tempDir,
          });
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(FileCollisionError);
        const collision = caught as FileCollisionError;
        expect(collision.collidingPaths).toContain("project/package.json");
        expect(collision.collidingPaths).toContain("project/tsconfig.json");
        expect(readTextSync(join(projectDir, "package.json"))).toBe(
          '{ "name": "mine" }',
        );
        expect(existsSyncPath(join(projectDir, "src/main.ts"))).toBe(false);
      });
    });
  },
);
