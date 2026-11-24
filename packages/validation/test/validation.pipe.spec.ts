import { describe, expect, it } from "bun:test";
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  METADATA_KEYS,
  MetadataRegistry,
  UnprocessableEntityException,
  type ValidationErrorResponse,
} from "@bunest/core";
import { Transform, Type } from "../src/transformer";
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidationError,
  type ValidatorConstraintInterface,
} from "../src/validator";
import {
  VALIDATION_PIPE_OPTIONS,
  ValidationPipe,
  flattenValidationErrors,
  stripDangerousKeys,
} from "../src";

const BLOCKED_DOMAINS = new Set(["blocked.test", "spam.invalid"]);

@ValidatorConstraint({ name: "isAllowedEmailDomain", async: true })
class AllowedEmailDomainConstraint implements ValidatorConstraintInterface {
  async validate(value: unknown): Promise<boolean> {
    await Bun.sleep(5);
    if (typeof value !== "string") {
      return false;
    }
    const domain = value.split("@")[1]?.toLowerCase() ?? "";
    return domain.length > 0 && !BLOCKED_DOMAINS.has(domain);
  }

  defaultMessage(args?: ValidationArguments): string {
    return `${args?.property ?? "email"} domain is not allowed`;
  }
}

class AddressDto {
  @IsString()
  zipCode!: string;

  @IsString()
  @MinLength(2)
  city!: string;
}

class OrderItemDto {
  @IsString()
  sku!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

class CreateOrderDto {
  @IsEmail()
  email!: string;

  @ValidateNested()
  @Type(() => AddressDto)
  address!: AddressDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];

  getTotalQuantity(): number {
    return this.items.reduce((sum, item) => sum + item.quantity, 0);
  }
}

class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(3)
  name!: string;

  @IsOptional()
  @IsString()
  bio?: string;

  getGreeting(): string {
    return `Hello, ${this.name}`;
  }
}

class AsyncSignupDto {
  @IsEmail()
  @Validate(AllowedEmailDomainConstraint)
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

class StrictPrimitiveDto {
  @IsBoolean()
  active!: boolean;

  @IsInt()
  age!: number;
}

class ExplicitTransformDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page!: number;

  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  published!: boolean;
}

class GroupedUserDto {
  @IsEmail(undefined, { groups: ["create", "update"] })
  email!: string;

  @IsString({ groups: ["create"] })
  @MinLength(8, { groups: ["create"] })
  password?: string;

  @IsString({ groups: ["update"] })
  reason?: string;
}

class BaseEntityDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(2)
  name!: string;
}

class AdminUserDto extends BaseEntityDto {
  @IsString()
  role!: string;

  @IsArray()
  @IsString({ each: true })
  permissions!: string[];
}

class UndecoratedDto {
  anything?: string;
}

class MultiConstraintDto {
  @IsString()
  @MinLength(5)
  @IsEmail()
  contact!: string;
}

async function expectValidationError(
  promise: Promise<unknown>,
): Promise<HttpException> {
  try {
    await promise;
    throw new Error("Expected promise to reject with HttpException");
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    return err as HttpException;
  }
}

