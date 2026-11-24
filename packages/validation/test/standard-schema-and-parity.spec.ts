import { describe, expect, it } from "bun:test";
import {
  BODY_SANITIZED_SYMBOL,
  HttpException,
  HttpStatus,
  IntersectionType,
  OmitType,
  PartialType,
  PickType,
  StreamableFile,
  type CallHandler,
  type ExecutionContext,
  type StandardSchemaV1,
  type ValidationErrorResponse,
} from "@bunest/core";
import {
  IsEmail,
  IsInt,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from "../src/validator";
import { Transform, Type as TransformType } from "../src/transformer";
import {
  SchemaValidationPipe,
  StandardSchemaSerializerInterceptor,
  StandardSchemaValidationPipe,
  UseStandardSchema,
  ValidationPipe,
} from "../src";

function makeExecutionContext(
  controllerClass: Function,
  handler: Function,
): ExecutionContext {
  return {
    getClass: () => controllerClass as any,
    getHandler: () => handler,
    getArgs: () => [] as any,
    getArgByIndex: () => undefined as any,
    getType: () => "http" as any,
    switchToHttp: () => ({
      getRequest: () => new Request("http://localhost/test") as any,
      getResponse: () => ({}) as any,
      getNext: () => (() => undefined) as any,
    }),
    switchToRpc: () => ({
      getData: () => undefined as any,
      getContext: () => undefined as any,
    }),
    switchToWs: () => ({
      getData: () => undefined as any,
      getClient: () => undefined as any,
      getPattern: () => "",
    }),
  };
}

function makeCallHandler<T>(value: T): CallHandler<T> {
  return {
    async handle() {
      return value;
    },
  };
}

describe("ValidationPipe Hot Path (BODY_SANITIZED_SYMBOL & Pre-normalized Options)", () => {
  class UserInputDto {
    @IsString()
    @MinLength(2)
    name!: string;

    @IsEmail()
    email!: string;
  }

  it("skips redundant findDangerousKeys walk when BODY_SANITIZED_SYMBOL is stamped, while strictly rejecting unsanitized prototype-pollution keys", async () => {
    const pipe = new ValidationPipe();

    // 1. Direct unsanitized object with __proto__ own property MUST be rejected
    const poisoned = JSON.parse(
      '{"name":"Alice","email":"alice@example.com","__proto__":{"isAdmin":true}}',
    );
    try {
      await pipe.transform(poisoned, { type: "body", metatype: UserInputDto });
      throw new Error("expected prototype pollution rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const json = (
        err as HttpException
      ).toJSON() as unknown as ValidationErrorResponse;
      expect(json.statusCode).toBe(400);
      expect(json.details.some((d) => d.field.includes("__proto__"))).toBe(
        true,
      );
    }

    // 2. HTTP-sanitized object carrying unforgeable BODY_SANITIZED_SYMBOL takes fast path
    // Prove findDangerousKeys is skipped by placing a trap getter on a non-enumerable or extra deep branch?
    // Better: define a sanitized payload with BODY_SANITIZED_SYMBOL and verify exact DTO transformation.
    let nestedReads = 0;
    const sanitized: Record<PropertyKey, unknown> = {
      name: "Alice",
      email: "alice@example.com",
    };
    Object.defineProperty(sanitized, BODY_SANITIZED_SYMBOL, {
      value: true,
      enumerable: false,
    });
    // Track how many times `name` is accessed (with findDangerousKeys it would be read once more during deep scan)
    const rawName = "Alice";
    Object.defineProperty(sanitized, "name", {
      enumerable: true,
      configurable: true,
      get() {
        nestedReads++;
        return rawName;
      },
    });

    const sanitizedResult = await pipe.transform(sanitized, {
      type: "body",
      metatype: UserInputDto,
    });
    const readsWithSymbol = nestedReads;

    // Compare against identical object WITHOUT BODY_SANITIZED_SYMBOL
    nestedReads = 0;
    const unsanitized: Record<string, unknown> = {
      email: "alice@example.com",
    };
    Object.defineProperty(unsanitized, "name", {
      enumerable: true,
      configurable: true,
      get() {
        nestedReads++;
        return rawName;
      },
    });
    await pipe.transform(unsanitized, { type: "body", metatype: UserInputDto });
    const readsWithoutSymbol = nestedReads;

    expect(sanitizedResult).toBeInstanceOf(UserInputDto);
    expect(readsWithSymbol).toBeLessThan(readsWithoutSymbol);
  });

  it("skips DTO validation for @RawBody() Buffer metatype (Regression #118)", async () => {
    const pipe = new ValidationPipe();
    const raw = Buffer.from('{"event":"invoice.paid"}', "utf8");
    const result = await pipe.transform(raw, {
      type: "body",
      metatype: Buffer,
    });
    expect(result).toBe(raw);
  });
});

describe("Mapped DTO Types E2E with ValidationPipe (class-validator + class-transformer)", () => {
  class CreateAccountDto {
    @IsString()
    @MinLength(2)
    username!: string;

    @IsEmail()
    email!: string;

    @IsInt()
    @Min(18)
    age!: number;

    @IsString()
    @MinLength(8)
    password!: string;
  }

  class TraceMetaDto {
    @IsString()
    @MinLength(4)
    requestId!: string;
  }

  const pipe = new ValidationPipe();

  it("validates PartialType DTOs allowing partial updates while rejecting invalid/unknown fields", async () => {
    class UpdateAccountDto extends PartialType(CreateAccountDto) {}

    const empty = await pipe.transform(
      {},
      { type: "body", metatype: UpdateAccountDto },
    );
    expect(empty).toBeInstanceOf(UpdateAccountDto);

    const partial = (await pipe.transform(
      { email: "ada@example.com", age: 29 },
      { type: "body", metatype: UpdateAccountDto },
    )) as UpdateAccountDto;
    expect(partial).toBeInstanceOf(UpdateAccountDto);
    expect(partial.email).toBe("ada@example.com");
    expect(partial.age).toBe(29);

    await expect(
      pipe.transform(
        { email: "invalid-email" },
        { type: "body", metatype: UpdateAccountDto },
      ),
    ).rejects.toThrow(HttpException);

    await expect(
      pipe.transform(
        { unknownField: "nope" },
        { type: "body", metatype: UpdateAccountDto },
      ),
    ).rejects.toThrow(HttpException);
  });

  it("validates PickType, OmitType, and IntersectionType DTOs with strict whitelist enforcement", async () => {
    class ContactOnlyDto extends PickType(CreateAccountDto, ["email", "age"]) {}
    class SafeAccountDto extends OmitType(CreateAccountDto, ["password"]) {}
    class TrackedContactDto extends IntersectionType(
      ContactOnlyDto,
      TraceMetaDto,
    ) {}

    // PickType accepts picked fields, rejects unpicked password
    const picked = (await pipe.transform(
      { email: "pick@example.com", age: 24 },
      { type: "body", metatype: ContactOnlyDto },
    )) as ContactOnlyDto;
    expect(picked).toBeInstanceOf(ContactOnlyDto);
    expect(picked.email).toBe("pick@example.com");

    await expect(
      pipe.transform(
        { email: "pick@example.com", age: 24, password: "secretpassword" },
        { type: "body", metatype: ContactOnlyDto },
      ),
    ).rejects.toThrow(HttpException);

    // OmitType accepts remaining fields, rejects omitted password
    const omitted = (await pipe.transform(
      { username: "grace", email: "grace@example.com", age: 30 },
      { type: "body", metatype: SafeAccountDto },
    )) as SafeAccountDto;
    expect(omitted).toBeInstanceOf(SafeAccountDto);
    expect(omitted.username).toBe("grace");

    await expect(
      pipe.transform(
        {
          username: "grace",
          email: "grace@example.com",
          age: 30,
          password: "secretpassword",
        },
        { type: "body", metatype: SafeAccountDto },
      ),
    ).rejects.toThrow(HttpException);

    // IntersectionType requires fields from both source classes
    const merged = (await pipe.transform(
      { email: "ops@example.com", age: 31, requestId: "req-9999" },
      { type: "body", metatype: TrackedContactDto },
    )) as TrackedContactDto;
    expect(merged).toBeInstanceOf(TrackedContactDto);
    expect(merged.requestId).toBe("req-9999");

    await expect(
      pipe.transform(
        { email: "ops@example.com", age: 31 },
        { type: "body", metatype: TrackedContactDto },
      ),
    ).rejects.toThrow(HttpException);
  });

  it("preserves @Type() nested DTO transformation and executes @Transform() EXACTLY ONCE through PartialType with ValidationPipe (Regression #118)", async () => {
    let handleTransformRuns = 0;
    let cityTransformRuns = 0;

    class NestedAddressDto {
      @IsString()
      @Transform(({ value }) => {
        cityTransformRuns++;
        return typeof value === "string" ? value.trim() : value;
      })
      city!: string;
    }

    class ProfileDto {
      @IsString()
      @Transform(({ value }) => {
        handleTransformRuns++;
        return typeof value === "string"
          ? `${value.trim().toLowerCase()}!`
          : value;
      })
      handle!: string;

      @ValidateNested()
      @TransformType(() => NestedAddressDto)
      address!: NestedAddressDto;
    }

    class UpdateProfileDto extends PartialType(ProfileDto) {}

    const result = (await pipe.transform(
      { handle: "  Ada  ", address: { city: "  London  " } },
      { type: "body", metatype: UpdateProfileDto },
    )) as UpdateProfileDto;

    expect(result).toBeInstanceOf(UpdateProfileDto);
    expect(result.handle).toBe("ada!");
    expect(handleTransformRuns).toBe(1);
    expect(result.address).toBeInstanceOf(NestedAddressDto);
    expect(result.address?.city).toBe("London");
    expect(cityTransformRuns).toBe(1);
  });
});

describe("StandardSchemaValidationPipe & SchemaValidationPipe Standard Schema v1 Integration", () => {
  interface OrderPayload {
    address: { zipCode: string };
    items: Array<{ quantity: number }>;
  }

  const orderStandardSchema: StandardSchemaV1<unknown, OrderPayload> = {
    "~standard": {
      version: 1,
      vendor: "test-std-schema",
      async validate(input) {
        await Promise.resolve();
        if (typeof input !== "object" || input === null) {
          return { issues: [{ message: "Expected object" }] };
        }
        const obj = input as Record<string, any>;
        const issues: Array<{
          message: string;
          path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
        }> = [];

        if (
          !obj.address ||
          typeof obj.address.zipCode !== "string" ||
          obj.address.zipCode.length !== 5
        ) {
          issues.push({
            message: "zipCode must be 5 digits",
            path: ["address", "zipCode"],
          });
        }
        if (!Array.isArray(obj.items) || obj.items.length === 0) {
          issues.push({
            message: "items must be non-empty",
            path: [{ key: "items" }],
          });
        } else {
          obj.items.forEach((item: any, idx: number) => {
            if (typeof item?.quantity !== "number" || item.quantity < 1) {
              issues.push({
                message: "quantity must be >= 1",
                path: [{ key: "items" }, { key: idx }, { key: "quantity" }],
              });
            }
          });
        }

        if (issues.length > 0) {
          return { issues };
        }
        return {
          value: {
            address: { zipCode: obj.address.zipCode.trim() },
            items: obj.items.map((it: any) => ({ quantity: it.quantity })),
          },
        };
      },
    },
  };

  it("validates async Standard Schema v1, flattens nested dot/bracket paths into ADR-009 400 response, and guards prototype pollution", async () => {
    const pipe = new StandardSchemaValidationPipe(orderStandardSchema);

    const valid = await pipe.transform(
      { address: { zipCode: "94107" }, items: [{ quantity: 3 }] },
      { type: "body" },
    );
    expect(valid).toEqual({
      address: { zipCode: "94107" },
      items: [{ quantity: 3 }],
    });

    try {
      await pipe.transform(
        { address: { zipCode: "12" }, items: [{ quantity: 0 }] },
        { type: "body" },
      );
      throw new Error("should fail validation");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const httpErr = err as HttpException;
      expect(httpErr.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      const body = httpErr.toJSON() as unknown as ValidationErrorResponse;
      expect(body.message).toBe("Validation failed");
      expect(body.details).toEqual([
        {
          field: "address.zipCode",
          constraints: { standardSchema: "zipCode must be 5 digits" },
          messages: ["zipCode must be 5 digits"],
        },
        {
          field: "items[0].quantity",
          constraints: { standardSchema: "quantity must be >= 1" },
          messages: ["quantity must be >= 1"],
        },
      ]);
    }

    // Prototype pollution blocked when BODY_SANITIZED_SYMBOL is absent
    const polluted = JSON.parse(
      '{"address":{"zipCode":"94107"},"items":[{"quantity":1}],"__proto__":{"admin":true}}',
    );
    await expect(pipe.transform(polluted, { type: "body" })).rejects.toThrow(
      HttpException,
    );
  });

  it("SchemaValidationPipe transparently accepts StandardSchemaV1 schemas alongside legacy SchemaValidator", async () => {
    const pipe = new SchemaValidationPipe(orderStandardSchema);

    const ok = await pipe.transform(
      { address: { zipCode: "10001" }, items: [{ quantity: 2 }] },
      { type: "body" },
    );
    expect(ok).toEqual({
      address: { zipCode: "10001" },
      items: [{ quantity: 2 }],
    });

    try {
      await pipe.transform(
        { address: { zipCode: "bad" }, items: [{ quantity: -1 }] },
        { type: "body" },
      );
      throw new Error("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const json = (
        err as HttpException
      ).toJSON() as unknown as ValidationErrorResponse;
      expect(json.details.map((d) => d.field)).toEqual([
        "address.zipCode",
        "items[0].quantity",
      ]);
    }
  });
});

describe("StandardSchemaSerializerInterceptor & @UseStandardSchema", () => {
  const publicUserSchema: StandardSchemaV1<
    unknown,
    { id: number; email: string }
  > = {
    "~standard": {
      version: 1,
      vendor: "test-serializer",
      validate(val) {
        if (
          typeof val !== "object" ||
          val === null ||
          typeof (val as any).id !== "number" ||
          typeof (val as any).email !== "string"
        ) {
          return {
            issues: [{ message: "Invalid user response", path: ["user"] }],
          };
        }
        // Strip sensitive fields like passwordHash
        return {
          value: {
            id: (val as any).id,
            email: (val as any).email,
          },
        };
      },
    },
  };

  const minimalSchema: StandardSchemaV1<unknown, { id: number }> = {
    "~standard": {
      version: 1,
      vendor: "test-serializer",
      validate(val) {
        if (
          typeof val !== "object" ||
          val === null ||
          typeof (val as any).id !== "number"
        ) {
          return { issues: [{ message: "Missing numeric id", path: ["id"] }] };
        }
        return { value: { id: (val as any).id } };
      },
    },
  };

  @UseStandardSchema(publicUserSchema)
  class UsersController {
    getProfile() {}

    @UseStandardSchema(minimalSchema)
    getIdOnly() {}
  }

  it("transforms outgoing responses, honors method > controller precedence, rejects invalid output with 500, and passes native binary/streams untouched", async () => {
    const interceptor = new StandardSchemaSerializerInterceptor();

    // Controller-level schema strips passwordHash
    const profileCtx = makeExecutionContext(
      UsersController,
      UsersController.prototype.getProfile,
    );
    const out = await interceptor.intercept(
      profileCtx,
      makeCallHandler({
        id: 7,
        email: "ada@example.com",
        passwordHash: "secret-argon2id",
      }),
    );
    expect(out).toEqual({ id: 7, email: "ada@example.com" });

    // Method-level schema overrides controller-level schema
    const idCtx = makeExecutionContext(
      UsersController,
      UsersController.prototype.getIdOnly,
    );
    const idOut = await interceptor.intercept(
      idCtx,
      makeCallHandler({ id: 7, email: "ada@example.com" }),
    );
    expect(idOut).toEqual({ id: 7 });

    // Outgoing schema violation throws 500 InternalServerErrorException by default
    try {
      await interceptor.intercept(
        profileCtx,
        makeCallHandler({ id: "not-a-number" }),
      );
      throw new Error("should fail outgoing validation");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // Native Response / ReadableStream / Blob / Uint8Array / StreamableFile pass through untouched
    const rawResp = new Response("ok");
    const rawStream = new ReadableStream();
    const rawBlob = new Blob(["abc"]);
    const rawBytes = new Uint8Array([1, 2, 3]);
    const streamable = new StreamableFile(rawBytes);

    expect(
      await interceptor.intercept(profileCtx, makeCallHandler(rawResp)),
    ).toBe(rawResp);
    expect(
      await interceptor.intercept(profileCtx, makeCallHandler(rawStream)),
    ).toBeInstanceOf(ReadableStream);
    expect(
      await interceptor.intercept(profileCtx, makeCallHandler(rawBlob)),
    ).toBe(rawBlob);
    expect(
      await interceptor.intercept(profileCtx, makeCallHandler(rawBytes)),
    ).toBe(rawBytes);
    expect(
      await interceptor.intercept(profileCtx, makeCallHandler(streamable)),
    ).toBe(streamable);
  });
});
