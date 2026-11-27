import {
  Logger,
  MetadataRegistry,
  StreamableFile,
  getEntitySchema,
  getValidationMetadatasForTarget,
  hasEntitySchema,
  type EntityColumnMetadata,
  type Type,
} from "@bunest/core";
import { SWAGGER_METADATA_KEYS } from "./constants";
import type {
  ApiPropertyMetadata,
  ApiPropertyOptions,
  ApiSchemaOptions,
  ApiTypeInput,
  DiscriminatorObject,
  EnumSchemaAttributes,
  OpenApiSchema,
  OpenApiSchemaType,
  ReferenceObject,
  SchemaObject,
  StandardJSONSchemaV1,
  StandardSchemaConversionResult,
  StandardSchemaConverter,
  SwaggerEnumType,
} from "./interfaces/openapi.interface";
import { getPluginModelMetadata } from "./plugin-metadata-store";
import {
  SWAGGER_GENERIC_TYPE_META,
  SWAGGER_UNION_TYPE_META,
  getGenericTypeMetas,
  getUnionTypeMeta,
  type SwaggerGenericTypeMeta,
} from "./type-helpers/generic-type.helper";
import {
  SWAGGER_MAPPED_TYPE_META,
  type SwaggerMappedTypeMeta,
} from "./type-helpers/mapped-types.helper";

const BUILTIN_PRIMITIVE_CONSTRUCTORS = new Set<Function>([
  String,
  Number,
  Boolean,
  Object,
  Array,
  Date,
  Function,
  Symbol,
  BigInt,
  Promise,
  RegExp,
  Map,
  Set,
  Error,
  Uint8Array,
  ArrayBuffer,
  Blob,
  File,
  Response,
  Request,
  ReadableStream,
  StreamableFile,
]);

export function isDtoConstructor(value: unknown): value is Type<unknown> {
  if (typeof value !== "function") {
    return false;
  }
  if (BUILTIN_PRIMITIVE_CONSTRUCTORS.has(value)) {
    return false;
  }
  return Boolean(value.prototype);
}

const API_PROPERTY_EXPLICIT_REQUIRED = Symbol.for(
  "bunest:swagger:explicit_required",
);

const TRANSFORMER_STORAGE_SYMBOL = Symbol.for(
  "bunest:class-transformer:storage",
);

interface TransformerExposeMetaLike {
  readonly target: Function;
  readonly propertyName: string | undefined;
  readonly options?: {
    readonly name?: string;
    readonly toClassOnly?: boolean;
    readonly toPlainOnly?: boolean;
  };
}

interface TransformerExcludeMetaLike {
  readonly target: Function;
  readonly propertyName: string | undefined;
  readonly options?: {
    readonly toClassOnly?: boolean;
    readonly toPlainOnly?: boolean;
  };
}

interface TransformerTypeMetaLike {
  readonly target: Function;
  readonly propertyName: string;
  readonly reflectedType?: Function;
  readonly typeFunction?: (options?: unknown) => unknown;
}

interface TransformerMetadataStorageLike {
  hasTargetMetadata?(target: Function): boolean;
  hasMetadataFor?(target: Function): boolean;
  getStrategy?(target: Function): "excludeAll" | "exposeAll" | "none";
  getExposedMetadatas?(target: Function): TransformerExposeMetaLike[];
  getExcludedMetadatas?(target: Function): TransformerExcludeMetaLike[];
  findTypeMetadata?(
    target: Function,
    propertyName: string,
  ): TransformerTypeMetaLike | undefined;
  getDecoratedPropertyNames?(target: Function): string[];
}

function getTransformerStorage(): TransformerMetadataStorageLike | undefined {
  const g = globalThis as Record<PropertyKey, unknown>;
  const storage = g[TRANSFORMER_STORAGE_SYMBOL];
  if (storage && typeof storage === "object") {
    return storage as TransformerMetadataStorageLike;
  }
  return undefined;
}

function hasTransformerMetadata(target: Function): boolean {
  try {
    const storage = getTransformerStorage();
    if (!storage) return false;
    if (typeof storage.hasTargetMetadata === "function") {
      return storage.hasTargetMetadata(target);
    }
    if (typeof storage.hasMetadataFor === "function") {
      return storage.hasMetadataFor(target);
    }
    return false;
  } catch {
    return false;
  }
}

interface ExtractedTransformerHints {
  readonly excludeAll: boolean;
  readonly exposedProperties: Set<string>;
  readonly excludedProperties: Set<string>;
  readonly renamedProperties: Map<string, string>;
  readonly typeResolvers: Map<string, (options?: unknown) => unknown>;
}

function extractTransformerHints(dto: Function): ExtractedTransformerHints {
  const exposedProperties = new Set<string>();
  const excludedProperties = new Set<string>();
  const renamedProperties = new Map<string, string>();
  const typeResolvers = new Map<string, (options?: unknown) => unknown>();
  let excludeAll = false;

  try {
    const storage = getTransformerStorage();
    if (!storage) {
      return {
        excludeAll,
        exposedProperties,
        excludedProperties,
        renamedProperties,
        typeResolvers,
      };
    }

    if (typeof storage.getStrategy === "function") {
      excludeAll = storage.getStrategy(dto) === "excludeAll";
    }

    const exposed = storage.getExposedMetadatas?.(dto) ?? [];
    for (let i = 0; i < exposed.length; i++) {
      const meta = exposed[i];
      if (!meta || meta.propertyName === undefined) continue;
      exposedProperties.add(meta.propertyName);
      if (meta.options?.name !== undefined) {
        renamedProperties.set(meta.propertyName, meta.options.name);
      }
    }

    const excluded = storage.getExcludedMetadatas?.(dto) ?? [];
    for (let i = 0; i < excluded.length; i++) {
      const meta = excluded[i];
      if (!meta || meta.propertyName === undefined) continue;
      excludedProperties.add(meta.propertyName);
    }

    const decoratedNames = storage.getDecoratedPropertyNames?.(dto) ?? [];
    for (let i = 0; i < decoratedNames.length; i++) {
      const propName = decoratedNames[i]!;
      const typeMeta = storage.findTypeMetadata?.(dto, propName);
      if (typeMeta && typeof typeMeta.typeFunction === "function") {
        typeResolvers.set(propName, typeMeta.typeFunction);
      }
    }
  } catch {
    // Gracefully skip if @bunest/validation/transformer metadata storage is unavailable
  }

  return {
    excludeAll,
    exposedProperties,
    excludedProperties,
    renamedProperties,
    typeResolvers,
  };
}

const STANDARD_SCHEMA_DTO_KEY = Symbol.for("bunest:standard-schema-dto");
const STANDARD_SCHEMA_DTO_METADATA_KEY = "bunest:standard-schema-dto";

function isStandardSchemaCandidate(value: unknown): boolean {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    return false;
  }
  const std = (value as Record<string, unknown>)["~standard"];
  return typeof std === "object" && std !== null;
}

/**
 * Extracts a Standard Schema attached to a `createSchemaDto(schema)` DTO class
 * via `Symbol.for("bunest:standard-schema-dto")` (with Reflect metadata fallback)
 * without importing `@bunest/validation`.
 */
export function getStandardSchemaFromDto(target: unknown): unknown {
  if (typeof target !== "function") {
    return undefined;
  }
  const bySymbol = (target as unknown as Record<PropertyKey, unknown>)[
    STANDARD_SCHEMA_DTO_KEY
  ];
  if (isStandardSchemaCandidate(bySymbol)) {
    return bySymbol;
  }
  const byReflect = MetadataRegistry.get<unknown>(
    STANDARD_SCHEMA_DTO_METADATA_KEY,
    target,
  );
  if (isStandardSchemaCandidate(byReflect)) {
    return byReflect;
  }
  return undefined;
}

function isLazyTypeThunk(
  value: unknown,
): value is () => Type<any> | Function | [Function] {
  if (typeof value !== "function") {
    return false;
  }
  if (BUILTIN_PRIMITIVE_CONSTRUCTORS.has(value)) {
    return false;
  }
  if (value.prototype === undefined) {
    return true;
  }
  const src = Function.prototype.toString.call(value).trimStart();
  if (src.startsWith("class ") || src.startsWith("class{")) {
    return false;
  }
  if (
    MetadataRegistry.hasOwn(SWAGGER_METADATA_KEYS.API_PROPERTIES, value) ||
    MetadataRegistry.hasOwn(SWAGGER_METADATA_KEYS.API_SCHEMA, value) ||
    hasEntitySchema(value) ||
    getStandardSchemaFromDto(value) !== undefined ||
    hasClassValidatorMetadata(value) ||
    hasTransformerMetadata(value) ||
    Object.getOwnPropertyNames(value.prototype).length > 1
  ) {
    return false;
  }
  return value.length === 0 && !/^[A-Z]/.test(value.name);
}

function hasClassValidatorMetadata(target: Function): boolean {
  try {
    return getValidationMetadatasForTarget(target, false, false).length > 0;
  } catch {
    return false;
  }
}

/**
 * Returns `true` when `target` is a decorated DTO, `createSchemaDto` class, or
 * `@Entity()` class carrying Swagger `@ApiProperty`/`@ApiSchema`, Bunest `@Entity`,
 * Standard Schema DTO metadata, `@bunest/validation`, or CLI plugin model metadata.
 */
export function isSchemaDecoratedClass(target: Function): boolean {
  if (hasEntitySchema(target)) {
    return true;
  }
  if (getStandardSchemaFromDto(target) !== undefined) {
    return true;
  }
  for (const ctor of MetadataRegistry.getPrototypeChain(target)) {
    if (
      MetadataRegistry.hasOwn(SWAGGER_METADATA_KEYS.API_PROPERTIES, ctor) ||
      MetadataRegistry.hasOwn(SWAGGER_METADATA_KEYS.API_SCHEMA, ctor) ||
      getPluginModelMetadata(ctor) !== undefined ||
      Object.prototype.hasOwnProperty.call(ctor, SWAGGER_MAPPED_TYPE_META) ||
      Object.prototype.hasOwnProperty.call(ctor, SWAGGER_GENERIC_TYPE_META) ||
      Object.prototype.hasOwnProperty.call(ctor, SWAGGER_UNION_TYPE_META) ||
      (Object.prototype.hasOwnProperty.call(ctor, "_OPENAPI_METADATA_FACTORY") &&
        typeof (ctor as { _OPENAPI_METADATA_FACTORY?: unknown })
          ._OPENAPI_METADATA_FACTORY === "function")
    ) {
      return true;
    }
  }
  return hasClassValidatorMetadata(target) || hasTransformerMetadata(target);
}

function isOptionalEntityColumn(col: EntityColumnMetadata): boolean {
  return (
    col.nullable ||
    col.hasDefault ||
    col.generated ||
    col.createdAt ||
    col.updatedAt
  );
}

function hasExplicitApiRequired(apiMeta: ApiPropertyMetadata): boolean {
  return (
    (apiMeta as unknown as Record<PropertyKey, unknown>)[
      API_PROPERTY_EXPLICIT_REQUIRED
    ] === true || apiMeta.selfRequired !== undefined
  );
}

export function isStandardJsonSchema(
  value: unknown,
): value is StandardJSONSchemaV1 {
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
  const jsonSchema = (std as Record<string, unknown>).jsonSchema;
  if (typeof jsonSchema !== "object" || jsonSchema === null) {
    return false;
  }
  const conv = jsonSchema as Record<string, unknown>;
  return typeof conv.input === "function" || typeof conv.output === "function";
}

function rewriteStandardSchemaRefs(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(rewriteStandardSchemaRefs);
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "$ref" && typeof v === "string") {
        out[k] = v
          .replace(/^#\/\$defs\//, "#/components/schemas/")
          .replace(/^#\/definitions\//, "#/components/schemas/");
      } else {
        out[k] = rewriteStandardSchemaRefs(v);
      }
    }
    return out;
  }
  return node;
}

function isOpenApiVersion31OrNewer(version?: string): boolean {
  if (!version) return false;
  const parts = version.split(".").map((n) => Number.parseInt(n, 10));
  const maj = parts[0] || 3;
  const min = parts[1] || 0;
  return maj > 3 || (maj === 3 && min >= 1);
}

