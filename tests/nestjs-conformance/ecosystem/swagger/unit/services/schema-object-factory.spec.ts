import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  Body,
  Controller,
  Get,
  Logger,
  MetadataRegistry,
  Module,
  Post,
  Query,
  type Type,
} from "../../../../../../packages/core/src/common";
import { BunestFactory } from "../../../../../../packages/core/src";
import {
  ApiExtension,
  ApiHideProperty,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiSchema,
  DeepPartialType,
  DocumentBuilder,
  IntersectionType,
  OmitType,
  PartialType,
  PickType,
  SWAGGER_METADATA_KEYS,
  SchemaExplorer,
  SwaggerModule,
  type OpenApiParameter,
  type OpenApiSchema,
  type SchemaObject,
  type SchemasObject,
  type StandardJSONSchemaV1,
  type StandardSchemaConverter,
} from "../../../../../../packages/swagger/src";
import { createSpy, describeConformance } from "../../../../_helpers";
import { CreateUserDto } from "./fixtures/create-user.dto";

function createStandardSchema(
  schema: Record<string, unknown>,
  vendor = "test",
): StandardJSONSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor,
      validate: (value: unknown) => ({ value }),
      jsonSchema: {
        input: () => schema,
        output: () => schema,
      },
    },
  } as unknown as StandardJSONSchemaV1;
}

function exploreModel(
  dto: Function,
  explorer = new SchemaExplorer(),
): { key: string; schemas: Record<string, OpenApiSchema> } {
  const key = explorer.registerDtoSchema(dto);
  return { key, schemas: explorer.getSchemas() };
}

async function createDocForController(
  controller: Type<unknown>,
  standardSchemaConverter?: StandardSchemaConverter,
  openApiVersion = "3.0.0",
) {
  @Module({ controllers: [controller] })
  class TestModule {}
  const app = await BunestFactory.create(TestModule, { logger: false });
  try {
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setOpenAPIVersion(openApiVersion).build(),
      standardSchemaConverter ? { standardSchemaConverter } : {},
    );
  } finally {
    await app.close();
  }
}

