import { describe, expect, it } from "bun:test";
import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UsePipes,
  type StandardSchemaV1,
  type StandardSchemaV1Issue,
  type ValidationErrorResponse,
} from "../../src/common/index";
import { Test } from "@bunest/testing";
import { Type } from "@bunest/validation/transformer";
import {
  IsEmail,
  IsInt,
  IsString,
  Matches,
  Max,
  MinLength,
  ValidateNested,
  validate,
} from "@bunest/validation/validator";
import {
  AcceptLanguageLocaleResolver,
  I18nContext,
  I18nModule,
  I18nService,
  I18nStandardSchemaValidationPipe,
  I18nValidationPipe,
  InMemoryI18nLoader,
  i18nIssueMessage,
  i18nValidationMessage,
  translateStandardSchemaIssues,
  translateValidationErrors,
  type I18nCatalogs,
} from "../../src/i18n/index";
import { PlaceholderMessageFormatter } from "../../src/i18n/formatters/placeholder-message.formatter";

const VALIDATION_CATALOGS: I18nCatalogs = {
  en: {
    validation: {
      isEmail: "{path} must be a valid email (got {value})",
      minLength: {
        one: "{path} needs at least {count} character",
        other: "{path} needs at least {count} characters",
      },
      too_small: {
        string: "{path} must have at least {minimum} chars",
        number: {
          one: "{path} must be at least {count} unit",
          other: "{path} must be at least {count} units",
        },
      },
      invalid_format: {
        email: "{path} is not a valid email address",
      },
      min_length: "{path} requires minimum {requirement} chars",
    },
    orders: {
      tooMany: "{path}: maximum {constraint1} copies allowed (limit {max})",
      alphaOnly: "{path} must contain letters",
      noSpaces: "{path} must not contain spaces",
    },
    users: {
      tooYoung: "{property} must be at least {min}",
    },
    customNs: {
      isEmail: "CUSTOM-NS email error for {property}",
    },
  },
  pl: {
    validation: {
      isEmail: "{path} musi być poprawnym adresem email (podano {value})",
      minLength: {
        one: "{path} wymaga minimum {count} znaku",
        few: "{path} wymaga minimum {count} znaków",
        many: "{path} wymaga minimum {count} znaków",
        other: "{path} wymaga minimum {count} znaków",
      },
      too_small: {
        string: "{path} musi mieć co najmniej {minimum} znaków",
        number: {
          one: "{path} musi wynosić co najmniej {count} sztukę",
          few: "{path} musi wynosić co najmniej {count} sztuki",
          many: "{path} musi wynosić co najmniej {count} sztuk",
          other: "{path} musi wynosić co najmniej {count} sztuki",
        },
      },
      invalid_format: {
        email: "{path} nie jest poprawnym adresem email",
      },
      min_length: "{path} wymaga minimum {requirement} znaków",
    },
    orders: {
      tooMany: "{path}: maksymalnie {constraint1} kopii (limit {max})",
      alphaOnly: "{path} musi zawierać litery",
      noSpaces: "{path} nie może zawierać spacji",
    },
    users: {
      tooYoung: "{property} musi wynosić co najmniej {min}",
    },
  },
};

function makeI18n() {
  const loader = new InMemoryI18nLoader(VALIDATION_CATALOGS);
  const service = new I18nService(
    { defaultLocale: "en", logMissingKeys: "never" },
    VALIDATION_CATALOGS,
    loader,
    new PlaceholderMessageFormatter(),
  );
  const ctx = new I18nContext(service);
  return { service, ctx };
}

class AddressDto {
  @MinLength(3)
  city!: string;

  @IsString({ message: "plain untranslated message" })
  zip!: string;
}

class CreateOrderDto {
  @IsEmail()
  email!: string;

  @IsInt()
  @Max(10, { message: i18nValidationMessage("orders.tooMany", { max: 10 }) })
  copies!: number;

