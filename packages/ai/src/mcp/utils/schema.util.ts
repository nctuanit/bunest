import { isStandardSchema } from "@bunest/core";
import type { McpSchema } from "../interfaces/mcp-types";

export interface PreparedMcpSchema {
  readonly schema: McpSchema;
  readonly jsonSchema: Record<string, unknown>;
}

const preparedCache = new WeakMap<McpSchema, Record<string, unknown>>();

export function getSchemaJson(
  schema: McpSchema | undefined,
  io: "input" | "output" = "input",
): Record<string, unknown> {
  if (!schema) {
    return { type: "object", properties: {} };
  }
  const cached = preparedCache.get(schema);
  if (cached) {
    return cached;
  }
  const std = schema["~standard"];
  const fn = io === "output" ? std.jsonSchema?.output : std.jsonSchema?.input;
  if (typeof fn === "function") {
    const out = fn({ target: "draft-2020-12" });
    if (out && typeof out === "object") {
      return out;
    }
  }
  return { type: "object", properties: {} };
}

/**
 * Validates that `schema` is a Standard Schema and caches its JSON Schema representation.
 */
export function prepareSchema(
  schema: McpSchema,
  where: string,
  io: "input" | "output",
): McpSchema {
  if (!isStandardSchema(schema)) {
    throw new TypeError(
      `${where}: ${io}Schema must be a Standard Schema v1 object (with "~standard.validate").`,
    );
  }
  const std = schema["~standard"];
  const jsonFn =
    io === "output"
      ? (std.jsonSchema?.output ?? std.jsonSchema?.input)
      : std.jsonSchema?.input;
  let json: Record<string, unknown> = { type: "object", properties: {} };
  if (typeof jsonFn === "function") {
    const generated = jsonFn({ target: "draft-2020-12" });
    if (generated && typeof generated === "object") {
      json = generated;
    }
  }
  if (io === "input" && json.type !== undefined && json.type !== "object") {
    throw new TypeError(
      `${where}: ${io}Schema must describe an object (got JSON Schema type "${String(json.type)}").`,
    );
  }
  preparedCache.set(schema, json);
  return schema;
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