function normalizeJsonSchemaForOpenApi(
  node: unknown,
  preserveOas31 = false,
): unknown {
  if (Array.isArray(node)) {
    return node.map((item) =>
      normalizeJsonSchemaForOpenApi(item, preserveOas31),
    );
  }
  if (!node || typeof node !== "object") {
    return node;
  }
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(src)) {
    if (k === "$ref" && typeof v === "string") {
      out[k] = v
        .replace(/^#\/\$defs\//, "#/components/schemas/")
        .replace(/^#\/definitions\//, "#/components/schemas/");
    } else if (k === "const" && !preserveOas31) {
      out.enum = [v];
    } else if (k === "examples" && Array.isArray(v) && !preserveOas31) {
      if (v.length > 0 && !("example" in src)) {
        out.example = v[0];
      }
    } else if (
      (k === "properties" || k === "patternProperties" || k === "dependentSchemas") &&
      v &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      const mapped: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        mapped[pk] = normalizeJsonSchemaForOpenApi(pv, preserveOas31);
      }
      out[k] = mapped;
    } else if (
      (k === "items" ||
        k === "additionalProperties" ||
        k === "propertyNames" ||
        k === "not" ||
        k === "contains" ||
        k === "if" ||
        k === "then" ||
        k === "else") &&
      v &&
      typeof v === "object"
    ) {
      out[k] = normalizeJsonSchemaForOpenApi(v, preserveOas31);
    } else if (
      (k === "allOf" || k === "oneOf" || k === "anyOf" || k === "prefixItems") &&
      Array.isArray(v)
    ) {
      out[k] = v.map((item) =>
        normalizeJsonSchemaForOpenApi(item, preserveOas31),
      );
    } else {
      out[k] = v;
    }
  }

  // In OpenAPI 3.0 mode, if both `const` and `enum` were present, `const` narrows `enum` to `[const]`.
  if (!preserveOas31 && "const" in src) {
    out.enum = [src.const];
  }

  return out;
}

/**
 * Built-in zero-dependency Standard JSON Schema v1 (`~standard.jsonSchema`) converter.
 * Compatible with `@bunest/validation/schema`, Zod v4, Valibot, ArkType, and any
 * StandardJSONSchemaV1 object.
 *
 * Defaults to `"openapi-3.0"` (OpenAPI 3.0.3) when `openApiVersion` is omitted or `< 3.1`
 * (falling back to `"draft-2020-12"` if `"openapi-3.0"` is unsupported) and normalizes
 * `const` -> `enum` and `examples` -> `example`. When `openApiVersion` is explicitly
 * configured to `"3.1.0"` or newer, prefers `"draft-2020-12"` (falling back to
 * `"openapi-3.0"` with OAS 3.1 conversion).
 */
export const defaultStandardSchemaConverter: StandardSchemaConverter = (
  schema,
  options,
): StandardSchemaConversionResult | undefined => {
  if (!isStandardJsonSchema(schema)) {
    return undefined;
  }
  const converter = schema["~standard"].jsonSchema;
  const fn =
    options.schemaType === "output"
      ? (converter.output ?? converter.input)
      : (converter.input ?? converter.output);
  if (typeof fn !== "function") {
    return undefined;
  }

  const preferDraft202012 = isOpenApiVersion31OrNewer(options.openApiVersion);
  const primaryTarget = preferDraft202012 ? "draft-2020-12" : "openapi-3.0";
  const fallbackTarget = preferDraft202012 ? "openapi-3.0" : "draft-2020-12";

  let raw: Record<string, unknown> | undefined;
  let usedFallback = false;
  try {
    const candidate = fn({ target: primaryTarget });
    if (candidate && typeof candidate === "object") {
      raw = candidate;
    } else {
      throw new Error(
        `Standard JSON Schema converter returned non-object for target "${primaryTarget}".`,
      );
    }
  } catch (primaryErr) {
    try {
      const candidate = fn({ target: fallbackTarget });
      if (candidate && typeof candidate === "object") {
        raw = candidate;
        usedFallback = true;
      } else {
        return undefined;
      }
    } catch {
      if (typeof schema === "function") {
        new Logger("SwaggerModule").warn(
          `Failed to convert standard schema to ${primaryTarget}: ${
            primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
          }`,
        );
        return undefined;
      }
      throw primaryErr;
    }
  }

  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const cloned: Record<string, unknown> = { ...raw };
  const components: Record<string, unknown> = {};
  if (cloned.$defs && typeof cloned.$defs === "object") {
    Object.assign(components, cloned.$defs as Record<string, unknown>);
    delete cloned.$defs;
  }
  if (cloned.definitions && typeof cloned.definitions === "object") {
    Object.assign(components, cloned.definitions as Record<string, unknown>);
    delete cloned.definitions;
  }
  delete cloned.$schema;

  const finalizeNode = (node: unknown): unknown => {
    const normalized = normalizeJsonSchemaForOpenApi(node, preferDraft202012);
    if (
      preferDraft202012 &&
      usedFallback &&
      normalized &&
      typeof normalized === "object"
    ) {
      return convertSchemaToOas31(normalized as OpenApiSchema);
    }
    return normalized;
  };

  const normalizedComponents: Record<string, unknown> = {};
  for (const [compName, compDef] of Object.entries(components)) {
    normalizedComponents[compName] = finalizeNode(compDef);
  }

  return {
    schema: finalizeNode(cloned),
    ...(Object.keys(normalizedComponents).length > 0
      ? { components: normalizedComponents as Record<string, any> }
      : {}),
  };
};

export function normalizeEnumValues(rawEnum: SwaggerEnumType): unknown[] {
  const resolved = typeof rawEnum === "function" ? rawEnum() : rawEnum;
  if (Array.isArray(resolved)) {
    return [...resolved];
  }
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(resolved)) {
    if (
      typeof (resolved as Record<string, unknown>)[String(v)] === "number" &&
      !Number.isNaN(Number(k))
    ) {
      continue;
    }
    values.push(v);
  }
  return values;
}

function inferEnumSchemaType(
  values: readonly unknown[],
): OpenApiSchemaType | undefined {
  if (values.length === 0) return undefined;
  if (values.every((v) => typeof v === "string")) return "string";
  if (values.every((v) => typeof v === "number")) return "number";
  if (values.every((v) => typeof v === "boolean")) return "boolean";
  if (values.some((v) => typeof v === "string")) return "string";
  return undefined;
}

const OAS_ANNOTATION_KEYS = new Set<string>([
  "title",
  "description",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
  "example",
  "examples",
  "externalDocs",
  "xml",
  "discriminator",
]);

function isAnnotationKey(key: string): boolean {
  return OAS_ANNOTATION_KEYS.has(key) || key.startsWith("x-");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function applyNullable30(
  schema: OpenApiSchema,
  nullable?: boolean,
): OpenApiSchema {
  if (nullable === false) {
    const out = { ...schema };
    delete out.nullable;
    return out;
  }
  if (!nullable) {
    return schema;
  }
  if (schema.$ref) {
    const { $ref, ...siblings } = schema;
    return {
      ...siblings,
      type: "object",
      nullable: true,
      allOf: [{ $ref }],
    };
  }
  return { ...schema, nullable: true };
}

/**
 * Recursively converts an OpenAPI 3.0 schema (with `nullable: true`, boolean
 * `exclusiveMinimum`/`exclusiveMaximum`, single-element `allOf: [{ $ref }]`
 * wrappers, etc.) into an OpenAPI 3.1 JSON Schema 2020-12 compliant schema.
 */
export function convertSchemaToOas31(
  schema: OpenApiSchema,
  seen = new WeakMap<object, OpenApiSchema>(),
): OpenApiSchema {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (seen.has(schema)) {
    return seen.get(schema)!;
  }

  const out: Record<string, unknown> = {};
  seen.set(schema, out as OpenApiSchema);

  // 1. Copy fields and recurse into nested schema-valued positions
  for (const [k, v] of Object.entries(schema)) {
    if (
      (k === "properties" || k === "patternProperties") &&
      v &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      const mapped: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        mapped[pk] =
          pv && typeof pv === "object"
            ? convertSchemaToOas31(pv as OpenApiSchema, seen)
            : pv;
      }
      out[k] = mapped;
    } else if (k === "items" && v && typeof v === "object") {
      out[k] = Array.isArray(v)
        ? v.map((item) =>
            item && typeof item === "object"
              ? convertSchemaToOas31(item as OpenApiSchema, seen)
              : item,
          )
        : convertSchemaToOas31(v as OpenApiSchema, seen);
    } else if (
      (k === "additionalProperties" || k === "propertyNames" || k === "not") &&
      v &&
      typeof v === "object"
    ) {
      out[k] = convertSchemaToOas31(v as OpenApiSchema, seen);
    } else if (
      (k === "allOf" || k === "oneOf" || k === "anyOf" || k === "prefixItems") &&
      Array.isArray(v)
    ) {
      out[k] = v.map((branch) =>
        branch && typeof branch === "object"
          ? convertSchemaToOas31(branch as OpenApiSchema, seen)
          : branch,
      );
    } else {
      out[k] = v;
    }
  }

  // 2. Convert OAS 3.0 boolean exclusiveMinimum / exclusiveMaximum to OAS 3.1 numeric bounds
  if (typeof out.exclusiveMinimum === "boolean") {
    if (out.exclusiveMinimum === true && typeof out.minimum === "number") {
      out.exclusiveMinimum = out.minimum;
      delete out.minimum;
    } else {
      delete out.exclusiveMinimum;
    }
  }
  if (typeof out.exclusiveMaximum === "boolean") {
    if (out.exclusiveMaximum === true && typeof out.maximum === "number") {
      out.exclusiveMaximum = out.maximum;
      delete out.maximum;
    } else {
      delete out.exclusiveMaximum;
    }
  }

  // 3. Handle `nullable`
  const isNullable = out.nullable === true;
  if ("nullable" in out) {
    delete out.nullable;
  }
  if (!isNullable) {
    return out as OpenApiSchema;
  }

  // 3a. Direct `$ref`
  if (typeof out.$ref === "string") {
    const { $ref, ...siblings } = out;
    const res = { ...siblings, anyOf: [{ $ref }, { type: "null" }] } as OpenApiSchema;
    seen.set(schema, res);
    return res;
  }

  // 3b. Unwrap OAS 3.0 single-element `allOf: [{ $ref }]` wrapper (with optional `type: "object"`)
  if (
    Array.isArray(out.allOf) &&
    out.allOf.length === 1 &&
    out.allOf[0] &&
    typeof out.allOf[0] === "object" &&
    typeof (out.allOf[0] as Record<string, unknown>).$ref === "string" &&
    (out.type === undefined || out.type === "object")
  ) {
    const refEntry = out.allOf[0] as Record<string, unknown>;
    const siblings: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out)) {
      if (k !== "allOf" && k !== "type") {
        siblings[k] = v;
      }
    }
    const res = {
      ...siblings,
      anyOf: [refEntry, { type: "null" }],
    } as OpenApiSchema;
    seen.set(schema, res);
    return res;
  }

  // 3c. Enum (with or without `type`)
  if (Array.isArray(out.enum)) {
    if (!out.enum.includes(null)) {
      out.enum = [...out.enum, null];
    }
    if (typeof out.type === "string") {
      out.type = [out.type, "null"];
    } else if (Array.isArray(out.type) && !out.type.includes("null")) {
      out.type = [...out.type, "null"];
    }
    return out as OpenApiSchema;
  }

  // 3d. Simple typed schema (no combinators)
  const hasCombinator =
    out.allOf !== undefined ||
    out.oneOf !== undefined ||
    out.anyOf !== undefined ||
    out.not !== undefined;
  if (!hasCombinator && typeof out.type === "string") {
    out.type = [out.type, "null"];
    return out as OpenApiSchema;
  }
  if (!hasCombinator && Array.isArray(out.type)) {
    if (!out.type.includes("null")) {
      out.type = [...out.type, "null"];
    }
    return out as OpenApiSchema;
  }

  // 3e. Separate annotation siblings from structural/validation keywords
  const annotations: Record<string, unknown> = {};
  const core: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(out)) {
    if (isAnnotationKey(k)) {
      annotations[k] = v;
    } else {
      core[k] = v;
    }
  }

  // Pure annotation schema ({ description: "anything" }) asserts nothing -> drop nullable
  if (Object.keys(core).length === 0) {
    seen.set(schema, annotations as OpenApiSchema);
    return annotations as OpenApiSchema;
  }

  const res = {
    ...annotations,
    anyOf: [core, { type: "null" }],
  } as OpenApiSchema;
  seen.set(schema, res);
  return res;
}

