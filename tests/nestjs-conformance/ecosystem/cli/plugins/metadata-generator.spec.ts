import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateMetadataFile } from "../../../../../packages/cli/src";
import { describeConformance, itAdapted } from "../../../_helpers/index";

describeConformance(
  "Metadata Generator (generateMetadataFile & ESM import extensions)",
  {
    upstreamPath:
      "nest-cli/test/lib/compiler/plugins/plugin-metadata-generator.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts NestJS PluginMetadataGenerator (#3364 NodeNext/ESM import extension & metadata tree) tests to Bunest's `generateMetadataFile()`.",
  },
  () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "bunest-cli-conf-metagen-"));
      mkdirSync(join(tmpDir, "src", "users"), { recursive: true });
      mkdirSync(join(tmpDir, "src", "shared"), { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    const seedFixtureProject = () => {
      writeFileSync(
        join(tmpDir, "src", "shared", "address.dto.ts"),
        `export class AddressDto {
  /** Street line */
  street!: string;
  readonly zipCode!: string;
}
`,
        "utf8",
      );
      writeFileSync(
        join(tmpDir, "src", "users", "create-user.dto.ts"),
        `import { AddressDto } from "../shared/address.dto";

export enum UserRole {
  ADMIN = "admin",
  MEMBER = "member",
}

export class CreateUserDto {
  /** Primary email address */
  @IsEmail()
  email!: string;

  @Min(1)
  @Max(120)
  age: number = 18;

  nickname?: string | null;

  tags!: string[];

  role!: UserRole;

  address!: AddressDto;

  @ApiHideProperty()
  secret!: string;
}
`,
        "utf8",
      );
      writeFileSync(
        join(tmpDir, "src", "users", "users.controller.ts"),
        `import { CreateUserDto } from "./create-user.dto";

function Get(): MethodDecorator { return () => {}; }
function Post(): MethodDecorator { return () => {}; }

export class UsersController {
  /** List all users */
  @Get()
  findAll(): Promise<string[]> {
    return Promise.resolve([]);
  }

  /** Create a user */
  @Post()
  create(): CreateUserDto {
    return {} as CreateUserDto;
  }
}
`,
        "utf8",
      );
      // Files that MUST be skipped by walkSourceFiles
      writeFileSync(
        join(tmpDir, "src", "users", "users.controller.spec.ts"),
        `export class IgnoredSpecController { @Get() run(): string { return ""; } }\n`,
        "utf8",
      );
      writeFileSync(
        join(tmpDir, "src", "users", "types.dto.d.ts"),
        `export declare class IgnoredDtsDto { id: string; }\n`,
        "utf8",
      );
    };

    describe("ESM `.js` import extension rewriting (esmCompatible)", () => {
      it("omits `.js` extension on relative imports by default (bundler resolution)", async () => {
        seedFixtureProject();

        const res = await generateMetadataFile({
          rootDir: tmpDir,
          pathToSource: "src",
          outDir: "src",
        });

        expect(res.modelsCount).toBe(2);
        expect(res.controllersCount).toBe(1);
        expect(existsSync(res.outputPath)).toBe(true);
        expect(res.code).toContain('import("./shared/address.dto")');
        expect(res.code).toContain('import("./users/create-user.dto")');
        expect(res.code).toContain('import("./users/users.controller")');
        expect(res.code).not.toContain(".dto.js");
        expect(res.code).not.toContain(".controller.js");
      });

      it("appends `.js` to relative dynamic imports across models and controllers when esmCompatible is true", async () => {
        seedFixtureProject();

        const res = await generateMetadataFile({
          rootDir: tmpDir,
          pathToSource: "src",
          outDir: "src",
          esmCompatible: true,
          esmCompatibleWasConfigured: true,
        });

        expect(res.code).toContain('import("./shared/address.dto.js")');
        expect(res.code).toContain('import("./users/create-user.dto.js")');
        expect(res.code).toContain('import("./users/users.controller.js")');
        expect(res.code).not.toContain(".js.js");
      });

      it("emits relative `../` import specifiers when outDir is a sibling directory", async () => {
        seedFixtureProject();

        const res = await generateMetadataFile({
          rootDir: tmpDir,
          pathToSource: "src",
          outDir: "generated",
          esmCompatible: true,
        });

        expect(res.outputPath).toBe(join(tmpDir, "generated", "metadata.ts"));
        expect(res.code).toContain('import("../src/shared/address.dto.js")');
        expect(res.code).toContain('import("../src/users/users.controller.js")');
      });

      // BUNEST_BUG: generateMetadataFile() only checks `options.esmCompatible === true` and does not inspect tsconfig.json `moduleResolution: "NodeNext"` / `"Node16"` to auto-enable `.js` extensions when `esmCompatible` is unset (packages/cli/src/plugins/metadata.plugin.ts:2054)
      it.skip("auto-enables `.js` import extensions when tsconfig uses NodeNext/Node16 moduleResolution", async () => {
        seedFixtureProject();
        writeFileSync(
          join(tmpDir, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              module: "NodeNext",
              moduleResolution: "NodeNext",
            },
          }),
          "utf8",
        );

        const res = await generateMetadataFile({
          rootDir: tmpDir,
          pathToSource: "src",
          outDir: "src",
        });

        expect(res.code).toContain('import("./shared/address.dto.js")');
      });
    });

    describe("metadata tree extraction & runtime loadability", () => {
      it("ignores .spec.ts, .test.ts, .d.ts, node_modules, and dist directories", async () => {
        seedFixtureProject();
        mkdirSync(join(tmpDir, "src", "node_modules", "pkg"), {
          recursive: true,
        });
        writeFileSync(
          join(tmpDir, "src", "node_modules", "pkg", "ignored.dto.ts"),
          `export class NodeModDto { x!: string; }\n`,
          "utf8",
        );
        mkdirSync(join(tmpDir, "src", "dist"), { recursive: true });
        writeFileSync(
          join(tmpDir, "src", "dist", "built.dto.ts"),
          `export class DistDto { x!: string; }\n`,
          "utf8",
        );

        const res = await generateMetadataFile({
          rootDir: tmpDir,
          pathToSource: "src",
          outDir: "src",
        });

        expect(res.code).not.toContain("IgnoredSpecController");
        expect(res.code).not.toContain("IgnoredDtsDto");
        expect(res.code).not.toContain("NodeModDto");
        expect(res.code).not.toContain("DistDto");
      });

      it("emits constraints, JSDoc comments, readonly, enumName, nullable, defaults, and hides @ApiHideProperty fields", async () => {
        seedFixtureProject();

        const res = await generateMetadataFile({
          rootDir: tmpDir,
          pathToSource: "src",
          outDir: "src",
          readonly: true,
          autoFillEnumName: true,
          dtoKeyOfComment: "description",
          controllerKeyOfComment: "summary",
        });

        expect(res.code).toContain('"AddressDto"');
        expect(res.code).toContain('"CreateUserDto"');
        expect(res.code).toContain('"UsersController"');
        expect(res.code).toContain('"description": "Street line"');
        expect(res.code).toContain("readOnly: true");
        expect(res.code).toContain('format: "email"');
        expect(res.code).toContain("minimum: 1");
        expect(res.code).toContain("maximum: 120");
        expect(res.code).toContain("default: 18");
        expect(res.code).toContain("nullable: true");
        expect(res.code).toContain("isArray: true");
        expect(res.code).toContain('enumName: "UserRole"');
        expect(res.code).not.toContain('"secret"');
        expect(res.code).toContain('"summary": "List all users"');
        expect(res.code).toContain("status: 200");
        expect(res.code).toContain("status: 201");
      });

      it("supports custom dtoFileNameSuffix and controllerFileNameSuffix filters", async () => {
        writeFileSync(
          join(tmpDir, "src", "item.schema.ts"),
          `export class ItemSchema { title!: string; }\n`,
          "utf8",
        );
        writeFileSync(
          join(tmpDir, "src", "item.handler.ts"),
          `export class ItemHandler { @Get() list(): string { return ""; } }\n`,
          "utf8",
        );

        const res = await generateMetadataFile({
          rootDir: tmpDir,
          pathToSource: "src",
          outDir: "src",
          dtoFileNameSuffix: [".schema.ts"],
          controllerFileNameSuffix: [".handler.ts"],
        });

        expect(res.modelsCount).toBe(1);
        expect(res.controllersCount).toBe(1);
        expect(res.code).toContain('"ItemSchema"');
        expect(res.code).toContain('"ItemHandler"');
      });

      itAdapted(
        ["ADR-001", "ADR-002"],
        "generates an executable ESM metadata.ts module directly importable by Bun",
        async () => {
          writeFileSync(
            join(tmpDir, "src", "simple.dto.ts"),
            `export class SimpleDto {\n  /** Name */\n  name!: string;\n}\n`,
            "utf8",
          );
          writeFileSync(
            join(tmpDir, "src", "simple.controller.ts"),
            `function Get(): MethodDecorator { return () => {}; }\nexport class SimpleController {\n  /** Ping */\n  @Get()\n  ping(): string { return "pong"; }\n}\n`,
            "utf8",
          );

          const res = await generateMetadataFile({
            rootDir: tmpDir,
            pathToSource: "src",
            outDir: "src",
            esmCompatible: false,
          });

          const mod = (await import(
            `${pathToFileURL(res.outputPath).href}?t=${Date.now()}`
          )) as {
            default: () => Promise<{
              "@nestjs/swagger": {
                models: Array<[Promise<unknown>, Record<string, unknown>]>;
                controllers: Array<[Promise<unknown>, Record<string, unknown>]>;
              };
            }>;
          };
          const loaded = await mod.default();
          expect(loaded["@nestjs/swagger"].models).toHaveLength(1);
          expect(loaded["@nestjs/swagger"].controllers).toHaveLength(1);
          const [, modelMeta] = loaded["@nestjs/swagger"].models[0]!;
          expect(modelMeta).toHaveProperty("SimpleDto");
          const [, ctrlMeta] = loaded["@nestjs/swagger"].controllers[0]!;
          expect(ctrlMeta).toHaveProperty("SimpleController");
        },
      );
    });
  },
);
