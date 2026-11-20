import "reflect-metadata";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSchematicFiles,
  generateSchematic,
  parseSchematicName,
  type GenerateSchematicOptions,
  type PlannedFile,
} from "../../../../../packages/cli/src";
import { describeConformance, itAdapted } from "../../../_helpers/index";

type ExtendedResourceOptions = GenerateSchematicOptions & {
  readonly crud?: boolean;
  readonly type?:
    | "rest"
    | "microservice"
    | "ws"
    | "graphql-code-first"
    | "graphql-schema-first";
};

function findFile(
  files: readonly PlannedFile[],
  relativePath: string,
): PlannedFile | undefined {
  return files.find((file) => file.relativePath === relativePath);
}

describeConformance(
  "Resource Schematic",
  {
    upstreamPath: "schematics/src/lib/resource/resource.factory.test.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts @nestjs/schematics resource factory tests to Bunest CLI REST CRUD templates (class-validator DTOs, verbatimModuleSyntax value/type imports, bun:test CRUD spec). Missing non-REST transports, crud: false, entity generation, and plural singularization are documented via BUNEST_BUG skips.",
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

    describe("[REST API]", () => {
      itAdapted(
        ["ADR-001", "ADR-002"],
        "should generate appropriate REST CRUD files",
        async () => {
          const planned = buildSchematicFiles(
            "resource",
            parseSchematicName("users"),
            { flat: false, spec: true },
          );
          expect(planned.map((f) => f.relativePath)).toEqual([
            "users/dto/create-users.dto.ts",
            "users/dto/update-users.dto.ts",
            "users/users.service.ts",
            "users/users.controller.ts",
            "users/users.module.ts",
            "users/users.spec.ts",
          ]);

          const cwd = createTempDir();
          const result = await generateSchematic({
            schematic: "resource",
            name: "users",
            cwd,
          });
          expect(result.files.map((f) => f.relativePath)).toEqual([
            "users/dto/create-users.dto.ts",
            "users/dto/update-users.dto.ts",
            "users/users.service.ts",
            "users/users.controller.ts",
            "users/users.module.ts",
            "users/users.spec.ts",
          ]);
        },
        "Bunest generates REST DTOs, service, controller, module, and unified CRUD integration spec",
      );

      // BUNEST_BUG: resource schematic omits entities/<singular>.entity.ts and does not singularize plural resource names ("users" emits "dto/create-users.dto.ts" instead of "dto/create-user.dto.ts" and no "entities/user.entity.ts") (packages/cli/src/templates/schematic.templates.ts:875-910)
      it.skip("should generate entities/user.entity.ts and singularized DTO filenames for plural resource names", () => {
        const planned = buildSchematicFiles(
          "resource",
          parseSchematicName("users"),
          { flat: false, spec: true },
        );
        const paths = planned.map((f) => f.relativePath).sort();
        expect(paths).toContain("users/entities/user.entity.ts");
        expect(paths).toContain("users/dto/create-user.dto.ts");
        expect(paths).toContain("users/dto/update-user.dto.ts");
      });

      // BUNEST_BUG: parseSchematicName rejects leading underscore ("_users") instead of preserving underscores in resource paths and filenames (packages/cli/src/utils/naming.ts: VALID_SEGMENT_REGEX and toKebabCase)
      it.skip("should keep underscores in resource's path and file name", () => {
        const planned = buildSchematicFiles(
          "resource",
          parseSchematicName("_users"),
          { flat: false, spec: true },
        );
        expect(planned.map((f) => f.relativePath)).toContain(
          "_users/_users.controller.ts",
        );
        expect(planned.map((f) => f.relativePath)).toContain(
          "_users/_users.module.ts",
        );
        expect(planned.map((f) => f.relativePath)).toContain(
          "_users/_users.service.ts",
        );
      });

      itAdapted(
        ["ADR-001", "ADR-002"],
        "should support nested paths and flat layout",
        async () => {
          const cwd = createTempDir();
          const result = await generateSchematic({
            schematic: "resource",
            name: "admin/userProfile",
            flat: true,
            spec: true,
            cwd,
          });
          expect(result.files.map((f) => f.relativePath)).toEqual([
            "admin/create-user-profile.dto.ts",
            "admin/update-user-profile.dto.ts",
            "admin/user-profile.service.ts",
            "admin/user-profile.controller.ts",
            "admin/user-profile.module.ts",
            "admin/user-profile.spec.ts",
          ]);
          const ctrl = readFileSync(
            join(cwd, "src/admin/user-profile.controller.ts"),
            "utf8",
          );
          expect(ctrl).toContain('from "./create-user-profile.dto"');
          expect(ctrl).toContain('from "./update-user-profile.dto"');
        },
        "adjusts DTO import prefix to './' in flat mode under normalized nested paths",
      );

      describe('when "crud" option is not enabled', () => {
        // BUNEST_BUG: GenerateSchematicOptions and buildSchematicFiles("resource") do not support crud: false to omit DTOs and CRUD entry points (packages/cli/src/types.ts, packages/cli/src/templates/schematic.templates.ts:875-1094)
        it.skip("should generate appropriate files (without dtos)", async () => {
          const cwd = createTempDir();
          const options: ExtendedResourceOptions = {
            schematic: "resource",
            name: "users",
            crud: false,
            cwd,
          };
          const result = await generateSchematic(options);
          const files = result.files.map((f) => f.relativePath);
          expect(files.some((f) => f.includes("dto/"))).toBe(false);
          expect(files).toContain("users/users.controller.ts");
          expect(files).toContain("users/users.module.ts");
          expect(files).toContain("users/users.service.ts");
        });
      });

      describe('when "spec" option is not enabled', () => {
        it("should omit spec file when spec is false", async () => {
          const cwd = createTempDir();
          const result = await generateSchematic({
            schematic: "resource",
            name: "users",
            spec: false,
            cwd,
          });
          const files = result.files.map((f) => f.relativePath);
          expect(files).toEqual([
            "users/dto/create-users.dto.ts",
            "users/dto/update-users.dto.ts",
            "users/users.service.ts",
            "users/users.controller.ts",
            "users/users.module.ts",
          ]);
          expect(existsSync(join(cwd, "src/users/users.spec.ts"))).toBe(false);
        });

        // BUNEST_BUG: GenerateSchematicOptions and buildSchematicFiles("resource") do not support crud: false combined with spec: false (packages/cli/src/types.ts, packages/cli/src/templates/schematic.templates.ts:875-1094)
        it.skip("should generate appropriate files (without dtos and specs)", async () => {
          const cwd = createTempDir();
          const options: ExtendedResourceOptions = {
            schematic: "resource",
            name: "users",
            spec: false,
            crud: false,
            cwd,
          };
          const result = await generateSchematic(options);
          expect(result.files.map((f) => f.relativePath).sort()).toEqual([
            "users/users.controller.ts",
            "users/users.module.ts",
            "users/users.service.ts",
          ]);
        });
      });
    });

    describe("[REST API - generated contents]", () => {
      let suiteDir: string;

      beforeAll(async () => {
        suiteDir = mkdtempSync(join(tmpdir(), "bunest-cli-conf-"));
        await generateSchematic({
          schematic: "resource",
          name: "users",
          cwd: suiteDir,
        });
      });

      afterAll(() => {
        if (suiteDir) {
          rmSync(suiteDir, { recursive: true, force: true });
        }
      });

      itAdapted(
        ["ADR-001", "ADR-002"],
        'should generate "UsersController" class',
        () => {
          const content = readFileSync(
            join(suiteDir, "src/users/users.controller.ts"),
            "utf8",
          );
          expect(content).toEqual(`import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from "@bunest/core";
import { CreateUsersDto } from "./dto/create-users.dto";
import { UpdateUsersDto } from "./dto/update-users.dto";
import { UsersService, type UsersRecord } from "./users.service";

@Controller("/users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  create(@Body() dto: CreateUsersDto): UsersRecord {
    return this.usersService.create(dto);
  }

  @Get()
  findAll(): UsersRecord[] {
    return this.usersService.findAll();
  }

  @Get(":id")
  findOne(@Param("id") id: string): UsersRecord {
    return this.usersService.findOne(id);
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body() dto: UpdateUsersDto,
  ): UsersRecord {
    return this.usersService.update(id, dto);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@Param("id") id: string): void {
    this.usersService.remove(id);
  }
}
`);
        },
        "value-imports DTO classes for decorator metadata and type-imports UsersRecord under verbatimModuleSyntax",
      );

      itAdapted(
        ["ADR-001", "ADR-002"],
        'should generate "UsersService" class',
        () => {
          const content = readFileSync(
            join(suiteDir, "src/users/users.service.ts"),
            "utf8",
          );
          expect(content)
            .toEqual(`import { Injectable, NotFoundException } from "@bunest/core";
import type { CreateUsersDto } from "./dto/create-users.dto";
import type { UpdateUsersDto } from "./dto/update-users.dto";

export interface UsersRecord {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

@Injectable()
export class UsersService {
  private readonly items = new Map<string, UsersRecord>();
  private seq = 0;

  create(dto: CreateUsersDto): UsersRecord {
    const id = \`users_\${++this.seq}\`;
    const record: UsersRecord = {
      id,
      name: dto.name,
      description: dto.description,
    };
    this.items.set(id, record);
    return record;
  }

  findAll(): UsersRecord[] {
    return [...this.items.values()];
  }

  findOne(id: string): UsersRecord {
    const found = this.items.get(id);
    if (!found) {
      throw new NotFoundException(\`Users "\${id}" not found\`);
    }
    return found;
  }

  update(id: string, dto: UpdateUsersDto): UsersRecord {
    const existing = this.findOne(id);
    const updated: UsersRecord = {
      ...existing,
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
    };
    this.items.set(id, updated);
    return updated;
  }

  remove(id: string): void {
    this.findOne(id);
    this.items.delete(id);
  }
}
`);
        },
        "generates complete in-memory CRUD service with import type DTO references",
      );

      itAdapted(
        ["ADR-001", "ADR-002"],
        'should generate "UsersModule" class',
        () => {
          const content = readFileSync(
            join(suiteDir, "src/users/users.module.ts"),
            "utf8",
          );
          expect(content).toEqual(`import { Module } from "@bunest/core";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
`);
        },
        "exports UsersService from generated @bunest/core UsersModule",
      );

      // BUNEST_BUG: resource schematic does not generate entities/<singular>.entity.ts (packages/cli/src/templates/schematic.templates.ts:875-1094)
      it.skip('should generate "User" entity class', () => {
        const entityPath = join(suiteDir, "src/users/entities/user.entity.ts");
        expect(existsSync(entityPath)).toBe(true);
        expect(readFileSync(entityPath, "utf8")).toEqual("export class User {}\n");
      });

      itAdapted(
        ["ADR-001", "ADR-002"],
        'should generate "CreateUsersDto" class',
        () => {
          const content = readFileSync(
            join(suiteDir, "src/users/dto/create-users.dto.ts"),
            "utf8",
          );
          expect(content)
            .toEqual(`import { IsOptional, IsString, MinLength } from "class-validator";

export class CreateUsersDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;
}
`);
        },
        "generates class-validator decorated DTO compatible with Bunest ValidationPipe",
      );

      itAdapted(
        ["ADR-001", "ADR-002"],
        'should generate "UpdateUsersDto" class',
        () => {
          const content = readFileSync(
            join(suiteDir, "src/users/dto/update-users.dto.ts"),
            "utf8",
          );
          expect(content)
            .toEqual(`import { IsOptional, IsString, MinLength } from "class-validator";

export class UpdateUsersDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
`);
        },
        "generates standalone optional class-validator UpdateDto without @nestjs/swagger or @nestjs/mapped-types",
      );

      itAdapted(
        ["ADR-001", "ADR-002"],
        "should generate CRUD integration spec file using bun:test and @bunest/testing",
        () => {
          const content = readFileSync(
            join(suiteDir, "src/users/users.spec.ts"),
            "utf8",
          );
          expect(content).toContain('import "reflect-metadata";');
          expect(content).toContain(
            'import { describe, expect, it } from "bun:test";',
          );
          expect(content).toContain(
            'import { ValidationPipe } from "@bunest/core";',
          );
          expect(content).toContain('import { Test } from "@bunest/testing";');
          expect(content).toContain(
            'import { UsersModule } from "./users.module";',
          );
          expect(content).toContain(
            'import type { UsersRecord } from "./users.service";',
          );
          expect(content).toContain('describe("UsersModule CRUD"');
          expect(content).toContain('client.post("/users"');
          expect(content).toContain('client.get("/users")');
          expect(content).toContain("client.patch(");
          expect(content).toContain("client.delete(");
        },
        "Bunest generates a unified HTTP CRUD integration spec instead of separate empty controller/service unit stubs",
      );
    });

    describe('[REST API - with "crud" disabled]', () => {
      // BUNEST_BUG: resource schematic does not support crud: false to emit minimal controller/service without DTOs or entity (packages/cli/src/types.ts, packages/cli/src/templates/schematic.templates.ts:875-1094)
      it.skip("should generate minimal UsersController, UsersService, and UsersModule without DTOs or entity", async () => {
        const cwd = createTempDir();
        const options: ExtendedResourceOptions = {
          schematic: "resource",
          name: "users",
          crud: false,
          spec: false,
          cwd,
        };
        await generateSchematic(options);

        const controller = readFileSync(
          join(cwd, "src/users/users.controller.ts"),
          "utf8",
        );
        expect(controller).not.toContain("@Post()");
        expect(controller).not.toContain("CreateUserDto");
        expect(
          existsSync(join(cwd, "src/users/dto/create-user.dto.ts")),
        ).toBe(false);
        expect(
          existsSync(join(cwd, "src/users/entities/user.entity.ts")),
        ).toBe(false);
      });
    });

    describe("[Microservice]", () => {
      // BUNEST_BUG: resource schematic does not support type: "microservice" (@MessagePattern/@Payload controller, DTOs, entity, and crud/spec flags) (packages/cli/src/types.ts, packages/cli/src/templates/schematic.templates.ts:875-1094)
      it.skip("should generate microservice CRUD files with @MessagePattern and @Payload handlers", async () => {
        const cwd = createTempDir();
        const options: ExtendedResourceOptions = {
          schematic: "resource",
          name: "users",
          type: "microservice",
          cwd,
        };
        const result = await generateSchematic(options);
        const controller = result.files.find(
          (f) => f.relativePath === "users/users.controller.ts",
        );
        expect(controller?.content).toContain("@MessagePattern(");
        expect(controller?.content).toContain("@Payload()");
      });

      // BUNEST_BUG: resource schematic does not support type: "microservice" with crud: false (packages/cli/src/types.ts, packages/cli/src/templates/schematic.templates.ts:875-1094)
      it.skip("should generate microservice files without DTOs when crud is disabled", async () => {
        const cwd = createTempDir();
        const options: ExtendedResourceOptions = {
          schematic: "resource",
          name: "users",
          type: "microservice",
          crud: false,
          spec: false,
          cwd,
        };
        const result = await generateSchematic(options);
        expect(result.files.map((f) => f.relativePath).sort()).toEqual([
          "users/users.controller.ts",
          "users/users.module.ts",
          "users/users.service.ts",
        ]);
      });
    });

    describe("[WebSockets]", () => {
      // BUNEST_BUG: resource schematic does not support type: "ws" (@WebSocketGateway/@SubscribeMessage gateway, DTOs, entity, and crud/spec flags) (packages/cli/src/types.ts, packages/cli/src/templates/schematic.templates.ts:875-1094)
      it.skip("should generate WebSockets gateway CRUD files with @WebSocketGateway and @SubscribeMessage", async () => {
        const cwd = createTempDir();
        const options: ExtendedResourceOptions = {
          schematic: "resource",
          name: "users",
          type: "ws",
          crud: true,
          cwd,
        };
        const result = await generateSchematic(options);
        const gateway = result.files.find(
          (f) => f.relativePath === "users/users.gateway.ts",
        );
        expect(gateway).toBeDefined();
        expect(gateway?.content).toContain("@WebSocketGateway()");
        expect(gateway?.content).toContain("@SubscribeMessage(");
      });

      // BUNEST_BUG: resource schematic does not support type: "ws" with crud: false (packages/cli/src/types.ts, packages/cli/src/templates/schematic.templates.ts:875-1094)
      it.skip("should generate WebSockets gateway files without DTOs when crud is disabled", async () => {
        const cwd = createTempDir();
        const options: ExtendedResourceOptions = {
          schematic: "resource",
          name: "users",
          type: "ws",
          crud: false,
          spec: false,
          cwd,
        };
        const result = await generateSchematic(options);
        expect(result.files.map((f) => f.relativePath).sort()).toEqual([
          "users/users.gateway.ts",
          "users/users.module.ts",
          "users/users.service.ts",
        ]);
      });
    });

    describe("[GraphQL - Code first]", () => {
      // BUNEST_BUG: resource schematic does not support type: "graphql-code-first" (@Resolver/@Query/@Mutation resolver, @ObjectType entity, @InputType DTOs) (packages/cli/src/types.ts, packages/cli/src/templates/schematic.templates.ts:875-1094)
      it.skip("should generate GraphQL code-first resolver, entity, and input DTO files", async () => {
        const cwd = createTempDir();
        const options: ExtendedResourceOptions = {
          schematic: "resource",
          name: "users",
          type: "graphql-code-first",
          crud: true,
          cwd,
        };
        const result = await generateSchematic(options);
        const resolver = result.files.find(
          (f) => f.relativePath === "users/users.resolver.ts",
        );
        expect(resolver).toBeDefined();
        expect(resolver?.content).toContain("@Resolver(");
        expect(resolver?.content).toContain("@Mutation(");
        expect(
          result.files.find(
            (f) => f.relativePath === "users/dto/create-user.input.ts",
          ),
        ).toBeDefined();
      });

      // BUNEST_BUG: resource schematic does not support type: "graphql-code-first" with crud: false (packages/cli/src/types.ts, packages/cli/src/templates/schematic.templates.ts:875-1094)
      it.skip("should generate GraphQL code-first files without inputs when crud is disabled", async () => {
        const cwd = createTempDir();
        const options: ExtendedResourceOptions = {
          schematic: "resource",
          name: "users",
          type: "graphql-code-first",
          crud: false,
          spec: false,
          cwd,
        };
        const result = await generateSchematic(options);
        expect(result.files.map((f) => f.relativePath).sort()).toEqual([
          "users/users.module.ts",
          "users/users.resolver.ts",
          "users/users.service.ts",
        ]);
      });
    });

    describe("[GraphQL - Schema first]", () => {
      // BUNEST_BUG: resource schematic does not support type: "graphql-schema-first" (.graphql SDL schema, resolver, entity, input DTOs) (packages/cli/src/types.ts, packages/cli/src/templates/schematic.templates.ts:875-1094)
      it.skip("should generate GraphQL schema-first .graphql SDL, resolver, entity, and input DTO files", async () => {
        const cwd = createTempDir();
        const options: ExtendedResourceOptions = {
          schematic: "resource",
          name: "users",
          type: "graphql-schema-first",
          cwd,
        };
        const result = await generateSchematic(options);
        const sdl = result.files.find(
          (f) => f.relativePath === "users/users.graphql",
        );
        expect(sdl).toBeDefined();
        expect(sdl?.content).toContain("type Query {");
        expect(sdl?.content).toContain("type Mutation {");
      });

      // BUNEST_BUG: resource schematic does not support type: "graphql-schema-first" with crud: false (packages/cli/src/types.ts, packages/cli/src/templates/schematic.templates.ts:875-1094)
      it.skip("should generate GraphQL schema-first files without SDL/inputs when crud is disabled", async () => {
        const cwd = createTempDir();
        const options: ExtendedResourceOptions = {
          schematic: "resource",
          name: "users",
          type: "graphql-schema-first",
          crud: false,
          spec: false,
          cwd,
        };
        const result = await generateSchematic(options);
        expect(result.files.map((f) => f.relativePath).sort()).toEqual([
          "users/users.module.ts",
          "users/users.resolver.ts",
          "users/users.service.ts",
        ]);
      });
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should create spec file when flat is true",
      async () => {
        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic: "resource",
          name: "foo",
          spec: true,
          flat: true,
          cwd,
        });

        expect(
          result.files.find((f) => f.relativePath === "foo.spec.ts"),
        ).toBeDefined();
      },
      "Bunest emits unified <name>.spec.ts for resource schematic",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should create spec file with custom file suffix",
      async () => {
        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic: "resource",
          name: "foo",
          spec: true,
          specFileSuffix: "test",
          flat: true,
          cwd,
        });

        expect(
          result.files.find((f) => f.relativePath === "foo.spec.ts"),
        ).toBeUndefined();
        expect(
          result.files.find((f) => f.relativePath === "foo.test.ts"),
        ).toBeDefined();
      },
      "honours specFileSuffix for unified resource spec",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should generate REST resource and spec files with extensionless Bun ESM imports (no .js suffix)",
      async () => {
        const cwd = createTempDir();
        await generateSchematic({
          schematic: "application",
          name: "my-app",
          flat: true,
          cwd,
        });
        await generateSchematic({
          schematic: "resource",
          name: "users",
          spec: true,
          flat: true,
          cwd,
        });

        const controller = readFileSync(
          join(cwd, "src/users.controller.ts"),
          "utf8",
        );
        const service = readFileSync(join(cwd, "src/users.service.ts"), "utf8");
        const mod = readFileSync(join(cwd, "src/users.module.ts"), "utf8");
        const spec = readFileSync(join(cwd, "src/users.spec.ts"), "utf8");

        for (const content of [controller, service, mod, spec]) {
          expect(content).not.toMatch(/\.js["']/);
        }
        expect(controller).toContain(
          'import { CreateUsersDto } from "./create-users.dto"',
        );
        expect(controller).toContain(
          'import { UpdateUsersDto } from "./update-users.dto"',
        );
        expect(controller).toContain(
          'import { UsersService, type UsersRecord } from "./users.service"',
        );
        expect(service).toContain(
          'import type { CreateUsersDto } from "./create-users.dto"',
        );
        expect(service).toContain(
          'import type { UpdateUsersDto } from "./update-users.dto"',
        );
        expect(mod).toContain(
          'import { UsersController } from "./users.controller"',
        );
        expect(mod).toContain(
          'import { UsersService } from "./users.service"',
        );
        expect(spec).toContain(
          'import { UsersModule } from "./users.module"',
        );
      },
      "Bun moduleResolution: 'bundler' uses extensionless TS imports across all generated ESM files",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should generate standalone UpdateDto without requiring @nestjs/mapped-types install tasks",
      () => {
        const planned = buildSchematicFiles(
          "resource",
          parseSchematicName("users"),
          { flat: false, spec: true },
        );
        const updateDto = findFile(planned, "users/dto/update-users.dto.ts");
        expect(updateDto).toBeDefined();
        expect(updateDto?.content).not.toContain("@nestjs/mapped-types");
        expect(updateDto?.content).not.toContain("@nestjs/swagger");
        expect(updateDto?.content).toContain('from "class-validator"');
      },
      "Bunest resource UpdateDto uses class-validator directly without spawning package-manager install tasks",
    );
  },
);