function applyNullable31(
  schema: OpenApiSchema,
  nullable?: boolean,
): OpenApiSchema {
  if (nullable === undefined) {
    return convertSchemaToOas31(schema);
  }
  return convertSchemaToOas31({ ...schema, nullable });
}

function truncateExampleDepth(
  value: unknown,
  maxDepth: number,
  currentDepth = 0,
  ancestors = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    return value;
  }
  if (ancestors.has(value)) {
    return Array.isArray(value) ? [] : {};
  }
  if (currentDepth >= maxDepth) {
    return Array.isArray(value) ? [] : {};
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) =>
        truncateExampleDepth(item, maxDepth, currentDepth + 1, ancestors),
      );
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = truncateExampleDepth(v, maxDepth, currentDepth + 1, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

function applyExampleMaxDepthToSchema(
  schema: OpenApiSchema,
  ownMaxDepth: number | undefined,
  childMaxDepth: number | undefined = ownMaxDepth,
  seen = new WeakSet<object>(),
): void {
  if (!schema || typeof schema !== "object") return;
  if (seen.has(schema)) return;
  seen.add(schema);

  if (ownMaxDepth !== undefined) {
    if (schema.example !== undefined) {
      schema.example = truncateExampleDepth(schema.example, ownMaxDepth);
    }
    if (schema.examples !== undefined) {
      if (Array.isArray(schema.examples)) {
        schema.examples = schema.examples.map((ex) =>
          truncateExampleDepth(ex, ownMaxDepth),
        );
      } else if (isPlainObject(schema.examples)) {
        const mapped: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(schema.examples)) {
          mapped[k] = truncateExampleDepth(v, ownMaxDepth);
        }
        schema.examples = mapped as any;
      }
    }
  }
  if (childMaxDepth === undefined) return;

  if (schema.properties && typeof schema.properties === "object") {
    for (const prop of Object.values(schema.properties)) {
      if (prop && typeof prop === "object") {
        applyExampleMaxDepthToSchema(prop, childMaxDepth, childMaxDepth, seen);
      }
    }
  }
  if (schema.patternProperties && typeof schema.patternProperties === "object") {
    for (const prop of Object.values(schema.patternProperties)) {
      if (prop && typeof prop === "object") {
        applyExampleMaxDepthToSchema(prop, childMaxDepth, childMaxDepth, seen);
      }
    }
  }
  if (schema.items && typeof schema.items === "object") {
    if (Array.isArray(schema.items)) {
      for (const item of schema.items) {
        if (item && typeof item === "object") {
          applyExampleMaxDepthToSchema(
            item as OpenApiSchema,
            childMaxDepth,
            childMaxDepth,
            seen,
          );
        }
      }
    } else {
      applyExampleMaxDepthToSchema(
        schema.items,
        childMaxDepth,
        childMaxDepth,
        seen,
      );
    }
  }
  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object"
  ) {
    applyExampleMaxDepthToSchema(
      schema.additionalProperties,
      childMaxDepth,
      childMaxDepth,
      seen,
    );
  }
  for (const key of ["allOf", "oneOf", "anyOf"] as const) {
    if (Array.isArray(schema[key])) {
      for (const branch of schema[key]!) {
        if (branch && typeof branch === "object") {
          applyExampleMaxDepthToSchema(
            branch as OpenApiSchema,
            childMaxDepth,
            childMaxDepth,
            seen,
          );
        }
      }
    }
  }
  if (schema.not && typeof schema.not === "object") {
    applyExampleMaxDepthToSchema(
      schema.not,
      childMaxDepth,
      childMaxDepth,
      seen,
    );
  }
}

interface ExtractedValidatorHints {
  readonly properties: Map<string, Partial<OpenApiSchema>>;
  readonly optionalProperties: Set<string>;
}

function extractClassValidatorHints(dto: Function): ExtractedValidatorHints {
  const properties = new Map<string, Partial<OpenApiSchema>>();
  const optionalProperties = new Set<string>();

  try {
    const metas = getValidationMetadatasForTarget(dto, false, false);

    for (let i = 0; i < metas.length; i++) {
      const meta = metas[i];
      if (!meta || !meta.propertyName) continue;
      const propName = meta.propertyName;

      if (meta.type === "conditionalValidation") {
        if (meta.name === "isOptional") {
          optionalProperties.add(propName);
        }
        continue;
      }

      let schema = properties.get(propName);
      if (!schema) {
        schema = {};
        properties.set(propName, schema);
      }

      const isEach = (meta as { each?: boolean }).each === true;
      const ruleName = (meta.name ?? meta.type ?? "").toLowerCase();
      const constraints = meta.constraints ?? [];

      if (ruleName === "nestedvalidation") {
        if (isEach) {
          schema.type = "array";
        }
        continue;
      }

      let target: Partial<OpenApiSchema> = schema;
      if (isEach) {
        schema.type = "array";
        if (
          !schema.items ||
          Array.isArray(schema.items) ||
          "$ref" in schema.items
        ) {
          schema.items = {};
        }
        target = schema.items;
      }

      switch (ruleName) {
        case "isstring":
          target.type = "string";
          break;
        case "isemail":
          target.type = "string";
          target.format = "email";
          break;
        case "isuuid":
          target.type = "string";
          target.format = "uuid";
          break;
        case "isurl":
        case "isdatauri":
          target.type = "string";
          target.format = "uri";
          break;
        case "isfqdn":
          target.type = "string";
          target.format = "hostname";
          break;
        case "isip": {
          target.type = "string";
          const ver =
            constraints[0] !== undefined ? String(constraints[0]) : "";
          if (ver === "4") {
            target.format = "ipv4";
          } else if (ver === "6") {
            target.format = "ipv6";
          } else {
            target.format = "ip";
          }
          break;
        }
        case "isdate":
        case "isiso8601":
        case "isdatestring":
        case "isrfc3339":
          target.type = "string";
          target.format = "date-time";
          break;
        case "ismilitarytime":
          target.type = "string";
          target.pattern = target.pattern ?? "^(?:[01]\\d|2[0-3]):[0-5]\\d$";
          break;
        case "isjwt":
          target.type = "string";
          target.format = "jwt";
          break;
        case "ismongoid":
          target.type = "string";
          target.pattern = target.pattern ?? "^[0-9a-fA-F]{24}$";
          break;
        case "isbase64":
          target.type = "string";
          target.format = "byte";
          target.contentEncoding = "base64";
          break;
        case "issemver":
          target.type = "string";
          target.format = "semver";
          break;
        case "ishexcolor":
          target.type = "string";
          target.pattern =
            target.pattern ??
            "^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$";
          break;
        case "isstrongpassword": {
          target.type = "string";
          target.format = "password";
          const opts = constraints[0] as { minLength?: number } | undefined;
          const minLen =
            typeof opts?.minLength === "number" ? opts.minLength : 8;
          target.minLength = Math.max(target.minLength ?? 0, minLen);
          break;
        }
        case "isalpha": {
          target.type = "string";
          const locale = constraints[0];
          if (
            locale === undefined ||
            locale === "en-US" ||
            locale === "en-GB" ||
            locale === "en-AU"
          ) {
            target.pattern = target.pattern ?? "^[A-Za-z]+$";
          }
          break;
        }
        case "isalphanumeric": {
          target.type = "string";
          const locale = constraints[0];
          if (
            locale === undefined ||
            locale === "en-US" ||
            locale === "en-GB" ||
            locale === "en-AU"
          ) {
            target.pattern = target.pattern ?? "^[A-Za-z0-9]+$";
          }
          break;
        }
        case "isascii":
          target.type = "string";
          target.pattern = target.pattern ?? "^[\\x00-\\x7F]+$";
          break;
        case "isiso31661alpha2":
          target.type = "string";
          target.minLength = Math.max(target.minLength ?? 0, 2);
          target.maxLength =
            target.maxLength !== undefined ? Math.min(target.maxLength, 2) : 2;
          break;
        case "isiso31661alpha3":
        case "isiso4217currencycode":
          target.type = "string";
          target.minLength = Math.max(target.minLength ?? 0, 3);
          target.maxLength =
            target.maxLength !== undefined ? Math.min(target.maxLength, 3) : 3;
          break;
        case "islowercase":
        case "isuppercase":
        case "isport":
        case "isnumberstring":
        case "isdecimal":
        case "isbooleanstring":
        case "isjson":
        case "ishexadecimal":
        case "isoctal":
        case "ishash":
        case "iscreditcard":
        case "isiban":
        case "isisbn":
        case "ismacaddress":
        case "ismimetype":
        case "istimezone":
        case "islocale":
        case "isphonenumber":
        case "ismobilephone":
        case "ispostalcode":
          target.type = "string";
          break;
        case "isint":
          target.type = "integer";
          break;
        case "isnumber":
          target.type = target.type ?? "number";
          break;
        case "ispositive":
          target.type = target.type ?? "number";
          if (target.minimum === undefined || target.minimum <= 0) {
            target.minimum = 0;
            target.exclusiveMinimum = true;
          }
          break;
        case "isnegative":
          target.type = target.type ?? "number";
          if (target.maximum === undefined || target.maximum >= 0) {
            target.maximum = 0;
            target.exclusiveMaximum = true;
          }
          break;
        case "isdivisibleby":
          target.type = target.type ?? "number";
          if (typeof constraints[0] === "number" && constraints[0] !== 0) {
            target.multipleOf = Math.abs(constraints[0]);
          }
          break;
        case "isboolean":
          target.type = "boolean";
          break;
        case "isobject":
          target.type = "object";
          break;
        case "isnotemptyobject":
          target.type = "object";
          target.minProperties = Math.max(target.minProperties ?? 0, 1);
          break;
        case "isarray":
          target.type = "array";
          break;
        case "isnotempty":
          if (target.type === undefined || target.type === "string") {
            target.minLength = Math.max(target.minLength ?? 0, 1);
          }
          break;
        case "islength":
          target.type = target.type ?? "string";
          if (typeof constraints[0] === "number") {
            target.minLength = constraints[0];
          }
          if (typeof constraints[1] === "number") {
            target.maxLength = constraints[1];
          }
          break;
        case "minlength":
          if (typeof constraints[0] === "number") {
            target.minLength = constraints[0];
          }
          break;
        case "maxlength":
          if (typeof constraints[0] === "number") {
            target.maxLength = constraints[0];
          }
          break;
        case "min":
          if (typeof constraints[0] === "number") {
            if (
              target.exclusiveMinimum === true &&
              typeof target.minimum === "number"
            ) {
              if (constraints[0] > target.minimum) {
                target.minimum = constraints[0];
                delete target.exclusiveMinimum;
              }
            } else {
              target.minimum = constraints[0];
            }
          }
          break;
        case "max":
          if (typeof constraints[0] === "number") {
            if (
              target.exclusiveMaximum === true &&
              typeof target.maximum === "number"
            ) {
              if (constraints[0] < target.maximum) {
                target.maximum = constraints[0];
                delete target.exclusiveMaximum;
              }
            } else {
              target.maximum = constraints[0];
            }
          }
          break;
        case "matches":
          if (constraints[0] instanceof RegExp) {
            target.pattern = constraints[0].source;
          } else if (typeof constraints[0] === "string") {
            target.pattern = constraints[0];
          }
          break;
        case "isenum":
          if (constraints[0] && typeof constraints[0] === "object") {
            const vals = normalizeEnumValues(
              constraints[0] as Record<string, string | number>,
            );
            target.enum = vals;
            if (target.type === undefined) {
              const inferred = inferEnumSchemaType(vals);
              if (inferred) target.type = inferred;
            }
          }
          break;
        case "isin":
          if (Array.isArray(constraints[0])) {
            const vals = [...constraints[0]];
            target.enum = vals;
            if (target.type === undefined) {
              const inferred = inferEnumSchemaType(vals);
              if (inferred) target.type = inferred;
            }
          }
          break;
        case "equals":
          if (constraints.length > 0 && constraints[0] !== undefined) {
            target.const = constraints[0];
          }
          break;
        case "arraynotempty":
          target.type = "array";
          target.minItems = Math.max(target.minItems ?? 0, 1);
          break;
        case "arrayminsize":
          target.type = "array";
          if (typeof constraints[0] === "number") {
            target.minItems = Math.max(target.minItems ?? 0, constraints[0]);
          }
          break;
        case "arraymaxsize":
          target.type = "array";
          if (typeof constraints[0] === "number") {
            target.maxItems = constraints[0];
          }
          break;
        case "arrayunique":
          target.type = "array";
          target.uniqueItems = true;
          break;
        default:
          break;
      }
    }
  } catch {
    // Gracefully skip if @bunest/validation metadata storage is unavailable
  }

  return { properties, optionalProperties };
}

