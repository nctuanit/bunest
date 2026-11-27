import { describe, expect, test } from "bun:test";
import {
  Body,
  BunestFactory,
  Controller,
  Get,
  Module,
  Post,
  ValidationPipe,
  type StandardSchemaV1,
} from "@bunest/core";
import { createSchemaDto, s } from "@bunest/validation/schema";
import {
  ApiGenericResponse,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiSchema,
  CompositionType,
  DocumentBuilder,
  GenericType,
  IntersectionType,
  OmitType,
  PartialType,
  PickType,
  SwaggerModule,
  UnionType,
  generateSchema,
} from "../src/index";

const STANDARD_SCHEMA_DTO_KEY = Symbol.for("bunest:standard-schema-dto");

// --- Fixtures for Generics & Unions ---

class UserItemDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ example: "ada@bunest.dev" })
  email!: string;
}

class PageMetaDto {
  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  perPage!: number;
}

class ApiEnvelopeDto<T> {
  @ApiProperty({ example: true })
  ok!: boolean;

  @ApiProperty({ description: "Envelope payload" })
  data!: T;
}

class PaginatedDto<T> {
  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ isArray: true })
  items!: T[];
}

class CustomSlotWrapperDto<T> {
  @ApiProperty()
  requestId!: string;

  result!: T;
}

@ApiSchema({ name: "CanineModel" })
class DogDto {
  @ApiProperty({ enum: ["dog"] })
  kind!: "dog";

  @ApiProperty()
  barkVolume!: number;
}

class CatDto {
  @ApiProperty({ enum: ["cat"] })
  kind!: "cat";

  @ApiProperty()
  livesLeft!: number;
}

class BirdDto {
  @ApiProperty({ enum: ["bird"] })
  kind!: "bird";

  @ApiProperty()
  wingspanCm!: number;
}

const PetUnion = UnionType([DogDto, CatDto], {
  name: "Pet",
  description: "A domesticated pet",
  discriminator: {
    propertyName: "kind",
    mapping: {
      dog: DogDto,
      cat: CatDto,
    },
  },
});

const UndiscriminatedAnimalUnion = UnionType([DogDto, BirdDto]);

class OwnerDto {
  @ApiProperty()
  ownerName!: string;

  @ApiProperty({ type: PetUnion })
  favoritePet!: InstanceType<typeof PetUnion>;

  @ApiPropertyOptional({ type: [PetUnion] })
  allPets?: Array<InstanceType<typeof PetUnion>>;
}

class NamedUserEnvelopeDto extends GenericType(ApiEnvelopeDto, {
  data: UserItemDto,
}) {}

const GenericWithMetaDto = GenericType(
  ApiEnvelopeDto,
  { data: [UserItemDto], meta: PageMetaDto },
  { name: "UsersWithMetaEnvelope", description: "Users list with page meta" },
);

// --- Fixtures for createSchemaDto Mapped Types ---

// Work around pre-existing BaseSchema variance check in packages/validation/src/schema
const objSchema = <T extends object>(
  shape: Record<string, unknown>,
) =>
  s.object(shape as Record<string, any>) as unknown as StandardSchemaV1<T, T>;

interface CreateAccountShape {
  email: string;
  name: string;
  password: string;
  age?: number;
}

const CreateAccountSchema = objSchema<CreateAccountShape>({
  email: s.string().email(),
  name: s.string().min(2),
  password: s.string().min(8),
  age: s.coerce.number().int().min(18).optional(),
});

class CreateAccountDto extends createSchemaDto(CreateAccountSchema) {}

interface AuditShape {
  createdBy: string;
  version: number;
}

const AuditSchema = objSchema<AuditShape>({
  createdBy: s.string().uuid(),
  version: s.number().int().min(1),
});

class AuditSchemaDto extends createSchemaDto(AuditSchema) {}

class ClassicTagDto {
  @ApiProperty({ example: "vip" })
  tag!: string;
}

