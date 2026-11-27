import { MetadataRegistry, isStandardSchema } from "@bunest/core";
import type { McpSchema, McpSchemaInput } from "../interfaces/mcp-types";
import {
  STANDARD_SCHEMA_DTO_KEY,
  STANDARD_SCHEMA_DTO_METADATA_KEY,
} from "../mcp.constants";

export interface PreparedMcpSchema {
  readonly schema: McpSchema;
  readonly jsonSchema: Record<string, unknown>;
}

const preparedCache = new WeakMap<McpSchema, Record<string, unknown>>();
const JSON_SCHEMA_TARGETS = [
  "draft-2020-12",
  "draft-07",
  "openapi-3.0",
] as const;

/**
 * Unwraps either a Standard Schema v1 object or a `createSchemaDto(schema)` DTO
 * class constructor (via `Symbol.for("bunest:standard-schema-dto")` with Reflect
 * metadata fallback) into the underlying `McpSchema`, without depending on
 * `@bunest/validation`.
 */
export function unwrapStandardSchemaDto(input: unknown): McpSchema | undefined {
  if (isStandardSchema(input)) {
    return input as McpSchema;
  }
  if (typeof input === "function") {
    const bySymbol = (input as unknown as Record<PropertyKey, unknown>)[
      STANDARD_SCHEMA_DTO_KEY
    ];
    if (isStandardSchema(bySymbol)) {
      return bySymbol as McpSchema;
    }
    const byReflect = MetadataRegistry.get<unknown>(
      STANDARD_SCHEMA_DTO_METADATA_KEY,
      input,
    );
    if (isStandardSchema(byReflect)) {
      return byReflect as McpSchema;
    }
  }
  return undefined;
}

function emitJsonSchema(
  schema: McpSchema,
  io: "input" | "output",
): Record<string, unknown> {
  const std = schema["~standard"];
  const fn =
    io === "output"
      ? (std.jsonSchema?.output ?? std.jsonSchema?.input)
      : (std.jsonSchema?.input ?? std.jsonSchema?.output);
  if (typeof fn !== "function") {
    return { type: "object", properties: {} };
  }
  for (const target of JSON_SCHEMA_TARGETS) {
    try {
      const out = fn({ target });
      if (out && typeof out === "object") {
        return out;
      }
    } catch {
      // Try next supported JSON Schema draft target
    }
  }
  return { type: "object", properties: {} };
}

export function getSchemaJson(
  schema: McpSchemaInput | undefined,
  io: "input" | "output" = "input",
): Record<string, unknown> {
  if (!schema) {
    return { type: "object", properties: {} };
  }
  const unwrapped = unwrapStandardSchemaDto(schema);
  if (!unwrapped) {
    return { type: "object", properties: {} };
  }
  const cached = preparedCache.get(unwrapped);
  if (cached) {
    return cached;
  }
  return emitJsonSchema(unwrapped, io);
}

/**
 * Validates that `schema` is a Standard Schema v1 (or a `createSchemaDto(schema)`
 * DTO class constructor), unwraps it, and caches its JSON Schema representation.
 */
export function prepareSchema(
  schema: McpSchemaInput,
  where: string,
  io: "input" | "output",
): McpSchema {
  const unwrapped = unwrapStandardSchemaDto(schema);
  if (!unwrapped) {
    throw new TypeError(
      `${where}: ${io}Schema must be a Standard Schema v1 object (with "~standard.validate") or a createSchemaDto(schema) class.`,
    );
  }
  const json = emitJsonSchema(unwrapped, io);
  if (io === "input" && json.type !== undefined && json.type !== "object") {
    throw new TypeError(
      `${where}: ${io}Schema must describe an object (got JSON Schema type "${String(json.type)}").`,
    );
  }
  preparedCache.set(unwrapped, json);
  return unwrapped;
}

export async function validateWithSchema(
  schema: McpSchema,
  value: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const result = await schema["~standard"].validate(value);
  if (result.issues && result.issues.length > 0) {
    const msg = result.issues
      .map((issue) => {
        const path = issue.path
          ?.map((seg) =>
            typeof seg === "object" && seg !== null && "key" in seg
              ? String(seg.key)
              : String(seg),
          )
          .join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
    return { ok: false, message: msg || "Validation failed" };
  }
  return {
    ok: true,
    value: "value" in result ? result.value : value,
  };
}
