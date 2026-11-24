import type { AiSchema } from "../interfaces/ai-schema.interface";
import { AiConfigurationError } from "../errors/ai.errors";

/** JSON Schema drafts, in order of preference. */
const TARGETS = ["draft-07", "draft-2020-12"] as const;

export interface ModelSchemaValidationSuccess<T = unknown> {
  success: true;
  value: T;
}

export interface ModelSchemaValidationFailure {
  success: false;
  error: Error;
}

export type ModelSchemaValidationResult<T = unknown> =
  ModelSchemaValidationSuccess<T> | ModelSchemaValidationFailure;

export interface ModelSchema<T = unknown> {
  readonly jsonSchema: Record<string, unknown>;
  readonly validate?: (
    value: unknown,
  ) => Promise<ModelSchemaValidationResult<T>>;
}

const converted = new WeakMap<AiSchema, ModelSchema<any>>();

/** The schema of a tool without arguments. */
export const EMPTY_OBJECT_SCHEMA: ModelSchema<Record<string, never>> = {
  jsonSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

/**
 * Converts a Standard Schema with JSON Schema into a validated `ModelSchema`.
 */
export function toModelSchema<T = unknown>(
  schema: AiSchema,
  where: string,
  { object = false }: { object?: boolean } = {},
): ModelSchema<T> {
  if (schema && typeof schema === "object") {
    const cached = converted.get(schema);
    if (cached) {
      if (
        object &&
        cached.jsonSchema.type !== undefined &&
        cached.jsonSchema.type !== "object"
      ) {
        throw new AiConfigurationError(
          `${where}: arguments are an object, and this schema describes ${JSON.stringify(cached.jsonSchema.type)}. Wrap it in an object schema.`,
        );
      }
      return cached as ModelSchema<T>;
    }
  }

  const standard = schema?.["~standard"];
  if (!standard || typeof standard.validate !== "function") {
    throw new AiConfigurationError(
      `${where}: not a Standard Schema. Pass a Zod 4.2+ schema, an ArkType type, a Valibot schema wrapped with toStandardJsonSchema(), or any Standard Schema v1 with ~standard.jsonSchema.`,
    );
  }

  if (typeof standard.jsonSchema?.input !== "function") {
    throw new AiConfigurationError(
      `${where}: the "${standard.vendor}" schema cannot produce JSON Schema (no ~standard.jsonSchema), which the model needs.`,
    );
  }

  let root: Record<string, unknown> | undefined;
  let failure: unknown;
  for (const target of TARGETS) {
    try {
      root = standard.jsonSchema.input({ target });
      break;
    } catch (error) {
      failure = error;
    }
  }

  if (!root) {
    throw new AiConfigurationError(
      `${where}: the schema cannot be converted to JSON Schema: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
  }

  if (object && root.type !== undefined && root.type !== "object") {
    throw new AiConfigurationError(
      `${where}: arguments are an object, and this schema describes ${JSON.stringify(root.type)}. Wrap it in an object schema.`,
    );
  }

  const result: ModelSchema<T> = {
    jsonSchema: root,
    async validate(value: unknown): Promise<ModelSchemaValidationResult<T>> {
      const outcome = await standard.validate(value);
      if ("issues" in outcome && outcome.issues) {
        return {
          success: false,
          error: new TypeError(formatIssues(outcome.issues)),
        };
      }
      return {
        success: true,
        value: (outcome as { value: T }).value,
      };
    },
  };

  converted.set(schema, result);
  return result;
}

/** Validation issues as one line each, with their path: what the model reads to correct itself. */
export function formatIssues(
  issues: ReadonlyArray<{
    readonly message: string;
    readonly path?:
      ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
  }>,
): string {
  return issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((segment) =>
          String(
            typeof segment === "object" && segment !== null && "key" in segment
              ? segment.key
              : segment,
          ),
        )
        .join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("\n");
}