class UpdateAccountDto extends PartialType(CreateAccountDto) {}
class PublicAccountDto extends OmitType(CreateAccountDto, ["password"] as const) {}
class AccountLoginDto extends PickType(CreateAccountDto, [
  "email",
  "password",
] as const) {}
class AuditedAccountDto extends IntersectionType(
  PublicAccountDto,
  AuditSchemaDto,
) {}
class ComposedAccountDto extends CompositionType(
  AccountLoginDto,
  AuditSchemaDto,
) {}
class PartialPublicAccountDto extends PartialType(PublicAccountDto) {}
class MixedSchemaAndClassicDto extends IntersectionType(
  PublicAccountDto,
  ClassicTagDto,
) {}

// Wrapper created via createSchemaDto for GenericType-over-SchemaDto test
const SchemaEnvelopeBase = objSchema<{ ok: boolean; data: Record<string, unknown> }>({
  ok: s.boolean(),
  data: s.object({}),
});
class SchemaEnvelopeDto extends createSchemaDto(SchemaEnvelopeBase) {}

// Generic raw Standard Schema v1 + Standard JSON Schema v1 (NO .partial()/.pick()/.omit()/.extend())
function createRawStandardSchemaDto() {
  interface RawShape {
    title: string;
    secret: string;
    count?: number;
  }
  const rawSchema: StandardSchemaV1<RawShape, RawShape> & {
    readonly "~standard": {
      readonly version: 1;
      readonly vendor: string;
      readonly validate: (val: unknown) => any;
      readonly jsonSchema: {
        readonly input: () => Record<string, unknown>;
        readonly output: () => Record<string, unknown>;
      };
    };
  } = {
    "~standard": {
      version: 1,
      vendor: "raw-test",
      validate(value: unknown) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return { issues: [{ message: "Expected object" }] };
        }
        const rec = value as Record<string, unknown>;
        const issues: Array<{ message: string; path: string[] }> = [];
        if (typeof rec.title !== "string" || rec.title.length < 2) {
          issues.push({ message: "title min 2", path: ["title"] });
        }
        if (typeof rec.secret !== "string" || rec.secret.length < 4) {
          issues.push({ message: "secret min 4", path: ["secret"] });
        }
        if (rec.count !== undefined && typeof rec.count !== "number") {
          issues.push({ message: "count must be number", path: ["count"] });
        }
        return issues.length > 0 ? { issues } : { value: rec as unknown as RawShape };
      },
      jsonSchema: {
        input: () => ({
          type: "object",
          properties: {
            title: { type: "string", minLength: 2 },
            secret: { type: "string", minLength: 4 },
            count: { type: "number" },
          },
          required: ["title", "secret"],
        }),
        output: () => ({
          type: "object",
          properties: {
            title: { type: "string", minLength: 2 },
            secret: { type: "string", minLength: 4 },
            count: { type: "number" },
          },
          required: ["title", "secret"],
        }),
      },
    },
  };

  class RawSchemaDto {}
  Object.defineProperty(RawSchemaDto, STANDARD_SCHEMA_DTO_KEY, {
    value: rawSchema,
    enumerable: false,
  });
  return RawSchemaDto as new () => {
    title: string;
    secret: string;
    count?: number;
  };
}