export interface SchemaExplorerOptions {
  readonly excludeDynamicDefaults?: boolean;
  readonly exampleMaxDepth?: number;
  readonly standardSchemaConverter?: StandardSchemaConverter;
  readonly openApiVersion?: string;
}

/**
 * Introspects TypeScript design types, `@ApiProperty` metadata (with inheritance),
 * `@ApiSchema` metadata, CLI plugin metadata, `@bunest/validation` constraints, and
 * Standard JSON Schema objects into OpenAPI 3.1 `components.schemas`, handling
 * nested and circular DTO references without infinite recursion.
 */
/**
 * Returns true if a schema `default` value is dynamic (a function, Date, or
 * any non-plain class instance whose prototype is not Object.prototype / null).
 */
export function isDynamicDefaultValue(val: unknown): boolean {
  if (typeof val === "function") return true;
  if (val === null || typeof val !== "object") return false;
  if (Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  return proto !== Object.prototype && proto !== null;
}

/**
 * Non-mutating recursive pass that strips dynamic `default` values from a
 * schema and all nested sub-schemas (`properties`, `items`, `additionalProperties`,
 * `patternProperties`, `allOf`, `oneOf`, `anyOf`, `not`).
 */
export function stripDynamicDefaultsFromSchema<T>(
  schema: T,
  seen = new WeakMap<object, unknown>(),
): T {
  if (!schema || typeof schema !== "object") return schema;
  if (seen.has(schema as object)) return seen.get(schema as object) as T;
  if (Array.isArray(schema)) {
    const out: unknown[] = [];
    seen.set(schema as object, out);
    for (const item of schema) {
      out.push(stripDynamicDefaultsFromSchema(item, seen));
    }
    return out as unknown as T;
  }
  const proto = Object.getPrototypeOf(schema);
  if (proto !== Object.prototype && proto !== null) {
    return schema;
  }

  const s = schema as Record<string, unknown>;
  const clone: Record<string, unknown> = {};
  seen.set(schema as object, clone);

  for (const [k, v] of Object.entries(s)) {
    if (k === "default" && isDynamicDefaultValue(v)) {
      continue;
    }
    if (
      (k === "properties" || k === "patternProperties") &&
      v &&
      typeof v === "object"
    ) {
      const mapped: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        mapped[pk] = stripDynamicDefaultsFromSchema(pv, seen);
      }
      clone[k] = mapped;
    } else if (
      (k === "items" || k === "additionalProperties" || k === "not") &&
      v &&
      typeof v === "object"
    ) {
      clone[k] = stripDynamicDefaultsFromSchema(v, seen);
    } else if (
      (k === "allOf" || k === "oneOf" || k === "anyOf") &&
      Array.isArray(v)
    ) {
      clone[k] = v.map((branch) => stripDynamicDefaultsFromSchema(branch, seen));
    } else {
      clone[k] = v;
    }
  }
  return clone as T;
}

export class SchemaExplorer {
  private readonly schemas: Record<string, OpenApiSchema> = {};
  private readonly classToName = new Map<Function, string>();
  private readonly nameToClass = new Map<string, Function>();
  private readonly activeDtoStack: string[] = [];
  private readonly options: SchemaExplorerOptions;

  constructor(options: SchemaExplorerOptions = {}) {
    this.options = options;
  }

  private isOas31(): boolean {
    const ver = this.options.openApiVersion ?? "3.1.0";
    const parts = ver.split(".").map((n) => Number.parseInt(n, 10));
    const maj = parts[0] || 3;
    const min = parts[1] || 0;
    return maj > 3 || (maj === 3 && min >= 1);
  }

  private finalizeNullable(
    schema: OpenApiSchema,
    nullable?: boolean,
  ): OpenApiSchema {
    if (this.isOas31()) {
      return applyNullable31(schema, nullable);
    }
    return applyNullable30(schema, nullable);
  }

  getSchemas(): Record<string, OpenApiSchema> {
    return { ...this.schemas };
  }

  getSchemaName(dto: Function): string | undefined {
    return this.classToName.get(dto);
  }

  /**
   * Registers a reusable named enum schema under `components.schemas[enumName]`
   * and returns a `$ref` schema pointing to it.
   */
  registerEnumSchema(
    enumName: string,
    rawEnum: SwaggerEnumType,
    enumSchema?: EnumSchemaAttributes,
    enumNames?: string[],
  ): OpenApiSchema {
    const values = normalizeEnumValues(rawEnum);
    const inferredType = inferEnumSchemaType(values);
    const definition: OpenApiSchema = {
      ...(inferredType ? { type: inferredType } : {}),
      enum: values,
      ...(enumNames ? { "x-enumNames": [...enumNames] } : {}),
      ...(enumSchema ? { ...enumSchema } : {}),
    };
    this.schemas[enumName] = definition;
    return { $ref: `#/components/schemas/${enumName}` };
  }

  /**
   * Converts a Standard Schema object (e.g. Zod v4 / Valibot / ArkType or custom
   * converter) into an OpenAPI schema, merging any emitted `components` into
   * `this.schemas`.
   */
  resolveStandardSchema(
    standardSchema: unknown,
    schemaType: "input" | "output" = "output",
  ): OpenApiSchema | undefined {
    const converterOpts: {
      schemaType: "input" | "output";
      openApiVersion?: string;
    } =
      this.options.openApiVersion !== undefined
        ? { schemaType, openApiVersion: this.options.openApiVersion }
        : { schemaType };
    const converter =
      this.options.standardSchemaConverter ?? defaultStandardSchemaConverter;
    const result =
      converter(standardSchema, converterOpts) ??
      (this.options.standardSchemaConverter
        ? defaultStandardSchemaConverter(standardSchema, converterOpts)
        : undefined);
    if (!result || !result.schema || typeof result.schema !== "object") {
      return undefined;
    }
    if (result.components && typeof result.components === "object") {
      for (const [name, compSchema] of Object.entries(result.components)) {
        if (compSchema && typeof compSchema === "object") {
          this.schemas[name] = rewriteStandardSchemaRefs(
            compSchema,
          ) as OpenApiSchema;
        }
      }
    }
    return rewriteStandardSchemaRefs(result.schema) as OpenApiSchema;
  }

  /**
   * Resolves a type input (`String`, `Number`, DTO class, `[Dto]`, `() => Dto`,
   * Standard Schema, `createSchemaDto`, etc.) into an OpenAPI 3.1 schema
   * (registering DTOs in `components.schemas` and returning `$ref`).
   */
  resolveTypeSchema(
    rawType: ApiTypeInput | unknown,
    isArray = false,
    schemaType: "input" | "output" = "input",
  ): OpenApiSchema {
    if (rawType === undefined) {
      return isArray ? { type: "array", items: {} } : {};
    }

    // Standard Schema v1 / StandardJSONSchemaV1 support
    if (
      typeof rawType === "object" &&
      rawType !== null &&
      "~standard" in rawType
    ) {
      const converted = this.resolveStandardSchema(rawType, schemaType);
      if (converted) {
        return isArray ? { type: "array", items: converted } : converted;
      }
    }

    let resolved: unknown = rawType;
    if (isLazyTypeThunk(resolved)) {
      resolved = resolved();
    }

    if (Array.isArray(resolved)) {
      const itemType = resolved[0] as ApiTypeInput | undefined;
      return {
        type: "array",
        items: this.resolveTypeSchema(itemType, false, schemaType),
      };
    }

    let baseSchema: OpenApiSchema;

    if (typeof resolved === "string") {
      const normalized = resolved.toLowerCase();
      if (normalized === "file") {
        baseSchema = { type: "string", format: "binary" };
      } else if (
        normalized === "string" ||
        normalized === "number" ||
        normalized === "integer" ||
        normalized === "boolean" ||
        normalized === "array" ||
        normalized === "object" ||
        normalized === "null"
      ) {
        baseSchema = { type: normalized as OpenApiSchemaType };
      } else {
        baseSchema = { type: "string" };
      }
    } else if (resolved === String) {
      baseSchema = { type: "string" };
    } else if (resolved === Number) {
      baseSchema = { type: "number" };
    } else if (resolved === Boolean) {
      baseSchema = { type: "boolean" };
    } else if (resolved === Date) {
      baseSchema = { type: "string", format: "date-time" };
    } else if (resolved === BigInt) {
      baseSchema = { type: "integer", format: "int64" };
    } else if (resolved === Array) {
      baseSchema = { type: "array", items: {} };
      return baseSchema;
    } else if (resolved === Object) {
      baseSchema = { type: "object" };
    } else if (
      resolved === File ||
      resolved === Blob ||
      resolved === Uint8Array
    ) {
      baseSchema = { type: "string", format: "binary" };
    } else if (isDtoConstructor(resolved)) {
      const refName = this.registerDtoSchema(resolved, schemaType);
      baseSchema = { $ref: `#/components/schemas/${refName}` };
    } else if (isPlainObject(resolved)) {
      const entries = Object.entries(resolved);
      if (entries.length === 0) {
        baseSchema = {};
      } else if (
        entries.every(
          ([, v]) =>
            typeof v === "string" ||
            typeof v === "number" ||
            typeof v === "boolean",
        )
      ) {
        // SWC const-enum plain object (e.g. `{ ACTIVE: "active", PAUSED: "paused" }`)
        const enumVals = normalizeEnumValues(resolved as SwaggerEnumType);
        const inferred = inferEnumSchemaType(enumVals);
        baseSchema = {
          ...(inferred ? { type: inferred } : {}),
          enum: enumVals,
        };
      } else if (
        entries.every(
          ([, v]) =>
            isPlainObject(v) &&
            ("type" in v ||
              "enum" in v ||
              "oneOf" in v ||
              "anyOf" in v ||
              "allOf" in v ||
              "properties" in v),
        )
      ) {
        // Nested object-literal type descriptor from `type: () => ({ prop: { required, type: () => ... } })`
        const nestedProps: Record<string, OpenApiSchema> = {};
        const nestedRequired: string[] = [];
        for (const [propKey, propDesc] of entries) {
          const desc = propDesc as ApiPropertyOptions;
          nestedProps[propKey] = this.buildInlinePropertySchema(desc);
          if (desc.required !== false) {
            nestedRequired.push(propKey);
          }
        }
        baseSchema = {
          type: "object",
          properties: nestedProps,
          ...(nestedRequired.length > 0 ? { required: nestedRequired } : {}),
        };
      } else {
        baseSchema = {};
      }
    } else {
      baseSchema = {};
    }

    if (isArray) {
      return { type: "array", items: baseSchema };
    }

    return baseSchema;
  }

