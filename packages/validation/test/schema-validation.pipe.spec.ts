import { describe, expect, it } from "bun:test";
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  UnprocessableEntityException,
  type ValidationErrorResponse,
} from "@bunest/core";
import {
  SchemaValidationPipe,
  type SchemaValidationIssue,
  type SchemaValidator,
} from "../src";

interface ParsedOrder {
  email: string;
  items: Array<{ sku: string; quantity: number }>;
}

/**
 * Zod-compatible schema mock implementing `safeParse` and `parse`.
 */
const orderZodLikeSchema: SchemaValidator<ParsedOrder> = {
  safeParse(input: unknown) {
    const issues: SchemaValidationIssue[] = [];

    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return {
        success: false,
        error: {
          issues: [
            { path: [], code: "invalid_type", message: "Expected object" },
          ],
        },
      };
    }

    const obj = input as Record<string, unknown>;
    if (typeof obj.email !== "string" || !obj.email.includes("@")) {
      issues.push({
        path: ["email"],
        code: "invalid_string",
        message: "Invalid email",
      });
    }

    if (!Array.isArray(obj.items)) {
      issues.push({
        path: ["items"],
        code: "invalid_type",
        message: "Expected array",
      });
    } else {
      obj.items.forEach((item, idx) => {
        const rec = item as Record<string, unknown>;
        if (typeof rec?.sku !== "string" || rec.sku.length === 0) {
          issues.push({
            path: ["items", idx, "sku"],
            code: "too_small",
            message: "sku is required",
          });
        }
        if (typeof rec?.quantity !== "number" || rec.quantity < 1) {
          issues.push({
            path: ["items", idx, "quantity"],
            code: "too_small",
            message: "quantity must be >= 1",
          });
        }
      });
    }

    if (issues.length > 0) {
      return { success: false, error: { issues } };
    }

    return {
      success: true,
      data: {
        email: (obj.email as string).trim().toLowerCase(),
        items: obj.items as Array<{ sku: string; quantity: number }>,
      },
    };
  },
};

function getValidationBody(err: unknown): ValidationErrorResponse {
  expect(err).toBeInstanceOf(HttpException);
  return (
    err as HttpException
  ).getResponse() as unknown as ValidationErrorResponse;
}