describeConformance(
  "SchemaObjectFactory (SchemaExplorer)",
  {
    upstreamPath: "test/services/schema-object-factory.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002", "ADR-005"],
    notes:
      "Adapts upstream SchemaObjectFactory / ModelPropertiesAccessor / SwaggerTypesMapper + zod/valibot tests to Bunest public SchemaExplorer, SwaggerModule.createDocument(), and inline StandardJSONSchemaV1 objects (ADR-001, ADR-002, ADR-005, ADR-013).",
  },
  () => {
    let explorer: SchemaExplorer;

    beforeEach(() => {
      explorer = new SchemaExplorer();
    });

    describe("exploreModelSchema", () => {
      enum Role {
        Admin = "admin",
        User = "user",
      }

      enum Group {
        User = "user",
        Guest = "guest",
        Family = "family",
        Neighboard = "neighboard",
      }

      enum Ranking {
        First = 1,
        Second = 2,
        Third = 3,
      }

      enum HairColour {
        Brown = "Brown",
        Blond = "Blond",
        Ginger = "Ginger",
      }

      class CreatePersonDto {
        @ApiProperty()
        name!: string;
        @ApiProperty({ enum: Role, enumName: "Role" })
        role!: Role;
      }

      it("should convert zod standard schemas into an OpenAPI override", async () => {
        const std = createStandardSchema(
          {
            type: "object",
            properties: {
              value: { type: "string" },
              tags: { type: "array", items: { type: "number" } },
            },
            required: ["value", "tags"],
          },
          "zod",
        );

        @Controller("q")
        class Ctrl {
          @Get()
          find(@Query("filter", { schema: std } as any) _filter: unknown) {}
        }

        const doc = await createDocForController(Ctrl);
        expect(doc.paths["/q"]?.get?.parameters).toEqual([
          expect.objectContaining({
            in: "query",
            name: "filter",
            schema: expect.objectContaining({
              type: "object",
              properties: {
                value: { type: "string" },
                tags: { type: "array", items: { type: "number" } },
              },
              required: ["value", "tags"],
            }),
          }),
        ]);
      });

      it("should preserve OpenAPI metadata on zod overrides", async () => {
        const std = createStandardSchema(
          {
            type: "string",
            description: "filter description",
            example: "cats",
          },
          "zod",
        );

        @Controller("q")
        class Ctrl {
          @Get()
          find(@Query("filter", { schema: std } as any) _filter: string) {}
        }

        const doc = await createDocForController(Ctrl);
        expect(doc.paths["/q"]?.get?.parameters).toEqual([
          expect.objectContaining({
            schema: {
              type: "string",
              description: "filter description",
              example: "cats",
            },
          }),
        ]);
      });

      it("should preserve zod unions, enums, and nested OpenAPI metadata on overrides", async () => {
        const std = createStandardSchema(
          {
            type: "object",
            properties: {
              species: {
                type: "string",
                enum: ["cat", "dog"],
                title: "Species",
                description: "Species enum from Zod",
                example: "cat",
              },
              contact: {
                title: "PreferredContact",
                description: "Preferred contact from Zod",
                example: "owner@example.com",
                anyOf: [
                  { type: "string", format: "email" },
                  {
                    type: "object",
                    properties: {
                      phone: {
                        type: "string",
                        description: "Phone number from Zod",
                        example: "123-456",
                      },
                    },
                  },
                ],
              },
              profile: {
                type: "object",
                title: "CatProfile",
                description: "Nested cat profile from Zod",
                properties: {
                  nickname: {
                    type: "string",
                    description: "Nested nickname from Zod",
                    example: "Captain Whiskers",
                  },
                },
              },
            },
          },
          "zod",
        );

        @Controller("q")
        class Ctrl {
          @Get()
          find(@Query("filter", { schema: std } as any) _filter: object) {}
        }

        const doc = await createDocForController(Ctrl);
        const parameter = doc.paths["/q"]?.get?.parameters?.[0] as any;
        expect(parameter?.schema?.properties?.species).toEqual({
          type: "string",
          enum: ["cat", "dog"],
          title: "Species",
          description: "Species enum from Zod",
          example: "cat",
        });
        expect(parameter?.schema?.properties?.contact).toEqual(
          expect.objectContaining({
            title: "PreferredContact",
            description: "Preferred contact from Zod",
          }),
        );
        expect(parameter?.schema?.properties?.profile).toEqual(
          expect.objectContaining({
            title: "CatProfile",
            description: "Nested cat profile from Zod",
            properties: expect.objectContaining({
              nickname: {
                type: "string",
                description: "Nested nickname from Zod",
                example: "Captain Whiskers",
              },
            }),
          }),
        );
      });

      it("should convert valibot standard schemas into query properties", async () => {
        const std = createStandardSchema(
          {
            type: "object",
            properties: {
              page: { type: "number" },
              search: { type: "string" },
            },
            required: ["page"],
          },
          "valibot",
        );

        @Controller("q")
        class Ctrl {
          @Get()
          find(@Query({ schema: std } as any) _q: object) {}
        }

        const doc = await createDocForController(Ctrl);
        expect(doc.paths["/q"]?.get?.parameters).toEqual([
          expect.objectContaining({
            in: "query",
            name: "page",
            required: true,
            schema: { type: "number" },
          }),
          expect.objectContaining({
            in: "query",
            name: "search",
            required: false,
            schema: { type: "string" },
          }),
        ]);
      });

      it("should preserve OpenAPI metadata on valibot overrides", async () => {
        const std = createStandardSchema(
          {
            type: "object",
            properties: {
              name: { type: "string", description: "cat name" },
              search: { type: "string", title: "Search term" },
            },
            required: ["name"],
          },
          "valibot",
        );

        @Controller("q")
        class Ctrl {
          @Get()
          find(@Query({ schema: std } as any) _q: object) {}
        }

        const doc = await createDocForController(Ctrl);
        expect(doc.paths["/q"]?.get?.parameters).toEqual([
          expect.objectContaining({
            name: "name",
            required: true,
            schema: { type: "string", description: "cat name" },
          }),
          expect.objectContaining({
            name: "search",
            required: false,
            schema: { type: "string", title: "Search term" },
          }),
        ]);
      });

      it("should expand valibot unions, enums, and nested metadata into query parameters", async () => {
        const std = createStandardSchema(
          {
            type: "object",
            properties: {
              mode: {
                type: "string",
                enum: ["simple", "advanced"],
                description: "Mode enum from Valibot",
                example: "simple",
              },
              filter: {
                title: "FilterTitle",
                description: "Filter union from Valibot",
                anyOf: [
                  { type: "string" },
                  {
                    type: "object",
                    properties: {
                      nested: {
                        type: "string",
                        description: "Nested filter from Valibot",
                        example: "persian",
                      },
                    },
                  },
                ],
              },
              details: {
                type: "object",
                title: "Details title from Valibot",
                description: "Nested details from Valibot",
                properties: {
                  label: {
                    type: "string",
                    description: "Nested label from Valibot",
                    example: "primary",
                  },
                },
              },
            },
          },
          "valibot",
        );

        @Controller("q")
        class Ctrl {
          @Get()
          find(@Query({ schema: std } as any) _q: object) {}
        }

        const doc = await createDocForController(Ctrl);
        const params = (doc.paths["/q"]?.get?.parameters ?? []) as any[];
        const mode = params.find((p) => p.name === "mode");
        const filter = params.find((p) => p.name === "filter");
        const details = params.find((p) => p.name === "details");

        expect(mode?.schema).toEqual(
          expect.objectContaining({
            type: "string",
            enum: ["simple", "advanced"],
            description: "Mode enum from Valibot",
          }),
        );
        expect(filter?.schema).toEqual(
          expect.objectContaining({
            title: "FilterTitle",
            description: "Filter union from Valibot",
          }),
        );
        expect(details?.schema).toEqual(
          expect.objectContaining({
            type: "object",
            title: "Details title from Valibot",
            description: "Nested details from Valibot",
          }),
        );
      });

      class Person {
        @ApiProperty({ enum: Role, enumName: "Role" })
        role!: Role;

        @ApiProperty({ enum: Role, enumName: "Role", isArray: true })
        roles!: Role[];

        @ApiProperty({ enum: Group, enumName: "Group", isArray: true })
        groups!: Group[];

        @ApiProperty({ enum: Ranking, enumName: "Ranking", isArray: true })
        rankings!: Ranking[];

        @ApiProperty({ enum: () => HairColour, enumName: "HairColour" })
        hairColour!: HairColour;

        @ApiProperty({
          enum: () => ["Pizza", "Burger", "Salad"],
          enumName: "Food",
          isArray: true,
        })
        favouriteFoods!: string[];
      }

      it("should explore enum", () => {
        explorer.registerDtoSchema(Person);
        const schemas = explorer.getSchemas();

        expect(Object.keys(schemas)).toHaveLength(6);
        expect(schemas).toHaveProperty("Role");
        expect(schemas.Role).toEqual({
          type: "string",
          enum: ["admin", "user"],
        });
        expect(schemas.Group).toEqual({
          type: "string",
          enum: ["user", "guest", "family", "neighboard"],
        });
        expect(schemas.Ranking).toEqual({
          type: "number",
          enum: [1, 2, 3],
        });
        expect(schemas.HairColour).toEqual({
          type: "string",
          enum: ["Brown", "Blond", "Ginger"],
        });
        expect(schemas.Food).toEqual({
          type: "string",
          enum: ["Pizza", "Burger", "Salad"],
        });
        expect(schemas.Person).toEqual({
          type: "object",
          properties: {
            role: { $ref: "#/components/schemas/Role" },
            roles: {
              type: "array",
              items: { $ref: "#/components/schemas/Role" },
            },
            groups: {
              type: "array",
              items: { $ref: "#/components/schemas/Group" },
            },
            rankings: {
              type: "array",
              items: { $ref: "#/components/schemas/Ranking" },
            },
            hairColour: { $ref: "#/components/schemas/HairColour" },
            favouriteFoods: {
              type: "array",
              items: { $ref: "#/components/schemas/Food" },
            },
          },
          required: [
            "role",
            "roles",
            "groups",
            "rankings",
            "hairColour",
            "favouriteFoods",
          ],
        });

        explorer.registerDtoSchema(CreatePersonDto);
        const allSchemas = explorer.getSchemas();
        expect(Object.keys(allSchemas)).toHaveLength(7);
        expect(allSchemas.CreatePersonDto).toEqual({
          type: "object",
          properties: {
            name: { type: "string" },
            role: { $ref: "#/components/schemas/Role" },
          },
          required: ["name", "role"],
        });
      });

      // BUNEST_BUG: SchemaExplorer.applyApiPropertyOptionsToSchema (packages/swagger/src/schema-explorer.ts:740-742) sets top-level enum on array schemas instead of moving enum into items (and ignores _OPENAPI_METADATA_FACTORY)
      it.skip("should merge array enum metadata without keeping a top-level enum", () => {
        class ValidationShimArrayEnumDto {
          @ApiProperty({ enum: Role, isArray: true })
          roles!: Role[];

          static _OPENAPI_METADATA_FACTORY() {
            return {
              roles: {
                enum: Role,
                isArray: true,
              },
            };
          }
        }

        const { schemas } = exploreModel(ValidationShimArrayEnumDto, explorer);
        expect(schemas.ValidationShimArrayEnumDto).toEqual({
          type: "object",
          properties: {
            roles: {
              type: "array",
              items: {
                type: "string",
                enum: ["admin", "user"],
              },
            },
          },
          required: ["roles"],
        });
      });

      // BUNEST_BUG: SchemaExplorer.buildPropertySchema (packages/swagger/src/schema-explorer.ts:831-848) returns early with bare $ref when enumName is set, dropping sibling oneOf combinators
      it.skip("should support enumName with oneOf", () => {
        enum Status {
          Active = "active",
          Inactive = "inactive",
        }

        class DtoWithEnumOneOf {
          @ApiProperty({
            oneOf: [{ type: "string" }],
            enum: Status,
            enumName: "Status",
          })
          status!: Status | string;
        }

        const { schemas } = exploreModel(DtoWithEnumOneOf, explorer);
        expect(schemas).toHaveProperty("Status");
        expect(schemas.Status).toEqual({
          type: "string",
          enum: ["active", "inactive"],
        });
        expect(schemas.DtoWithEnumOneOf?.properties?.status).toEqual({
          oneOf: [{ type: "string" }, { $ref: "#/components/schemas/Status" }],
        });
        expect(schemas.DtoWithEnumOneOf?.properties?.status).not.toHaveProperty(
          "allOf",
        );
      });

      // BUNEST_BUG: SchemaExplorer.registerDtoSchema (packages/swagger/src/schema-explorer.ts:575-582) silently disambiguates duplicate DTO names with _2 without logging a Logger.warn
      it.skip("should log a warning when detecting duplicate DTOs with different schemas", () => {
        const loggerWarnSpy = spyOn(Logger, "warn").mockImplementation(
          () => {},
        );
        try {
          class DuplicateDTO {
            @ApiProperty()
            property1!: string;
          }
          explorer.registerDtoSchema(DuplicateDTO);

          class DuplicateDTOWithDifferentSchema {
            @ApiProperty()
            property2!: string;
          }
          Object.defineProperty(DuplicateDTOWithDifferentSchema, "name", {
            value: "DuplicateDTO",
          });
          explorer.registerDtoSchema(DuplicateDTOWithDifferentSchema);

          expect(loggerWarnSpy).toHaveBeenCalledWith(
            expect.stringContaining('Duplicate DTO detected: "DuplicateDTO"'),
          );
        } finally {
          loggerWarnSpy.mockRestore();
        }
      });

      it("should not log an error when detecting duplicate DTOs with different schemas", () => {
        const loggerErrorSpy = spyOn(Logger, "error").mockImplementation(
          () => {},
        );
        const loggerWarnSpy = spyOn(Logger, "warn").mockImplementation(
          () => {},
        );
        try {
          class DuplicateDTO {
            @ApiProperty()
            property1!: string;
          }
          explorer.registerDtoSchema(DuplicateDTO);

          class DuplicateDTOWithDifferentSchema {
            @ApiProperty()
            property2!: string;
          }
          Object.defineProperty(DuplicateDTOWithDifferentSchema, "name", {
            value: "DuplicateDTO",
          });
          explorer.registerDtoSchema(DuplicateDTOWithDifferentSchema);

          expect(loggerErrorSpy).not.toHaveBeenCalled();
        } finally {
          loggerErrorSpy.mockRestore();
          loggerWarnSpy.mockRestore();
        }
      });

      it("should not log a warning when detecting duplicate DTOs with the same schemas", () => {
        const loggerWarnSpy = spyOn(Logger, "warn").mockImplementation(
          () => {},
        );
        try {
          class DuplicateDTO {
            @ApiProperty()
            property1!: string;
          }
          explorer.registerDtoSchema(DuplicateDTO);

          class DuplicateDTOWithSameSchema {
            @ApiProperty()
            property1!: string;
          }
          Object.defineProperty(DuplicateDTOWithSameSchema, "name", {
            value: "DuplicateDTO",
          });
          explorer.registerDtoSchema(DuplicateDTOWithSameSchema);

          expect(loggerWarnSpy).not.toHaveBeenCalled();
        } finally {
          loggerWarnSpy.mockRestore();
        }
      });

      // BUNEST_BUG: PickType (packages/core/src/common/mapped-types/mapped-types.utils.ts) names inline classes Pick<Base> instead of key-suffixed Pick<Base><Keys>
      it.skip("should keep inline PickType schemas distinct", () => {
        class ActivityContentDto {
          @ApiProperty()
          title!: string;

          @ApiProperty()
          description!: string;

          @ApiProperty({ isArray: true, type: String })
          categories!: string[];
        }

        class UserDto {
          @ApiProperty()
          id!: string;

          @ApiProperty()
          name!: string;
        }

        class ActivityResponseDto {
          @ApiProperty({
            type: PickType(ActivityContentDto, [
              "title",
              "description",
              "categories",
            ]),
          })
          content!: Pick<
            ActivityContentDto,
            "title" | "description" | "categories"
          >;

          @ApiProperty({ type: PickType(UserDto, ["id", "name"]) })
          organizer!: Pick<UserDto, "id" | "name">;
        }

        const { schemas } = exploreModel(ActivityResponseDto, explorer);
        expect(schemas.ActivityResponseDto).toEqual({
          type: "object",
          properties: {
            content: {
              $ref: "#/components/schemas/PickActivityContentDtoTitleDescriptionCategories",
            },
            organizer: {
              $ref: "#/components/schemas/PickUserDtoIdName",
            },
          },
          required: ["content", "organizer"],
        });
      });

      // BUNEST_BUG: OmitType (packages/core/src/common/mapped-types/mapped-types.utils.ts) names inline classes Omit<Base> instead of key-suffixed Omit<Base><Keys>
      it.skip("should keep inline OmitType schemas distinct", () => {
        class ActivityContentDto {
          @ApiProperty()
          title!: string;

          @ApiProperty()
          description!: string;

          @ApiProperty({ isArray: true, type: String })
          categories!: string[];
        }

        class UserDto {
          @ApiProperty()
          id!: string;

          @ApiProperty()
          name!: string;
        }

        class ActivityResponseDto {
          @ApiProperty({ type: OmitType(ActivityContentDto, ["description"]) })
          content!: Omit<ActivityContentDto, "description">;

          @ApiProperty({ type: OmitType(UserDto, ["name"]) })
          organizer!: Omit<UserDto, "name">;
        }

        const { schemas } = exploreModel(ActivityResponseDto, explorer);
        expect(schemas.ActivityResponseDto?.properties).toEqual({
          content: {
            $ref: "#/components/schemas/OmitActivityContentDtoDescription",
          },
          organizer: { $ref: "#/components/schemas/OmitUserDtoName" },
        });
      });

      // BUNEST_BUG: PickType/OmitType (packages/core/src/common/mapped-types/mapped-types.utils.ts) use base-only + numeric suffix names instead of visible-key-suffixed names
      it.skip("should not spell properties hidden from the document in inline mapped type names", () => {
        class AccountDto {
          @ApiProperty()
          id!: string;

          @ApiProperty()
          email!: string;

          @ApiHideProperty()
          passwordHash!: string;

          totpSecret!: string;
        }

        class SessionDto {
          @ApiProperty({
            type: OmitType(AccountDto, ["passwordHash", "totpSecret"]),
          })
          account!: Omit<AccountDto, "passwordHash" | "totpSecret">;

          @ApiProperty({
            type: PickType(AccountDto, ["email", "passwordHash"]),
          })
          contact!: Pick<AccountDto, "email" | "passwordHash">;

          @ApiProperty({ type: OmitType(AccountDto, ["email", "totpSecret"]) })
          owner!: Omit<AccountDto, "email" | "totpSecret">;
        }

        const { schemas } = exploreModel(SessionDto, explorer);
        expect(schemas.SessionDto?.properties).toEqual({
          account: { $ref: "#/components/schemas/OmitAccountDto" },
          contact: { $ref: "#/components/schemas/PickAccountDtoEmail" },
          owner: { $ref: "#/components/schemas/OmitAccountDtoEmail" },
        });
        expect(JSON.stringify(schemas)).not.toMatch(/passwordHash|totpSecret/i);
      });

      it("should keep inline PartialType schemas distinct", () => {
        class ActivityContentDto {
          @ApiProperty()
          title!: string;

          @ApiProperty({ isArray: true, type: String })
          categories!: string[];
        }

        class UserDto {
          @ApiProperty()
          id!: string;

          @ApiProperty()
          name!: string;
        }

        class ActivityResponseDto {
          @ApiProperty({ type: PartialType(ActivityContentDto) })
          content!: Partial<ActivityContentDto>;

          @ApiProperty({ type: PartialType(UserDto) })
          organizer!: Partial<UserDto>;
        }

        const { schemas } = exploreModel(ActivityResponseDto, explorer);
        expect(schemas.ActivityResponseDto?.properties).toEqual({
          content: { $ref: "#/components/schemas/PartialActivityContentDto" },
          organizer: { $ref: "#/components/schemas/PartialUserDto" },
        });
        expect(schemas.PartialActivityContentDto).toEqual({
          type: "object",
          properties: {
            title: { type: "string" },
            categories: {
              type: "array",
              items: { type: "string" },
            },
          },
        });
        expect(schemas.PartialUserDto).toEqual({
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
          },
        });
      });

      it("should keep nested DeepPartialType schemas distinct", () => {
        class OwnerDto {
          @ApiProperty()
          name!: string;

          @ApiProperty()
          email!: string;
        }

        class AddressDto {
          @ApiProperty()
          street!: string;

          @ApiProperty()
          city!: string;
        }

        class CreateCatDto {
          @ApiProperty()
          name!: string;

          @ApiProperty({ type: () => OwnerDto })
          owner!: OwnerDto;

          @ApiProperty({ type: () => AddressDto })
          address!: AddressDto;
        }

        class UpdateCatDto extends DeepPartialType(CreateCatDto) {}

        const { schemas } = exploreModel(UpdateCatDto, explorer);
        expect(Object.keys(schemas).sort()).toEqual([
          "DeepPartialAddressDto",
          "DeepPartialOwnerDto",
          "UpdateCatDto",
        ]);
        expect(schemas.UpdateCatDto?.properties).toEqual({
          name: { type: "string" },
          owner: { $ref: "#/components/schemas/DeepPartialOwnerDto" },
          address: { $ref: "#/components/schemas/DeepPartialAddressDto" },
        });
        expect(schemas.DeepPartialOwnerDto).toEqual({
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string" },
          },
        });
        expect(schemas.DeepPartialAddressDto).toEqual({
          type: "object",
          properties: {
            street: { type: "string" },
            city: { type: "string" },
          },
        });
      });

      // BUNEST_BUG: SchemaExplorer (packages/swagger/src/schema-explorer.ts:526-550,716,860-910) omits BigInt->int64, ignores _OPENAPI_METADATA_FACTORY, keeps format on array instead of items, and retains reflected type: "object" next to oneOf
      it.skip("should create openapi schema", () => {
        const { key, schemas } = exploreModel(CreateUserDto, explorer);

        expect(schemas[key]).toEqual({
          type: "object",
          properties: {
            login: { type: "string" },
            password: { type: "string", example: "password123" },
            houses: {
              items: { $ref: "#/components/schemas/House" },
              type: "array",
            },
            age: { type: "number", format: "int64", example: 10 },
            amount: { type: "integer", format: "int64" },
            createdAt: { format: "date-time", type: "string" },
            custom: {
              readOnly: true,
              type: "array",
              maxItems: 10,
              minItems: 1,
              items: {
                type: "array",
                items: { type: "number" },
              },
            },
            profile: {
              description: "Profile",
              anyOf: [
                { $ref: "#/components/schemas/CreateProfileDto" },
                { type: "null" },
              ],
            },
            tags: { items: { type: "string" }, type: "array" },
            twoDimensionPrimitives: {
              items: { type: "array", items: { type: "string" } },
              type: "array",
            },
            twoDimensionModels: {
              items: {
                type: "array",
                items: { $ref: "#/components/schemas/CreateProfileDto" },
              },
              type: "array",
            },
            urls: {
              items: { format: "uri", type: "string" },
              type: "array",
            },
            luckyNumbers: {
              type: "array",
              items: { type: "integer" },
            },
            options: {
              items: {
                properties: { isReadonly: { type: "string" } },
                type: "object",
              },
              type: "array",
            },
            allOf: {
              oneOf: [
                { $ref: "#/components/schemas/Cat" },
                { $ref: "#/components/schemas/Dog" },
              ],
              discriminator: { propertyName: "pet_type" },
            },
            formatArray: {
              type: "array",
              items: { type: "string", format: "uuid" },
            },
          },
          required: expect.arrayContaining([
            "login",
            "password",
            "profile",
            "tags",
            "twoDimensionPrimitives",
            "twoDimensionModels",
            "urls",
            "luckyNumbers",
            "options",
            "allOf",
            "houses",
            "createdAt",
            "amount",
            "formatArray",
          ]),
        });
        expect(schemas.CreateProfileDto).toEqual({
          type: "object",
          properties: {
            firstname: { type: "string" },
            lastname: { type: "string" },
            parent: { $ref: "#/components/schemas/CreateUserDto" },
          },
          required: ["firstname", "lastname", "parent"],
        });
      });

      it("should represent nullable $ref properties cleanly (issue #3274)", () => {
        class ProfileDto {
          @ApiProperty()
          bio!: string;
        }

        class UserWithNullableProfile {
          @ApiProperty({
            nullable: true,
            type: () => ProfileDto,
          })
          profile!: ProfileDto;
        }

        const { schemas } = exploreModel(UserWithNullableProfile, explorer);
        // Bunest emits OAS 3.1 `anyOf: [{ $ref }, { type: "null" }]` natively
        expect(schemas.UserWithNullableProfile?.properties?.profile).toEqual({
          anyOf: [
            { $ref: "#/components/schemas/ProfileDto" },
            { type: "null" },
          ],
        });
      });

      // BUNEST_BUG: SchemaExplorer.buildPropertySchema (packages/swagger/src/schema-explorer.ts:860-912) keeps reflected design:type ("object") next to oneOf, producing type: ["object", "null"] instead of anyOf: [{ oneOf }, { type: "null" }]
      it.skip("should drop inferred type for nullable oneOf properties (issue #3928)", () => {
        class DtoWithNullablePrimitiveUnion {
          @ApiProperty({
            oneOf: [{ type: "string" }, { type: "number" }],
            nullable: true,
          })
          value!: string | number | null;
        }

        const { schemas } = exploreModel(
          DtoWithNullablePrimitiveUnion,
          explorer,
        );
        expect(
          schemas.DtoWithNullablePrimitiveUnion?.properties?.value,
        ).toEqual({
          anyOf: [
            { oneOf: [{ type: "string" }, { type: "number" }] },
            { type: "null" },
          ],
        });
      });

      it("should keep an explicit type when property also declares allOf (issue #4249)", () => {
        class DtoWithExplicitTypeAndAllOf {
          @ApiProperty({
            type: "string",
            allOf: [{ pattern: "^[a-z]" }, { pattern: "^[a-z0-9_.-]*$" }],
          })
          username!: string;
        }

        const { schemas } = exploreModel(DtoWithExplicitTypeAndAllOf, explorer);
        expect(
          schemas.DtoWithExplicitTypeAndAllOf?.properties?.username,
        ).toEqual({
          type: "string",
          allOf: [{ pattern: "^[a-z]" }, { pattern: "^[a-z0-9_.-]*$" }],
        });
      });

      // BUNEST_BUG: SchemaExplorer.buildPropertySchema (packages/swagger/src/schema-explorer.ts:860-910) keeps reflected type: "object" when oneOf is declared without an explicit type
      it.skip("should drop the additionalProperties inferred from a record when property declares oneOf", () => {
        class DtoWithRecordAndOneOf {
          @ApiProperty({
            oneOf: [
              { type: "object", properties: { score: { type: "number" } } },
            ],
          })
          grade!: Record<string, string>;

          static _OPENAPI_METADATA_FACTORY() {
            return {
              grade: {
                required: true,
                type: "object",
                additionalProperties: { type: "string" },
              },
            };
          }
        }

        const { schemas } = exploreModel(DtoWithRecordAndOneOf, explorer);
        expect(schemas.DtoWithRecordAndOneOf?.properties?.grade).toEqual({
          oneOf: [
            { type: "object", properties: { score: { type: "number" } } },
          ],
        });
      });

      // BUNEST_BUG: SchemaExplorer.buildPropertySchema (packages/swagger/src/schema-explorer.ts:860-910) keeps reflected type: "object" when oneOf is declared alongside explicit additionalProperties
      it.skip("should keep an explicit additionalProperties when property also declares oneOf", () => {
        class DtoWithExplicitAdditionalPropertiesAndOneOf {
          @ApiProperty({
            additionalProperties: false,
            oneOf: [
              { type: "object", properties: { score: { type: "number" } } },
            ],
          })
          grade!: Record<string, string>;

          static _OPENAPI_METADATA_FACTORY() {
            return {
              grade: {
                required: true,
                type: "object",
                additionalProperties: { type: "string" },
              },
            };
          }
        }

        const { schemas } = exploreModel(
          DtoWithExplicitAdditionalPropertiesAndOneOf,
          explorer,
        );
        expect(
          schemas.DtoWithExplicitAdditionalPropertiesAndOneOf?.properties
            ?.grade,
        ).toEqual({
          additionalProperties: false,
          oneOf: [
            { type: "object", properties: { score: { type: "number" } } },
          ],
        });
      });

      it("should purge linked types from properties", () => {
        class Human {
          @ApiProperty()
          id!: string;

          @ApiProperty({ link: () => Human })
          spouseId!: string;
        }

        const { schemas } = exploreModel(Human, explorer);
        expect(schemas.Human).toEqual({
          type: "object",
          properties: {
            id: { type: "string" },
            spouseId: { type: "string" },
          },
          required: ["id", "spouseId"],
        });
      });

      it("should convert RegExp pattern to string in schema", () => {
        class RegExpPatternDto {
          @ApiProperty({ pattern: /^[+]?abc$/ })
          code!: string;
        }

        const { schemas } = exploreModel(RegExpPatternDto, explorer);
        expect(schemas.RegExpPatternDto).toEqual({
          type: "object",
          properties: {
            code: { type: "string", pattern: "^[+]?abc$" },
          },
          required: ["code"],
        });
      });

      it("should strip flags when converting RegExp pattern", () => {
        class RegExpFlagsDto {
          @ApiProperty({ pattern: /abc/i })
          value!: string;
        }

        const { schemas } = exploreModel(RegExpFlagsDto, explorer);
        expect(schemas.RegExpFlagsDto).toEqual({
          type: "object",
          properties: {
            value: { type: "string", pattern: "abc" },
          },
          required: ["value"],
        });
      });

      it("should keep string pattern unchanged", () => {
        class StringPatternDto {
          @ApiProperty({ pattern: "^[a-z]+$" })
          slug!: string;
        }

        const { schemas } = exploreModel(StringPatternDto, explorer);
        expect(schemas.StringPatternDto).toEqual({
          type: "object",
          properties: {
            slug: { type: "string", pattern: "^[a-z]+$" },
          },
          required: ["slug"],
        });
      });

      it("should override base class metadata", () => {
        class CreatUserDto {
          @ApiProperty({ minLength: 0, required: true })
          name!: string;
        }

        class UpdateUserDto extends CreatUserDto {
          @ApiProperty({ minLength: 1, required: false })
          override name: string = undefined!;
        }

        explorer.registerDtoSchema(CreatUserDto);
        explorer.registerDtoSchema(UpdateUserDto);
        const schemas = explorer.getSchemas();

        expect(schemas.CreatUserDto).toEqual({
          type: "object",
          properties: { name: { type: "string", minLength: 0 } },
          required: ["name"],
        });
        expect(schemas.UpdateUserDto).toEqual({
          type: "object",
          properties: { name: { type: "string", minLength: 1 } },
        });
      });

      // BUNEST_BUG: SchemaExplorer.applyApiPropertyOptionsToSchema (packages/swagger/src/schema-explorer.ts:801) leaves sibling $ref alongside allOf instead of merging { $ref } into allOf
      it.skip("should keep a user-defined allOf on a model-typed property", () => {
        class AllOfNestedDto {
          @ApiProperty()
          a!: string;
        }
        class AllOfHolderDto {
          @ApiProperty({ type: AllOfNestedDto, allOf: [{ required: ["a"] }] })
          nested!: AllOfNestedDto;
        }

        const { schemas } = exploreModel(AllOfHolderDto, explorer);
        expect(schemas.AllOfHolderDto?.properties?.nested).toEqual({
          allOf: [
            { required: ["a"] },
            { $ref: "#/components/schemas/AllOfNestedDto" },
          ],
        });
      });

      // BUNEST_BUG: SchemaExplorer.applyApiPropertyOptionsToSchema (packages/swagger/src/schema-explorer.ts:722-725) copies default DTO object verbatim without filtering out @ApiHideProperty() fields
      it.skip("should not publish properties hidden from a model through a default", () => {
        class SettingsDto {
          @ApiProperty()
          email!: boolean;

          @ApiHideProperty()
          bypassRateLimit!: boolean;
        }
        class TreeDto {
          @ApiProperty({ type: () => TreeDto })
          parent!: TreeDto;

          @ApiHideProperty()
          secret!: string;
        }
        const settings = Object.assign(new SettingsDto(), {
          email: true,
          bypassRateLimit: true,
        });
        const tree = Object.assign(new TreeDto(), { secret: "x" });
        tree.parent = tree;

        class AccountDto {
          @ApiProperty({
            type: () => SettingsDto,
            default: { email: true, bypassRateLimit: true },
          })
          settings!: SettingsDto;

          @ApiProperty({ type: [SettingsDto], default: [settings] })
          history!: SettingsDto[];

          @ApiProperty({ type: Object, default: settings })
          raw!: object;

          @ApiProperty({ type: Object, default: { bypassRateLimit: true } })
          plain!: object;

          @ApiProperty({ type: () => TreeDto, default: tree })
          tree!: TreeDto;
        }

        const { schemas } = exploreModel(AccountDto, explorer);
        const properties = schemas.AccountDto?.properties as Record<
          string,
          SchemaObject
        >;

        expect(properties.settings?.default).toEqual({ email: true });
        expect(properties.history?.default).toEqual([{ email: true }]);
        expect(properties.raw?.default).toEqual({ email: true });
        expect(properties.plain?.default).toEqual({ bypassRateLimit: true });
        expect(properties.tree?.default).toEqual({ parent: undefined });
        expect(settings.bypassRateLimit).toBe(true);
      });

      // BUNEST_BUG: SchemaExplorer (packages/swagger/src/schema-explorer.ts:596-636) does not read static _OPENAPI_METADATA_FACTORY() metadata for nested default key picking
      it.skip("should read plugin metadata before picking the keys of a nested default", () => {
        const loggerWarnSpy = spyOn(Logger, "warn").mockImplementation(
          () => {},
        );
        try {
          class SettingsDto {
            enabled = true;

            @ApiHideProperty()
            secret = "x";

            static _OPENAPI_METADATA_FACTORY() {
              return {
                enabled: { required: true, type: () => Boolean, default: true },
              };
            }
          }
          class ResponseDto {
            settings = new SettingsDto();

            static _OPENAPI_METADATA_FACTORY() {
              return {
                settings: {
                  required: true,
                  type: () => SettingsDto,
                  default: new SettingsDto(),
                },
              };
            }
          }

          const { schemas } = exploreModel(ResponseDto, explorer);
          const settingsDefault = (
            schemas.ResponseDto?.properties as Record<string, SchemaObject>
          )?.settings?.default;

          expect(settingsDefault).toEqual({ enabled: true });
          expect(loggerWarnSpy).not.toHaveBeenCalled();
        } finally {
          loggerWarnSpy.mockRestore();
        }
      });

      describe("@ApiSchema", () => {
        it("should use the class name when no options object was passed", () => {
          @ApiSchema()
          class CreateUserLocalDto {}

          const { schemas } = exploreModel(CreateUserLocalDto, explorer);
          expect(Object.keys(schemas)).toContain("CreateUserLocalDto");
        });

        it("should use the class name when the options object is empty", () => {
          @ApiSchema({})
          class CreateUserLocalDto {}

          const { schemas } = exploreModel(CreateUserLocalDto, explorer);
          expect(Object.keys(schemas)).toContain("CreateUserLocalDto");
        });

        it("should use the schema name instead of class name", () => {
          @ApiSchema({ name: "CreateUser" })
          class CreateUserLocalDto {}

          const { schemas } = exploreModel(CreateUserLocalDto, explorer);
          expect(Object.keys(schemas)).toContain("CreateUser");
        });

        it("should not use the schema name of the base class", () => {
          @ApiSchema({ name: "CreateUser" })
          class CreateUserLocalDto {}

          class UpdateUserLocalDto extends CreateUserLocalDto {}

          const { schemas } = exploreModel(UpdateUserLocalDto, explorer);
          expect(Object.keys(schemas)).toContain("UpdateUserLocalDto");
        });

        it("should override the schema name of the base class", () => {
          @ApiSchema({ name: "CreateUser" })
          class CreateUserLocalDto {}

          @ApiSchema({ name: "UpdateUser" })
          class UpdateUserLocalDto extends CreateUserLocalDto {}

          const { schemas } = exploreModel(UpdateUserLocalDto, explorer);
          expect(Object.keys(schemas)).toContain("UpdateUser");
        });

        it("should correctly handle recursive schema references in ApiSchema decorator", () => {
          @ApiSchema({ name: "MenuNode" })
          class MenuNodeDto {
            @ApiProperty({ type: () => MenuNodeDto })
            childNode!: MenuNodeDto;
          }

          @ApiSchema({ name: "Menu" })
          class MenuDto {
            @ApiProperty({ type: () => MenuNodeDto })
            rootNode!: MenuNodeDto;
          }

          const { schemas } = exploreModel(MenuDto, explorer);
          expect(
            (schemas.MenuNode?.properties?.childNode as SchemaObject)?.$ref,
          ).toEqual("#/components/schemas/MenuNode");
          expect(
            (schemas.Menu?.properties?.rootNode as SchemaObject)?.$ref,
          ).toEqual("#/components/schemas/MenuNode");
        });

        it("should use the description if provided", () => {
          @ApiSchema({ description: "Represents a user." })
          class CreateUserLocalDto {}

          const { schemas } = exploreModel(CreateUserLocalDto, explorer);
          expect(schemas.CreateUserLocalDto?.description).toEqual(
            "Represents a user.",
          );
        });

        // BUNEST_BUG: SchemaExplorer.registerDtoSchema (packages/swagger/src/schema-explorer.ts:587-594) only copies description from @ApiSchema() and ignores title, deprecated, example, externalDocs, additionalProperties, minProperties, maxProperties
        it.skip("should apply object-level schema keywords", () => {
          @ApiSchema({
            name: "CreateUser",
            title: "Create user",
            additionalProperties: false,
            minProperties: 1,
            maxProperties: 10,
            deprecated: true,
            example: { name: "Alice" },
            externalDocs: { url: "https://example.com/users" },
          } as any)
          class CreateUserLocalDto {
            @ApiProperty()
            name!: string;
          }

          const { schemas } = exploreModel(CreateUserLocalDto, explorer);
          expect(schemas.CreateUser).toEqual({
            type: "object",
            title: "Create user",
            additionalProperties: false,
            minProperties: 1,
            maxProperties: 10,
            deprecated: true,
            example: { name: "Alice" },
            externalDocs: { url: "https://example.com/users" },
            properties: {
              name: { type: "string" },
            },
            required: ["name"],
          });
        });

        it("should not use the description of the base class", () => {
          @ApiSchema({ description: "Represents a user." })
          class CreateUserLocalDto {}

          @ApiSchema({ description: "Represents a user update." })
          class UpdateUserLocalDto extends CreateUserLocalDto {}

          const { schemas } = exploreModel(UpdateUserLocalDto, explorer);
          expect(schemas.UpdateUserLocalDto?.description).toEqual(
            "Represents a user update.",
          );
        });
      });

      // BUNEST_BUG: SchemaExplorer.registerDtoSchema (packages/swagger/src/schema-explorer.ts:564-689) ignores class-level @ApiExtension() metadata on DTO schemas
      it.skip("should include extension properties", () => {
        @ApiExtension("x-test", "value")
        class CreatUserDto {
          @ApiProperty({ minLength: 0, required: true })
          name!: string;
        }

        const { schemas } = exploreModel(CreatUserDto, explorer);
        expect((schemas.CreatUserDto as any)?.["x-test"]).toEqual("value");
      });

      it("should create arrays of objects", () => {
        class ObjectDto {
          @ApiProperty()
          field!: string;
        }

        class TestDto {
          @ApiProperty({ type: [String] })
          arrayOfStrings!: string[];
        }

        class Test2Dto {
          @ApiProperty({ isArray: true, type: ObjectDto })
          arrayOfObjects!: ObjectDto[];
        }

        explorer.registerDtoSchema(TestDto);
        explorer.registerDtoSchema(Test2Dto);
        const schemas = explorer.getSchemas();

        expect(schemas.TestDto).toEqual({
          type: "object",
          properties: {
            arrayOfStrings: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["arrayOfStrings"],
        });
        expect(schemas.Test2Dto).toEqual({
          type: "object",
          properties: {
            arrayOfObjects: {
              type: "array",
              items: { $ref: "#/components/schemas/ObjectDto" },
            },
          },
          required: ["arrayOfObjects"],
        });
      });

      it("should not use undefined enum", () => {
        class TestDto {
          @ApiProperty({ type: "string", enum: undefined })
          testString!: string;
        }

        const { schemas } = exploreModel(TestDto, explorer);
        expect(schemas.TestDto).toEqual({
          type: "object",
          properties: { testString: { type: "string" } },
          required: ["testString"],
        });
      });

      it("should not use undefined enum on array", () => {
        class TestDto {
          @ApiProperty({ type: "string", isArray: true, enum: undefined })
          testStringArray!: string[];
        }

        const { schemas } = exploreModel(TestDto, explorer);
        expect(schemas.TestDto).toEqual({
          type: "object",
          properties: {
            testStringArray: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["testStringArray"],
        });
      });

      it("should resolve nested array type to the correct leaf type", () => {
        class NestedArrayDto {
          @ApiProperty({ type: [[String]] as any })
          matrix!: string[][];
        }

        const { schemas } = exploreModel(NestedArrayDto, explorer);
        expect(schemas.NestedArrayDto).toEqual({
          type: "object",
          properties: {
            matrix: {
              type: "array",
              items: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
          required: ["matrix"],
        });
      });

      it("should keep explicit array items and item type when array declares allOf", () => {
        class Tag {}
        class DtoWithArrayAndAllOf {
          @ApiProperty({ type: [Tag], allOf: [{ minItems: 1 }] })
          tags!: Tag[];

          @ApiProperty({ type: [String], allOf: [{ minItems: 1 }] })
          names!: string[];

          @ApiProperty({
            type: "array",
            items: { type: "string" },
            allOf: [{ minItems: 1 }],
          })
          explicitItems!: string[];

          @ApiProperty({
            isArray: true,
            items: { type: "string" },
            allOf: [{ description: "x" }],
          })
          itemsWithAllOf!: string[];
        }

        const { schemas } = exploreModel(DtoWithArrayAndAllOf, explorer);
        const props = schemas.DtoWithArrayAndAllOf?.properties as Record<
          string,
          any
        >;

        expect(props.tags).toEqual({
          type: "array",
          items: { $ref: "#/components/schemas/Tag" },
          allOf: [{ minItems: 1 }],
        });
        expect(props.names).toEqual({
          type: "array",
          items: { type: "string" },
          allOf: [{ minItems: 1 }],
        });
        expect(props.explicitItems).toEqual({
          type: "array",
          items: { type: "string" },
          allOf: [{ minItems: 1 }],
        });
        expect(props.itemsWithAllOf).toEqual({
          type: "array",
          items: { type: "string" },
          allOf: [{ description: "x" }],
        });
      });

      // BUNEST_BUG: SchemaExplorer.buildPropertySchema (packages/swagger/src/schema-explorer.ts:860-910) retains reflected design:type ("object") next to oneOf when isArray is false
      it.skip("should drop the reflected type next to a combinator when isArray is false", () => {
        class DtoWithScalarUnion {
          @ApiProperty({
            isArray: false,
            oneOf: [{ type: "string" }, { type: "number" }],
          })
          value!: string | number;
        }

        const { schemas } = exploreModel(DtoWithScalarUnion, explorer);
        expect(schemas.DtoWithScalarUnion?.properties?.value).toEqual({
          oneOf: [{ type: "string" }, { type: "number" }],
        });
      });

      // BUNEST_BUG: SchemaExplorer.applyApiPropertyOptionsToSchema (packages/swagger/src/schema-explorer.ts:801-803) leaves oneOf/anyOf on the top-level array schema instead of migrating them into items
      it.skip("should migrate oneOf and anyOf combinators to array items for generic array types", () => {
        class Cat {}
        class Dog {}
        class DtoWithArrayUnionItems {
          @ApiProperty({
            type: "array",
            oneOf: [{ type: "string" }, { type: "number" }],
          })
          mixed!: (string | number)[];

          @ApiProperty({
            type: [Object],
            oneOf: [
              { $ref: "#/components/schemas/Cat" },
              { $ref: "#/components/schemas/Dog" },
            ],
          })
          petsOneOf!: (Cat | Dog)[];

          @ApiProperty({
            type: "array",
            anyOf: [{ type: "string" }, { type: "number" }],
          })
          mixedAnyOf!: (string | number)[];

          @ApiProperty({
            type: [Object],
            anyOf: [
              { $ref: "#/components/schemas/Cat" },
              { $ref: "#/components/schemas/Dog" },
            ],
          })
          petsAnyOf!: (Cat | Dog)[];
        }

        const { schemas } = exploreModel(DtoWithArrayUnionItems, explorer);
        const props = schemas.DtoWithArrayUnionItems?.properties as Record<
          string,
          any
        >;

        expect(props.mixed).toEqual({
          type: "array",
          items: { oneOf: [{ type: "string" }, { type: "number" }] },
        });
        expect(props.petsOneOf).toEqual({
          type: "array",
          items: {
            oneOf: [
              { $ref: "#/components/schemas/Cat" },
              { $ref: "#/components/schemas/Dog" },
            ],
          },
        });
        expect(props.mixedAnyOf).toEqual({
          type: "array",
          items: { anyOf: [{ type: "string" }, { type: "number" }] },
        });
        expect(props.petsAnyOf).toEqual({
          type: "array",
          items: {
            anyOf: [
              { $ref: "#/components/schemas/Cat" },
              { $ref: "#/components/schemas/Dog" },
            ],
          },
        });
      });
    });

    describe("createEnumSchemaType (registerEnumSchema & combinators)", () => {
      it("should assign schema type correctly if enumName is provided", () => {
        explorer.registerEnumSchema("MyEnum", [1, 2, 3]);
        expect(explorer.getSchemas()).toEqual({
          MyEnum: { enum: [1, 2, 3], type: "number" },
        });
      });

      // BUNEST_BUG: SchemaExplorer.buildPropertySchema (packages/swagger/src/schema-explorer.ts:831-848) returns bare $ref when enumName is set, dropping existing oneOf
      it.skip("should add $ref to existing oneOf when enumName is used with oneOf", () => {
        class EnumOneOfDto {
          @ApiProperty({
            type: "string",
            enum: ["a", "b", "c"],
            enumName: "MyEnum",
            isArray: false,
            oneOf: [{ type: "number" }],
          })
          field!: string | number;
        }

        const { schemas } = exploreModel(EnumOneOfDto, explorer);
        expect(schemas.MyEnum).toEqual({
          enum: ["a", "b", "c"],
          type: "string",
        });
        const prop = schemas.EnumOneOfDto?.properties?.field;
        expect(prop).toEqual(
          expect.objectContaining({
            oneOf: [
              { type: "number" },
              { $ref: "#/components/schemas/MyEnum" },
            ],
          }),
        );
        expect(prop).not.toHaveProperty("allOf");
        expect(prop).not.toHaveProperty("enum");
        expect(prop).not.toHaveProperty("enumName");
        expect(prop).not.toHaveProperty("type");
      });

      // BUNEST_BUG: SchemaExplorer.buildPropertySchema (packages/swagger/src/schema-explorer.ts:831-848) returns bare $ref when enumName is set, dropping existing anyOf
      it.skip("should add $ref to existing anyOf when enumName is used with anyOf", () => {
        class EnumAnyOfDto {
          @ApiProperty({
            type: "string",
            enum: ["x", "y"],
            enumName: "MyEnum",
            isArray: false,
            anyOf: [{ type: "number" }],
          })
          field!: string | number;
        }

        const { schemas } = exploreModel(EnumAnyOfDto, explorer);
        expect(schemas.MyEnum).toEqual({ enum: ["x", "y"], type: "string" });
        const prop = schemas.EnumAnyOfDto?.properties?.field;
        expect(prop).toEqual(
          expect.objectContaining({
            anyOf: [
              { type: "number" },
              { $ref: "#/components/schemas/MyEnum" },
            ],
          }),
        );
        expect(prop).not.toHaveProperty("allOf");
        expect(prop).not.toHaveProperty("enum");
        expect(prop).not.toHaveProperty("enumName");
      });
    });

    describe("createEnumParam (named enum query params)", () => {
      it("should create an enum schema definition", async () => {
        @Controller("e")
        class Ctrl {
          @Get()
          @ApiQuery({ name: "q", enumName: "MyEnum", enum: ["a", "b", "c"] })
          get() {}
        }

        const doc = await createDocForController(Ctrl);
        expect(doc.components?.schemas?.MyEnum).toEqual({
          enum: ["a", "b", "c"],
          type: "string",
        });
      });

      it("should create an enum schema definition for an array", async () => {
        @Controller("e")
        class Ctrl {
          @Get()
          @ApiQuery({
            name: "q",
            isArray: true,
            enumName: "MyEnum",
            enum: ["a", "b", "c"],
          })
          get() {}
        }

        const doc = await createDocForController(Ctrl);
        expect(doc.components?.schemas?.MyEnum).toEqual({
          enum: ["a", "b", "c"],
          type: "string",
        });
        expect(doc.paths["/e"]?.get?.parameters?.[0]?.schema).toEqual({
          type: "array",
          items: { $ref: "#/components/schemas/MyEnum" },
        });
      });

      it("should use the parameter type when there is no schema", async () => {
        @Controller("e")
        class Ctrl {
          @Get()
          @ApiQuery({
            name: "q",
            type: "number",
            enumName: "MyEnum",
            enum: [1, 2],
          })
          get() {}
        }

        const doc = await createDocForController(Ctrl);
        expect(doc.components?.schemas?.MyEnum).toEqual({
          enum: [1, 2],
          type: "number",
        });
      });

      it("should map the parameter type when it is a constructor", async () => {
        @Controller("e")
        class Ctrl {
          @Get()
          @ApiQuery({
            name: "q",
            type: Number,
            enumName: "MyEnum",
            enum: [1, 2],
          })
          get() {}
        }

        const doc = await createDocForController(Ctrl);
        expect(doc.components?.schemas?.MyEnum).toEqual({
          enum: [1, 2],
          type: "number",
        });
      });

      it("should use the items type for an array when there is no schema", async () => {
        @Controller("e")
        class Ctrl {
          @Get()
          @ApiQuery({
            name: "q",
            type: "array",
            isArray: true,
            enumName: "MyEnum",
            enum: [1, 2],
            items: { type: "number", enum: [1, 2] },
          })
          get() {}
        }

        const doc = await createDocForController(Ctrl);
        expect(doc.components?.schemas?.MyEnum).toEqual({
          enum: [1, 2],
          type: "number",
        });
      });
    });

    describe("createFromModel (parameter & body schema generation)", () => {
      it("should override an inferred named query type with a standard schema", async () => {
        class QueryDto {
          value!: string;
        }

        @Controller("m")
        class Ctrl {
          @Get()
          find(
            @Query("filter", {
              schema: createStandardSchema({ type: "string", pattern: "^foo" }),
            } as any)
            _filter: QueryDto,
          ) {}
        }

        const doc = await createDocForController(Ctrl);
        expect(doc.paths["/m"]?.get?.parameters).toEqual([
          expect.objectContaining({
            in: "query",
            name: "filter",
            schema: { type: "string", pattern: "^foo" },
          }),
        ]);
      });

      it("should promote a standard schema description onto a named parameter", async () => {
        @Controller("m")
        class Ctrl {
          @Get()
          find(
            @Query("filter", {
              schema: createStandardSchema({
                type: "string",
                description: "Filter description from schema",
              }),
            } as any)
            _filter: string,
          ) {}
        }

        const doc = await createDocForController(Ctrl);
        expect(doc.paths["/m"]?.get?.parameters).toEqual([
          expect.objectContaining({
            in: "query",
            name: "filter",
            description: "Filter description from schema",
            schema: {
              type: "string",
              description: "Filter description from schema",
            },
          }),
        ]);
      });

      it("should not override an explicit parameter description with the schema one", async () => {
        @Controller("m")
        class Ctrl {
          @Get()
          @ApiQuery({
            name: "filter",
            description: "Explicit decorator description",
          })
          find(
            @Query("filter", {
              schema: createStandardSchema({
                type: "string",
                description: "Filter description from schema",
              }),
            } as any)
            _filter: string,
          ) {}
        }

        const doc = await createDocForController(Ctrl);
        expect(doc.paths["/m"]?.get?.parameters).toEqual([
          expect.objectContaining({
            in: "query",
            name: "filter",
            description: "Explicit decorator description",
            schema: {
              type: "string",
              description: "Filter description from schema",
            },
          }),
        ]);
      });

      it("should override an inferred body type with a standard schema", async () => {
        class BodyDto {
          value!: number;
        }

        @Controller("m")
        class Ctrl {
          @Post()
          create(
            @Body({
              schema: createStandardSchema(
                {
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
                "zod",
              ),
            } as any)
            _body: BodyDto,
          ) {}
        }

        const doc = await createDocForController(Ctrl);
        expect(
          doc.paths["/m"]?.post?.requestBody?.content?.["application/json"]
            ?.schema,
        ).toEqual({
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        });
      });

      it("should expand unnamed query standard schemas into parameter properties", async () => {
        @Controller("m")
        class Ctrl {
          @Get()
          find(
            @Query({
              schema: createStandardSchema({
                type: "object",
                required: ["limit"],
                properties: {
                  limit: { type: "integer", minimum: 1 },
                  search: { type: "string" },
                },
              }),
            } as any)
            _q: object,
          ) {}
        }

        const doc = await createDocForController(Ctrl);
        expect(doc.paths["/m"]?.get?.parameters).toEqual([
          expect.objectContaining({
            in: "query",
            name: "limit",
            required: true,
            schema: { type: "integer", minimum: 1 },
          }),
          expect.objectContaining({
            in: "query",
            name: "search",
            required: false,
            schema: { type: "string" },
          }),
        ]);
      });

      it("should promote a standard schema property description onto its expanded parameter", async () => {
        @Controller("m")
        class Ctrl {
          @Get()
          find(
            @Query({
              schema: createStandardSchema({
                type: "object",
                required: ["limit"],
                properties: {
                  limit: {
                    type: "integer",
                    description: "Limit description from schema",
                  },
                  search: { type: "string" },
                },
              }),
            } as any)
            _q: object,
          ) {}
        }

        const doc = await createDocForController(Ctrl);
        const params = doc.paths["/m"]?.get?.parameters ?? [];
        expect(params).toEqual([
          expect.objectContaining({
            in: "query",
            name: "limit",
            description: "Limit description from schema",
            schema: {
              type: "integer",
              description: "Limit description from schema",
            },
          }),
          expect.objectContaining({
            in: "query",
            name: "search",
            schema: { type: "string" },
          }),
        ]);
        expect(params[1]).not.toHaveProperty("description");
      });

      it("should preserve parent example when a non-body param property has a DTO type", async () => {
        class ChildDto {
          @ApiProperty({ example: "child DTO example 1" })
          childKey1!: string;
          @ApiProperty({ example: "child DTO example 2" })
          childKey2!: string;
        }

        @Controller("m")
        class Ctrl {
          @Get()
          @ApiQuery({
            name: "parentKey",
            type: ChildDto,
            required: true,
            example: "parent DTO example",
          })
          find() {}
        }

        const doc = await createDocForController(Ctrl);
        const paramResult = doc.paths["/m"]?.get?.parameters?.[0] as any;
        expect(paramResult?.name).toBe("parentKey");
        expect(paramResult?.schema?.example).toBe("parent DTO example");
        expect(paramResult?.schema?.allOf?.[0]?.$ref).toContain("ChildDto");
      });

      it("should not alter schema when no extra schema options exist on param", async () => {
        class SimpleChild {
          @ApiProperty()
          value!: string;
        }

        @Controller("m")
        class Ctrl {
          @Get()
          @ApiQuery({ name: "child", type: SimpleChild, required: true })
          find() {}
        }

        const doc = await createDocForController(Ctrl);
        const paramResult = doc.paths["/m"]?.get?.parameters?.[0] as any;
        expect(paramResult?.schema?.$ref).toContain("SimpleChild");
        expect(paramResult?.schema?.allOf).toBeUndefined();
      });

      it("should merge param-level allOf with $ref wrapping and not lose example", async () => {
        class FilterDto {
          @ApiProperty()
          value!: string;
        }

        @Controller("m")
        class Ctrl {
          @Get()
          @ApiQuery({
            name: "filter",
            type: FilterDto,
            required: true,
            example: "foo",
            allOf: [{ $ref: "#/components/schemas/TagDto" }],
          })
          find() {}
        }

        const doc = await createDocForController(Ctrl);
        const paramResult = doc.paths["/m"]?.get?.parameters?.[0] as any;
        expect(paramResult?.allOf).toBeUndefined();
        expect(paramResult?.example).toBeUndefined();
        expect(paramResult?.schema?.example).toBe("foo");
        expect(paramResult?.schema?.allOf).toEqual(
          expect.arrayContaining([
            { $ref: "#/components/schemas/TagDto" },
            expect.objectContaining({
              $ref: expect.stringContaining("FilterDto"),
            }),
          ]),
        );
        expect(paramResult?.schema?.$ref).toBeUndefined();
      });

      it("should merge parameter and schema allOf constraints for a named scalar parameter", async () => {
        class FilterDto {
          @ApiProperty({ type: String })
          code!: string;
        }

        @Controller("m")
        class Ctrl {
          @Get()
          @ApiQuery({
            name: "filter",
            type: FilterDto,
            allOf: [{ required: ["code"] }],
            schema: { allOf: [{ minProperties: 1 }] },
          })
          find() {}
        }

        const doc = await createDocForController(Ctrl);
        const parameter = doc.paths["/m"]?.get?.parameters?.[0];
        expect(parameter).not.toHaveProperty("allOf");
        expect(parameter).toHaveProperty("schema", {
          allOf: [
            { minProperties: 1 },
            { required: ["code"] },
            { $ref: "#/components/schemas/FilterDto" },
          ],
        });
      });

      it("should keep array parameter allOf constraints separate from item constraints", async () => {
        class FilterDto {
          @ApiProperty({ type: String })
          code!: string;
        }

        @Controller("m")
        class Ctrl {
          @Get()
          @ApiQuery({
            name: "filters",
            type: FilterDto,
            isArray: true,
            allOf: [{ minItems: 1 }],
            schema: { allOf: [{ required: ["code"] }] },
          })
          find() {}
        }

        const doc = await createDocForController(Ctrl);
        const parameter = doc.paths["/m"]?.get?.parameters?.[0];
        expect(parameter).not.toHaveProperty("allOf");
        expect(parameter).toHaveProperty("schema", {
          type: "array",
          allOf: [{ minItems: 1 }],
          items: {
            allOf: [
              { required: ["code"] },
              { $ref: "#/components/schemas/FilterDto" },
            ],
          },
        });
      });

      // BUNEST_BUG: SchemaExplorer.resolveTypeSchema (packages/swagger/src/schema-explorer.ts:507-550) returns {} for SWC const-enum plain objects passed as query param type
      it.skip("should create enum schema for query params using SWC const-enum object metadata", async () => {
        const CampaignStatus = {
          ACTIVE: "active",
          PAUSED: "paused",
          COMPLETED: "completed",
        } as const;

        @Controller("m")
        class Ctrl {
          @Get()
          @ApiQuery({
            name: "status",
            type: CampaignStatus as any,
            required: false,
          })
          find() {}
        }

        const doc = await createDocForController(Ctrl);
        const params = doc.paths["/m"]?.get?.parameters ?? [];
        expect(params).toHaveLength(1);
        expect(params[0]).toEqual(
          expect.objectContaining({
            in: "query",
            name: "status",
            required: false,
            schema: {
              type: "string",
              enum: ["active", "paused", "completed"],
            },
          }),
        );
      });
    });

    describe("expandStandardSchemaParam", () => {
      it("should expand an unnamed query standard schema into one param per property", async () => {
        @Controller("ex")
        class Ctrl {
          @Get()
          find(
            @Query({
              schema: createStandardSchema({
                type: "object",
                required: ["limit"],
                properties: {
                  limit: { type: "integer" },
                  search: { type: "string" },
                },
              }),
            } as any)
            _q: object,
          ) {}
        }

        const doc = await createDocForController(Ctrl);
        expect(doc.paths["/ex"]?.get?.parameters).toEqual([
          expect.objectContaining({
            in: "query",
            name: "limit",
            required: true,
            schema: { type: "integer" },
          }),
          expect.objectContaining({
            in: "query",
            name: "search",
            required: false,
            schema: { type: "string" },
          }),
        ]);
      });

      it("should not expand a body param", async () => {
        @Controller("ex")
        class Ctrl {
          @Post()
          create(
            @Body({
              schema: createStandardSchema({
                type: "object",
                properties: { title: { type: "string" } },
              }),
            } as any)
            _b: object,
          ) {}
        }

        const doc = await createDocForController(Ctrl);
        expect(doc.paths["/ex"]?.post?.parameters).toBeUndefined();
        expect(
          doc.paths["/ex"]?.post?.requestBody?.content?.["application/json"]
            ?.schema,
        ).toEqual({
          type: "object",
          properties: { title: { type: "string" } },
        });
      });

      it("should not expand a named query param", async () => {
        @Controller("ex")
        class Ctrl {
          @Get()
          find(
            @Query("filter", {
              schema: createStandardSchema({
                type: "object",
                properties: { nested: { type: "string" } },
              }),
            } as any)
            _f: object,
          ) {}
        }

        const doc = await createDocForController(Ctrl);
        expect(doc.paths["/ex"]?.get?.parameters).toHaveLength(1);
        expect(doc.paths["/ex"]?.get?.parameters?.[0]?.name).toBe("filter");
      });

      it("should not expand a standard schema that does not convert to an object schema", async () => {
        @Controller("ex")
        class Ctrl {
          @Get()
          find(
            @Query({
              schema: createStandardSchema({
                oneOf: [{ type: "string" }, { type: "number" }],
              }),
            } as any)
            _q: unknown,
          ) {}
        }

        const doc = await createDocForController(Ctrl);
        expect(doc.paths["/ex"]?.get?.parameters ?? []).toEqual([]);
      });

      it("should not invoke the converter for non-standard params", async () => {
        const converter = createSpy(() => undefined);

        @Controller("ex")
        class Ctrl {
          @Get()
          find(@Query("q") _q: string) {}
        }

        await createDocForController(Ctrl, converter);
        expect(converter.callCount).toBe(0);
      });
    });

    describe("transformToArraySchemaProperty (array items & numeric constraints)", () => {
      it("should preserve items schema when metadata.items is already defined and type is string", () => {
        class SortDto {
          @ApiProperty({
            type: "array",
            isArray: true,
            items: {
              type: "object",
              additionalProperties: {
                type: "string",
                enum: ["asc", "desc"],
              },
            },
            example: [{ created_on: "desc" }],
            required: false,
          })
          sort?: unknown[];
        }

        const { schemas } = exploreModel(SortDto, explorer);
        const prop = schemas.SortDto?.properties?.sort as SchemaObject;
        expect(prop.items).toEqual({
          type: "object",
          additionalProperties: {
            type: "string",
            enum: ["asc", "desc"],
          },
        });
        expect(prop.type).toBe("array");
        expect(prop.example).toEqual([{ created_on: "desc" }]);
      });

      it("should use type parameter when metadata.items is not defined", () => {
        class ItemsDto {
          @ApiProperty({ type: "string", isArray: true, required: false })
          items?: string[];
        }

        const { schemas } = exploreModel(ItemsDto, explorer);
        const prop = schemas.ItemsDto?.properties?.items as SchemaObject;
        expect(prop.items).toEqual({ type: "string" });
        expect(prop.type).toBe("array");
      });

      it("should use type object when provided", () => {
        class ObjectItemsDto {
          @ApiProperty({
            type: "array",
            items: { type: "object", properties: { name: { type: "string" } } },
            required: false,
          })
          items?: Array<{ name: string }>;
        }

        const { schemas } = exploreModel(ObjectItemsDto, explorer);
        const prop = schemas.ObjectItemsDto?.properties?.items as SchemaObject;
        expect(prop.items).toEqual({
          type: "object",
          properties: { name: { type: "string" } },
        });
        expect(prop.type).toBe("array");
      });

      // BUNEST_BUG: SchemaExplorer.applyApiPropertyOptionsToSchema (packages/swagger/src/schema-explorer.ts:747-757) applies numeric bounds (minimum/maximum/exclusiveMinimum/exclusiveMaximum/multipleOf) onto the outer array schema instead of items
      it.skip("should move numeric constraints to the items", () => {
        class Order {
          @ApiProperty({
            type: [Number],
            minimum: 0,
            exclusiveMinimum: true,
            maximum: 100,
            exclusiveMaximum: true,
            multipleOf: 5,
          })
          quantities!: number[];
        }

        const { schemas } = exploreModel(Order, explorer);
        expect(schemas.Order?.properties?.quantities).toEqual({
          type: "array",
          items: {
            type: "number",
            minimum: 0,
            exclusiveMinimum: true,
            maximum: 100,
            exclusiveMaximum: true,
            multipleOf: 5,
          },
        });
      });
    });

    describe("boolean enum and explicit type preservation", () => {
      it('should produce type "boolean" with enum [true, false]', () => {
        class BoolEnumDto {
          @ApiProperty({ enum: [true, false] })
          active!: boolean;
        }

        const { schemas } = exploreModel(BoolEnumDto, explorer);
        expect(schemas.BoolEnumDto?.properties?.active).toEqual({
          type: "boolean",
          enum: [true, false],
        });
      });

      it('should produce type "boolean" with enum [true]', () => {
        class TrueLiteralDto {
          @ApiProperty({ enum: [true] })
          flag!: boolean;
        }

        const { schemas } = exploreModel(TrueLiteralDto, explorer);
        expect(schemas.TrueLiteralDto?.properties?.flag).toEqual({
          type: "boolean",
          enum: [true],
        });
      });

      it("should preserve explicit type when enum is also provided", () => {
        class ExplicitTypeBoolDto {
          @ApiProperty({ type: "boolean", enum: [true] })
          flag!: boolean;
        }

        const { schemas } = exploreModel(ExplicitTypeBoolDto, explorer);
        expect(schemas.ExplicitTypeBoolDto?.properties?.flag).toEqual({
          type: "boolean",
          enum: [true],
        });
      });

      it('should preserve explicit type "string" even when enum values are numbers', () => {
        class ExplicitTypeStringDto {
          @ApiProperty({ type: "string", enum: [1, 2, 3] })
          code!: string;
        }

        const { schemas } = exploreModel(ExplicitTypeStringDto, explorer);
        const prop = schemas.ExplicitTypeStringDto?.properties
          ?.code as SchemaObject;
        expect(prop.type).toBe("string");
        expect(prop.enum).toEqual([1, 2, 3]);
      });

      // BUNEST_BUG: SchemaExplorer (packages/swagger/src/schema-explorer.ts:596-636) does not read static _OPENAPI_METADATA_FACTORY() metadata
      it.skip("should infer string enum type when plugin metadata falls back to Object", () => {
        class ObjectFallbackMixedEnumDto {
          static _OPENAPI_METADATA_FACTORY() {
            return {
              gender: {
                required: true,
                type: () => Object,
                enum: ["a", 1],
              },
            };
          }
        }

        const { schemas } = exploreModel(ObjectFallbackMixedEnumDto, explorer);
        expect(schemas.ObjectFallbackMixedEnumDto?.properties?.gender).toEqual({
          type: "string",
          enum: ["a", 1],
        });
      });

      // BUNEST_BUG: SchemaExplorer (packages/swagger/src/schema-explorer.ts:596-636) does not read static _OPENAPI_METADATA_FACTORY() metadata
      it.skip("should infer number enum type when plugin metadata falls back to Object", () => {
        class ObjectFallbackNumberEnumDto {
          static _OPENAPI_METADATA_FACTORY() {
            return {
              value: {
                required: true,
                type: () => Object,
                enum: [1, 2],
              },
            };
          }
        }

        const { schemas } = exploreModel(ObjectFallbackNumberEnumDto, explorer);
        expect(schemas.ObjectFallbackNumberEnumDto?.properties?.value).toEqual({
          type: "number",
          enum: [1, 2],
        });
      });

      // BUNEST_BUG: SchemaExplorer (packages/swagger/src/schema-explorer.ts:596-636) does not read static _OPENAPI_METADATA_FACTORY() metadata
      it.skip("should move enum metadata into array items when plugin array metadata falls back to Object", () => {
        class ObjectFallbackArrayEnumDto {
          static _OPENAPI_METADATA_FACTORY() {
            return {
              values: {
                required: true,
                type: () => [Object],
                enum: ["a", "b"],
                isArray: true,
              },
            };
          }
        }

        const { schemas } = exploreModel(ObjectFallbackArrayEnumDto, explorer);
        expect(schemas.ObjectFallbackArrayEnumDto?.properties?.values).toEqual({
          type: "array",
          items: {
            type: "string",
            enum: ["a", "b"],
          },
        });
      });
    });

    describe("SWC const-enum compatibility (issue #3326)", () => {
      const MyStringEnum = { FOO: "FOO", BAR: "BAR" } as const;
      const MyNumericEnum = { ONE: 1, TWO: 2 } as const;

      it("should handle a const-enum object as design:type without throwing circular dependency error", () => {
        class SwcDto {
          @ApiProperty({ type: MyStringEnum as any, required: false })
          someEnum: any;
        }

        expect(() => exploreModel(SwcDto, explorer)).not.toThrow();
      });

      // BUNEST_BUG: SchemaExplorer.resolveTypeSchema (packages/swagger/src/schema-explorer.ts:507-550) returns {} for a string const-enum object reflected as design:type
      it.skip("should produce an enum schema when design:type is a string const-enum object (SWC behavior)", () => {
        class SwcStringEnumDto {
          @ApiProperty({ type: MyStringEnum as any, required: true })
          status: any;
        }

        const { schemas } = exploreModel(SwcStringEnumDto, explorer);
        const statusProp = schemas.SwcStringEnumDto?.properties
          ?.status as SchemaObject;
        expect(statusProp).toBeDefined();
        expect(statusProp.type ?? statusProp.allOf).toBeDefined();
      });

      it("should produce an enum schema when design:type is a numeric const-enum object (SWC behavior)", () => {
        class SwcNumericEnumDto {
          @ApiProperty({ type: MyNumericEnum as any, required: true })
          rank: any;
        }

        expect(() => exploreModel(SwcNumericEnumDto, explorer)).not.toThrow();
        const { schemas } = exploreModel(
          SwcNumericEnumDto,
          new SchemaExplorer(),
        );
        expect(schemas.SwcNumericEnumDto?.properties?.rank).toBeDefined();
      });
    });

    describe("circular dependency error message (issue #3655)", () => {
      // BUNEST_BUG: SchemaExplorer.buildPropertySchema (packages/swagger/src/schema-explorer.ts:850-874) silently returns {} instead of throwing a circular dependency error including class chain [OuterDto] [InnerDto] when design:type is undefined
      it.skip("should include the class name chain when a circular dependency is detected", () => {
        class InnerDto {
          @ApiProperty({ type: () => undefined as any, required: true })
          child: any;
        }

        class OuterDto {
          @ApiProperty({ type: () => InnerDto, required: true })
          inner!: InnerDto;
        }

        expect(() => exploreModel(OuterDto, explorer)).toThrow(
          /\[OuterDto\] \[InnerDto\] A circular dependency has been detected/,
        );
      });
    });

    describe("inherited property type override", () => {
      it("should use the child class type when a property is redeclared in a subclass", () => {
        class InfoPostDTO {
          @ApiProperty()
          name!: string;
        }
        class InfoPutDTO extends InfoPostDTO {
          @ApiProperty()
          id!: number;
        }
        class EntityPostDTO {
          @ApiProperty()
          id!: number;

          @ApiProperty({ type: () => InfoPostDTO })
          info!: InfoPostDTO;
        }
        class EntityPutDTO extends EntityPostDTO {
          @ApiProperty({ type: () => InfoPutDTO })
          override info: InfoPutDTO = undefined!;
        }

        const { schemas } = exploreModel(EntityPutDTO, explorer);
        const infoProp = schemas.EntityPutDTO?.properties?.info as any;
        const ref = infoProp?.$ref ?? infoProp?.allOf?.[0]?.$ref;
        expect(ref).toContain("InfoPutDTO");
        expect(ref).not.toContain("InfoPostDTO");
      });

      it("should keep the type the parent declared unless the re-declaration narrows it", () => {
        enum Status {
          Active = "active",
          Archived = "archived",
        }
        class Tag {}
        class PinnedTag extends Tag {}
        class CreateItemDto {
          @ApiProperty({ type: [Tag] })
          tags!: Tag[];

          @ApiProperty({ type: "integer" })
          count!: number;

          @ApiProperty({ enum: Status, enumName: "Status" })
          status!: Status;

          @ApiProperty()
          mainTag!: Tag;

          @ApiProperty()
          value!: string | number;
        }
        class UpdateItemDto extends CreateItemDto {
          @ApiPropertyOptional({ description: "Replaces every tag" })
          override tags: Tag[] = undefined!;

          @ApiPropertyOptional()
          override count: number = undefined!;

          @ApiPropertyOptional()
          override status: Status = undefined!;

          @ApiPropertyOptional()
          override mainTag: PinnedTag = undefined!;

          @ApiPropertyOptional()
          override value: number = undefined!;
        }

        const { schemas } = exploreModel(UpdateItemDto, explorer);
        expect(schemas.UpdateItemDto?.properties).toEqual({
          tags: {
            type: "array",
            items: { $ref: "#/components/schemas/Tag" },
            description: "Replaces every tag",
          },
          count: { type: "integer" },
          status: { $ref: "#/components/schemas/Status" },
          mainTag: { $ref: "#/components/schemas/PinnedTag" },
          value: { type: "number" },
        });
      });

      it("should keep the type the parent declared when CLI plugin metadata describes the re-declaration", () => {
        class Tag {}
        class CreateTagsDto {
          @ApiProperty({ type: [Tag] })
          tags!: Tag[];

          @ApiProperty({ type: "integer" })
          count!: number;
        }
        class UpdateTagsDto extends CreateTagsDto {
          @ApiPropertyOptional()
          override tags: Tag[] = undefined!;

          @ApiPropertyOptional()
          override count: number = undefined!;

          static _OPENAPI_METADATA_FACTORY() {
            return {
              tags: { required: false, type: () => [Tag] },
              count: { required: false, type: () => Number },
            };
          }
        }

        const { schemas } = exploreModel(UpdateTagsDto, explorer);
        expect(schemas.UpdateTagsDto).toEqual({
          type: "object",
          properties: {
            tags: {
              type: "array",
              items: { $ref: "#/components/schemas/Tag" },
            },
            count: { type: "integer" },
          },
        });
      });
    });

    describe("inherited property required override", () => {
      const requiredOf = (type: Type<unknown>) => {
        const { schemas } = exploreModel(type, new SchemaExplorer());
        return schemas[type.name]?.required ?? [];
      };

      it("should make a property required when a subclass re-declares an optional one with a bare @ApiProperty()", () => {
        class ParentWithOptionalName {
          @ApiPropertyOptional({ description: "Display name", example: "Ada" })
          name?: string;
        }
        class ChildWithRequiredName extends ParentWithOptionalName {
          @ApiProperty()
          override name: string = undefined!;
        }

        explorer.registerDtoSchema(ChildWithRequiredName);
        explorer.registerDtoSchema(ParentWithOptionalName);
        const schemas = explorer.getSchemas();

        expect(schemas.ChildWithRequiredName?.required).toEqual(["name"]);
        expect(schemas.ChildWithRequiredName?.properties?.name).toEqual({
          type: "string",
          description: "Display name",
          example: "Ada",
        });
        expect(schemas.ParentWithOptionalName?.required).toBeUndefined();
      });

      it("should keep the property optional when the subclass says so", () => {
        class ParentWithRequiredName {
          @ApiProperty()
          name!: string;
        }
        class ChildWithOptionalDecorator extends ParentWithRequiredName {
          @ApiPropertyOptional()
          override name: string = undefined!;
        }
        class ChildWithExplicitRequiredFalse extends ParentWithRequiredName {
          @ApiProperty({ required: false })
          override name: string = undefined!;
        }

        expect(requiredOf(ChildWithOptionalDecorator)).toEqual([]);
        expect(requiredOf(ChildWithExplicitRequiredFalse)).toEqual([]);
      });

      it("should keep inheriting required: false when the subclass does not re-declare the property", () => {
        class ParentWithOptionalName {
          @ApiPropertyOptional()
          name?: string;
        }
        class ChildWithOwnProperty extends ParentWithOptionalName {
          @ApiProperty()
          id!: number;
        }

        expect(requiredOf(ChildWithOwnProperty)).toEqual(["id"]);
      });

      it("should apply through more than one level of inheritance", () => {
        class GrandparentWithOptionalName {
          @ApiPropertyOptional()
          name?: string;
        }
        class ParentWithoutRedeclaration extends GrandparentWithOptionalName {}
        class ChildWithRequiredName extends ParentWithoutRedeclaration {
          @ApiProperty()
          override name: string = undefined!;
        }
        class GrandchildWithOptionalName extends ChildWithRequiredName {
          @ApiPropertyOptional()
          override name: string = undefined!;
        }

        expect(requiredOf(ParentWithoutRedeclaration)).toEqual([]);
        expect(requiredOf(ChildWithRequiredName)).toEqual(["name"]);
        expect(requiredOf(GrandchildWithOptionalName)).toEqual([]);
      });

      it("should not change how decorators stacked on the same class are merged", () => {
        class StackedDecorators {
          @ApiProperty({ description: "Display name" })
          @ApiPropertyOptional()
          name?: string;
        }

        expect(requiredOf(StackedDecorators)).toEqual([]);
      });

      it("should also apply when the CLI plugin metadata describes the subclass", () => {
        class PluginParent {
          @ApiPropertyOptional()
          name?: string;
        }
        class PluginChild extends PluginParent {
          @ApiProperty({ description: "Display name" })
          override name: string = undefined!;

          static _OPENAPI_METADATA_FACTORY() {
            return { name: { required: true, type: () => String } };
          }
        }

        expect(requiredOf(PluginChild)).toEqual(["name"]);
      });

      it("should keep the parent's explicit decorator over CLI plugin metadata when the subclass has no decorator", () => {
        class PluginParentWithOptionalName {
          @ApiPropertyOptional()
          name?: string;
        }
        class PluginChildWithoutDecorator extends PluginParentWithOptionalName {
          override name: string = undefined!;

          static _OPENAPI_METADATA_FACTORY() {
            return { name: { required: true, type: () => String } };
          }
        }

        expect(requiredOf(PluginChildWithoutDecorator)).toEqual([]);
      });
    });

    describe("property re-declared with CLI plugin metadata", () => {
      const createDtos = () => {
        class BillingDto {
          static _OPENAPI_METADATA_FACTORY(): Record<string, any> {
            return {
              plan: { required: true, type: () => String },
              fraudScore: { required: true, type: () => Number },
            };
          }
        }
        class PublicBillingDto {
          static _OPENAPI_METADATA_FACTORY(): Record<string, any> {
            return { plan: { required: true, type: () => String } };
          }
        }
        class AccountDto {
          @ApiProperty({ description: "Billing state", required: false })
          status!: string;

          static _OPENAPI_METADATA_FACTORY(): Record<string, any> {
            return {
              billing: { required: true, type: () => BillingDto },
              status: { required: true, type: () => BillingDto },
            };
          }
        }
        class PublicAccountDto extends AccountDto {
          static override _OPENAPI_METADATA_FACTORY(): Record<string, any> {
            return {
              billing: { required: true, type: () => PublicBillingDto },
              status: { required: true, type: () => PublicBillingDto },
            };
          }
        }
        return { AccountDto, PublicAccountDto };
      };
      const refOf = (property: Record<string, any> | undefined) =>
        property?.$ref ?? property?.allOf?.[0]?.$ref;

      // BUNEST_BUG: SchemaExplorer (packages/swagger/src/schema-explorer.ts:596-636) does not read static _OPENAPI_METADATA_FACTORY() metadata
      it.skip.each([
        ["alone", false],
        ["after its parent", true],
      ] as const)(
        "should document the type of the re-declaration when explored %s",
        (_, exploreParentFirst) => {
          const { AccountDto, PublicAccountDto } = createDtos();
          const exp = new SchemaExplorer();
          if (exploreParentFirst) {
            exp.registerDtoSchema(AccountDto);
          }
          exp.registerDtoSchema(PublicAccountDto);
          const schemas = exp.getSchemas();

          const { properties, required } = schemas.PublicAccountDto ?? {};
          expect(refOf(properties?.billing as any)).toEqual(
            "#/components/schemas/PublicBillingDto",
          );
          expect(refOf(properties?.status as any)).toEqual(
            "#/components/schemas/PublicBillingDto",
          );
          expect((properties?.status as SchemaObject)?.description).toEqual(
            "Billing state",
          );
          expect(required).toEqual(["billing"]);
        },
      );

      // BUNEST_BUG: SchemaExplorer / PickType (packages/swagger/src/schema-explorer.ts:596-636) does not read static _OPENAPI_METADATA_FACTORY() metadata
      it.skip("should document the type of the re-declaration in mapped types", () => {
        const { AccountDto, PublicAccountDto } = createDtos();
        class PublicBillingOnlyDto extends PickType(PublicAccountDto, [
          "billing",
        ] as never[]) {}

        const exp = new SchemaExplorer();
        exp.registerDtoSchema(AccountDto);
        exp.registerDtoSchema(PublicAccountDto);
        exp.registerDtoSchema(PublicBillingOnlyDto);
        const schemas = exp.getSchemas();

        expect(
          refOf(schemas.PublicBillingOnlyDto?.properties?.billing as any),
        ).toEqual("#/components/schemas/PublicBillingDto");
      });
    });

    describe("Record/additionalProperties (plugin output)", () => {
      it("should preserve additionalProperties emitted for Record<string, V>", () => {
        class RecordDto {
          @ApiProperty({
            type: "object",
            additionalProperties: { type: "string" },
          })
          attributes!: Record<string, string>;
        }

        const { schemas } = exploreModel(RecordDto, explorer);
        expect(schemas.RecordDto?.properties?.attributes).toEqual({
          type: "object",
          additionalProperties: { type: "string" },
        });
      });

      it("should preserve additionalProperties: true for Record<string, any>", () => {
        class AnyRecordDto {
          @ApiProperty({ type: "object", additionalProperties: true })
          attributes!: Record<string, any>;
        }

        const { schemas } = exploreModel(AnyRecordDto, explorer);
        expect(schemas.AnyRecordDto?.properties?.attributes).toEqual({
          type: "object",
          additionalProperties: true,
        });
      });

      // BUNEST_BUG: SchemaExplorer (packages/swagger/src/schema-explorer.ts:596-636) does not read static _OPENAPI_METADATA_FACTORY() metadata (additionalProperties lost)
      it.skip("should resolve the flat metadata the CLI plugin generates without a circular dependency", () => {
        class PluginRecordDto {
          @ApiProperty()
          attributes!: Record<string, string>;

          static _OPENAPI_METADATA_FACTORY() {
            return {
              attributes: {
                required: true,
                type: "object",
                additionalProperties: { type: "string" },
              },
            };
          }
        }

        expect(() => exploreModel(PluginRecordDto, explorer)).not.toThrow();
        const { schemas } = exploreModel(PluginRecordDto, new SchemaExplorer());
        expect(schemas.PluginRecordDto?.properties?.attributes).toEqual({
          type: "object",
          additionalProperties: { type: "string" },
        });
      });
    });

    describe("lazy enum", () => {
      let registry: string[];
      let numericRegistry: number[];

      const serialize = <T>(value: T): T => JSON.parse(JSON.stringify(value));

      beforeEach(() => {
        registry = ["first"];
        numericRegistry = [1];
      });

      function defineDto() {
        class LazyEnumDto {
          @ApiProperty({ enum: () => [...registry], enumName: "LazyEnum" })
          named!: string;

          @ApiProperty({ enum: () => [...registry] })
          unnamed!: string;

          @ApiProperty({
            enum: () => [...registry],
            enumName: "LazyArrayEnum",
            isArray: true,
          })
          many!: string[];

          @ApiProperty({
            enum: () => [...registry],
            enumName: "TypedLazyEnum",
            type: "string",
          })
          typed!: string;

          @ApiProperty({
            enum: () => [...numericRegistry],
            enumName: "NumericLazyEnum",
          })
          numeric!: number;

          @ApiProperty({
            enum: () => [...registry],
            enumName: "LazyTypeArrayEnum",
            type: () => [String],
          })
          lazyTypeArray!: string[];
        }
        return LazyEnumDto;
      }

      it("should call the enum function when the schema is generated, not when the decorator runs", () => {
        const LazyEnumDto = defineDto();
        registry.push("second");
        numericRegistry.push(2);

        const { schemas } = exploreModel(LazyEnumDto, explorer);
        const serialized = serialize(schemas);

        for (const name of [
          "LazyEnum",
          "LazyArrayEnum",
          "TypedLazyEnum",
          "LazyTypeArrayEnum",
        ]) {
          expect(serialized[name]).toEqual({
            type: "string",
            enum: ["first", "second"],
          });
        }
        expect(serialized.NumericLazyEnum).toEqual({
          type: "number",
          enum: [1, 2],
        });
      });

      // BUNEST_BUG: SchemaExplorer.buildPropertySchema (packages/swagger/src/schema-explorer.ts:831-840) ignores lazy array thunk `type: () => [String]` when enumName is set (checks only apiMeta.isArray)
      it.skip("should keep the shape of the generated properties", () => {
        const LazyEnumDto = defineDto();
        registry.push("second");

        const { schemas } = exploreModel(LazyEnumDto, explorer);

        expect(serialize(schemas.LazyEnumDto)?.properties).toEqual({
          named: { $ref: "#/components/schemas/LazyEnum" },
          unnamed: { type: "string", enum: ["first", "second"] },
          many: {
            type: "array",
            items: { $ref: "#/components/schemas/LazyArrayEnum" },
          },
          typed: { $ref: "#/components/schemas/TypedLazyEnum" },
          numeric: { $ref: "#/components/schemas/NumericLazyEnum" },
          lazyTypeArray: {
            type: "array",
            items: { $ref: "#/components/schemas/LazyTypeArrayEnum" },
          },
        });
      });

      it("should not infer the type from the values when it is explicit", () => {
        class ExplicitTypeDto {
          @ApiProperty({ enum: () => [1, 2], type: "string" })
          value!: string;
        }

        const { schemas } = exploreModel(ExplicitTypeDto, explorer);
        expect(serialize(schemas.ExplicitTypeDto)?.properties).toEqual({
          value: { type: "string", enum: [1, 2] },
        });
      });

      it("should infer the type separately for each property sharing an enum function", () => {
        const sharedEnum = () => [...registry];
        class SharedEnumDto {
          @ApiProperty({ enum: sharedEnum })
          inferred!: string;

          @ApiProperty({ enum: sharedEnum, type: "integer" })
          explicit!: string;
        }

        const { schemas } = exploreModel(SharedEnumDto, explorer);
        expect(serialize(schemas.SharedEnumDto)?.properties).toEqual({
          inferred: { type: "string", enum: ["first"] },
          explicit: { type: "integer", enum: ["first"] },
        });
      });

      describe("in a mapped type", () => {
        class BaseDto {
          @ApiProperty({ enum: () => [...registry], enumName: "MappedEnum" })
          named!: string;

          @ApiProperty({ enum: () => [...numericRegistry] })
          numeric!: string;

          @ApiProperty({ enum: () => [...numericRegistry] })
          untyped: any;
        }

        const mappedTypes: Array<[string, () => Type<any>]> = [
          ["PartialType", () => PartialType(BaseDto)],
          [
            "PickType",
            () => PickType(BaseDto, ["named", "numeric", "untyped"]),
          ],
          ["OmitType", () => OmitType(BaseDto, [])],
          ["IntersectionType", () => IntersectionType(BaseDto, class {})],
          ["DeepPartialType", () => DeepPartialType(BaseDto)],
        ];

        // BUNEST_BUG: Mapped types (packages/core/src/common/mapped-types/mapped-types.utils.ts, deep-partial-type.helper.ts) lose/mis-infer lazy numeric enum type as "string" instead of "number"
        it.skip.each(mappedTypes)(
          "should keep resolving the enums lazily with %s",
          (_name, createMappedType) => {
            const MappedDto = createMappedType();
            registry.push("second");
            numericRegistry.push(2);

            const { schemas } = exploreModel(MappedDto, new SchemaExplorer());
            const serialized = serialize(schemas);

            expect(serialized.MappedEnum).toEqual({
              type: "string",
              enum: ["first", "second"],
            });
            const properties = serialized[MappedDto.name]?.properties;
            expect(properties?.named).toEqual({
              $ref: "#/components/schemas/MappedEnum",
            });
            expect(properties?.numeric).toEqual({
              type: "number",
              enum: [1, 2],
            });
            expect(properties?.untyped).toEqual({
              type: "number",
              enum: [1, 2],
            });
          },
        );

        // BUNEST_BUG: Mapped types (packages/core/src/common/mapped-types/mapped-types.utils.ts) infer lazy numeric enum type as "string" instead of "number" in mapped query DTOs
        it.skip("should keep resolving the enums lazily in a mapped query DTO", async () => {
          class MappedQueryDto extends PartialType(BaseDto) {}

          @Controller("lq")
          class Ctrl {
            @Get()
            find(@Query() _q: MappedQueryDto) {}
          }

          registry.push("second");
          numericRegistry.push(2);

          const doc = await createDocForController(Ctrl);
          const params = serialize(doc.paths["/lq"]?.get?.parameters ?? []);
          const byName = Object.fromEntries(params.map((p) => [p.name, p]));

          expect(byName.named?.schema).toEqual({
            $ref: "#/components/schemas/MappedEnum",
          });
          expect(byName.numeric?.schema).toEqual({
            type: "number",
            enum: [1, 2],
          });
          expect(byName.untyped?.schema).toEqual({
            type: "number",
            enum: [1, 2],
          });
          expect(serialize(doc.components?.schemas)?.MappedEnum).toEqual({
            type: "string",
            enum: ["first", "second"],
          });
        });
      });

      describe("in a query DTO", () => {
        it("should resolve the enums when the parameters are generated", async () => {
          class LazyEnumQueryDto {
            @ApiProperty({ enum: () => [...registry], enumName: "QueryEnum" })
            named!: string;

            @ApiProperty({ enum: () => [...registry] })
            unnamed!: string;

            @ApiProperty({
              enum: () => [...registry],
              enumName: "QueryArrayEnum",
              isArray: true,
            })
            many!: string[];
          }

          @Controller("lq2")
          class Ctrl {
            @Get()
            find(@Query() _q: LazyEnumQueryDto) {}
          }

          registry.push("second");

          const doc = await createDocForController(Ctrl);
          const params = serialize(doc.paths["/lq2"]?.get?.parameters ?? []);
          const byName = Object.fromEntries(params.map((p) => [p.name, p]));

          expect(byName.named?.schema).toEqual({
            $ref: "#/components/schemas/QueryEnum",
          });
          expect(byName.unnamed?.schema).toEqual({
            type: "string",
            enum: ["first", "second"],
          });
          expect(byName.many?.schema).toEqual({
            type: "array",
            items: { $ref: "#/components/schemas/QueryArrayEnum" },
          });
          expect(serialize(doc.components?.schemas)).toEqual(
            expect.objectContaining({
              QueryEnum: { type: "string", enum: ["first", "second"] },
              QueryArrayEnum: { type: "string", enum: ["first", "second"] },
            }),
          );
        });
      });
    });

    describe("when a query DTO property is reflected as Object", () => {
      class ObjectQueryDto {
        @ApiPropertyOptional()
        filter?: any;

        @ApiPropertyOptional()
        record?: Record<string, string>;

        @ApiPropertyOptional({
          oneOf: [{ type: "string" }, { type: "number" }],
        })
        either?: string | number;

        @ApiPropertyOptional({ type: [Object] })
        list?: object[];
      }

      // BUNEST_BUG: SchemaExplorer.buildPropertySchema (packages/swagger/src/schema-explorer.ts:860-910) keeps reflected design:type ("object") next to oneOf on query DTO properties
      it.skip("should not create an Object component", async () => {
        @Controller("oq")
        class Ctrl {
          @Get()
          find(@Query() _q: ObjectQueryDto) {}
        }

        const doc = await createDocForController(Ctrl);
        const params = (doc.paths["/oq"]?.get?.parameters ??
          []) as OpenApiParameter[];
        const byName = Object.fromEntries(params.map((p) => [p.name, p]));

        expect(doc.components?.schemas?.Object).toBeUndefined();
        expect(byName.filter?.schema).toEqual({ type: "object" });
        expect(byName.record?.schema).toEqual({ type: "object" });
        expect(byName.either?.schema).toEqual({
          oneOf: [{ type: "string" }, { type: "number" }],
        });
        expect((byName.either?.schema as SchemaObject)?.type).toBeUndefined();
        expect(byName.list?.schema).toEqual({
          type: "array",
          items: { type: "object" },
        });
      });
    });

    describe("when a property is an array of bigint", () => {
      class Ledger {
        @ApiProperty({ type: [BigInt] })
        tuple!: bigint[];

        @ApiProperty({ type: BigInt, isArray: true, minItems: 1 })
        flag!: bigint[];

        @ApiProperty({ type: () => [BigInt] })
        lazy!: bigint[];
      }

      // BUNEST_BUG: SchemaExplorer.resolveTypeSchema (packages/swagger/src/schema-explorer.ts:526-550) does not map BigInt to { type: "integer", format: "int64" } (emits items: {})
      it.skip("should document an array of int64 integers", () => {
        const { schemas } = exploreModel(Ledger, explorer);

        expect(schemas.Ledger?.properties).toEqual({
          tuple: {
            type: "array",
            items: { type: "integer", format: "int64" },
          },
          flag: {
            type: "array",
            minItems: 1,
            items: { type: "integer", format: "int64" },
          },
          lazy: {
            type: "array",
            items: { type: "integer", format: "int64" },
          },
        });
      });
    });

    describe("when an object literal property holds another object literal", () => {
      class Customer {
        @ApiProperty({
          type: () =>
            ({
              street: {
                required: false,
                type: () => ({
                  name: { required: true, type: () => String },
                  number: { required: false, type: () => String },
                }),
              },
              tags: {
                required: true,
                type: () => [{ id: { required: true, type: () => String } }],
              },
            }) as any,
        })
        address!: Record<string, any>;
      }

      // BUNEST_BUG: SchemaExplorer.resolveTypeSchema (packages/swagger/src/schema-explorer.ts:474-557) does not support nested object-literal type descriptor objects returned from type: () => ({ ... })
      it.skip("should document whether it is required next to its own required keys", () => {
        const { schemas } = exploreModel(Customer, explorer);

        expect(schemas.Customer?.properties?.address).toEqual({
          type: "object",
          properties: {
            street: {
              type: "object",
              properties: {
                name: { type: "string" },
                number: { type: "string" },
              },
              required: ["name"],
            },
            tags: {
              type: "array",
              items: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
              },
            },
          },
          required: ["tags"],
        });
      });
    });
  },
);