describe("ValidationPipe", () => {
  describe("basic DTO validation & transformation", () => {
    it("transforms a valid payload into a DTO class instance (instanceof & methods preserved)", async () => {
      const pipe = new ValidationPipe();
      const result = (await pipe.transform(
        { email: "alice@example.com", name: "Alice" },
        { type: "body", metatype: CreateUserDto },
      )) as CreateUserDto;

      expect(result).toBeInstanceOf(CreateUserDto);
      expect(result.email).toBe("alice@example.com");
      expect(result.name).toBe("Alice");
      expect(result.getGreeting()).toBe("Hello, Alice");
    });

    it("throws normalized ADR-009 BadRequestException on invalid payload without echoing secrets", async () => {
      const capturedErrors: ValidationError[] = [];
      const pipe = new ValidationPipe();

      const err = await expectValidationError(
        pipe.transform(
          { email: "not-an-email", name: "Al" },
          { type: "body", metatype: CreateUserDto },
        ),
      );

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);

      const body = err.getResponse() as unknown as ValidationErrorResponse;
      expect(body.statusCode).toBe(400);
      expect(body.error).toBe("Bad Request");
      expect(body.message).toBe("Validation failed");
      expect(body.details).toHaveLength(2);

      const emailDetail = body.details.find((d) => d.field === "email");
      const nameDetail = body.details.find((d) => d.field === "name");
      expect(emailDetail).toEqual({
        field: "email",
        constraints: { isEmail: "email must be an email" },
        messages: ["email must be an email"],
      });
      expect(nameDetail?.constraints.minLength).toContain(
        "name must be longer than or equal to 3 characters",
      );
      expect(nameDetail?.messages).toEqual(
        Object.values(nameDetail?.constraints ?? {}),
      );

      // Ensure raw target & secret values are omitted by default (validationError: { target: false, value: false })
      const secretPipe = new ValidationPipe({
        exceptionFactory: (errors) => {
          capturedErrors.push(...errors);
          return new BadRequestException("captured");
        },
      });
      await expectValidationError(
        secretPipe.transform(
          { email: "alice@example.com", password: "short" },
          { type: "body", metatype: AsyncSignupDto },
        ),
      );
      expect(capturedErrors).toHaveLength(1);
      expect(capturedErrors[0]?.target).toBeUndefined();
      expect(capturedErrors[0]?.value).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("not-an-email");
    });
  });

  describe("whitelist, forbidNonWhitelisted, forbidUnknownValues, and transform: false", () => {
    it("rejects unexpected properties by default (whitelist: true, forbidNonWhitelisted: true)", async () => {
      const pipe = new ValidationPipe();
      const err = await expectValidationError(
        pipe.transform(
          {
            email: "alice@example.com",
            name: "Alice",
            isAdmin: true,
          },
          { type: "body", metatype: CreateUserDto },
        ),
      );

      const body = err.getResponse() as unknown as ValidationErrorResponse;
      expect(body.statusCode).toBe(400);
      expect(body.details).toEqual([
        {
          field: "isAdmin",
          constraints: {
            whitelistValidation: "property isAdmin should not exist",
          },
          messages: ["property isAdmin should not exist"],
        },
      ]);
    });

    it("strips non-whitelisted properties when forbidNonWhitelisted is false", async () => {
      const pipe = new ValidationPipe({ forbidNonWhitelisted: false });
      const result = (await pipe.transform(
        {
          email: "alice@example.com",
          name: "Alice",
          isAdmin: true,
        },
        { type: "body", metatype: CreateUserDto },
      )) as CreateUserDto & Record<string, unknown>;

      expect(result).toBeInstanceOf(CreateUserDto);
      expect(result.email).toBe("alice@example.com");
      expect(result.isAdmin).toBeUndefined();
      expect("isAdmin" in result).toBe(false);
    });

    it("returns whitelisted plain object (not class instance) when transform: false and whitelist: true", async () => {
      const pipe = new ValidationPipe({
        transform: false,
        forbidNonWhitelisted: false,
      });
      const input = {
        email: "alice@example.com",
        address: { zipCode: "10000", city: "Hanoi", extraNested: "drop-me" },
        items: [{ sku: "SKU-1", quantity: 2, extraItem: "drop-me" }],
        extraRoot: "drop-me",
      };

      const result = (await pipe.transform(input, {
        type: "body",
        metatype: CreateOrderDto,
      })) as Record<string, unknown>;

      expect(result).not.toBeInstanceOf(CreateOrderDto);
      expect(result).toEqual({
        email: "alice@example.com",
        address: { zipCode: "10000", city: "Hanoi" },
        items: [{ sku: "SKU-1", quantity: 2 }],
      });
      // Original input is not mutated
      expect(input.extraRoot).toBe("drop-me");
    });

    it("returns raw value untouched when transform: false and whitelist: false", async () => {
      const pipe = new ValidationPipe({
        transform: false,
        whitelist: false,
      });
      const input = { email: "alice@example.com", name: "Alice", extra: 123 };

      const result = await pipe.transform(input, {
        type: "body",
        metatype: CreateUserDto,
      });

      expect(result).toBe(input);
      expect(result).not.toBeInstanceOf(CreateUserDto);
    });

    it("enforces forbidUnknownValues: true by default on decorator-less DTOs", async () => {
      const strictPipe = new ValidationPipe();
      const err = await expectValidationError(
        strictPipe.transform(
          { anything: "hello" },
          { type: "body", metatype: UndecoratedDto },
        ),
      );
      const body = err.getResponse() as unknown as ValidationErrorResponse;
      expect(body.statusCode).toBe(400);
      expect(body.details[0]?.constraints.unknownValue).toBeDefined();

      const permissivePipe = new ValidationPipe({
        forbidUnknownValues: false,
        whitelist: false,
      });
      const result = await permissivePipe.transform(
        { anything: "hello" },
        { type: "body", metatype: UndecoratedDto },
      );
      expect(result).toBeInstanceOf(UndecoratedDto);
    });
  });

  describe("nested DTOs and arrays of nested DTOs", () => {
    it("instantiates nested DTOs and array items and validates them", async () => {
      const pipe = new ValidationPipe();
      const result = (await pipe.transform(
        {
          email: "buyer@example.com",
          address: { zipCode: "10000", city: "Hanoi" },
          items: [
            { sku: "BOOK-1", quantity: 2 },
            { sku: "PEN-2", quantity: 3 },
          ],
        },
        { type: "body", metatype: CreateOrderDto },
      )) as CreateOrderDto;

      expect(result).toBeInstanceOf(CreateOrderDto);
      expect(result.address).toBeInstanceOf(AddressDto);
      expect(result.items[0]).toBeInstanceOf(OrderItemDto);
      expect(result.items[1]).toBeInstanceOf(OrderItemDto);
      expect(result.getTotalQuantity()).toBe(5);
    });

    it("flattens nested object and array element errors to exact ADR-009 dot/bracket paths", async () => {
      const pipe = new ValidationPipe();
      const err = await expectValidationError(
        pipe.transform(
          {
            email: "bad-email",
            address: { zipCode: 12345, city: "H" },
            items: [
              { sku: "BOOK-1", quantity: 0 },
              { sku: "PEN-2", quantity: 2 },
              { sku: 999, quantity: -5 },
            ],
            unexpectedField: "nope",
          },
          { type: "body", metatype: CreateOrderDto },
        ),
      );

      const body = err.getResponse() as unknown as ValidationErrorResponse;
      expect(body.statusCode).toBe(400);
      expect(body.error).toBe("Bad Request");
      expect(body.message).toBe("Validation failed");

      const byField = new Map(body.details.map((d) => [d.field, d]));
      expect(byField.has("email")).toBe(true);
      expect(byField.has("address.zipCode")).toBe(true);
      expect(byField.has("address.city")).toBe(true);
      expect(byField.has("items[0].quantity")).toBe(true);
      expect(byField.has("items[2].sku")).toBe(true);
      expect(byField.has("items[2].quantity")).toBe(true);
      expect(byField.has("unexpectedField")).toBe(true);

      expect(byField.get("address.zipCode")?.constraints.isString).toBe(
        "zipCode must be a string",
      );
      expect(byField.get("items[0].quantity")?.constraints.min).toBe(
        "quantity must not be less than 1",
      );
      expect(byField.get("items[0].quantity")?.messages).toEqual([
        "quantity must not be less than 1",
      ]);
      expect(
        byField.get("unexpectedField")?.constraints.whitelistValidation,
      ).toBe("property unexpectedField should not exist");
    });
  });

  describe("optional fields, groups, async custom validators, and DTO inheritance", () => {
    it("supports @IsOptional() and skip*Properties flags", async () => {
      const pipe = new ValidationPipe();

      const omitted = (await pipe.transform(
        { email: "alice@example.com", name: "Alice" },
        { type: "body", metatype: CreateUserDto },
      )) as CreateUserDto;
      expect(omitted.bio).toBeUndefined();

      const invalidOptional = await expectValidationError(
        pipe.transform(
          { email: "alice@example.com", name: "Alice", bio: 12345 },
          { type: "body", metatype: CreateUserDto },
        ),
      );
      expect(
        (invalidOptional.getResponse() as unknown as ValidationErrorResponse)
          .details[0]?.field,
      ).toBe("bio");

      const skipMissingPipe = new ValidationPipe({
        skipMissingProperties: true,
      });
      const partial = (await skipMissingPipe.transform(
        { email: "alice@example.com" },
        { type: "body", metatype: CreateUserDto },
      )) as CreateUserDto;
      expect(partial.email).toBe("alice@example.com");

      const skipNullPipe = new ValidationPipe({ skipNullProperties: true });
      const withNull = (await skipNullPipe.transform(
        { email: "alice@example.com", name: null },
        { type: "body", metatype: CreateUserDto },
      )) as CreateUserDto;
      expect(withNull.name).toBeNull();

      const skipUndefinedPipe = new ValidationPipe({
        skipUndefinedProperties: true,
      });
      const withUndefined = (await skipUndefinedPipe.transform(
        { email: "alice@example.com", name: undefined },
        { type: "body", metatype: CreateUserDto },
      )) as CreateUserDto;
      expect(withUndefined.name).toBeUndefined();
    });

    it("enforces validation groups cleanly", async () => {
      const createPipe = new ValidationPipe({
        groups: ["create"],
        forbidNonWhitelisted: false,
      });
      const updatePipe = new ValidationPipe({
        groups: ["update"],
        forbidNonWhitelisted: false,
      });

      // Missing password fails "create" group
      const createErr = await expectValidationError(
        createPipe.transform(
          { email: "alice@example.com" },
          { type: "body", metatype: GroupedUserDto },
        ),
      );
      expect(
        (createErr.getResponse() as unknown as ValidationErrorResponse)
          .details[0]?.field,
      ).toBe("password");

      // Missing password passes "update" group when reason is provided
      const updated = (await updatePipe.transform(
        { email: "alice@example.com", reason: "profile change" },
        { type: "body", metatype: GroupedUserDto },
      )) as GroupedUserDto;
      expect(updated.email).toBe("alice@example.com");
      expect(updated.reason).toBe("profile change");
    });

    it("awaits async custom validators and rejects invalid async checks", async () => {
      const pipe = new ValidationPipe();

      const valid = (await pipe.transform(
        { email: "alice@example.com", password: "password123" },
        { type: "body", metatype: AsyncSignupDto },
      )) as AsyncSignupDto;
      expect(valid).toBeInstanceOf(AsyncSignupDto);

      const err = await expectValidationError(
        pipe.transform(
          { email: "bot@blocked.test", password: "password123" },
          { type: "body", metatype: AsyncSignupDto },
        ),
      );
      const body = err.getResponse() as unknown as ValidationErrorResponse;
      expect(body.details).toEqual([
        {
          field: "email",
          constraints: {
            isAllowedEmailDomain: "email domain is not allowed",
          },
          messages: ["email domain is not allowed"],
        },
      ]);
    });

    it("validates inherited properties on DTO subclasses", async () => {
      const pipe = new ValidationPipe();

      const admin = (await pipe.transform(
        {
          email: "admin@example.com",
          name: "Root Admin",
          role: "superadmin",
          permissions: ["users:read", "users:write"],
        },
        { type: "body", metatype: AdminUserDto },
      )) as AdminUserDto;
      expect(admin).toBeInstanceOf(AdminUserDto);
      expect(admin).toBeInstanceOf(BaseEntityDto);

      const err = await expectValidationError(
        pipe.transform(
          {
            email: "bad",
            name: "A",
            role: 123,
            permissions: ["ok", 42],
          },
          { type: "body", metatype: AdminUserDto },
        ),
      );
      const fields = (
        err.getResponse() as unknown as ValidationErrorResponse
      ).details.map((d) => d.field);
      expect(fields).toContain("email");
      expect(fields).toContain("name");
      expect(fields).toContain("role");
      expect(fields).toContain("permissions");
    });
  });

  describe("strict primitive handling & metatype skip rules", () => {
    it("NEVER silently coerces 'false' to true or '25' to 25 (enableImplicitConversion: false default)", async () => {
      const pipe = new ValidationPipe();

      const err = await expectValidationError(
        pipe.transform(
          { active: "false", age: "25" },
          { type: "body", metatype: StrictPrimitiveDto },
        ),
      );
      const body = err.getResponse() as unknown as ValidationErrorResponse;
      const fields = body.details.map((d) => d.field).sort();
      expect(fields).toEqual(["active", "age"]);

      // Custom transformOptions without enableImplicitConversion still keeps it false
      const pipeWithOtherTransformOpt = new ValidationPipe({
        transformOptions: { exposeDefaultValues: true },
      });
      await expectValidationError(
        pipeWithOtherTransformOpt.transform(
          { active: "false", age: "25" },
          { type: "body", metatype: StrictPrimitiveDto },
        ),
      );
    });

    it("supports explicit @Type() and @Transform() conversions cleanly", async () => {
      const pipe = new ValidationPipe();
      const result = (await pipe.transform(
        { page: "3", published: "false" },
        { type: "query", metatype: ExplicitTransformDto },
      )) as ExplicitTransformDto;

      expect(result).toBeInstanceOf(ExplicitTransformDto);
      expect(result.page).toBe(3);
      expect(result.published).toBe(false);
    });

    it("skips built-in primitive/native metatypes and missing metatypes without coercion", async () => {
      const pipe = new ValidationPipe();

      expect(
        await pipe.transform("false", { type: "query", metatype: Boolean }),
      ).toBe("false");
      expect(
        await pipe.transform("42", { type: "param", metatype: Number }),
      ).toBe("42");
      expect(
        await pipe.transform("hello", { type: "query", metatype: String }),
      ).toBe("hello");
      expect(
        await pipe.transform([1, 2], { type: "body", metatype: Array }),
      ).toEqual([1, 2]);
      expect(
        await pipe.transform({ any: 1 }, { type: "body", metatype: Object }),
      ).toEqual({ any: 1 });
      expect(
        await pipe.transform({ any: 1 }, { type: "body", metatype: undefined }),
      ).toEqual({ any: 1 });

      const req = new Request("http://localhost/test");
      expect(
        await pipe.transform(req, { type: "body", metatype: Request }),
      ).toBe(req);
    });

    it("rejects null, undefined, primitives, arrays, and non-record built-ins when a DTO metatype is expected", async () => {
      const pipe = new ValidationPipe();

      for (const badValue of [
        null,
        undefined,
        "hello",
        42,
        true,
        [],
        new Date(),
        new Uint8Array([1, 2]),
        new Map(),
      ]) {
        const err = await expectValidationError(
          pipe.transform(badValue, { type: "body", metatype: CreateUserDto }),
        );
        expect(err).toBeInstanceOf(BadRequestException);
        const body = err.getResponse() as unknown as ValidationErrorResponse;
        expect(body.details).toEqual([
          {
            field: "body",
            constraints: {
              isObject: "Validation failed (object is expected)",
            },
            messages: ["Validation failed (object is expected)"],
          },
        ]);
      }

      // Uses metadata.data when present
      const namedErr = await expectValidationError(
        pipe.transform(null, {
          type: "body",
          data: "user",
          metatype: CreateUserDto,
        }),
      );
      expect(
        (namedErr.getResponse() as unknown as ValidationErrorResponse)
          .details[0]?.field,
      ).toBe("user");
    });
  });

  describe("prototype pollution guard", () => {
    it("rejects top-level __proto__, constructor, and prototype keys before plainToInstance", async () => {
      const pipe = new ValidationPipe();

      const protoPayload = JSON.parse(
        '{"email":"alice@example.com","name":"Alice","__proto__":{"polluted":true}}',
      );
      const err1 = await expectValidationError(
        pipe.transform(protoPayload, { type: "body", metatype: CreateUserDto }),
      );
      const body1 = err1.getResponse() as unknown as ValidationErrorResponse;
      expect(body1.details[0]?.field).toBe("__proto__");
      expect(body1.details[0]?.constraints.forbiddenKey).toContain("__proto__");
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();

      const ctorPayload = {
        email: "alice@example.com",
        name: "Alice",
        constructor: { prototype: { polluted2: true } },
      };
      const err2 = await expectValidationError(
        pipe.transform(ctorPayload, { type: "body", metatype: CreateUserDto }),
      );
      expect(
        (err2.getResponse() as unknown as ValidationErrorResponse).details[0]
          ?.field,
      ).toBe("constructor");
      expect(({} as Record<string, unknown>).polluted2).toBeUndefined();

      const prototypePayload = {
        email: "alice@example.com",
        name: "Alice",
        prototype: { bad: 1 },
      };
      const err3 = await expectValidationError(
        pipe.transform(prototypePayload, {
          type: "body",
          metatype: CreateUserDto,
        }),
      );
      expect(
        (err3.getResponse() as unknown as ValidationErrorResponse).details[0]
          ?.field,
      ).toBe("prototype");
    });

    it("rejects nested and array-element dangerous keys even when whitelist & forbidNonWhitelisted are false", async () => {
      const permissivePipe = new ValidationPipe({
        whitelist: false,
        forbidNonWhitelisted: false,
      });

      const nestedPayload = JSON.parse(
        '{"email":"a@b.com","address":{"zipCode":"10000","city":"Hanoi","__proto__":{"x":1}},"items":[{"sku":"S1","quantity":1,"constructor":{"y":2}}]}',
      );
      const err = await expectValidationError(
        permissivePipe.transform(nestedPayload, {
          type: "body",
          metatype: CreateOrderDto,
        }),
      );
      const fields = (
        err.getResponse() as unknown as ValidationErrorResponse
      ).details.map((d) => d.field);
      expect(fields).toEqual(["address.__proto__", "items[0].constructor"]);
    });

    it("catches non-enumerable own dangerous properties and handles cyclic graphs safely", async () => {
      const pipe = new ValidationPipe();
      const sneaky: Record<string, unknown> = {
        email: "alice@example.com",
        name: "Alice",
      };
      Object.defineProperty(sneaky, "__proto__", {
        value: { injected: true },
        enumerable: false,
        configurable: true,
      });
      await expectValidationError(
        pipe.transform(sneaky, { type: "body", metatype: CreateUserDto }),
      );

      // Cyclic object with dangerous key does not stack-overflow
      const cyclic: Record<string, unknown> = {
        email: "alice@example.com",
        name: "Alice",
      };
      cyclic.self = cyclic;
      Object.defineProperty(cyclic, "constructor", {
        value: {},
        enumerable: true,
      });
      await expectValidationError(
        pipe.transform(cyclic, { type: "body", metatype: CreateUserDto }),
      );
    });

    it("stripDangerousKeys removes dangerous keys recursively without mutating input", () => {
      const dirty = JSON.parse(
        '{"ok":1,"__proto__":{"bad":1},"nested":{"a":"b","constructor":{"c":2},"list":[{"prototype":{"d":3},"keep":true}]}}',
      );
      const clean = stripDangerousKeys(dirty) as Record<string, unknown>;
      expect(Object.hasOwn(clean, "__proto__")).toBe(false);
      expect(clean).toEqual({
        ok: 1,
        nested: {
          a: "b",
          list: [{ keep: true }],
        },
      });
    });
  });

  describe("advanced options & customization", () => {
    it("supports stopAtFirstError, dismissDefaultMessages, disableErrorMessages, and custom errorHttpStatusCode", async () => {
      const allErrorsPipe = new ValidationPipe();
      const allErr = await expectValidationError(
        allErrorsPipe.transform(
          { contact: 123 },
          { type: "body", metatype: MultiConstraintDto },
        ),
      );
      const allConstraints = Object.keys(
        (allErr.getResponse() as unknown as ValidationErrorResponse).details[0]
          ?.constraints ?? {},
      );
      expect(allConstraints.length).toBeGreaterThan(1);

      const firstOnlyPipe = new ValidationPipe({ stopAtFirstError: true });
      const firstErr = await expectValidationError(
        firstOnlyPipe.transform(
          { contact: 123 },
          { type: "body", metatype: MultiConstraintDto },
        ),
      );
      const firstConstraints = Object.keys(
        (firstErr.getResponse() as unknown as ValidationErrorResponse)
          .details[0]?.constraints ?? {},
      );
      expect(firstConstraints).toHaveLength(1);

      const disabledMsgsPipe = new ValidationPipe({
        disableErrorMessages: true,
      });
      const disabledErr = await expectValidationError(
        disabledMsgsPipe.transform(
          { email: "bad", name: "a" },
          { type: "body", metatype: CreateUserDto },
        ),
      );
      expect(disabledErr.getResponse()).toEqual({
        statusCode: 400,
        error: "Bad Request",
        message: "Bad Request",
      });

      const dismissPipe = new ValidationPipe({ dismissDefaultMessages: true });
      const dismissErr = await expectValidationError(
        dismissPipe.transform(
          { email: "bad", name: "Alice" },
          { type: "body", metatype: CreateUserDto },
        ),
      );
      const dismissBody =
        dismissErr.getResponse() as unknown as ValidationErrorResponse;
      expect(dismissBody.details[0]?.field).toBe("email");
      expect(dismissBody.details[0]?.constraints.isEmail).toBe("");

      const status422Pipe = new ValidationPipe({
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      });
      const err422 = await expectValidationError(
        status422Pipe.transform(
          { email: "bad", name: "Alice" },
          { type: "body", metatype: CreateUserDto },
        ),
      );
      expect(err422).toBeInstanceOf(UnprocessableEntityException);
      expect(err422.getStatus()).toBe(422);
      expect(
        (err422.getResponse() as unknown as ValidationErrorResponse).error,
      ).toBe("Unprocessable Entity");

      const status418Pipe = new ValidationPipe({
        errorHttpStatusCode: HttpStatus.I_AM_A_TEAPOT,
      });
      const err418 = await expectValidationError(
        status418Pipe.transform(
          { email: "bad", name: "Alice" },
          { type: "body", metatype: CreateUserDto },
        ),
      );
      expect(err418.getStatus()).toBe(418);
      expect(
        (err418.getResponse() as unknown as ValidationErrorResponse).error,
      ).toBe("I'm a Teapot");
    });

    it("supports expectedType and validateCustomDecorators", async () => {
      const withExpected = new ValidationPipe({ expectedType: CreateUserDto });
      const result = (await withExpected.transform(
        { email: "alice@example.com", name: "Alice" },
        { type: "body", metatype: Object },
      )) as CreateUserDto;
      expect(result).toBeInstanceOf(CreateUserDto);

      const defaultPipe = new ValidationPipe();
      const rawCustom = { email: "invalid" };
      expect(
        await defaultPipe.transform(rawCustom, {
          type: "custom",
          metatype: CreateUserDto,
        }),
      ).toBe(rawCustom);

      const customValidatingPipe = new ValidationPipe({
        validateCustomDecorators: true,
      });
      await expectValidationError(
        customValidatingPipe.transform(rawCustom, {
          type: "custom",
          metatype: CreateUserDto,
        }),
      );
    });

    it("exposes DI-safe @Optional() @Inject(VALIDATION_PIPE_OPTIONS) metadata for @UsePipes(ValidationPipe) & APP_PIPE", () => {
      expect(
        MetadataRegistry.has(METADATA_KEYS.INJECTABLE, ValidationPipe),
      ).toBe(true);
      expect(MetadataRegistry.getOptionalDeps(ValidationPipe)).toEqual([0]);
      expect(MetadataRegistry.getInjectTokens(ValidationPipe)).toEqual([
        { index: 0, token: VALIDATION_PIPE_OPTIONS },
      ]);
    });

    it("invokes custom exceptionFactory with raw ValidationError[]", async () => {
      class CustomValidationError extends Error {
        constructor(public readonly fields: string[]) {
          super(`Custom failure: ${fields.join(", ")}`);
        }
      }

      const pipe = new ValidationPipe({
        exceptionFactory: (errors) =>
          new CustomValidationError(
            flattenValidationErrors(errors).map((d) => d.field),
          ),
      });

      try {
        await pipe.transform(
          { email: "nope", name: "a" },
          { type: "body", metatype: CreateUserDto },
        );
        throw new Error("Expected custom exception");
      } catch (err) {
        expect(err).toBeInstanceOf(CustomValidationError);
        expect((err as CustomValidationError).fields).toEqual([
          "email",
          "name",
        ]);
      }
    });
  });
});