  /**
   * Registers a DTO class in `components.schemas` and returns its schema name.
   * Honors `@ApiSchema({ name, description })` and inserts a placeholder BEFORE
   * recursing into properties so circular DTOs resolve cleanly via `$ref`.
   */
  registerDtoSchema(
    dto: Type<unknown> | Function,
    schemaType: "input" | "output" = "input",
  ): string {
    const existingName = this.classToName.get(dto);
    if (existingName !== undefined) {
      return existingName;
    }

    const schemaMeta = MetadataRegistry.getOwn<ApiSchemaOptions>(
      SWAGGER_METADATA_KEYS.API_SCHEMA,
      dto,
    );
    const standardDtoSchema = getStandardSchemaFromDto(dto);
    const entitySchema = hasEntitySchema(dto)
      ? getEntitySchema(dto)
      : undefined;
    const baseName = schemaMeta?.name || dto.name || "AnonymousSchema";
    let schemaName = baseName;
    let suffix = 2;
    const collidedWithExisting =
      this.nameToClass.has(schemaName) &&
      this.nameToClass.get(schemaName) !== dto;
    if (collidedWithExisting) {
      while (
        this.nameToClass.has(schemaName) &&
        this.nameToClass.get(schemaName) !== dto
      ) {
        schemaName = `${baseName}_${suffix++}`;
      }
    }

    const schemaDescription =
      schemaMeta?.description ?? entitySchema?.description;

    // Reserve immediately to break circular DTO recursion!
    this.classToName.set(dto, schemaName);
    this.nameToClass.set(schemaName, dto);

    // First-class `UnionType([A, B], { discriminator })` -> OpenAPI `oneOf` (+ optional `discriminator`)
    const unionMeta = getUnionTypeMeta(dto);
    if (unionMeta !== undefined) {
      const oneOf: Array<OpenApiSchema | ReferenceObject> = [];
      for (const rawVariant of unionMeta.variants) {
        const variant = isLazyTypeThunk(rawVariant) ? rawVariant() : rawVariant;
        oneOf.push(this.resolveTypeSchema(variant, false, schemaType));
      }

      let discriminator: DiscriminatorObject | undefined;
      if (unionMeta.discriminator) {
        discriminator = {
          propertyName: unionMeta.discriminator.propertyName,
        };
        if (unionMeta.discriminator.mapping) {
          const mapping: Record<string, string> = {};
          for (const [discValue, rawTarget] of Object.entries(
            unionMeta.discriminator.mapping,
          )) {
            if (typeof rawTarget === "string") {
              mapping[discValue] = rawTarget.startsWith("#/")
                ? rawTarget
                : `#/components/schemas/${rawTarget}`;
            } else {
              const targetCtor = isLazyTypeThunk(rawTarget)
                ? rawTarget()
                : rawTarget;
              if (isDtoConstructor(targetCtor)) {
                const refName = this.registerDtoSchema(targetCtor, schemaType);
                mapping[discValue] = `#/components/schemas/${refName}`;
              }
            }
          }
          if (Object.keys(mapping).length > 0) {
            discriminator.mapping = mapping;
          }
        }
      }

      const effectiveUnionDesc = schemaDescription ?? unionMeta.description;
      const unionSchema: OpenApiSchema = {
        oneOf,
        ...(discriminator ? { discriminator } : {}),
        ...(schemaMeta?.title !== undefined ? { title: schemaMeta.title } : {}),
        ...(effectiveUnionDesc !== undefined
          ? { description: effectiveUnionDesc }
          : {}),
        ...(schemaMeta?.deprecated !== undefined
          ? { deprecated: schemaMeta.deprecated }
          : {}),
        ...(schemaMeta?.example !== undefined
          ? { example: schemaMeta.example }
          : {}),
        ...(schemaMeta?.externalDocs !== undefined
          ? { externalDocs: schemaMeta.externalDocs }
          : {}),
      };

      const classExtensions = MetadataRegistry.getOwn<
        readonly { readonly key: string; readonly value: unknown }[]
      >(SWAGGER_METADATA_KEYS.API_EXTENSIONS, dto);
      if (classExtensions) {
        for (const ext of classExtensions) {
          (unionSchema as Record<string, unknown>)[ext.key] = ext.value;
        }
      }

      this.schemas[schemaName] = unionSchema;

      if (collidedWithExisting) {
        const existingSchema = this.schemas[baseName];
        if (
          existingSchema &&
          JSON.stringify(existingSchema) === JSON.stringify(unionSchema)
        ) {
          delete this.schemas[schemaName];
          this.nameToClass.delete(schemaName);
          this.classToName.set(dto, baseName);
          return baseName;
        }
        Logger.warn(
          `Duplicate DTO detected: "${baseName}". Use @ApiSchema({ name: "..." }) to disambiguate.`,
        );
      }

      return schemaName;
    }

    // Bridge for `createSchemaDto(schema)` classes (zero dependency on `@bunest/validation`)
    if (standardDtoSchema !== undefined) {
      const resolvedStd = this.resolveStandardSchema(
        standardDtoSchema,
        schemaType,
      );
      const genericMetas = getGenericTypeMetas(dto);
      const effectiveStdDesc =
        schemaDescription ??
        genericMetas[genericMetas.length - 1]?.description;
      const dtoSchema: OpenApiSchema = {
        ...(resolvedStd ?? { type: "object", properties: {} }),
        ...(schemaMeta?.title !== undefined ? { title: schemaMeta.title } : {}),
        ...(effectiveStdDesc !== undefined
          ? { description: effectiveStdDesc }
          : {}),
        ...(schemaMeta?.additionalProperties !== undefined
          ? { additionalProperties: schemaMeta.additionalProperties }
          : {}),
        ...(schemaMeta?.minProperties !== undefined
          ? { minProperties: schemaMeta.minProperties }
          : {}),
        ...(schemaMeta?.maxProperties !== undefined
          ? { maxProperties: schemaMeta.maxProperties }
          : {}),
        ...(schemaMeta?.deprecated !== undefined
          ? { deprecated: schemaMeta.deprecated }
          : {}),
        ...(schemaMeta?.example !== undefined
          ? { example: schemaMeta.example }
          : {}),
        ...(schemaMeta?.externalDocs !== undefined
          ? { externalDocs: schemaMeta.externalDocs }
          : {}),
      };

      // Apply `GenericType(SchemaWrapperDto, bindings)` substitutions on top of Standard Schema DTOs
      if (genericMetas.length > 0) {
        const nextProps: Record<string, OpenApiSchema | ReferenceObject> = {
          ...(dtoSchema.properties ?? {}),
        };
        const reqSet = new Set<string>(
          Array.isArray(dtoSchema.required) ? dtoSchema.required : [],
        );
        for (const gMeta of genericMetas) {
          for (const [propKey, rawBinding] of Object.entries(gMeta.bindings)) {
            const hadProp = Object.prototype.hasOwnProperty.call(
              nextProps,
              propKey,
            );
            const unwrapped = isLazyTypeThunk(rawBinding)
              ? rawBinding()
              : rawBinding;
            const boundIsArray = Array.isArray(unwrapped);
            const boundType = boundIsArray ? unwrapped[0] : unwrapped;
            nextProps[propKey] = this.resolveTypeSchema(
              boundType,
              boundIsArray,
              schemaType,
            );
            if (!hadProp) {
              reqSet.add(propKey);
            }
          }
        }
        dtoSchema.properties = nextProps;
        if (reqSet.size > 0) {
          dtoSchema.required = [...reqSet];
        }
      }

      const classExtensions = MetadataRegistry.getOwn<
        readonly { readonly key: string; readonly value: unknown }[]
      >(SWAGGER_METADATA_KEYS.API_EXTENSIONS, dto);
      if (classExtensions) {
        for (const ext of classExtensions) {
          (dtoSchema as Record<string, unknown>)[ext.key] = ext.value;
        }
      }

      const hiddenProps = this.collectHiddenProperties(dto);
      if (hiddenProps.size > 0 && dtoSchema.properties) {
        const filteredProps: Record<string, OpenApiSchema | ReferenceObject> =
          {};
        for (const [k, v] of Object.entries(dtoSchema.properties)) {
          if (!hiddenProps.has(k)) {
            filteredProps[k] = v;
          }
        }
        dtoSchema.properties = filteredProps;
        if (Array.isArray(dtoSchema.required)) {
          const filteredReq = dtoSchema.required.filter(
            (k) => !hiddenProps.has(k),
          );
          if (filteredReq.length > 0) {
            dtoSchema.required = filteredReq;
          } else {
            delete dtoSchema.required;
          }
        }
      }

      this.schemas[schemaName] = dtoSchema;

      if (collidedWithExisting) {
        const existingSchema = this.schemas[baseName];
        if (
          existingSchema &&
          JSON.stringify(existingSchema) === JSON.stringify(dtoSchema)
        ) {
          delete this.schemas[schemaName];
          this.nameToClass.delete(schemaName);
          this.classToName.set(dto, baseName);
          return baseName;
        }
        Logger.warn(
          `Duplicate DTO detected: "${baseName}". Use @ApiSchema({ name: "..." }) to disambiguate.`,
        );
      }

      return schemaName;
    }

    const dtoSchema: OpenApiSchema = {
      type: "object",
      ...(schemaMeta?.title !== undefined ? { title: schemaMeta.title } : {}),
      ...(schemaDescription !== undefined
        ? { description: schemaDescription }
        : {}),
      ...(schemaMeta?.additionalProperties !== undefined
        ? { additionalProperties: schemaMeta.additionalProperties }
        : {}),
      ...(schemaMeta?.minProperties !== undefined
        ? { minProperties: schemaMeta.minProperties }
        : {}),
      ...(schemaMeta?.maxProperties !== undefined
        ? { maxProperties: schemaMeta.maxProperties }
        : {}),
      ...(schemaMeta?.deprecated !== undefined
        ? { deprecated: schemaMeta.deprecated }
        : {}),
      ...(schemaMeta?.example !== undefined
        ? { example: schemaMeta.example }
        : {}),
      ...(schemaMeta?.externalDocs !== undefined
        ? { externalDocs: schemaMeta.externalDocs }
        : {}),
      properties: {},
    };

    // Apply class-level @ApiExtension() metadata onto the DTO schema
    const classExtensions = MetadataRegistry.getOwn<
      readonly { readonly key: string; readonly value: unknown }[]
    >(SWAGGER_METADATA_KEYS.API_EXTENSIONS, dto);
    if (classExtensions) {
      for (const ext of classExtensions) {
        (dtoSchema as Record<string, unknown>)[ext.key] = ext.value;
      }
    }

    this.schemas[schemaName] = dtoSchema;
    this.activeDtoStack.push(schemaName);
    try {
      this.populateDtoSchema(dto, dtoSchema, entitySchema, schemaType);
    } finally {
      this.activeDtoStack.pop();
    }

    if (collidedWithExisting) {
      const existingSchema = this.schemas[baseName];
      if (
        existingSchema &&
        JSON.stringify(existingSchema) === JSON.stringify(dtoSchema)
      ) {
        delete this.schemas[schemaName];
        this.nameToClass.delete(schemaName);
        this.classToName.set(dto, baseName);
        return baseName;
      }
      Logger.warn(
        `Duplicate DTO detected: "${baseName}". Use @ApiSchema({ name: "..." }) to disambiguate.`,
      );
    }

    return schemaName;
  }

  private collectHiddenProperties(dto: Function): Set<string> {
    const hidden = new Set<string>();
    for (const ctor of MetadataRegistry.getPrototypeChain(dto)) {
      const ownHidden = MetadataRegistry.getOwn<readonly string[]>(
        SWAGGER_METADATA_KEYS.API_HIDDEN_PROPERTIES,
        ctor,
      );
      if (ownHidden) {
        for (const k of ownHidden) hidden.add(k);
      }
    }
    return hidden;
  }

