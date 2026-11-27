import { describe, expect, test } from "bun:test";
import {
  Body,
  BunestFactory,
  Controller,
  Get,
  Module,
  Param,
  Post,
  Query,
  SerializeOptions,
  UsePipes,
  UseStandardSchema,
} from "@bunest/core";
import {
  ValidationPipe,
  createSchemaDto,
  s,
} from "../../validation/src";
import {
  ArrayNotEmpty,
  ArrayUnique,
  Equals,
  IsBase64,
  IsDivisibleBy,
  IsEnum,
  IsFQDN,
  IsHexColor,
  IsIP,
  IsISO8601,
  IsJWT,
  IsMilitaryTime,
  IsMongoId,
  IsNegative,
  IsNotEmptyObject,
  IsPositive,
  IsSemVer,
  IsStrongPassword,
  IsUUID,
  IsUrl,
  Length,
} from "../../validation/src/validator";
import {
  ApiOkResponse,
  ApiSchema,
  DocumentBuilder,
  SchemaExplorer,
  SwaggerModule,
  defaultStandardSchemaConverter,
  generateSchema,
  type StandardJSONSchemaV1,
} from "../src";

enum AccountTier {
  FREE = "free",
  PRO = "pro",
}

const CreateUserSchema = s
  .object({
    email: s.string().email().describe("Primary contact email"),
    age: s.coerce.number().int().min(18).max(120),
    role: s.enum(["user", "admin"]).default("user"),
    tags: s.array(s.string().min(2)).nonempty().optional(),
  })
  .describe("Create user payload");

class CreateUserDto extends createSchemaDto(CreateUserSchema) {}

const UserOutputSchema = s.object({
  id: s.string().uuid(),
  email: s.string().email(),
  role: s.enum(["user", "admin"]).default("user"),
  bio: s.string().nullable(),
});

class UserResponseDto extends createSchemaDto(UserOutputSchema) {}

const FilterQuerySchema = s.object({
  page: s.coerce.number().int().min(1).default(1),
  search: s.string().min(2).optional(),
});

class FilterQueryDto extends createSchemaDto(FilterQuerySchema) {}

class ReflectOnlySchemaDto {
  constructor(public readonly value?: unknown) {}
}
Reflect.defineMetadata(
  "bunest:standard-schema-dto",
  s.object({
    code: s.string().length(6),
    active: s.boolean(),
  }),
  ReflectOnlySchemaDto,
);

class ExpandedHintsDto {
  @Length(3, 20)
  username!: string;

  @IsPositive()
  amount!: number;

  @IsNegative()
  delta!: number;

  @IsDivisibleBy(5)
  step!: number;

  @IsIP(4)
  ipv4!: string;

  @IsIP(6)
  ipv6!: string;

  @IsIP()
  ipAny!: string;

  @IsISO8601()
  occurredAt!: string;

  @IsUUID()
  traceId!: string;

  @IsUrl()
  website!: string;

  @IsEnum(AccountTier)
  tier!: AccountTier;

  @ArrayNotEmpty()
  @ArrayUnique()
  scopes!: string[];

  @IsFQDN()
  domain!: string;

  @IsJWT()
  token!: string;

  @IsMongoId()
  mongoId!: string;

  @IsBase64()
  payloadB64!: string;

  @IsSemVer()
  version!: string;

  @IsHexColor()
  accentColor!: string;

  @IsStrongPassword({ minLength: 12 })
  password!: string;

  @IsMilitaryTime()
  alarmTime!: string;

  @IsNotEmptyObject()
  metadata!: Record<string, unknown>;

  @Equals("v1")
  schemaVersion!: "v1";
}