describe("@bunest/swagger First-Class Generics, UnionType & createSchemaDto Mapped-Types", () => {
  test("GenericType, UnionType (with discriminator), and ApiGenericResponse generate crisp OpenAPI 3.1 schemas without @ApiExtraModels", async () => {
    const SchemaEnvelopeUser = GenericType(SchemaEnvelopeDto, {
      data: UserItemDto,
    });

    @Controller("/catalog")
    class CatalogController {
      @Get("user")
      @ApiGenericResponse({
        wrapper: ApiEnvelopeDto,
        item: UserItemDto,
        description: "Wrapped single user",
      })
      getWrappedUser() {
        return {};
      }

      @Get("users")
      @ApiGenericResponse({
        wrapper: PaginatedDto,
        item: UserItemDto,
        isArray: true,
        description: "Paginated users list",
      })
      listUsers() {
        return {};
      }

      @Post("custom-slot")
      @ApiGenericResponse({
        wrapper: CustomSlotWrapperDto,
        item: UserItemDto,
        property: "result",
        status: 201,
        name: "CustomUserResult",
      })
      createCustom() {
        return {};
      }

      @Get("named-envelope")
      @ApiOkResponse({ type: NamedUserEnvelopeDto })
      getNamedEnvelope() {
        return {};
      }

      @Get("multi-binding")
      @ApiOkResponse({ type: GenericWithMetaDto })
      getMultiBinding() {
        return {};
      }

      @Get("schema-envelope")
      @ApiOkResponse({ type: SchemaEnvelopeUser })
      getSchemaEnvelope() {
        return {};
      }

      @Get("pet")
      @ApiOkResponse({ type: PetUnion })
      getPet() {
        return {};
      }

      @Get("animal")
      @ApiOkResponse({ type: UndiscriminatedAnimalUnion })
      getAnimal() {
        return {};
      }

      @Get("owner")
      @ApiOkResponse({ type: OwnerDto })
      getOwner() {
        return {};
      }
    }

    @Module({ controllers: [CatalogController] })
    class CatalogModule {}

    const app = await BunestFactory.create(CatalogModule, { logger: false });
    try {
      const doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle("Generics & Unions").build(),
      );
      const schemas = doc.components?.schemas ?? {};

      // 1. @ApiGenericResponse single item (auto-detected `data` property)
      expect(
        doc.paths["/catalog/user"]?.get?.responses["200"]?.content?.[
          "application/json"
        ]?.schema,
      ).toEqual({ $ref: "#/components/schemas/ApiEnvelopeDtoOfUserItemDto" });
      expect(doc.paths["/catalog/user"]?.get?.responses["200"]?.description).toBe(
        "Wrapped single user",
      );
      expect(schemas.ApiEnvelopeDtoOfUserItemDto?.properties?.ok).toMatchObject({
        type: "boolean",
      });
      expect(
        schemas.ApiEnvelopeDtoOfUserItemDto?.properties?.data,
      ).toMatchObject({
        $ref: "#/components/schemas/UserItemDto",
        description: "Envelope payload",
      });
      // Inner DTO auto-registered with zero @ApiExtraModels!
      expect(schemas.UserItemDto?.properties?.email).toMatchObject({
        type: "string",
      });

      // 2. @ApiGenericResponse array item (auto-detected `items` property on PaginatedDto)
      expect(
        doc.paths["/catalog/users"]?.get?.responses["200"]?.content?.[
          "application/json"
        ]?.schema,
      ).toEqual({
        $ref: "#/components/schemas/PaginatedDtoOfUserItemDtoArray",
      });
      expect(
        schemas.PaginatedDtoOfUserItemDtoArray?.properties?.total,
      ).toMatchObject({ type: "number" });
      expect(
        schemas.PaginatedDtoOfUserItemDtoArray?.properties?.items,
      ).toEqual({
        type: "array",
        items: { $ref: "#/components/schemas/UserItemDto" },
      });

      // 3. @ApiGenericResponse explicit `property`, `status`, and `name`
      expect(
        doc.paths["/catalog/custom-slot"]?.post?.responses["201"]?.content?.[
          "application/json"
        ]?.schema,
      ).toEqual({ $ref: "#/components/schemas/CustomUserResult" });
      expect(schemas.CustomUserResult?.properties?.requestId).toMatchObject({
        type: "string",
      });
      expect(schemas.CustomUserResult?.properties?.result).toEqual({
        $ref: "#/components/schemas/UserItemDto",
      });
      expect(schemas.CustomUserResult?.required).toEqual(
        expect.arrayContaining(["requestId", "result"]),
      );

      // 4. Subclassed GenericType keeps subclass name
      expect(
        doc.paths["/catalog/named-envelope"]?.get?.responses["200"]?.content?.[
          "application/json"
        ]?.schema,
      ).toEqual({ $ref: "#/components/schemas/NamedUserEnvelopeDto" });
      expect(schemas.NamedUserEnvelopeDto?.properties?.data).toMatchObject({
        $ref: "#/components/schemas/UserItemDto",
      });

      // 5. Multiple bindings + explicit name/description
      expect(schemas.UsersWithMetaEnvelope?.description).toBe(
        "Users list with page meta",
      );
      expect(schemas.UsersWithMetaEnvelope?.properties?.data).toMatchObject({
        type: "array",
        items: { $ref: "#/components/schemas/UserItemDto" },
      });
      expect(schemas.UsersWithMetaEnvelope?.properties?.meta).toEqual({
        $ref: "#/components/schemas/PageMetaDto",
      });
      expect(schemas.PageMetaDto?.properties?.perPage).toBeDefined();

      // 6. GenericType wrapping a createSchemaDto wrapper
      expect(
        schemas.SchemaEnvelopeDtoOfUserItemDto?.properties?.ok,
      ).toMatchObject({ type: "boolean" });
      expect(
        schemas.SchemaEnvelopeDtoOfUserItemDto?.properties?.data,
      ).toEqual({ $ref: "#/components/schemas/UserItemDto" });

      // 7. Discriminated UnionType (`oneOf` + `discriminator.mapping`, honoring @ApiSchema name)
      expect(
        doc.paths["/catalog/pet"]?.get?.responses["200"]?.content?.[
          "application/json"
        ]?.schema,
      ).toEqual({ $ref: "#/components/schemas/Pet" });
      expect(schemas.Pet).toEqual({
        description: "A domesticated pet",
        oneOf: [
          { $ref: "#/components/schemas/CanineModel" },
          { $ref: "#/components/schemas/CatDto" },
        ],
        discriminator: {
          propertyName: "kind",
          mapping: {
            dog: "#/components/schemas/CanineModel",
            cat: "#/components/schemas/CatDto",
          },
        },
      });
      expect(schemas.CanineModel?.properties?.barkVolume).toMatchObject({
        type: "number",
      });
      expect(schemas.CatDto?.properties?.livesLeft).toMatchObject({
        type: "number",
      });

      // 8. Undiscriminated UnionType auto-names and registers variants
      expect(schemas.CanineModelOrBirdDto).toEqual({
        oneOf: [
          { $ref: "#/components/schemas/CanineModel" },
          { $ref: "#/components/schemas/BirdDto" },
        ],
      });
      expect(schemas.BirdDto?.properties?.wingspanCm).toMatchObject({
        type: "number",
      });

      // 9. UnionType referenced inside DTO properties (single & array)
      expect(schemas.OwnerDto?.properties?.favoritePet).toEqual({
        $ref: "#/components/schemas/Pet",
      });
      expect(schemas.OwnerDto?.properties?.allPets).toEqual({
        type: "array",
        items: { $ref: "#/components/schemas/Pet" },
      });
    } finally {
      await app.close();
    }
  });

  test("PartialType, PickType, OmitType, IntersectionType, CompositionType bridge createSchemaDto for OpenAPI AND runtime validation", async () => {
    @Controller("/accounts")
    class AccountsController {
      @Post()
      create(@Body() dto: CreateAccountDto) {
        return dto;
      }

      @Post("partial")
      updatePartial(@Body() dto: UpdateAccountDto) {
        return dto;
      }

      @Post("public")
      publicView(@Body() dto: PublicAccountDto) {
        return dto;
      }

      @Post("login")
      login(@Body() dto: AccountLoginDto) {
        return dto;
      }

      @Post("audited")
      audited(@Body() dto: AuditedAccountDto) {
        return dto;
      }

      @Post("composed")
      composed(@Body() dto: ComposedAccountDto) {
        return dto;
      }

      @Post("partial-public")
      partialPublic(@Body() dto: PartialPublicAccountDto) {
        return dto;
      }

      @Post("mixed")
      mixed(@Body() dto: MixedSchemaAndClassicDto) {
        return dto;
      }
    }

    @Module({ controllers: [AccountsController] })
    class AccountsModule {}

    const app = await BunestFactory.create(AccountsModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe());
    await app.init();

    try {
      const doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle("Schema DTO Mapped Types").build(),
      );
      const schemas = doc.components?.schemas ?? {};

      // PartialType(CreateAccountDto): all properties optional, no `required`
      expect(Object.keys(schemas.UpdateAccountDto?.properties ?? {}).sort()).toEqual([
        "age",
        "email",
        "name",
        "password",
      ]);
      expect(schemas.UpdateAccountDto?.required).toBeUndefined();
      expect(schemas.UpdateAccountDto?.properties?.email).toMatchObject({
        type: "string",
        format: "email",
      });

      // OmitType(CreateAccountDto, ["password"]): password removed, email+name required
      expect(Object.keys(schemas.PublicAccountDto?.properties ?? {}).sort()).toEqual([
        "age",
        "email",
        "name",
      ]);
      expect(schemas.PublicAccountDto?.properties?.password).toBeUndefined();
      expect(schemas.PublicAccountDto?.required).toEqual(
        expect.arrayContaining(["email", "name"]),
      );
      expect(schemas.PublicAccountDto?.required).not.toContain("password");

      // PickType(CreateAccountDto, ["email", "password"]): only email & password
      expect(Object.keys(schemas.AccountLoginDto?.properties ?? {}).sort()).toEqual([
        "email",
        "password",
      ]);
      expect(schemas.AccountLoginDto?.required).toEqual(
        expect.arrayContaining(["email", "password"]),
      );

      // IntersectionType(PublicAccountDto, AuditSchemaDto): combined properties & required
      expect(
        Object.keys(schemas.AuditedAccountDto?.properties ?? {}).sort(),
      ).toEqual(["age", "createdBy", "email", "name", "version"]);
      expect(schemas.AuditedAccountDto?.required).toEqual(
        expect.arrayContaining(["email", "name", "createdBy", "version"]),
      );

      // CompositionType(AccountLoginDto, AuditSchemaDto)
      expect(
        Object.keys(schemas.ComposedAccountDto?.properties ?? {}).sort(),
      ).toEqual(["createdBy", "email", "password", "version"]);

      // Chained PartialType(OmitType(CreateAccountDto, ["password"]))
      expect(
        Object.keys(schemas.PartialPublicAccountDto?.properties ?? {}).sort(),
      ).toEqual(["age", "email", "name"]);
      expect(schemas.PartialPublicAccountDto?.required).toBeUndefined();

      // Mixed IntersectionType(createSchemaDto, classic @ApiProperty DTO)
      expect(
        Object.keys(schemas.MixedSchemaAndClassicDto?.properties ?? {}).sort(),
      ).toEqual(["age", "email", "name", "tag"]);
      expect(schemas.MixedSchemaAndClassicDto?.required).toEqual(
        expect.arrayContaining(["email", "name", "tag"]),
      );

      // Runtime ValidationPipe verification over HTTP!
      // 1. Partial accepts subset `{ email }` and rejects invalid email
      const okPartial = await app.inject({
        method: "POST",
        url: "/accounts/partial",
        payload: { email: "ada@bunest.dev" },
      });
      expect(okPartial.statusCode).toBe(201);
      expect(okPartial.json()).toEqual({ email: "ada@bunest.dev" });

      const badPartial = await app.inject({
        method: "POST",
        url: "/accounts/partial",
        payload: { email: "not-an-email" },
      });
      expect(badPartial.statusCode).toBe(400);

      // 2. OmitType accepts payload without `password` and strips unknown `password`
      const okOmit = await app.inject({
        method: "POST",
        url: "/accounts/public",
        payload: { email: "ada@bunest.dev", name: "Ada", password: "ignored" },
      });
      expect(okOmit.statusCode).toBe(201);
      expect(okOmit.json()).toEqual({ email: "ada@bunest.dev", name: "Ada" });

      // 3. PickType requires email & password only
      const okPick = await app.inject({
        method: "POST",
        url: "/accounts/login",
        payload: { email: "ada@bunest.dev", password: "super-secret-password" },
      });
      expect(okPick.statusCode).toBe(201);

      const badPick = await app.inject({
        method: "POST",
        url: "/accounts/login",
        payload: { email: "ada@bunest.dev", password: "short" },
      });
      expect(badPick.statusCode).toBe(400);

      // 4. IntersectionType validates fields from BOTH schemas
      const okIntersect = await app.inject({
        method: "POST",
        url: "/accounts/audited",
        payload: {
          email: "ada@bunest.dev",
          name: "Ada",
          createdBy: "550e8400-e29b-41d4-a716-446655440000",
          version: 2,
        },
      });
      expect(okIntersect.statusCode).toBe(201);

      const badIntersect = await app.inject({
        method: "POST",
        url: "/accounts/audited",
        payload: {
          email: "ada@bunest.dev",
          name: "Ada",
          createdBy: "not-a-uuid",
          version: 0,
        },
      });
      expect(badIntersect.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  test("mapped-types fallback works on generic Standard Schema DTOs without .partial()/.pick()/.omit()/.extend()", async () => {
    const RawDto = createRawStandardSchemaDto();

    class RawPartial extends PartialType(RawDto) {}
    class RawPicked extends PickType(RawDto, ["title"] as const) {}
    class RawOmitted extends OmitType(RawDto, ["secret"] as const) {}
    class RawIntersected extends IntersectionType(RawPicked, AuditSchemaDto) {}

    // OpenAPI generation via standalone generateSchema
    const partialGen = generateSchema(RawPartial);
    expect(partialGen.schema.required).toBeUndefined();
    expect(Object.keys(partialGen.schema.properties ?? {}).sort()).toEqual([
      "count",
      "secret",
      "title",
    ]);

    const pickedGen = generateSchema(RawPicked);
    expect(Object.keys(pickedGen.schema.properties ?? {})).toEqual(["title"]);
    expect(pickedGen.schema.required).toEqual(["title"]);

    const omittedGen = generateSchema(RawOmitted);
    expect(Object.keys(omittedGen.schema.properties ?? {}).sort()).toEqual([
      "count",
      "title",
    ]);
    expect(omittedGen.schema.required).toEqual(["title"]);

    const intersectedGen = generateSchema(RawIntersected);
    expect(
      Object.keys(intersectedGen.schema.properties ?? {}).sort(),
    ).toEqual(["createdBy", "title", "version"]);
    expect(intersectedGen.schema.required).toEqual(
      expect.arrayContaining(["title", "createdBy", "version"]),
    );

    // Runtime Standard Schema validation via Symbol.for("bunest:standard-schema-dto")
    const partialSchema = (RawPartial as unknown as Record<symbol, StandardSchemaV1>)[
      STANDARD_SCHEMA_DTO_KEY
    ]!;
    expect((await partialSchema["~standard"].validate({ title: "Hi" })).issues).toBeUndefined();
    expect((await partialSchema["~standard"].validate({ title: "x" })).issues?.length).toBeGreaterThan(0);

    const pickedSchema = (RawPicked as unknown as Record<symbol, StandardSchemaV1>)[
      STANDARD_SCHEMA_DTO_KEY
    ]!;
    expect(await pickedSchema["~standard"].validate({ title: "Hello", secret: "ignored" })).toEqual({
      value: { title: "Hello" },
    });
    expect((await pickedSchema["~standard"].validate({ title: "a" })).issues?.length).toBeGreaterThan(0);

    const omittedSchema = (RawOmitted as unknown as Record<symbol, StandardSchemaV1>)[
      STANDARD_SCHEMA_DTO_KEY
    ]!;
    expect(await omittedSchema["~standard"].validate({ title: "Hello", count: 3 })).toEqual({
      value: { title: "Hello", count: 3 },
    });

    const intersectedSchema = (RawIntersected as unknown as Record<symbol, StandardSchemaV1>)[
      STANDARD_SCHEMA_DTO_KEY
    ]!;
    const okMerged = await intersectedSchema["~standard"].validate({
      title: "Hello",
      createdBy: "550e8400-e29b-41d4-a716-446655440000",
      version: 1,
    });
    expect(okMerged.issues).toBeUndefined();
    const badMerged = await intersectedSchema["~standard"].validate({
      title: "a",
      createdBy: "bad",
      version: 0,
    });
    expect(badMerged.issues?.length).toBeGreaterThan(0);
  });
});