  @Matches(/[a-z]/i, { message: i18nValidationMessage("orders.alphaOnly") })
  @Matches(/^\S+$/, { message: i18nValidationMessage("orders.noSpaces") })
  code!: string;

  @ValidateNested()
  @Type(() => AddressDto)
  address!: AddressDto;
}

describe("class-validator I18nValidationPipe & helpers", () => {
  it("translates constraints in Bunest default, NestJS list, grouped, and custom exceptionFactory modes", async () => {
    const { ctx } = makeI18n();

    const badPayload = {
      email: "bad-email",
      copies: 99,
      code: "has space",
      address: { city: "LA", zip: 12345 },
    };

    // 1. Bunest default mode ("bunest")
    const bunestPipe = new I18nValidationPipe();
    await ctx.run("pl", async () => {
      let err: unknown;
      try {
        await bunestPipe.transform(badPayload, {
          type: "body",
          metatype: CreateOrderDto,
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      const body = (
        err as BadRequestException
      ).getResponse() as unknown as ValidationErrorResponse;
      expect(body.message).toBe("Validation failed");
      const byField = new Map(body.details.map((d) => [d.field, d]));
      expect(byField.get("email")?.constraints.isEmail).toBe(
        "email musi być poprawnym adresem email (podano bad-email)",
      );
      expect(byField.get("copies")?.constraints.max).toBe(
        "copies: maksymalnie 10 kopii (limit 10)",
      );
      expect(byField.get("code")?.constraints.matches).toBe(
        "code nie może zawierać spacji",
      );
      expect(byField.get("address.city")?.constraints.minLength).toBe(
        "address.city wymaga minimum 3 znaków",
      );
      expect(byField.get("address.zip")?.constraints.isString).toBe(
        "plain untranslated message",
      );
    });

    // 2. NestJS "list" mode: translated nested messages NOT prefixed, untranslated KEEP parent prefix
    const listPipe = new I18nValidationPipe({ errorFormat: "list" });
    await ctx.run("en", async () => {
      let err: unknown;
      try {
        await listPipe.transform(badPayload, {
          type: "body",
          metatype: CreateOrderDto,
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      const body = (err as BadRequestException).getResponse() as {
        message: string[];
      };
      expect(body.message).toContain(
        "email must be a valid email (got bad-email)",
      );
      expect(body.message).toContain(
        "address.city needs at least 3 characters",
      );
      expect(body.message).toContain("address.plain untranslated message");
    });

    // 3. NestJS "grouped" mode
    const groupedPipe = new I18nValidationPipe({ errorFormat: "grouped" });
    await ctx.run("en", async () => {
      let err: unknown;
      try {
        await groupedPipe.transform(badPayload, {
          type: "body",
          metatype: CreateOrderDto,
        });
      } catch (e) {
        err = e;
      }
      const body = (err as BadRequestException).getResponse() as {
        message: Record<string, string[]>;
      };
      expect(body.message["address.city"]).toEqual([
        "address.city needs at least 3 characters",
      ]);
    });

    // 4. Custom exceptionFactory strips target & value by default (Bunest ADR-009) and preserves them when requested
    let capturedDefault: unknown[] = [];
    const stripPipe = new I18nValidationPipe({
      exceptionFactory: (errors) => {
        capturedDefault = errors;
        return new BadRequestException("custom");
      },
    });
    await ctx.run("en", async () => {
      await expect(
        stripPipe.transform(badPayload, {
          type: "body",
          metatype: CreateOrderDto,
        }),
      ).rejects.toThrow("custom");
    });
    expect((capturedDefault[0] as { target?: unknown }).target).toBeUndefined();
    expect((capturedDefault[0] as { value?: unknown }).value).toBeUndefined();

    // 5. Custom namespace option
    class SimpleEmailDto {
      @IsEmail()
      email!: string;
    }
    const nsPipe = new I18nValidationPipe({
      namespace: "customNs",
      errorFormat: "list",
    });
    await ctx.run("en", async () => {
      let err: unknown;
      try {
        await nsPipe.transform(
          { email: "nope" },
          { type: "body", metatype: SimpleEmailDto },
        );
      } catch (e) {
        err = e;
      }
      expect((err as BadRequestException).getResponse()).toMatchObject({
        message: ["CUSTOM-NS email error for email"],
      });
    });
  });

  it("translateValidationErrors returns errors unchanged outside a request context", async () => {
    const dto = new AddressDto();
    dto.city = "a";
    dto.zip = "123";
    const errors = await validate(dto);
    const original = errors[0]?.constraints?.minLength;
    translateValidationErrors(errors);
    expect(errors[0]?.constraints?.minLength).toBe(original);
  });
});

describe("Standard Schema I18nStandardSchemaValidationPipe & helpers", () => {
  const mockSchema: StandardSchemaV1<unknown, { email: string; age: number }> =
    {
      "~standard": {
        version: 1,
        vendor: "test-schema",
        validate(value: unknown) {
          const input = (value ?? {}) as Record<string, unknown>;
          const issues: Array<StandardSchemaV1Issue & Record<string, unknown>> =
            [];
          if (typeof input.email !== "string" || !input.email.includes("@")) {
            issues.push({
              message: "Invalid email",
              path: ["email"],
              code: "invalid_format",
              format: "email",
            });
          }
          if (typeof input.age !== "number" || input.age < 18) {
            issues.push({
              message: i18nIssueMessage("users.tooYoung", { min: 18 }),
              path: ["age"],
            });
          }
          if (typeof input.bio === "string" && input.bio.length < 3) {
            issues.push({
              message: "Too short",
              path: [{ key: "profile" }, { key: "bio" }],
              code: "too_small",
              origin: "string",
              minimum: 3,
            });
          }
          if (input.rawFail) {
            issues.push({
              message: "Expected object",
              path: [],
              code: "too_small",
              origin: "string",
              minimum: 1,
            });
          }
          if (input.untranslated) {
            issues.push({
              message: "Keep raw message",
              path: ["other"],
              code: "unknown_code_xyz",
            });
          }
          return issues.length > 0
            ? { issues }
            : { value: { email: String(input.email), age: Number(input.age) } };
        },
      },
    };

  it("translates explicit i18nIssueMessage, code.format, code.origin, Valibot type, and class-based issues", () => {
    const { ctx } = makeI18n();

    class ClassBasedIssue implements StandardSchemaV1Issue {
      readonly path = ["count"];
      readonly code = "too_small";
      readonly origin = "number";
      get minimum(): number {
        return 2;
      }
      get message(): string {
        return "Must be >= 2";
      }
    }

    const issues: StandardSchemaV1Issue[] = [
      {
        message: i18nIssueMessage("users.tooYoung", { min: 21 }),
        path: ["age"],
      },
      {
        message: "too short",
        path: ["name"],
        type: "min_length",
        requirement: 5,
      } as StandardSchemaV1Issue,
      new ClassBasedIssue(),
      {
        message: "$i18n:users.tooYoung|not-json",
        path: ["broken"],
      },
      {
        message: "root level error",
        path: [],
        code: "too_small",
        origin: "string",
        minimum: 1,
      } as StandardSchemaV1Issue,
    ];

    ctx.run("pl", () => {
      const translated = translateStandardSchemaIssues(issues);
      expect(translated[0]?.message).toBe("age musi wynosić co najmniej 21");
      expect(translated[1]?.message).toBe("name wymaga minimum 5 znaków");
      expect(translated[2]?.message).toBe(
        "count musi wynosić co najmniej 2 sztuki",
      );
      // Class-based issue prototype getters remain intact
      expect((translated[2] as unknown as ClassBasedIssue).minimum).toBe(2);
      // Malformed $i18n prefix stays unchanged
      expect(translated[3]?.message).toBe("$i18n:users.tooYoung|not-json");
      // Whole-input issue (empty path) is untouched by issue-code lookup
      expect(translated[4]?.message).toBe("root level error");
    });
  });

  it("works in both Bunest explicit-schema mode and NestJS global/formatIssueMessages modes", async () => {
    const { ctx } = makeI18n();

    // Explicit schema mode (Bunest)
    const explicitPipe = new I18nStandardSchemaValidationPipe(mockSchema);
    await ctx.run("pl", async () => {
      let err: unknown;
      try {
        await explicitPipe.transform({
          email: "bad",
          age: 12,
          bio: "hi",
          untranslated: true,
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      const body = (
        err as BadRequestException
      ).getResponse() as unknown as ValidationErrorResponse;
      const byField = new Map(body.details.map((d) => [d.field, d.messages]));
      expect(byField.get("email")).toEqual([
        "email nie jest poprawnym adresem email",
      ]);
      expect(byField.get("age")).toEqual(["age musi wynosić co najmniej 18"]);
      expect(byField.get("profile.bio")).toEqual([
        "profile.bio musi mieć co najmniej 3 znaków",
      ]);
      expect(byField.get("other")).toEqual(["Keep raw message"]);
    });

    // Global mode + formatIssueMessages (NestJS parity: no `path: ` on translated, keep `path: ` on untranslated)
    class TestableStandardPipe extends I18nStandardSchemaValidationPipe {
      exposeFormat(issues: readonly StandardSchemaV1Issue[]): string[] {
        return this.formatIssueMessages(issues);
      }
    }
    const testable = new TestableStandardPipe();
    ctx.run("en", () => {
      const translated = translateStandardSchemaIssues([
        {
          message: i18nIssueMessage("users.tooYoung", { min: 18 }),
          path: ["age"],
        },
        {
          message: "Keep raw message",
          path: ["other"],
        },
      ]);
      expect(testable.exposeFormat(translated)).toEqual([
        "age must be at least 18",
        "other: Keep raw message",
      ]);
    });
  });

  it("integrates I18nValidationPipe and I18nStandardSchemaValidationPipe end-to-end in HTTP controllers", async () => {
    class EmailOnlyDto {
      @IsEmail()
      email!: string;
    }

    @Controller("validate")
    class ValidateController {
      @Post("dto")
      @UsePipes(new I18nValidationPipe())
      checkDto(@Body() dto: EmailOnlyDto) {
        return dto;
      }

      @Post("schema")
      @UsePipes(new I18nStandardSchemaValidationPipe())
      checkSchema(@Body(mockSchema) data: { email: string; age: number }) {
        return data;
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        I18nModule.forRoot({
          defaultLocale: "en",
          loader: new InMemoryI18nLoader(VALIDATION_CATALOGS),
          resolvers: [new AcceptLanguageLocaleResolver()],
        }),
      ],
      controllers: [ValidateController],
    }).compile();

    const app = mod.createNestApplication();
    await app.init();

    const dtoRes = await app.inject({
      method: "POST",
      url: "/validate/dto",
      headers: { "accept-language": "pl" },
      payload: { email: "nope" },
    });
    expect(dtoRes.statusCode).toBe(400);
    expect(dtoRes.json<ValidationErrorResponse>().details[0]?.messages).toEqual(
      ["email musi być poprawnym adresem email (podano nope)"],
    );

    const schemaRes = await app.inject({
      method: "POST",
      url: "/validate/schema",
      headers: { "accept-language": "pl" },
      payload: { email: "nope", age: 10 },
    });
    expect(schemaRes.statusCode).toBe(400);
    const schemaDetails = new Map(
      schemaRes
        .json<ValidationErrorResponse>()
        .details.map((d) => [d.field, d.messages]),
    );
    expect(schemaDetails.get("email")).toEqual([
      "email nie jest poprawnym adresem email",
    ]);
    expect(schemaDetails.get("age")).toEqual([
      "age musi wynosić co najmniej 18",
    ]);

    await app.close();
  });
});