  private sanitizeDefaultValue(
    value: unknown,
    modelCtor?: Function,
    seen = new WeakSet<object>(),
  ): unknown {
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) return undefined;
      seen.add(value);
      try {
        return value.map((item) =>
          this.sanitizeDefaultValue(item, modelCtor, seen),
        );
      } finally {
        seen.delete(value);
      }
    }
    // Determine effective DTO constructor: explicit modelCtor OR instance's own DTO constructor
    const valueCtor =
      typeof (value as { constructor?: unknown }).constructor === "function" &&
      isDtoConstructor((value as { constructor: Function }).constructor)
        ? (value as { constructor: Function }).constructor
        : undefined;
    const effectiveCtor =
      modelCtor && isDtoConstructor(modelCtor) ? modelCtor : valueCtor;

    if (!effectiveCtor) {
      return value;
    }

    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    try {
      const hidden = this.collectHiddenProperties(effectiveCtor);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (hidden.has(k)) {
          continue;
        }
        out[k] = this.sanitizeDefaultValue(v, undefined, seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }

  private collectDtoProperties(dto: Type<unknown> | Function): {
    propertyMap: Map<string, ApiPropertyMetadata>;
    hiddenProps: Set<string>;
    decoratorKeys: Set<string>;
  } {
    const propertyMap = new Map<string, ApiPropertyMetadata>();
    const hiddenProps = new Set<string>();
    const decoratorKeys = new Set<string>();

    for (const ctor of MetadataRegistry.getPrototypeChain(dto)) {
      const mappedMeta = Object.prototype.hasOwnProperty.call(
        ctor,
        SWAGGER_MAPPED_TYPE_META,
      )
        ? (ctor as unknown as Record<symbol, SwaggerMappedTypeMeta>)[
            SWAGGER_MAPPED_TYPE_META
          ]
        : undefined;

      if (mappedMeta) {
        const collected = new Map<string, ApiPropertyMetadata>();
        const collectedHidden = new Set<string>();
        const collectedDecoratorKeys = new Set<string>();
        const subResults = mappedMeta.sources.map((src) =>
          this.collectDtoProperties(src),
        );

        // Preserve NestJS key order: decorator-declared keys across all sources first,
        // then factory/plugin-declared keys across all sources.
        for (const sub of subResults) {
          for (const [k, v] of sub.propertyMap.entries()) {
            if (sub.decoratorKeys.has(k)) {
              collected.set(k, v);
              collectedDecoratorKeys.add(k);
            }
          }
        }
        for (const sub of subResults) {
          for (const [k, v] of sub.propertyMap.entries()) {
            if (!sub.decoratorKeys.has(k)) {
              collected.set(k, v);
            }
          }
          for (const h of sub.hiddenProps) {
            collectedHidden.add(h);
          }
        }

        const keySet = mappedMeta.keys ? new Set(mappedMeta.keys) : undefined;
        for (const [k, v] of collected.entries()) {
          if (mappedMeta.kind === "pick" && keySet && !keySet.has(k)) {
            continue;
          }
          if (mappedMeta.kind === "omit" && keySet && keySet.has(k)) {
            continue;
          }

          let nextEntry: ApiPropertyMetadata = { ...v };
          if (hasExplicitApiRequired(v)) {
            Object.defineProperty(nextEntry, API_PROPERTY_EXPLICIT_REQUIRED, {
              value: true,
              enumerable: false,
            });
          }

          if (
            mappedMeta.kind === "partial" ||
            mappedMeta.kind === "deepPartial"
          ) {
            nextEntry = { ...nextEntry, required: false };
            Object.defineProperty(nextEntry, API_PROPERTY_EXPLICIT_REQUIRED, {
              value: true,
              enumerable: false,
            });
          }

          if (
            mappedMeta.kind === "deepPartial" &&
            mappedMeta.wrapNestedDto
          ) {
            let candidate: unknown = nextEntry.type ?? nextEntry.designType;
            if (isLazyTypeThunk(candidate)) {
              try {
                candidate = candidate();
              } catch {
                candidate = undefined;
              }
            }
            let nestedCtor: Type<unknown> | undefined;
            let nestedIsArray = nextEntry.isArray === true;
            if (Array.isArray(candidate) && isDtoConstructor(candidate[0])) {
              nestedCtor = candidate[0];
              nestedIsArray = true;
            } else if (isDtoConstructor(candidate)) {
              nestedCtor = candidate;
            }
            if (nestedCtor) {
              const wrapped = mappedMeta.wrapNestedDto(nestedCtor);
              nextEntry = {
                ...nextEntry,
                type: () => wrapped,
                isArray: nestedIsArray,
              };
            }
          }

          propertyMap.set(k, nextEntry);
          if (collectedDecoratorKeys.has(k)) {
            decoratorKeys.add(k);
          }
        }

        for (const h of collectedHidden) {
          if (mappedMeta.kind === "pick" && keySet && !keySet.has(h)) {
            continue;
          }
          if (mappedMeta.kind === "omit" && keySet && keySet.has(h)) {
            continue;
          }
          hiddenProps.add(h);
        }
        continue;
      }

      // Compute own metadata sources on `ctor`
      const ownProps =
        MetadataRegistry.getOwn<readonly ApiPropertyMetadata[]>(
          SWAGGER_METADATA_KEYS.API_PROPERTIES,
          ctor,
        ) ?? [];
      const ownPropsByKey = new Map<string, ApiPropertyMetadata>();
      for (const entry of ownProps) {
        if (entry) ownPropsByKey.set(entry.propertyKey, entry);
      }

      const ownFactoryByKey = new Map<string, ApiPropertyOptions>();
      if (
        Object.prototype.hasOwnProperty.call(
          ctor,
          "_OPENAPI_METADATA_FACTORY",
        ) &&
        typeof (ctor as { _OPENAPI_METADATA_FACTORY?: unknown })
          ._OPENAPI_METADATA_FACTORY === "function"
      ) {
        const factoryResult = (
          ctor as unknown as {
            _OPENAPI_METADATA_FACTORY: () => Record<string, ApiPropertyOptions>;
          }
        )._OPENAPI_METADATA_FACTORY();
        if (factoryResult && typeof factoryResult === "object") {
          for (const [propKey, propOpts] of Object.entries(factoryResult)) {
            if (propOpts && typeof propOpts === "object") {
              ownFactoryByKey.set(propKey, propOpts);
            }
          }
        }
      }

      const ownPluginByKey = new Map<string, ApiPropertyOptions>();
      const pluginProps = getPluginModelMetadata(ctor);
      if (pluginProps) {
        for (const p of pluginProps) {
          ownPluginByKey.set(p.propertyKey, p as unknown as ApiPropertyOptions);
        }
      }

      // Key ordering on `ctor`: @ApiProperty first, then _OPENAPI_METADATA_FACTORY, then plugin store.
      // Precedence when merging for a key: @ApiProperty > _OPENAPI_METADATA_FACTORY > plugin store.
      const orderedKeys = new Set<string>([
        ...ownPropsByKey.keys(),
        ...ownFactoryByKey.keys(),
        ...ownPluginByKey.keys(),
      ]);

      for (const propKey of orderedKeys) {
        let merged: ApiPropertyMetadata | undefined = propertyMap.get(propKey);

        const pluginOpt = ownPluginByKey.get(propKey);
        if (pluginOpt) {
          merged = {
            ...(pluginOpt as unknown as ApiPropertyMetadata),
            ...(merged ?? {}),
            propertyKey: propKey,
          };
        }

        const factoryOpt = ownFactoryByKey.get(propKey);
        if (factoryOpt) {
          let effectiveType = factoryOpt.type;
          if (
            merged?.type === "integer" &&
            effectiveType !== undefined &&
            (effectiveType === Number ||
              (isLazyTypeThunk(effectiveType) && effectiveType() === Number))
          ) {
            effectiveType = merged.type;
          }
          const prevHadExplicitReq =
            merged !== undefined && hasExplicitApiRequired(merged);
          const nextMerged: ApiPropertyMetadata = {
            ...(merged ?? {}),
            ...factoryOpt,
            ...(effectiveType !== undefined ? { type: effectiveType } : {}),
            propertyKey: propKey,
            required: prevHadExplicitReq
              ? merged!.required
              : typeof factoryOpt.required === "boolean"
                ? factoryOpt.required
                : (merged?.required ?? true),
          };
          if (prevHadExplicitReq) {
            Object.defineProperty(nextMerged, API_PROPERTY_EXPLICIT_REQUIRED, {
              value: true,
              enumerable: false,
            });
          }
          merged = nextMerged;
        }

        const entry = ownPropsByKey.get(propKey);
        if (entry) {
          decoratorKeys.add(propKey);
          const entryHasCombinator =
            entry.oneOf !== undefined ||
            entry.anyOf !== undefined ||
            entry.allOf !== undefined;
          const sanitizedBase =
            merged && entryHasCombinator && entry.type === undefined
              ? (() => {
                  const copy = { ...merged };
                  delete copy.type;
                  if (entry.additionalProperties === undefined) {
                    delete copy.additionalProperties;
                  }
                  return copy;
                })()
              : merged;
          const nextMerged = sanitizedBase
            ? { ...sanitizedBase, ...entry }
            : entry;
          if (hasExplicitApiRequired(entry)) {
            Object.defineProperty(nextMerged, API_PROPERTY_EXPLICIT_REQUIRED, {
              value: true,
              enumerable: false,
            });
          }
          merged = nextMerged;
        }

        if (merged) {
          propertyMap.set(propKey, merged);
        }
      }

      const genericMeta = Object.prototype.hasOwnProperty.call(
        ctor,
        SWAGGER_GENERIC_TYPE_META,
      )
        ? (ctor as unknown as Record<symbol, SwaggerGenericTypeMeta>)[
            SWAGGER_GENERIC_TYPE_META
          ]
        : undefined;

      if (genericMeta) {
        for (const [propKey, rawBinding] of Object.entries(
          genericMeta.bindings,
        )) {
          const unwrapped = isLazyTypeThunk(rawBinding)
            ? rawBinding()
            : rawBinding;
          const boundIsArray = Array.isArray(unwrapped);
          const boundType = boundIsArray ? unwrapped[0] : unwrapped;
          const existing = propertyMap.get(propKey);
          const nextEntry: ApiPropertyMetadata = {
            ...(existing ?? {}),
            propertyKey: propKey,
            type: boundType as ApiTypeInput,
            isArray: boundIsArray,
            required: existing?.required ?? true,
          };
          delete nextEntry.schema;
          if (!boundIsArray) {
            delete nextEntry.items;
          }
          if (existing && hasExplicitApiRequired(existing)) {
            Object.defineProperty(nextEntry, API_PROPERTY_EXPLICIT_REQUIRED, {
              value: true,
              enumerable: false,
            });
          }
          propertyMap.set(propKey, nextEntry);
          decoratorKeys.add(propKey);
        }
      }

      const ownHidden = MetadataRegistry.getOwn<readonly string[]>(
        SWAGGER_METADATA_KEYS.API_HIDDEN_PROPERTIES,
        ctor,
      );
      if (ownHidden) {
        for (const hiddenKey of ownHidden) {
          hiddenProps.add(hiddenKey);
        }
      }
    }

    return { propertyMap, hiddenProps, decoratorKeys };
  }

  private collectStandardSchemaMappedProperties(
    dto: Type<unknown> | Function,
    schemaType: "input" | "output",
  ): {
    properties: Record<string, OpenApiSchema | ReferenceObject>;
    required: Set<string>;
  } {
    const properties: Record<string, OpenApiSchema | ReferenceObject> = {};
    const required = new Set<string>();

    const visit = (cls: Function): void => {
      for (const ctor of MetadataRegistry.getPrototypeChain(cls)) {
        const mappedMeta = Object.prototype.hasOwnProperty.call(
          ctor,
          SWAGGER_MAPPED_TYPE_META,
        )
          ? (ctor as unknown as Record<symbol, SwaggerMappedTypeMeta>)[
              SWAGGER_MAPPED_TYPE_META
            ]
          : undefined;
        if (!mappedMeta) continue;

        const keySet = mappedMeta.keys ? new Set(mappedMeta.keys) : undefined;
        for (const src of mappedMeta.sources) {
          const srcStd = getStandardSchemaFromDto(src);
          if (srcStd !== undefined) {
            const resolved = this.resolveStandardSchema(srcStd, schemaType);
            if (resolved?.properties) {
              const srcReq = new Set(resolved.required ?? []);
              for (const [k, v] of Object.entries(resolved.properties)) {
                if (mappedMeta.kind === "pick" && keySet && !keySet.has(k)) {
                  continue;
                }
                if (mappedMeta.kind === "omit" && keySet && keySet.has(k)) {
                  continue;
                }
                properties[k] = v;
                if (
                  mappedMeta.kind !== "partial" &&
                  mappedMeta.kind !== "deepPartial" &&
                  srcReq.has(k)
                ) {
                  required.add(k);
                }
              }
            }
          } else {
            visit(src);
          }
        }
      }
    };

    visit(dto);
    return { properties, required };
  }

  private populateDtoSchema(
    dto: Type<unknown> | Function,
    dtoSchema: OpenApiSchema,
    entitySchema: ReturnType<typeof getEntitySchema> | undefined,
    schemaType: "input" | "output" = "input",
  ): void {
    // Collect entity column metadata (from @Entity + @Column + @PrimaryKey across inheritance chain)
    const entityColumnMap = new Map<string, EntityColumnMetadata>();
    if (entitySchema) {
      for (let i = 0; i < entitySchema.columns.length; i++) {
        const col = entitySchema.columns[i]!;
        entityColumnMap.set(col.propertyName, col);
      }
    }

    // Collect plugin metadata, _OPENAPI_METADATA_FACTORY, @ApiProperty, @ApiHideProperty, and mapped types
    const { propertyMap, hiddenProps, decoratorKeys } =
      this.collectDtoProperties(dto);

    // Collect Standard Schema properties from mixed mapped types (e.g. IntersectionType(SchemaDto, ClassDto))
    const stdMapped = this.collectStandardSchemaMappedProperties(
      dto,
      schemaType,
    );

    // Collect @bunest/validation hints across the DTO class
    const validatorHints = extractClassValidatorHints(dto);

    // Collect @bunest/validation/transformer hints (@Exclude, @Expose, @Type)
    const transformerHints = extractTransformerHints(dto);

    const allPropertyNames = new Set<string>([
      ...entityColumnMap.keys(),
      ...propertyMap.keys(),
      ...validatorHints.properties.keys(),
      ...transformerHints.exposedProperties,
      ...transformerHints.typeResolvers.keys(),
    ]);

    const properties: Record<string, OpenApiSchema | ReferenceObject> = {};
    const required: string[] = [];

    for (const [k, v] of Object.entries(stdMapped.properties)) {
      if (hiddenProps.has(k)) continue;
      properties[k] = v;
      if (stdMapped.required.has(k)) {
        required.push(k);
      }
    }

    for (const propKey of allPropertyNames) {
      if (hiddenProps.has(propKey)) {
        continue;
      }
      const entityCol = entityColumnMap.get(propKey);
      const hasExplicitApiProperty = decoratorKeys.has(propKey);

      if (
        entityCol !== undefined &&
        (entityCol as { select?: boolean }).select === false &&
        !hasExplicitApiProperty
      ) {
        continue;
      }

      if (
        transformerHints.excludeAll &&
        !transformerHints.exposedProperties.has(propKey) &&
        !hasExplicitApiProperty
      ) {
        continue;
      }

      if (
        transformerHints.excludedProperties.has(propKey) &&
        !transformerHints.exposedProperties.has(propKey) &&
        !hasExplicitApiProperty
      ) {
        continue;
      }

      const apiMeta = propertyMap.get(propKey);
      const valHints = validatorHints.properties.get(propKey);
      const isOptionalByValidator =
        validatorHints.optionalProperties.has(propKey);
      const transformerTypeFn = transformerHints.typeResolvers.get(propKey);

      const outputName =
        apiMeta?.name ??
        transformerHints.renamedProperties.get(propKey) ??
        propKey;
      const propSchema = this.buildPropertySchema(
        dto,
        propKey,
        apiMeta,
        valHints,
        entityCol,
        transformerTypeFn,
      );
      properties[outputName] = propSchema;

      const explicitReq =
        apiMeta?.selfRequired !== undefined
          ? apiMeta.selfRequired
          : typeof apiMeta?.required === "boolean"
            ? apiMeta.required
            : true;

      let isRequired: boolean;
      if (apiMeta !== undefined) {
        if (entityCol !== undefined && !hasExplicitApiRequired(apiMeta)) {
          isRequired =
            !isOptionalEntityColumn(entityCol) && !isOptionalByValidator;
        } else {
          isRequired = explicitReq && !isOptionalByValidator;
        }
      } else if (entityCol !== undefined) {
        isRequired =
          !isOptionalEntityColumn(entityCol) && !isOptionalByValidator;
      } else {
        isRequired = !isOptionalByValidator;
      }
      if (isRequired && !required.includes(outputName)) {
        required.push(outputName);
      }
    }

    dtoSchema.properties = properties;
    if (required.length > 0) {
      dtoSchema.required = required;
    }
  }

  private buildInlinePropertySchema(
    meta: ApiPropertyOptions | OpenApiSchema | ReferenceObject,
  ): OpenApiSchema {
    if ("$ref" in meta && typeof meta.$ref === "string") {
      return { ...(meta as OpenApiSchema) };
    }
    const opts = meta as ApiPropertyOptions;
    let schema: OpenApiSchema;
    if (opts.type !== undefined) {
      schema = this.resolveTypeSchema(opts.type, opts.isArray === true);
    } else {
      schema = {};
    }
    this.applyApiPropertyOptionsToSchema(schema, opts);
    return this.finalizeNullable(schema, opts.nullable);
  }

  private applyApiPropertyOptionsToSchema(
    schema: OpenApiSchema,
    apiMeta: ApiPropertyOptions,
  ): void {
    if (apiMeta.title !== undefined) schema.title = apiMeta.title;
    if (apiMeta.description !== undefined) {
      schema.description = apiMeta.description;
    }
    if (apiMeta.format !== undefined) {
      if (schema.type === "array" && schema.items && !("$ref" in schema.items)) {
        schema.items = { ...schema.items, format: apiMeta.format };
      } else {
        schema.format = apiMeta.format;
      }
    }
    if (apiMeta.default !== undefined) {
      const isDynamic = isDynamicDefaultValue(apiMeta.default);
      if (!(this.options.excludeDynamicDefaults && isDynamic)) {
        const rawDefault =
          typeof apiMeta.default === "function"
            ? (apiMeta.default as () => unknown)()
            : apiMeta.default;
        let defaultModelCtor: Function | undefined;
        if (apiMeta.type !== undefined) {
          let unwrapped: unknown = isLazyTypeThunk(apiMeta.type)
            ? apiMeta.type()
            : apiMeta.type;
          if (Array.isArray(unwrapped)) unwrapped = unwrapped[0];
          if (isDtoConstructor(unwrapped)) {
            defaultModelCtor = unwrapped;
          }
        }
        schema.default = this.sanitizeDefaultValue(
          rawDefault,
          defaultModelCtor,
        );
      }
    }
    const maxDepth = apiMeta.exampleMaxDepth ?? this.options.exampleMaxDepth;
    if (apiMeta.example !== undefined) {
      schema.example =
        maxDepth !== undefined
          ? truncateExampleDepth(apiMeta.example, maxDepth)
          : apiMeta.example;
    }
    if (apiMeta.examples !== undefined) {
      schema.examples = Array.isArray(apiMeta.examples)
        ? [...apiMeta.examples]
        : { ...apiMeta.examples };
    }
    if (apiMeta.enum !== undefined && !apiMeta.enumName) {
      const enumVals = normalizeEnumValues(apiMeta.enum);
      if (schema.type === "array" && schema.items && !("$ref" in schema.items)) {
        const itemsObj = { ...schema.items };
        itemsObj.enum = enumVals;
        if (itemsObj.type === undefined || itemsObj.type === "object") {
          const inferred = inferEnumSchemaType(enumVals);
          if (inferred) itemsObj.type = inferred;
        }
        schema.items = itemsObj;
      } else {
        schema.enum = enumVals;
        if (
          apiMeta.type === undefined ||
          schema.type === undefined ||
          schema.type === "object"
        ) {
          const inferred = inferEnumSchemaType(enumVals);
          if (inferred) schema.type = inferred;
        }
      }
    }
    if (apiMeta["x-enumNames"] !== undefined) {
      schema["x-enumNames"] = [...apiMeta["x-enumNames"]];
    }
    if (apiMeta.const !== undefined) schema.const = apiMeta.const;
    const isArrayWithInlineItems =
      schema.type === "array" &&
      schema.items !== undefined &&
      !("$ref" in schema.items);
    const numericTarget: OpenApiSchema = isArrayWithInlineItems
      ? (schema.items = { ...schema.items })
      : schema;
    if (apiMeta.minimum !== undefined) numericTarget.minimum = apiMeta.minimum;
    if (apiMeta.maximum !== undefined) numericTarget.maximum = apiMeta.maximum;
    if (apiMeta.exclusiveMinimum !== undefined) {
      numericTarget.exclusiveMinimum = apiMeta.exclusiveMinimum;
    }
    if (apiMeta.exclusiveMaximum !== undefined) {
      numericTarget.exclusiveMaximum = apiMeta.exclusiveMaximum;
    }
    if (apiMeta.multipleOf !== undefined) {
      numericTarget.multipleOf = apiMeta.multipleOf;
    }
    if (apiMeta.minLength !== undefined) schema.minLength = apiMeta.minLength;
    if (apiMeta.maxLength !== undefined) schema.maxLength = apiMeta.maxLength;
    if (apiMeta.pattern !== undefined) {
      schema.pattern =
        apiMeta.pattern instanceof RegExp
          ? apiMeta.pattern.source
          : apiMeta.pattern;
    }
    if (apiMeta.minItems !== undefined) schema.minItems = apiMeta.minItems;
    if (apiMeta.maxItems !== undefined) schema.maxItems = apiMeta.maxItems;
    if (apiMeta.uniqueItems !== undefined) {
      schema.uniqueItems = apiMeta.uniqueItems;
    }
    if (apiMeta.minProperties !== undefined) {
      schema.minProperties = apiMeta.minProperties;
    }
    if (apiMeta.maxProperties !== undefined) {
      schema.maxProperties = apiMeta.maxProperties;
    }
    if (apiMeta.readOnly !== undefined) schema.readOnly = apiMeta.readOnly;
    if (apiMeta.writeOnly !== undefined) schema.writeOnly = apiMeta.writeOnly;
    if (apiMeta.deprecated !== undefined) {
      schema.deprecated = apiMeta.deprecated;
    }
    if (apiMeta.items !== undefined && schema.type === "array") {
      schema.items = { ...apiMeta.items };
    }
    if (apiMeta.properties !== undefined) {
      const nestedProps: Record<string, OpenApiSchema> = {};
      for (const [k, v] of Object.entries(apiMeta.properties)) {
        nestedProps[k] = this.buildInlinePropertySchema(v);
      }
      schema.properties = nestedProps;
      if (Array.isArray(apiMeta.required)) {
        schema.required = [...apiMeta.required];
      }
    }
    if (apiMeta.additionalProperties !== undefined) {
      schema.additionalProperties = apiMeta.additionalProperties;
    }
    if (apiMeta.patternProperties !== undefined) {
      schema.patternProperties = apiMeta.patternProperties;
    }
    if (apiMeta.allOf !== undefined) {
      if (schema.$ref) {
        const refVal = schema.$ref;
        delete schema.$ref;
        schema.allOf = [...apiMeta.allOf, { $ref: refVal }];
      } else {
        schema.allOf = [...apiMeta.allOf];
      }
    }
    if (apiMeta.anyOf !== undefined) {
      if (schema.type === "array") {
        const curItems =
          schema.items && !("$ref" in schema.items) ? { ...schema.items } : {};
        if (curItems.type === "object") delete curItems.type;
        curItems.anyOf = [...apiMeta.anyOf];
        schema.items = curItems;
      } else {
        schema.anyOf = [...apiMeta.anyOf];
      }
    }
    if (apiMeta.oneOf !== undefined) {
      if (schema.type === "array") {
        const curItems =
          schema.items && !("$ref" in schema.items) ? { ...schema.items } : {};
        if (curItems.type === "object") delete curItems.type;
        curItems.oneOf = [...apiMeta.oneOf];
        schema.items = curItems;
      } else {
        schema.oneOf = [...apiMeta.oneOf];
      }
    }
    if (apiMeta.not !== undefined) schema.not = apiMeta.not;
    if (apiMeta.discriminator !== undefined) {
      schema.discriminator = { ...apiMeta.discriminator };
    }
    if (apiMeta.xml !== undefined) schema.xml = { ...apiMeta.xml };
    if (apiMeta.externalDocs !== undefined) {
      schema.externalDocs = { ...apiMeta.externalDocs };
    }
    if (apiMeta.contentEncoding !== undefined) {
      schema.contentEncoding = apiMeta.contentEncoding;
    }
    if (apiMeta.contentMediaType !== undefined) {
      schema.contentMediaType = apiMeta.contentMediaType;
    }
    if (this.options.excludeDynamicDefaults) {
      const cleaned = stripDynamicDefaultsFromSchema(schema);
      for (const key of Object.keys(schema)) {
        delete (schema as Record<string, unknown>)[key];
      }
      Object.assign(schema, cleaned);
    }
    if (maxDepth !== undefined || this.options.exampleMaxDepth !== undefined) {
      applyExampleMaxDepthToSchema(
        schema,
        maxDepth,
        this.options.exampleMaxDepth,
      );
    }
  }

  private resolveEntityColumnBaseSchema(
    col: EntityColumnMetadata,
  ): OpenApiSchema {
    switch (col.type as string) {
      case "integer":
        return { type: "integer" };
      case "bigint":
        return { type: "integer", format: "int64" };
      case "real":
        return { type: "number" };
      case "boolean":
        return { type: "boolean" };
      case "date":
        return { type: "string", format: "date" };
      case "datetime":
        return { type: "string", format: "date-time" };
      case "uuid":
        return { type: "string", format: "uuid" };
      case "blob":
        return { type: "string", format: "binary" };
      case "json":
        if (col.designType === Array) {
          return { type: "array", items: {} };
        }
        if (col.designType !== undefined && isDtoConstructor(col.designType)) {
          return this.resolveTypeSchema(col.designType, false);
        }
        return { type: "object" };
      case "varchar":
      case "text":
      default:
        return { type: "string" };
    }
  }

  private applyEntityColumnMetadataToSchema(
    schema: OpenApiSchema,
    col: EntityColumnMetadata,
  ): void {
    if (col.description !== undefined) {
      schema.description = col.description;
    }
    if (col.hasDefault && col.default !== undefined) {
      const isDynamic =
        typeof col.default === "function" || col.default instanceof Date;
      if (!(this.options.excludeDynamicDefaults && isDynamic)) {
        schema.default =
          typeof col.default === "function"
            ? (col.default as () => unknown)()
            : col.default;
      }
    }
    if (col.example !== undefined) {
      const maxDepth = this.options.exampleMaxDepth;
      schema.example =
        maxDepth !== undefined
          ? truncateExampleDepth(col.example, maxDepth)
          : col.example;
    }
    if (schema.$ref) {
      return;
    }
    if (col.minLength !== undefined) {
      schema.minLength = col.minLength;
    }
    const effectiveMaxLength =
      col.maxLength ??
      (col.type === "varchar" || col.type === "text" ? col.length : undefined);
    if (effectiveMaxLength !== undefined) {
      schema.maxLength = effectiveMaxLength;
    }
    if (col.min !== undefined) {
      schema.minimum = col.min;
    }
    if (col.max !== undefined) {
      schema.maximum = col.max;
    }
    if (col.pattern !== undefined) {
      schema.pattern =
        col.pattern instanceof RegExp ? col.pattern.source : col.pattern;
    }
    if (col.enum !== undefined && col.enum.length > 0) {
      schema.enum = [...col.enum];
    }
  }

  private applyValidatorHintsToSchema(
    target: OpenApiSchema,
    hints: Partial<OpenApiSchema>,
  ): void {
    if (target.$ref) {
      return;
    }
    if (hints.type !== undefined && target.type === undefined) {
      target.type = hints.type;
    } else if (hints.type === "integer" && target.type === "number") {
      target.type = "integer";
    }
    if (hints.format !== undefined && target.format === undefined) {
      target.format = hints.format;
    }
    if (hints.minLength !== undefined) {
      target.minLength = hints.minLength;
    }
    if (hints.maxLength !== undefined) {
      target.maxLength = hints.maxLength;
    }
    if (hints.minimum !== undefined) target.minimum = hints.minimum;
    if (hints.maximum !== undefined) target.maximum = hints.maximum;
    if (hints.exclusiveMinimum !== undefined) {
      target.exclusiveMinimum = hints.exclusiveMinimum;
    }
    if (hints.exclusiveMaximum !== undefined) {
      target.exclusiveMaximum = hints.exclusiveMaximum;
    }
    if (hints.multipleOf !== undefined) {
      target.multipleOf = hints.multipleOf;
    }
    if (hints.pattern !== undefined) target.pattern = hints.pattern;
    if (
      hints.contentEncoding !== undefined &&
      target.contentEncoding === undefined
    ) {
      target.contentEncoding = hints.contentEncoding;
    }
    if (hints.minProperties !== undefined) {
      target.minProperties = hints.minProperties;
    }
    if (hints.enum !== undefined && target.enum === undefined) {
      target.enum = hints.enum;
    }
    if (hints.const !== undefined) {
      if (this.isOas31()) {
        if (target.const === undefined) {
          target.const = hints.const;
        }
      } else if (target.enum === undefined) {
        target.enum = [hints.const];
      }
    }
    if (hints.minItems !== undefined) target.minItems = hints.minItems;
    if (hints.maxItems !== undefined) target.maxItems = hints.maxItems;
    if (hints.uniqueItems !== undefined) {
      target.uniqueItems = hints.uniqueItems;
    }
    if (
      hints.items !== undefined &&
      !Array.isArray(hints.items) &&
      !("$ref" in hints.items) &&
      target.type === "array"
    ) {
      if (target.items === undefined) {
        target.items = {};
      }
      if (!Array.isArray(target.items) && !("$ref" in target.items)) {
        this.applyValidatorHintsToSchema(target.items, hints.items);
      }
    }
  }

  private buildPropertySchema(
    dto: Type<unknown> | Function,
    propKey: string,
    apiMeta: ApiPropertyMetadata | undefined,
    valHints: Partial<OpenApiSchema> | undefined,
    entityCol?: EntityColumnMetadata,
    transformerTypeFn?: (options?: unknown) => unknown,
  ): OpenApiSchema {
    if (apiMeta?.schema) {
      const cloned = { ...apiMeta.schema };
      const maxDepth = apiMeta.exampleMaxDepth ?? this.options.exampleMaxDepth;
      if (maxDepth !== undefined || this.options.exampleMaxDepth !== undefined) {
        applyExampleMaxDepthToSchema(
          cloned,
          maxDepth,
          this.options.exampleMaxDepth,
        );
      }
      return this.finalizeNullable(
        cloned,
        apiMeta.nullable ?? entityCol?.nullable,
      );
    }

    // Named reusable enum schema (`@ApiProperty({ enum: Status, enumName: "Status" })`)
    if (apiMeta?.enumName && apiMeta.enum !== undefined) {
      const enumRef = this.registerEnumSchema(
        apiMeta.enumName,
        apiMeta.enum,
        apiMeta.enumSchema,
        apiMeta["x-enumNames"],
      );
      const unwrappedEnumType =
        apiMeta.type !== undefined && isLazyTypeThunk(apiMeta.type)
          ? apiMeta.type()
          : apiMeta.type;
      const isEnumArray =
        apiMeta.isArray === true || Array.isArray(unwrappedEnumType);
      let base: OpenApiSchema;
      if (apiMeta.oneOf !== undefined) {
        base = { oneOf: [...apiMeta.oneOf, enumRef] };
      } else if (apiMeta.anyOf !== undefined) {
        base = { anyOf: [...apiMeta.anyOf, enumRef] };
      } else {
        base = isEnumArray ? { type: "array", items: enumRef } : enumRef;
      }
      if (apiMeta.description !== undefined) {
        base.description = apiMeta.description;
      } else if (entityCol?.description !== undefined) {
        base.description = entityCol.description;
      }
      if (apiMeta.default !== undefined) {
        base.default = apiMeta.default;
      } else if (entityCol?.hasDefault && entityCol.default !== undefined) {
        base.default = entityCol.default;
      }
      if (apiMeta.example !== undefined) {
        base.example = apiMeta.example;
      } else if (entityCol?.example !== undefined) {
        base.example = entityCol.example;
      }
      if (apiMeta.deprecated !== undefined)
        base.deprecated = apiMeta.deprecated;
      return this.finalizeNullable(
        base,
        apiMeta.nullable ?? entityCol?.nullable,
      );
    }

    const reflectedDesignType =
      apiMeta?.designType ??
      entityCol?.designType ??
      MetadataRegistry.getType(dto.prototype, propKey);

    const explicitType = apiMeta?.type;
    // Detect circular dependency when a lazy type thunk returns `undefined`
    if (explicitType !== undefined && isLazyTypeThunk(explicitType)) {
      const thunkVal = explicitType();
      if (thunkVal === undefined) {
        const chain = this.activeDtoStack.map((n) => `[${n}]`).join(" ");
        throw new Error(
          `${chain} A circular dependency has been detected (property key: "${propKey}"). Please, make sure that each side of a bidirectional relationships are using lazy resolvers ("type: () => ClassType").`,
        );
      }
    }
    const hasExplicitCombinator =
      apiMeta?.oneOf !== undefined ||
      apiMeta?.anyOf !== undefined ||
      apiMeta?.allOf !== undefined;
    const isArray =
      apiMeta?.isArray === true ||
      Array.isArray(explicitType) ||
      (explicitType === undefined &&
        entityCol === undefined &&
        (reflectedDesignType === Array || valHints?.type === "array"));

    let resolvedTransformerType: unknown;
    if (explicitType === undefined && transformerTypeFn !== undefined) {
      try {
        resolvedTransformerType = transformerTypeFn();
      } catch {
        resolvedTransformerType = undefined;
      }
    }

    let schema: OpenApiSchema;
    if (explicitType !== undefined) {
      schema = this.resolveTypeSchema(explicitType, apiMeta?.isArray === true);
    } else if (hasExplicitCombinator && !isArray) {
      schema = {};
    } else if (resolvedTransformerType !== undefined) {
      schema = this.resolveTypeSchema(
        resolvedTransformerType,
        isArray || reflectedDesignType === Array,
      );
    } else if (entityCol !== undefined) {
      schema = this.resolveEntityColumnBaseSchema(entityCol);
    } else if (
      reflectedDesignType !== undefined &&
      reflectedDesignType !== Array
    ) {
      schema = this.resolveTypeSchema(reflectedDesignType, false);
    } else if (isArray) {
      schema = {
        type: "array",
        items: apiMeta?.items ? { ...apiMeta.items } : {},
      };
    } else {
      schema = {};
    }

    // Apply @Entity/@Column constraints & metadata first
    if (entityCol) {
      this.applyEntityColumnMetadataToSchema(schema, entityCol);
    }

    // Apply @bunest/validation inferred hints next (explicit @ApiProperty overrides both)
    if (valHints) {
      this.applyValidatorHintsToSchema(schema, valHints);
    }

    // Apply explicit @ApiProperty options (highest precedence)
    if (apiMeta) {
      this.applyApiPropertyOptionsToSchema(schema, apiMeta);
    }

    const effectiveNullable =
      apiMeta?.nullable !== undefined ? apiMeta.nullable : entityCol?.nullable;
    return this.finalizeNullable(schema, effectiveNullable);
  }
}

/**
 * Standalone DTO-to-OpenAPI schema generator without bootstrapping an application.
 * Returns the generated root `schema` alongside all referenced `schemas`.
 */
export function generateSchema<T = any>(
  target: Type<T>,
  extraSchemas: Record<string, SchemaObject> = {},
): { schema: SchemaObject; schemas: Record<string, SchemaObject> } {
  const explorer = new SchemaExplorer();
  const rootName = explorer.registerDtoSchema(target);
  const generated = explorer.getSchemas();
  const schemas: Record<string, SchemaObject> = {
    ...extraSchemas,
    ...generated,
  };
  return {
    schema: schemas[rootName] ?? { type: "object", properties: {} },
    schemas,
  };
}
