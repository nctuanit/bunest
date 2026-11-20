import "reflect-metadata";
import type {
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1Options,
  StandardSchemaV1Result,
} from "../../../../../packages/common/src";

export function createStandardSchema<
  TOutput extends object = Record<string, unknown>,
>(
  validate: (
    value: unknown,
    options?: StandardSchemaV1Options,
  ) => StandardSchemaV1Result<TOutput> | Promise<StandardSchemaV1Result<TOutput>>,
  vendor = "test",
): StandardSchemaV1<Record<string, unknown>, TOutput> {
  return {
    "~standard": {
      version: 1,
      vendor,
      validate,
    },
  };
}

/**
 * Zero-dependency Standard Schema v1 equivalent of:
 * ```ts
 * Joi.object({
 *   PORT: Joi.number().required(),
 *   DATABASE_NAME: Joi.string().required(),
 * })
 * ```
 * Supports `options?.libraryOptions?.allowUnknown === false`, `.describe()`, and reports all issues.
 */
export function createJoiLikePortDbSchema(): StandardSchemaV1<
  Record<string, unknown>,
  Record<string, unknown>
> {
  const allowedKeys = new Set(["PORT", "DATABASE_NAME"]);

  const schema = createStandardSchema<Record<string, unknown>>(
    (raw: unknown, options?: StandardSchemaV1Options) => {
      const rec =
        raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const issues: StandardSchemaV1Issue[] = [];
      const allowUnknown = options?.libraryOptions?.allowUnknown !== false;

      const rawPort = rec.PORT;
      let parsedPort: number | undefined;
      if (rawPort === undefined || rawPort === "") {
        issues.push({ message: '"PORT" is required', path: ["PORT"] });
      } else {
        const n = typeof rawPort === "number" ? rawPort : Number(rawPort);
        if (Number.isNaN(n)) {
          issues.push({ message: '"PORT" must be a number', path: ["PORT"] });
        } else {
          parsedPort = n;
        }
      }

      const rawDb = rec.DATABASE_NAME;
      if (rawDb === undefined || rawDb === "") {
        issues.push({
          message: '"DATABASE_NAME" is required',
          path: ["DATABASE_NAME"],
        });
      } else if (typeof rawDb !== "string") {
        issues.push({
          message: '"DATABASE_NAME" must be a string',
          path: ["DATABASE_NAME"],
        });
      }

      if (!allowUnknown) {
        for (const key of Object.keys(rec)) {
          if (!allowedKeys.has(key)) {
            issues.push({
              message: `"${key}" is not allowed`,
              path: [key],
            });
          }
        }
      }

      if (issues.length > 0) {
        return { issues };
      }

      return {
        value: {
          ...(allowUnknown ? rec : {}),
          PORT: parsedPort,
          DATABASE_NAME: rawDb as string,
        },
      };
    },
    "joi",
  );

  return Object.assign(schema, {
    describe: () => ({ keys: { PORT: {}, DATABASE_NAME: {} } }),
  });
}

/**
 * Zero-dependency Standard Schema v1 equivalent of Zod v3 / v4 / v4 mini schemas:
 * strips undeclared keys from `value`, transforms `PORT` to number, and reports all issues.
 */
export function createZodLikePortDbSchema(
  variant: "zod-v3" | "zod-v4" | "zod-v4-mini",
): StandardSchemaV1<Record<string, unknown>, { PORT: number; DATABASE_NAME: string }> {
  const schema = createStandardSchema<{ PORT: number; DATABASE_NAME: string }>(
    (raw: unknown) => {
      const rec =
        raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const issues: StandardSchemaV1Issue[] = [];

      let parsedPort: number | undefined;
      if (variant === "zod-v4-mini") {
        if (rec.PORT === undefined) {
          issues.push({
            message: "Invalid input: expected number, received NaN",
            path: ["PORT"],
          });
        } else {
          const coerced = Number(rec.PORT);
          if (Number.isNaN(coerced)) {
            issues.push({
              message: "Invalid input: expected number, received NaN",
              path: ["PORT"],
            });
          } else {
            parsedPort = coerced;
          }
        }
      } else {
        if (typeof rec.PORT !== "string") {
          issues.push({
            message: "Expected string, received undefined",
            path: ["PORT"],
          });
        } else {
          parsedPort = Number.parseInt(rec.PORT, 10);
        }
      }

      if (typeof rec.DATABASE_NAME !== "string") {
        issues.push({
          message: "Expected string, received undefined",
          path: ["DATABASE_NAME"],
        });
      }

      if (issues.length > 0) {
        return { issues };
      }

      return {
        value: {
          PORT: parsedPort!,
          DATABASE_NAME: rec.DATABASE_NAME as string,
        },
      };
    },
    "zod",
  );

  return Object.assign(schema, { shape: { PORT: {}, DATABASE_NAME: {} } });
}

/**
 * Zero-dependency Standard Schema v1 equivalent of `v.object({ PORT: v.string() })`.
 */
export function createValibotLikePortSchema(): StandardSchemaV1<
  Record<string, unknown>,
  { PORT: string }
> {
  const schema = createStandardSchema<{ PORT: string }>((raw: unknown) => {
    const rec =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    if (typeof rec.PORT !== "string") {
      return {
        issues: [
          {
            message: "Invalid type: Expected string but received undefined",
            path: ["PORT"],
          },
        ],
      };
    }
    return { value: { PORT: rec.PORT } };
  }, "valibot");

  return Object.assign(schema, { entries: { PORT: {} } });
}
