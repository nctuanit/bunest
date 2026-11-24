import type { OpenAPIObject } from "../../../../../../packages/swagger/src";

const OAS_30_31_HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

const OAS_32_HTTP_METHODS = new Set([...OAS_30_31_HTTP_METHODS, "query"]);

const PATH_ITEM_META_KEYS = new Set([
  "$ref",
  "summary",
  "description",
  "servers",
  "parameters",
  "additionalOperations",
]);

/**
 * Lightweight zero-dependency structural OpenAPI 3.0 / 3.1 / 3.2 validator
 * replacing `@apidevtools/swagger-parser` per ADR-001.
 */
export function validateOpenApiDocument(doc: OpenAPIObject): OpenAPIObject {
  if (!doc || typeof doc !== "object") {
    throw new Error("OpenAPI document must be an object");
  }
  if (typeof doc.openapi !== "string" || !/^\d+\.\d+\.\d+$/.test(doc.openapi)) {
    throw new Error(`Invalid openapi version: ${String(doc.openapi)}`);
  }
  if (
    !doc.info ||
    typeof doc.info.title !== "string" ||
    typeof doc.info.version !== "string"
  ) {
    throw new Error("OpenAPI document requires info.title and info.version");
  }
  if (!doc.paths || typeof doc.paths !== "object") {
    throw new Error("OpenAPI document requires paths object");
  }

  const [majorStr, minorStr] = doc.openapi.split(".");
  const major = Number(majorStr);
  const minor = Number(minorStr);
  const is31OrLater = major > 3 || (major === 3 && minor >= 1);
  const is32OrLater = major > 3 || (major === 3 && minor >= 2);
  const allowedMethods = is32OrLater
    ? OAS_32_HTTP_METHODS
    : OAS_30_31_HTTP_METHODS;

  const seenOpIds = new Set<string>();
  const componentSchemas = doc.components?.schemas ?? {};

  const validatePathItem = (pathKey: string, item: Record<string, any>) => {
    for (const [key, val] of Object.entries(item)) {
      if (PATH_ITEM_META_KEYS.has(key) || key.startsWith("x-")) {
        continue;
      }
      if (!allowedMethods.has(key)) {
        throw new Error(
          `Disallowed HTTP method "${key}" under "${pathKey}" for OpenAPI ${doc.openapi}`,
        );
      }
      if (val && typeof val === "object") {
        if (typeof val.operationId === "string") {
          if (seenOpIds.has(val.operationId)) {
            throw new Error(`Duplicate operationId "${val.operationId}"`);
          }
          seenOpIds.add(val.operationId);
        }
        if (!val.responses || typeof val.responses !== "object") {
          throw new Error(
            `Operation ${key.toUpperCase()} ${pathKey} missing responses`,
          );
        }
      }
    }
  };

  for (const [pathKey, item] of Object.entries(doc.paths)) {
    if (!pathKey.startsWith("/")) {
      throw new Error(`Path key "${pathKey}" must start with "/"`);
    }
    if (item && typeof item === "object") {
      validatePathItem(pathKey, item as Record<string, any>);
    }
  }

  if (doc.webhooks) {
    if (!is31OrLater) {
      throw new Error(`webhooks are not valid in OpenAPI ${doc.openapi}`);
    }
    for (const [hookKey, item] of Object.entries(doc.webhooks)) {
      if (item && typeof item === "object") {
        validatePathItem(`webhooks.${hookKey}`, item as Record<string, any>);
      }
    }
  }

  // Verify $ref targets inside components.schemas exist and no `nullable` remains in 3.1+
  const walk = (node: unknown, inPropsMap = false) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, false);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (!inPropsMap && typeof obj.$ref === "string") {
      const m = /^#\/components\/schemas\/(.+)$/.exec(obj.$ref);
      if (m && !(m[1]! in componentSchemas)) {
        throw new Error(`Unresolved schema $ref "${obj.$ref}"`);
      }
    }
    if (!inPropsMap && is31OrLater && "nullable" in obj) {
      throw new Error(
        `OpenAPI ${doc.openapi} document must not contain 3.0 "nullable" keyword`,
      );
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k === "example" || k === "default" || k.startsWith("x-")) {
        continue;
      }
      walk(v, k === "properties");
    }
  };
  walk(doc);

  return doc;
}
