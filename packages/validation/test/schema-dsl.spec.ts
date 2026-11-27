import { describe, expect, it } from "bun:test";
import {
  BadRequestException,
  Body,
  BunestFactory,
  Controller,
  HttpException,
  Module,
  Post,
  UsePipes,
  type ValidationErrorResponse,
} from "@bunest/core";
import {
  STANDARD_SCHEMA_DTO_KEY,
  SchemaValidationError,
  ValidationPipe,
  createSchemaDto,
  s,
  type InferInput,
  type InferOutput,
} from "../src";
import {
  s as sSubpath,
  createSchemaDto as createSchemaDtoSubpath,
  STANDARD_SCHEMA_DTO_KEY as SUBPATH_DTO_KEY,
} from "../src/schema";

describe("@bunest/validation/schema DSL & createSchemaDto", () => {
  it("exports identical symbols from root and ./schema subpath", () => {
    expect(s).toBe(sSubpath);
    expect(createSchemaDto).toBe(createSchemaDtoSubpath);
    expect<symbol>(STANDARD_SCHEMA_DTO_KEY).toBe(
      Symbol.for("bunest:standard-schema-dto"),
    );
    expect<symbol>(SUBPATH_DTO_KEY).toBe(STANDARD_SCHEMA_DTO_KEY);
  });

  it("validates and transforms string constraints and coercion", () => {
    const schema = s
      .string()
      .trim()
      .min(3)
      .max(10)
      .regex(/^[a-z0-9_]+$/);

    expect(schema.parse("  ada_01  ")).toBe("ada_01");
    expect(schema.safeParse("ab").success).toBe(false);
    expect(schema.safeParse("too_long_string").success).toBe(false);
    expect(schema.safeParse("BAD!").success).toBe(false);

    expect(s.string().length(4).parse("abcd")).toBe("abcd");
    expect(s.string().length(4).safeParse("abc").success).toBe(false);
    expect(s.string().nonempty().safeParse("").success).toBe(false);

    expect(s.string().email().parse("ada@bunest.dev")).toBe("ada@bunest.dev");
    expect(s.string().email().safeParse("not-email").success).toBe(false);

    expect(s.string().url().parse("https://bunest.dev/docs")).toBe(
      "https://bunest.dev/docs",
    );
    expect(s.string().url().safeParse("not a url").success).toBe(false);

    expect(
      s.string().uuid().parse("550e8400-e29b-41d4-a716-446655440000"),
    ).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(s.string().uuid().safeParse("invalid-uuid").success).toBe(false);

    expect(s.coerce.string().parse(42)).toBe("42");
    expect(s.coerce.string().parse(true)).toBe("true");
    expect(s.coerce.string().safeParse(null).success).toBe(false);
  });

  it("validates number, int, boolean, date, literal, enum, and coercions", () => {
    expect(s.number().min(1).max(10).multipleOf(0.5).parse(2.5)).toBe(2.5);
    expect(s.number().multipleOf(0.5).safeParse(2.3).success).toBe(false);
    expect(s.number().positive().parse(0.1)).toBe(0.1);
    expect(s.number().positive().safeParse(0).success).toBe(false);
    expect(s.number().negative().parse(-1)).toBe(-1);
    expect(s.number().negative().safeParse(0).success).toBe(false);
    expect(s.number().finite().safeParse(Infinity).success).toBe(false);
    expect(s.int().parse(7)).toBe(7);
    expect(s.int().safeParse(7.5).success).toBe(false);
    expect(s.coerce.number().int().min(18).parse("25")).toBe(25);
    expect(s.coerce.number().safeParse("   ").success).toBe(false);

    expect(s.boolean().parse(false)).toBe(false);
    expect(s.boolean().safeParse("false").success).toBe(false);
    expect(s.coerce.boolean().parse("true")).toBe(true);
    expect(s.coerce.boolean().parse("false")).toBe(false);
    expect(s.coerce.boolean().parse(1)).toBe(true);
    expect(s.coerce.boolean().parse(0)).toBe(false);

    const minDate = new Date("2025-01-01T00:00:00.000Z");
    const maxDate = new Date("2027-01-01T00:00:00.000Z");
    const dateSchema = s.coerce.date().min(minDate).max(maxDate);
    const parsedDate = dateSchema.parse("2026-06-01T12:00:00.000Z");
    expect(parsedDate).toBeInstanceOf(Date);
    expect(dateSchema.safeParse("2024-01-01T00:00:00.000Z").success).toBe(false);

    expect(s.literal("v1").parse("v1")).toBe("v1");
    expect(s.literal("v1").safeParse("v2").success).toBe(false);

    enum Role {
      Admin = "admin",
      User = "user",
    }
    const roleTuple = s.enum(["admin", "user"]);
    const roleEnum = s.enum(Role);
    expect(roleTuple.parse("admin")).toBe("admin");
    expect(roleEnum.parse(Role.User)).toBe(Role.User);
    expect(roleEnum.safeParse("guest").success).toBe(false);
  });

  it("validates arrays, tuples, records, objects (partial/pick/omit/extend/passthrough/strict), unions, and discriminatedUnions", () => {
    const tagsSchema = s.array(s.string().trim().min(2)).min(1).max(3).nonempty();
    expect(tagsSchema.parse(["  ts ", "bun"])).toEqual(["ts", "bun"]);
    expect(tagsSchema.safeParse([]).success).toBe(false);
    expect(tagsSchema.safeParse(["a"]).success).toBe(false);

    const tupleSchema = s.tuple([s.string(), s.int()]).rest(s.boolean());
    expect(tupleSchema.parse(["ok", 1, true, false])).toEqual([
      "ok",
      1,
      true,
      false,
    ]);
    expect(tupleSchema.safeParse(["ok"]).success).toBe(false);

    const recSchema = s.record(s.string().min(2), s.int().positive());
    expect(recSchema.parse({ ab: 1, cd: 2 })).toEqual({ ab: 1, cd: 2 });
    expect(recSchema.safeParse({ a: 1 }).success).toBe(false);

    const baseObj = s.object({
      id: s.string().uuid(),
      email: s.string().email(),
      age: s.coerce.number().int().min(18),
      role: s.enum(["admin", "member"]).default("member"),
      bio: s.string().nullable().optional(),
    });

    const parsed = baseObj.parse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      email: "ada@bunest.dev",
      age: "28",
      extra: "stripped-by-default",
    });
    expect(parsed).toEqual({
      id: "550e8400-e29b-41d4-a716-446655440000",
      email: "ada@bunest.dev",
      age: 28,
      role: "member",
    });

    expect(baseObj.passthrough().parse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      email: "ada@bunest.dev",
      age: 28,
      extra: "kept",
    })).toMatchObject({ extra: "kept" });

    expect(
      baseObj.strict().safeParse({
        id: "550e8400-e29b-41d4-a716-446655440000",
        email: "ada@bunest.dev",
        age: 28,
        extra: "forbidden",
      }).success,
    ).toBe(false);

    const partialObj = baseObj.partial();
    expect(partialObj.parse({})).toEqual({});

    const pickedObj = baseObj.pick(["email", "age"]);
    expect(pickedObj.parse({ email: "a@b.co", age: "20" })).toEqual({
      email: "a@b.co",
      age: 20,
    });

    const omittedObj = baseObj.omit(["id", "role"]);
    expect(omittedObj.parse({ email: "a@b.co", age: 20 })).toEqual({
      email: "a@b.co",
      age: 20,
    });

    const extendedObj = pickedObj.extend({ active: s.boolean() });
    expect(
      extendedObj.parse({ email: "a@b.co", age: 20, active: true }),
    ).toEqual({
      email: "a@b.co",
      age: 20,
      active: true,
    });

    const unionSchema = s.union([s.string(), s.int()]);
    expect(unionSchema.parse("hi")).toBe("hi");
    expect(unionSchema.parse(42)).toBe(42);
    expect(unionSchema.safeParse(false).success).toBe(false);

    const eventSchema = s.discriminatedUnion("type", [
      s.object({ type: s.literal("created"), id: s.string() }),
      s.object({ type: s.literal("deleted"), reason: s.string() }),
    ]);
    expect(eventSchema.parse({ type: "created", id: "1" })).toEqual({
      type: "created",
      id: "1",
    });
    const badEvent = eventSchema.safeParse({ type: "unknown" });
    expect(badEvent.success).toBe(false);
    if (!badEvent.success) {
      expect(badEvent.issues[0]?.path).toEqual(["type"]);
    }
  });

  it("supports .refine(), .transform(), async schemas, and InferInput/InferOutput", async () => {
    const PasswordSchema = s
      .object({
        password: s.string().min(8),
        confirm: s.string(),
      })
      .refine((v) => v.password === v.confirm, {
        message: "Passwords must match",
        path: ["confirm"],
      })
      .transform((v) => ({ hash: `hashed:${v.password}` }));

    type In = InferInput<typeof PasswordSchema>;
    type Out = InferOutput<typeof PasswordSchema>;
    const sampleIn: In = { password: "secret123", confirm: "secret123" };
    const sampleOut: Out = PasswordSchema.parse(sampleIn);
    expect(sampleOut).toEqual({ hash: "hashed:secret123" });

    expect(() =>
      PasswordSchema.parse({ password: "secret123", confirm: "mismatch" }),
    ).toThrow(SchemaValidationError);

    const asyncSchema = s
      .string()
      .refine(async (val) => {
        await Bun.sleep(1);
        return val !== "taken";
      }, "Already taken")
      .transform(async (val) => val.toUpperCase());

    expect(await asyncSchema.parseAsync("ada")).toBe("ADA");
    const asyncFail = await asyncSchema.safeParseAsync("taken");
    expect(asyncFail.success).toBe(false);
  });

  it("implements StandardSchemaV1 and StandardJSONSchemaV1 (draft-2020-12 & openapi-3.0)", () => {
    const UserSchema = s
      .object({
        id: s.string().uuid().describe("Unique user ID"),
        age: s.int().positive().max(130).meta({ example: 30 }),
        status: s.enum(["active", "disabled"]).default("active"),
        nickname: s.string().nullable().optional(),
        coords: s.tuple([s.number(), s.number()]),
        kind: s.literal("user"),
      })
      .describe("User payload");

    // ~standard.validate
    const valid = UserSchema["~standard"].validate({
      id: "550e8400-e29b-41d4-a716-446655440000",
      age: 30,
      coords: [10, 20],
      kind: "user",
    });
    expect("issues" in valid ? valid.issues : undefined).toBeUndefined();

    // draft-2020-12 JSON Schema
    const js2020 = UserSchema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });
    expect(js2020.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(js2020.description).toBe("User payload");
    expect(js2020.required).toEqual(["id", "age", "coords", "kind"]);
    const props2020 = js2020.properties as Record<string, any>;
    expect(props2020.id).toMatchObject({
      type: "string",
      format: "uuid",
      description: "Unique user ID",
    });
    expect(props2020.age).toMatchObject({
      type: "integer",
      exclusiveMinimum: 0,
      maximum: 130,
      examples: [30],
    });
    expect(props2020.nickname).toEqual({ type: ["string", "null"] });
    expect(props2020.coords).toMatchObject({
      type: "array",
      prefixItems: [{ type: "number" }, { type: "number" }],
      items: false,
    });
    expect(props2020.kind).toEqual({ const: "user" });

    // draft-2020-12 output schema marks `.default(...)` field as required!
    const js2020Out = UserSchema["~standard"].jsonSchema.output({
      target: "draft-2020-12",
    });
    expect(js2020Out.required).toEqual(["id", "age", "status", "coords", "kind"]);

    // openapi-3.0 JSON Schema
    const oas30 = UserSchema["~standard"].jsonSchema.input({
      target: "openapi-3.0",
    });
    const props30 = oas30.properties as Record<string, any>;
    expect(props30.age).toMatchObject({
      type: "integer",
      minimum: 0,
      exclusiveMinimum: true,
      maximum: 130,
      example: 30,
    });
    expect(props30.nickname).toEqual({ type: "string", nullable: true });
    expect(props30.kind).toEqual({ type: "string", enum: ["user"] });
  });

  it("bridges createSchemaDto(schema) into ValidationPipe and Nest/Bunest HTTP controllers", async () => {
    const CreateAccountSchema = s.object({
      email: s.string().trim().email(),
      age: s.coerce.number().int().min(18),
      role: s.enum(["member", "admin"]).default("member"),
      profile: s.object({
        displayName: s.string().min(2),
      }),
    });

    class CreateAccountDto extends createSchemaDto(CreateAccountSchema) {
      greeting(): string {
        return `Welcome ${this.profile.displayName} (${this.role})`;
      }
    }

    expect(
      (CreateAccountDto as unknown as Record<PropertyKey, unknown>)[
        STANDARD_SCHEMA_DTO_KEY
      ],
    ).toBe(CreateAccountSchema);
    expect(
      Reflect.getMetadata("bunest:standard-schema-dto", CreateAccountDto),
    ).toBe(CreateAccountSchema);

    const pipe = new ValidationPipe();

    const valid = (await pipe.transform(
      {
        email: "  ada@bunest.dev  ",
        age: "29",
        profile: { displayName: "Ada" },
        extraUnknownField: "stripped",
      },
      { type: "body", metatype: CreateAccountDto },
    )) as CreateAccountDto;

    expect(valid).toBeInstanceOf(CreateAccountDto);
    expect(valid.email).toBe("ada@bunest.dev");
    expect(valid.age).toBe(29);
    expect(valid.role).toBe("member");
    expect((valid as unknown as Record<string, unknown>).extraUnknownField).toBeUndefined();
    expect(valid.greeting()).toBe("Welcome Ada (member)");

    // Invalid input produces ADR-009 nested field paths
    try {
      await pipe.transform(
        {
          email: "not-an-email",
          age: 12,
          profile: { displayName: "A" },
        },
        { type: "body", metatype: CreateAccountDto },
      );
      throw new Error("Expected validation failure");
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const body = (err as HttpException).getResponse() as unknown as ValidationErrorResponse;
      expect(body.details.map((d) => d.field)).toEqual([
        "email",
        "age",
        "profile.displayName",
      ]);
    }

    // Also works with errorFormat: "grouped"
    const groupedPipe = new ValidationPipe({ errorFormat: "grouped" });
    try {
      await groupedPipe.transform(
        { email: "bad", age: 10, profile: { displayName: "X" } },
        { type: "body", metatype: CreateAccountDto },
      );
      throw new Error("Expected grouped validation failure");
    } catch (err) {
      const resp = (err as HttpException).getResponse() as {
        message: Record<string, string[]>;
      };
      expect(resp.message.email).toBeDefined();
      expect(resp.message.age).toBeDefined();
      expect(resp.message["profile.displayName"]).toBeDefined();
    }

    // Prototype pollution blocked
    const poisoned = JSON.parse(
      '{"email":"ada@bunest.dev","age":25,"profile":{"displayName":"Ada"},"__proto__":{"admin":true}}',
    );
    await expect(
      pipe.transform(poisoned, { type: "body", metatype: CreateAccountDto }),
    ).rejects.toThrow(BadRequestException);

    // End-to-end HTTP controller test using @Body() dto: CreateAccountDto
    @Controller("/accounts")
    @UsePipes(new ValidationPipe())
    class AccountsController {
      @Post()
      create(@Body() dto: CreateAccountDto) {
        return {
          ok: true,
          isDto: dto instanceof CreateAccountDto,
          greeting: dto.greeting(),
          dto,
        };
      }
    }

    @Module({ controllers: [AccountsController] })
    class AccountsModule {}

    const app = await BunestFactory.create(AccountsModule, { logger: false });
    try {
      const okRes = await app.fetch(
        new Request("http://localhost/accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "  grace@bunest.dev ",
            age: "35",
            profile: { displayName: "Grace" },
          }),
        }),
      );
      expect(okRes.status).toBe(201);
      expect(await okRes.json()).toEqual({
        ok: true,
        isDto: true,
        greeting: "Welcome Grace (member)",
        dto: {
          email: "grace@bunest.dev",
          age: 35,
          role: "member",
          profile: { displayName: "Grace" },
        },
      });

      const badRes = await app.fetch(
        new Request("http://localhost/accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "bad",
            age: 15,
            profile: { displayName: "G" },
          }),
        }),
      );
      expect(badRes.status).toBe(400);
    } finally {
      await app.close();
    }
  });
});
