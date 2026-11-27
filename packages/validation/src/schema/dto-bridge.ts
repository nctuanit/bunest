import type {
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1PathSegment,
  ValidationError,
} from "@bunest/core/common";

/**
 * Cross-package symbol key attaching a Standard Schema v1 instance onto a
 * DTO constructor produced by `createSchemaDto(schema)`.
 * Shared by `@bunest/validation` and `@bunest/swagger` via `Symbol.for()`
 * without introducing cross-package dependencies.
 */
export const STANDARD_SCHEMA_DTO_KEY = Symbol.for(
  "bunest:standard-schema-dto",
);

/**
 * Reflect metadata key mirrored alongside `STANDARD_SCHEMA_DTO_KEY` on
 * `createSchemaDto(schema)` classes.
 */
export const STANDARD_SCHEMA_DTO_METADATA_KEY = "bunest:standard-schema-dto";

/**
 * Internal non-enumerable symbol stamped on `createSchemaDto` instances by
 * `plainToInstance` so the validator engine can run the attached Standard
 * Schema against the exact original plain input and hydrate validated output
 * back onto the DTO instance.
 */
export const SCHEMA_DTO_RAW_INPUT_KEY = Symbol.for(
  "bunest:standard-schema-dto:raw-input",
);

function isStandardSchemaLike(
  value: unknown,
): value is StandardSchemaV1<unknown, unknown> {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    return false;
  }
  const std = (value as Record<string, unknown>)["~standard"];
  if (typeof std !== "object" || std === null) {
    return false;
  }
  const props = std as Record<string, unknown>;
  return props.version === 1 && typeof props.validate === "function";
}

/**
 * Extracts the attached `StandardSchemaV1` from a `createSchemaDto` class
 * (or any subclass extending it), checking `STANDARD_SCHEMA_DTO_KEY` first
 * and falling back to `Reflect.getMetadata("bunest:standard-schema-dto", target)`.
 */
export function getStandardSchemaFromDto(
  target: unknown,
): StandardSchemaV1<unknown, unknown> | undefined {
  if (typeof target !== "function") {
    return undefined;
  }

  const bySymbol = (target as unknown as Record<PropertyKey, unknown>)[
    STANDARD_SCHEMA_DTO_KEY
  ];
  if (isStandardSchemaLike(bySymbol)) {
    return bySymbol;
  }

  if (
    typeof Reflect !== "undefined" &&
    typeof Reflect.getMetadata === "function"
  ) {
    const byReflect = Reflect.getMetadata(
      STANDARD_SCHEMA_DTO_METADATA_KEY,
      target,
    );
    if (isStandardSchemaLike(byReflect)) {
      return byReflect;
    }
  }

  return undefined;
}

export function isStandardSchemaDto(target: unknown): boolean {
  return getStandardSchemaFromDto(target) !== undefined;
}

function normalizePathSegment(
  segment: PropertyKey | StandardSchemaV1PathSegment,
): string {
  const raw =
    typeof segment === "object" && segment !== null && "key" in segment
      ? segment.key
      : segment;
  if (typeof raw === "symbol") {
    return raw.description ?? String(raw);
  }
  return String(raw);
}

/**
 * Converts Standard Schema v1 issues into a `ValidationError[]` tree compatible
 * with `ValidationPipe`'s ADR-009 `"bunest"`, `"list"`, and `"grouped"` formatters.
 */
export function standardSchemaIssuesToValidationErrors(
  issues: readonly StandardSchemaV1Issue[],
  options?: { readonly stopAtFirstError?: boolean },
): ValidationError[] {
  if (issues.length === 0) {
    return [
      {
        property: "",
        children: [],
        constraints: { standardSchema: "Validation failed" },
      },
    ];
  }

  interface TreeNode {
    property: string;
    constraints?: Record<string, string>;
    childrenMap: Map<string, TreeNode>;
  }

  const rootMap = new Map<string, TreeNode>();

  const getOrCreateNode = (
    map: Map<string, TreeNode>,
    property: string,
  ): TreeNode => {
    let node = map.get(property);
    if (!node) {
      node = { property, childrenMap: new Map() };
      map.set(property, node);
    }
    return node;
  };

  const addConstraint = (node: TreeNode, message: string): void => {
    if (!node.constraints) {
      node.constraints = { standardSchema: message };
      return;
    }
    if (options?.stopAtFirstError) {
      return;
    }
    let key = "standardSchema";
    let suffix = 2;
    while (Object.prototype.hasOwnProperty.call(node.constraints, key)) {
      key = `standardSchema_${suffix++}`;
    }
    node.constraints[key] = message;
  };

  const count = options?.stopAtFirstError ? 1 : issues.length;
  for (let i = 0; i < count; i++) {
    const issue = issues[i];
    if (!issue) continue;
    const message =
      typeof issue.message === "string" && issue.message.length > 0
        ? issue.message
        : "Invalid value";

    const segments =
      Array.isArray(issue.path) && issue.path.length > 0
        ? issue.path.map(normalizePathSegment)
        : [""];

    let currentMap = rootMap;
    let leaf: TreeNode | undefined;
    for (let s = 0; s < segments.length; s++) {
      leaf = getOrCreateNode(currentMap, segments[s]!);
      currentMap = leaf.childrenMap;
    }
    if (leaf) {
      addConstraint(leaf, message);
    }
  }

  const toValidationError = (node: TreeNode): ValidationError => {
    const children: ValidationError[] = [];
    for (const child of node.childrenMap.values()) {
      children.push(toValidationError(child));
    }
    return {
      property: node.property,
      children,
      ...(node.constraints ? { constraints: node.constraints } : {}),
    };
  };

  const errors: ValidationError[] = [];
  for (const node of rootMap.values()) {
    errors.push(toValidationError(node));
  }
  return errors;
}

/**
 * Synchronizes a validated/transformed Standard Schema output object onto a
 * `createSchemaDto` class instance (stripping unknown keys, applying defaults
 * and coerced/transformed values while preserving prototype & methods).
 */
export function applySchemaOutputToInstance(
  instance: object,
  output: unknown,
): void {
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return;
  }
  const target = instance as Record<string, unknown>;
  const source = output as Record<string, unknown>;

  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      delete target[key];
    }
  }

  for (const key of Object.keys(source)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    target[key] = source[key];
  }
}