describe("SchemaValidationPipe", () => {
  it("validates and transforms payloads via safeParse (Zod/Valibot style)", async () => {
    const pipe = new SchemaValidationPipe(orderZodLikeSchema);
    const result = await pipe.transform(
      {
        email: "  Alice@Example.com ",
        items: [{ sku: "BOOK-1", quantity: 2 }],
      },
      { type: "body" },
    );

    expect(result).toEqual({
      email: "alice@example.com",
      items: [{ sku: "BOOK-1", quantity: 2 }],
    });
  });

  it("normalizes schema issues into ADR-009 ValidationErrorResponse with dot/bracket paths", async () => {
    const pipe = new SchemaValidationPipe(orderZodLikeSchema);

    try {
      await pipe.transform(
        {
          email: "invalid",
          items: [{ sku: "", quantity: 0 }],
        },
        { type: "body" },
      );
      throw new Error("Expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const body = getValidationBody(err);
      expect(body).toEqual({
        statusCode: 400,
        error: "Bad Request",
        message: "Validation failed",
        details: [
          {
            field: "email",
            constraints: { invalid_string: "Invalid email" },
            messages: ["Invalid email"],
          },
          {
            field: "items[0].sku",
            constraints: { too_small: "sku is required" },
            messages: ["sku is required"],
          },
          {
            field: "items[0].quantity",
            constraints: { too_small: "quantity must be >= 1" },
            messages: ["quantity must be >= 1"],
          },
        ],
      });
    }
  });

  it("prefers safeParseAsync over sync safeParse for async refinements", async () => {
    const asyncSchema: SchemaValidator<{ username: string }> = {
      safeParse() {
        throw new Error(
          "sync safeParse should not be called when safeParseAsync exists",
        );
      },
      async safeParseAsync(input: unknown) {
        await Bun.sleep(5);
        const rec = input as Record<string, unknown>;
        if (rec?.username === "taken") {
          return {
            success: false,
            error: {
              issues: [
                {
                  path: ["username"],
                  code: "custom",
                  message: "username is already taken",
                },
                {
                  path: ["username"],
                  code: "custom",
                  message: "choose a different username",
                },
              ],
            },
          };
        }
        return {
          success: true,
          data: { username: String(rec?.username ?? "") },
        };
      },
    };

    const pipe = new SchemaValidationPipe(asyncSchema);
    expect(
      await pipe.transform({ username: "alice" }, { type: "body" }),
    ).toEqual({ username: "alice" });

    try {
      await pipe.transform({ username: "taken" }, { type: "body" });
      throw new Error("Expected rejection");
    } catch (err) {
      const body = getValidationBody(err);
      expect(body.details).toEqual([
        {
          field: "username",
          constraints: {
            custom: "username is already taken",
            custom_2: "choose a different username",
          },
          messages: [
            "username is already taken",
            "choose a different username",
          ],
        },
      ]);
    }
  });

  it("supports parse-only and parseAsync-only custom validators", async () => {
    const parseOnlySchema: SchemaValidator<number> = {
      parse(input: unknown): number {
        if (typeof input !== "number" || input <= 0) {
          throw new Error("must be a positive number");
        }
        return input * 2;
      },
    };

    const pipe = new SchemaValidationPipe(parseOnlySchema, {
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    });
    expect(await pipe.transform(21, { type: "param", data: "count" })).toBe(42);

    try {
      await pipe.transform(-5, { type: "param", data: "count" });
      throw new Error("Expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      const body = getValidationBody(err);
      expect(body.statusCode).toBe(422);
      expect(body.details).toEqual([
        {
          field: "count",
          constraints: { schemaValidation: "must be a positive number" },
          messages: ["must be a positive number"],
        },
      ]);
    }
  });

  it("rejects prototype pollution payloads before invoking the schema validator", async () => {
    let called = false;
    const schema: SchemaValidator<unknown> = {
      safeParse(input: unknown) {
        called = true;
        return { success: true, data: input };
      },
    };

    const pipe = new SchemaValidationPipe(schema);
    const malicious = JSON.parse('{"name":"ok","__proto__":{"polluted":true}}');

    try {
      await pipe.transform(malicious, { type: "body" });
      throw new Error("Expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect(called).toBe(false);
      const body = getValidationBody(err);
      expect(body.details[0]?.field).toBe("__proto__");
    }
  });

  it("supports disableErrorMessages, validateCustomDecorators, custom exceptionFactory, and fails fast on invalid schema", async () => {
    expect(
      () => new SchemaValidationPipe({} as SchemaValidator<unknown>),
    ).toThrow(TypeError);

    const pipe = new SchemaValidationPipe(orderZodLikeSchema, {
      disableErrorMessages: true,
    });

    // Skips custom decorators by default
    const passthrough: unknown = await pipe.transform("raw", {
      type: "custom",
    });
    expect(passthrough).toBe("raw");

    try {
      await pipe.transform({ email: "bad" }, { type: "body" });
      throw new Error("Expected rejection");
    } catch (err) {
      expect((err as HttpException).getResponse()).toEqual({
        statusCode: 400,
        error: "Bad Request",
        message: "Bad Request",
      });
    }

    const customPipe = new SchemaValidationPipe(orderZodLikeSchema, {
      validateCustomDecorators: true,
      exceptionFactory: (_error, details) =>
        new Error(`SCHEMA_FAIL:${details.length}`),
    });

    try {
      await customPipe.transform({ email: "bad" }, { type: "custom" });
      throw new Error("Expected rejection");
    } catch (err) {
      expect((err as Error).message).toBe("SCHEMA_FAIL:2");
    }
  });
});