describe("@bunest/swagger Single Source of Truth (Schema DSL, Serializer Inference, Hints & OAS 3.1)", () => {
  test("drives BOTH runtime ValidationPipe and OpenAPI 3.1 SwaggerModule from a single createSchemaDto", async () => {
    const ControllerOutSchema = s.object({
      source: s.literal("controller"),
    });

    const HandlerOutSchema = s.object({
      id: s.string().uuid(),
      email: s.string().email(),
      kind: s.literal("public-user"),
    });

    const OptionsOutSchema = s.object({
      items: s.array(s.string().min(1)),
      total: s.int().min(0),
    });

    const OverrideApiDtoSchema = s.object({
      overridden: s.boolean(),
    });
    class OverrideApiDto extends createSchemaDto(OverrideApiDtoSchema) {}

    @UseStandardSchema(ControllerOutSchema)
    @UsePipes(new ValidationPipe())
    @Controller("/ssot-users")
    class SsotUsersController {
      @Post()
      create(@Body() dto: CreateUserDto): UserResponseDto {
        return new UserResponseDto({
          id: "550e8400-e29b-41d4-a716-446655440000",
          email: dto.email,
          role: dto.role,
          bio: null,
        });
      }

      @Get()
      @SerializeOptions({ schema: OptionsOutSchema })
      list(@Query() _query: FilterQueryDto) {
        return { items: ["a"], total: 1 };
      }

      @Get(":id")
      @UseStandardSchema(HandlerOutSchema)
      findOne(@Param("id") id: string) {
        return { id, email: "ada@bunest.dev", kind: "public-user" as const };
      }

      @Get("explicit-override")
      @UseStandardSchema(HandlerOutSchema)
      @ApiOkResponse({ type: OverrideApiDto, description: "Explicit wins" })
      explicitOverride() {
        return { overridden: true };
      }
    }

    @Controller("/ssot-return-dto")
    class SsotReturnDtoController {
      @Post()
      createDirect(@Body() dto: CreateUserDto): UserResponseDto {
        return new UserResponseDto({
          id: "550e8400-e29b-41d4-a716-446655440000",
          email: dto.email,
          role: dto.role,
          bio: null,
        });
      }

      @Get("reflect-fallback")
      reflectFallback(): ReflectOnlySchemaDto {
        return new ReflectOnlySchemaDto({ code: "123456", active: true });
      }
    }

    @Module({ controllers: [SsotUsersController, SsotReturnDtoController] })
    class SsotModule {}

    const app = await BunestFactory.create(SsotModule, { logger: false });
    try {
      // 1. Runtime ValidationPipe works on CreateUserDto
      const okRes = await app.fetch(
        new Request("http://localhost/ssot-users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "ada@bunest.dev", age: "25" }),
        }),
      );
      expect(okRes.status).toBe(201);
      expect(await okRes.json()).toEqual({
        id: "550e8400-e29b-41d4-a716-446655440000",
        email: "ada@bunest.dev",
        role: "user",
        bio: null,
      });

      const badRes = await app.fetch(
        new Request("http://localhost/ssot-users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "bad", age: 10 }),
        }),
      );
      expect(badRes.status).toBe(400);

      // 2. SwaggerModule generates complete OpenAPI 3.1 spec from the same schemas
      const doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle("SSOT API").setVersion("1.0.0").build(),
      );

      expect(doc.openapi).toBe("3.1.0");
      const schemas = doc.components?.schemas ?? {};

      // CreateUserDto registered in components.schemas with input required fields
      expect(schemas.CreateUserDto).toMatchObject({
        type: "object",
        description: "Create user payload",
        required: ["email", "age"],
      });
      expect(schemas.CreateUserDto?.properties?.email).toMatchObject({
        type: "string",
        format: "email",
        description: "Primary contact email",
      });
      expect(schemas.CreateUserDto?.properties?.age).toMatchObject({
        type: "integer",
        minimum: 18,
        maximum: 120,
      });

      // UserResponseDto registered via design:returntype with output required fields (including default role) and OAS 3.1 nullable bio
      expect(
        doc.paths["/ssot-return-dto"]?.post?.responses["201"]?.content?.[
          "application/json"
        ]?.schema,
      ).toEqual({ $ref: "#/components/schemas/UserResponseDto" });
      expect(schemas.UserResponseDto?.required).toEqual([
        "id",
        "email",
        "role",
        "bio",
      ]);
      expect(schemas.UserResponseDto?.properties?.bio).toEqual({
        type: ["string", "null"],
      });

      // POST /ssot-users references CreateUserDto (request) & falls back to ControllerOutSchema or UserResponseDto
      const createOp = doc.paths["/ssot-users"]?.post;
      expect(
        createOp?.requestBody?.content?.["application/json"]?.schema,
      ).toEqual({ $ref: "#/components/schemas/CreateUserDto" });
      // Controller-level @UseStandardSchema takes precedence over design:returntype when no explicit @ApiResponse
      expect(
        createOp?.responses["201"]?.content?.["application/json"]?.schema,
      ).toEqual({
        type: "object",
        properties: {
          source: { const: "controller" },
        },
        required: ["source"],
      });

      // @Query() FilterQueryDto expanded into query parameters
      const listOp = doc.paths["/ssot-users"]?.get;
      const pageParam = listOp?.parameters?.find(
        (p) => p.in === "query" && p.name === "page",
      );
      const searchParam = listOp?.parameters?.find(
        (p) => p.in === "query" && p.name === "search",
      );
      expect(pageParam?.required).toBe(false);
      expect(pageParam?.schema).toMatchObject({
        type: "integer",
        minimum: 1,
        default: 1,
      });
      expect(searchParam?.required).toBe(false);
      expect(searchParam?.schema).toMatchObject({
        type: "string",
        minLength: 2,
      });

      // @SerializeOptions({ schema: OptionsOutSchema }) inferred on GET /ssot-users
      expect(
        listOp?.responses["200"]?.content?.["application/json"]?.schema,
      ).toEqual({
        type: "object",
        properties: {
          items: { type: "array", items: { type: "string", minLength: 1 } },
          total: { type: "integer", minimum: 0 },
        },
        required: ["items", "total"],
      });

      // Method-level @UseStandardSchema(HandlerOutSchema) overrides controller-level @UseStandardSchema
      expect(
        doc.paths["/ssot-users/{id}"]?.get?.responses["200"]?.content?.[
          "application/json"
        ]?.schema,
      ).toEqual({
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          email: { type: "string", format: "email" },
          kind: { const: "public-user" },
        },
        required: ["id", "email", "kind"],
      });

      // Explicit @ApiOkResponse overrides @UseStandardSchema
      expect(
        doc.paths["/ssot-users/explicit-override"]?.get?.responses["200"]
          ?.content?.["application/json"]?.schema,
      ).toEqual({ $ref: "#/components/schemas/OverrideApiDto" });

      // Reflect.getMetadata("bunest:standard-schema-dto", ...) fallback works for design:returntype
      expect(
        doc.paths["/ssot-return-dto/reflect-fallback"]?.get?.responses["200"]
          ?.content?.["application/json"]?.schema,
      ).toEqual({ $ref: "#/components/schemas/ReflectOnlySchemaDto" });
      expect(schemas.ReflectOnlySchemaDto).toMatchObject({
        type: "object",
        properties: {
          code: { type: "string", minLength: 6, maxLength: 6 },
          active: { type: "boolean" },
        },
        required: ["code", "active"],
      });
    } finally {
      await app.close();
    }
  });

  test("extracts expanded @bunest/validation constraints into OpenAPI 3.1 and 3.0 schemas", () => {
    const oas31 = generateSchema(ExpandedHintsDto);
    const p31 = oas31.schema.properties ?? {};

    expect(p31.username).toMatchObject({
      type: "string",
      minLength: 3,
      maxLength: 20,
    });
    expect(p31.amount).toMatchObject({ type: "number", exclusiveMinimum: 0 });
    expect(p31.delta).toMatchObject({ type: "number", exclusiveMaximum: 0 });
    expect(p31.step).toMatchObject({ type: "number", multipleOf: 5 });
    expect(p31.ipv4).toMatchObject({ type: "string", format: "ipv4" });
    expect(p31.ipv6).toMatchObject({ type: "string", format: "ipv6" });
    expect(p31.ipAny).toMatchObject({ type: "string", format: "ip" });
    expect(p31.occurredAt).toMatchObject({
      type: "string",
      format: "date-time",
    });
    expect(p31.traceId).toMatchObject({ type: "string", format: "uuid" });
    expect(p31.website).toMatchObject({ type: "string", format: "uri" });
    expect(p31.tier).toMatchObject({
      type: "string",
      enum: ["free", "pro"],
    });
    expect(p31.scopes).toMatchObject({
      type: "array",
      minItems: 1,
      uniqueItems: true,
    });
    expect(p31.domain).toMatchObject({ type: "string", format: "hostname" });
    expect(p31.token).toMatchObject({ type: "string", format: "jwt" });
    expect(p31.mongoId).toMatchObject({
      type: "string",
      pattern: "^[0-9a-fA-F]{24}$",
    });
    expect(p31.payloadB64).toMatchObject({
      type: "string",
      format: "byte",
      contentEncoding: "base64",
    });
    expect(p31.version).toMatchObject({ type: "string", format: "semver" });
    expect(p31.accentColor).toMatchObject({ type: "string" });
    expect(p31.password).toMatchObject({
      type: "string",
      format: "password",
      minLength: 12,
    });
    expect(p31.alarmTime).toMatchObject({
      type: "string",
      pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
    });
    expect(p31.metadata).toMatchObject({ type: "object", minProperties: 1 });
    expect(p31.schemaVersion).toMatchObject({ const: "v1" });

    // OpenAPI 3.0 retains boolean exclusiveMinimum/Maximum & enum for Equals
    const explorer30 = new SchemaExplorer({ openApiVersion: "3.0.3" });
    const name30 = explorer30.registerDtoSchema(ExpandedHintsDto);
    const p30 = explorer30.getSchemas()[name30]?.properties ?? {};
    expect(p30.amount).toMatchObject({
      type: "number",
      minimum: 0,
      exclusiveMinimum: true,
    });
    expect(p30.delta).toMatchObject({
      type: "number",
      maximum: 0,
      exclusiveMaximum: true,
    });
    expect(p30.schemaVersion).toMatchObject({ enum: ["v1"] });
  });

  test("defaultStandardSchemaConverter prefers draft-2020-12 for OpenAPI 3.1 and falls back to openapi-3.0 only when unsupported/throwing", () => {
    const seenTargets: string[] = [];

    const native2020Schema: StandardJSONSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "native-2020",
        jsonSchema: {
          input: ({ target }) => {
            seenTargets.push(`input:${target}`);
            return {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              properties: {
                kind: { const: "widget" },
                note: { type: ["string", "null"], examples: ["hello"] },
              },
            };
          },
          output: ({ target }) => {
            seenTargets.push(`output:${target}`);
            return { type: "string", const: "ok" };
          },
        },
      },
    };

    // 1. Default / OAS 3.1 prefers draft-2020-12 and preserves `const`, `examples`, and `type: ["string", "null"]`
    const oas31Res = defaultStandardSchemaConverter(native2020Schema, {
      schemaType: "input",
      openApiVersion: "3.1.0",
    });
    expect(seenTargets).toEqual(["input:draft-2020-12"]);
    expect(oas31Res?.schema).toEqual({
      type: "object",
      properties: {
        kind: { const: "widget" },
        note: { type: ["string", "null"], examples: ["hello"] },
      },
    });

    // 2. Fallback to openapi-3.0 when draft-2020-12 throws, and convert fallback result cleanly for OAS 3.1
    const fallbackTargets: string[] = [];
    const legacyOnlySchema: StandardJSONSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "legacy-only",
        jsonSchema: {
          input: ({ target }) => {
            fallbackTargets.push(target);
            if (target === "draft-2020-12") {
              throw new Error("draft-2020-12 unsupported");
            }
            return {
              type: "object",
              properties: {
                label: { type: "string", nullable: true },
                count: { type: "number", minimum: 0, exclusiveMinimum: true },
              },
            };
          },
          output: () => ({ type: "object" }),
        },
      },
    };

    const fallbackRes = defaultStandardSchemaConverter(legacyOnlySchema, {
      schemaType: "input",
      openApiVersion: "3.1.0",
    });
    expect(fallbackTargets).toEqual(["draft-2020-12", "openapi-3.0"]);
    expect(fallbackRes?.schema).toEqual({
      type: "object",
      properties: {
        label: { type: ["string", "null"] },
        count: { type: "number", exclusiveMinimum: 0 },
      },
    });

    // 3. OpenAPI 3.0.x prefers openapi-3.0 first and normalizes const/examples
    seenTargets.length = 0;
    const oas30Res = defaultStandardSchemaConverter(native2020Schema, {
      schemaType: "input",
      openApiVersion: "3.0.3",
    });
    expect(seenTargets).toEqual(["input:openapi-3.0"]);
    expect(oas30Res?.schema).toEqual({
      type: "object",
      properties: {
        kind: { enum: ["widget"] },
        note: { type: ["string", "null"], example: "hello" },
      },
    });
  });

  test("honors @ApiSchema metadata on createSchemaDto subclasses", () => {
    @ApiSchema({
      name: "RenamedSchemaDto",
      description: "Overridden description",
    })
    class MyDto extends createSchemaDto(
      s.object({
        id: s.string().uuid(),
      }),
    ) {}

    const { schema, schemas } = generateSchema(MyDto);
    expect(schemas.RenamedSchemaDto).toBeDefined();
    expect(schema).toMatchObject({
      type: "object",
      description: "Overridden description",
      properties: {
        id: { type: "string", format: "uuid" },
      },
      required: ["id"],
    });
  });
});
