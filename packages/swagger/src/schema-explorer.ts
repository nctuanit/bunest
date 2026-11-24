import {
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
    hasClassValidatorMetadata(value) ||
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
 * Returns `true` when `target` is a decorated DTO or `@Entity()` class carrying
 * Swagger `@ApiProperty`/`@ApiSchema`, Bunest `@Entity`, `class-validator`, or
 * CLI plugin model metadata.
 */
export function isSchemaDecoratedClass(target: Function): boolean {
  if (hasEntitySchema(target)) {
    return true;
  }
  for (const ctor of MetadataRegistry.getPrototypeChain(target)) {
    if (
      MetadataRegistry.hasOwn(SWAGGER_METADATA_KEYS.API_PROPERTIES, ctor) ||
      MetadataRegistry.hasOwn(SWAGGER_METADATA_KEYS.API_SCHEMA, ctor) ||
      getPluginModelMetadata(ctor) !== undefined
    ) {
      return true;
    }
  }
  return hasClassValidatorMetadata(target);
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

/**
 * Built-in zero-dependency Standard JSON Schema v1 (`~standard.jsonSchema`) converter.
 * Compatible with Zod v4, Valibot, ArkType, and any StandardJSONSchemaV1 object.
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
  let raw: Record<string, unknown>;
  try {
    raw = fn({ target: "openapi-3.0" });
  } catch {
    raw = fn({ target: "draft-2020-12" });
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

  // Rewrite local JSON Schema `#/$defs/X` or `#/definitions/X` to `#/components/schemas/X`
  const rewriteRefs = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(rewriteRefs);
    }
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === "$ref" && typeof v === "string") {
          out[k] = v
            .replace(/^#\/\$defs\//, "#/components/schemas/")
            .replace(/^#\/definitions\//, "#/components/schemas/");
        } else {
          out[k] = rewriteRefs(v);
        }
      }
      return out;
    }
    return node;
  };

  return {
    schema: rewriteRefs(cloned),
    ...(Object.keys(components).length > 0
      ? { components: rewriteRefs(components) as Record<string, any> }
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
  return undefined;
}

function applyNullable31(
  schema: OpenApiSchema,
  nullable?: boolean,
): OpenApiSchema {
  if (!nullable) {
    return schema;
  }
  if (schema.$ref) {
    const { $ref, ...siblings } = schema;
    return { ...siblings, anyOf: [{ $ref }, { type: "null" }] };
  }
  if (typeof schema.type === "string") {
    return { ...schema, type: [schema.type, "null"] };
  }
  if (Array.isArray(schema.type)) {
    return schema.type.includes("null")
      ? schema
      : { ...schema, type: [...schema.type, "null"] };
  }
  return { anyOf: [schema, { type: "null" }] };
}

function truncateExampleDepth(
  value: unknown,
  maxDepth: number,
  currentDepth = 0,
): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (currentDepth >= maxDepth) {
    return Array.isArray(value) ? [] : {};
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      truncateExampleDepth(item, maxDepth, currentDepth + 1),
    );
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = truncateExampleDepth(v, maxDepth, currentDepth + 1);
  }
  return out;
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
        optionalProperties.add(propName);
        continue;
      }

      let schema = properties.get(propName);
      if (!schema) {
        schema = {};
        properties.set(propName, schema);
      }

      const ruleName = (meta.name ?? meta.type ?? "").toLowerCase();
      const constraints = meta.constraints ?? [];

      switch (ruleName) {
        case "isstring":
          schema.type = "string";
          break;
        case "isemail":
          schema.type = "string";
          schema.format = "email";
          break;
        case "isuuid":
          schema.type = "string";
          schema.format = "uuid";
          break;
        case "isurl":
          schema.type = "string";
          schema.format = "uri";
          break;
        case "isdatestring":
          schema.type = "string";
          schema.format = "date-time";
          break;
        case "isint":
          schema.type = "integer";
          break;
        case "isnumber":
        case "ispositive":
        case "isnegative":
          schema.type = schema.type ?? "number";
          break;
        case "isboolean":
          schema.type = "boolean";
          break;
        case "isarray":
          schema.type = "array";
          break;
        case "isnotempty":
          if (schema.type === undefined || schema.type === "string") {
            schema.minLength = Math.max(schema.minLength ?? 0, 1);
          }
          break;
        case "minlength":
          if (typeof constraints[0] === "number") {
            schema.minLength = constraints[0];
          }
          break;
        case "maxlength":
          if (typeof constraints[0] === "number") {
            schema.maxLength = constraints[0];
          }
          break;
        case "min":
          if (typeof constraints[0] === "number") {
            schema.minimum = constraints[0];
          }
          break;
        case "max":
          if (typeof constraints[0] === "number") {
            schema.maximum = constraints[0];
          }
          break;
        case "matches":
          if (constraints[0] instanceof RegExp) {
            schema.pattern = constraints[0].source;
          } else if (typeof constraints[0] === "string") {
            schema.pattern = constraints[0];
          }
          break;
        case "isenum":
          if (constraints[0] && typeof constraints[0] === "object") {
            schema.enum = normalizeEnumValues(
              constraints[0] as Record<string, string | number>,
            );
          }
          break;
        case "isin":
          if (Array.isArray(constraints[0])) {
            schema.enum = [...constraints[0]];
          }
          break;
        case "arrayminsize":
          if (typeof constraints[0] === "number") {
            schema.minItems = constraints[0];
          }
          break;
        case "arraymaxsize":
          if (typeof constraints[0] === "number") {
            schema.maxItems = constraints[0];
          }
          break;
        case "arrayunique":
          schema.uniqueItems = true;
          break;
        default:
          break;
      }
    }
  } catch {
    // Gracefully skip if class-validator metadata storage is unavailable
  }

  return { properties, optionalProperties };
}

export interface SchemaExplorerOptions {
  readonly excludeDynamicDefaults?: boolean;
  readonly exampleMaxDepth?: number;
  readonly standardSchemaConverter?: StandardSchemaConverter;
}

/**
 * Introspects TypeScript design types, `@ApiProperty` metadata (with inheritance),
 * `@ApiSchema` metadata, CLI plugin metadata, `class-validator` constraints, and
 * Standard JSON Schema objects into OpenAPI 3.1 `components.schemas`, handling
 * nested and circular DTO references without infinite recursion.
 */
export class SchemaExplorer {
  private readonly schemas: Record<string, OpenApiSchema> = {};
  private readonly classToName = new Map<Function, string>();
  private readonly nameToClass = new Map<string, Function>();
  private readonly options: SchemaExplorerOptions;

  constructor(options: SchemaExplorerOptions = {}) {
    this.options = options;
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
    const converter =
      this.options.standardSchemaConverter ?? defaultStandardSchemaConverter;
    const result =
      converter(standardSchema, { schemaType }) ??
      (this.options.standardSchemaConverter
        ? defaultStandardSchemaConverter(standardSchema, { schemaType })
        : undefined);
    if (!result || !result.schema || typeof result.schema !== "object") {
      return undefined;
    }
    if (result.components && typeof result.components === "object") {
      for (const [name, compSchema] of Object.entries(result.components)) {
        if (compSchema && typeof compSchema === "object") {
          this.schemas[name] = compSchema as OpenApiSchema;
        }
      }
    }
    return result.schema as OpenApiSchema;
  }

  /**
   * Resolves a type input (`String`, `Number`, DTO class, `[Dto]`, `() => Dto`,
   * Standard Schema, etc.) into an OpenAPI 3.1 schema (registering DTOs in
   * `components.schemas` and returning `$ref`).
   */
  resolveTypeSchema(
    rawType: ApiTypeInput | unknown,
    isArray = false,
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
      const converted = this.resolveStandardSchema(rawType, "input");
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
        items: this.resolveTypeSchema(itemType, false),
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
      const refName = this.registerDtoSchema(resolved);
      baseSchema = { $ref: `#/components/schemas/${refName}` };
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
  registerDtoSchema(dto: Type<unknown> | Function): string {
    const existingName = this.classToName.get(dto);
    if (existingName !== undefined) {
      return existingName;
    }

    const schemaMeta = MetadataRegistry.getOwn<ApiSchemaOptions>(
      SWAGGER_METADATA_KEYS.API_SCHEMA,
      dto,
    );
    const entitySchema = hasEntitySchema(dto)
      ? getEntitySchema(dto)
      : undefined;
    const baseName = schemaMeta?.name || dto.name || "AnonymousSchema";
    let schemaName = baseName;
    let suffix = 2;
    while (
      this.nameToClass.has(schemaName) &&
      this.nameToClass.get(schemaName) !== dto
    ) {
      schemaName = `${baseName}_${suffix++}`;
    }

    const schemaDescription =
      schemaMeta?.description ?? entitySchema?.description;

    // Reserve immediately to break circular DTO recursion!
    this.classToName.set(dto, schemaName);
    this.nameToClass.set(schemaName, dto);
    const dtoSchema: OpenApiSchema = {
      type: "object",
      ...(schemaDescription !== undefined
        ? { description: schemaDescription }
        : {}),
      properties: {},
    };
    this.schemas[schemaName] = dtoSchema;

    // Collect entity column metadata (from @Entity + @Column + @PrimaryKey across inheritance chain)
    const entityColumnMap = new Map<string, EntityColumnMetadata>();
    if (entitySchema) {
      for (let i = 0; i < entitySchema.columns.length; i++) {
        const col = entitySchema.columns[i]!;
        entityColumnMap.set(col.propertyName, col);
      }
    }

    // Collect plugin metadata (lowest precedence), then @ApiProperty and @ApiHideProperty across inheritance chain
    const propertyMap = new Map<string, ApiPropertyMetadata>();
    const hiddenProps = new Set<string>();
    for (const ctor of MetadataRegistry.getPrototypeChain(dto)) {
      const pluginProps = getPluginModelMetadata(ctor);
      if (pluginProps) {
        for (const p of pluginProps) {
          const existing = propertyMap.get(p.propertyKey);
          propertyMap.set(p.propertyKey, {
            ...(p as unknown as ApiPropertyMetadata),
            ...(existing ?? {}),
            propertyKey: p.propertyKey,
          });
        }
      }
      const ownProps = MetadataRegistry.getOwn<readonly ApiPropertyMetadata[]>(
        SWAGGER_METADATA_KEYS.API_PROPERTIES,
        ctor,
      );
      if (ownProps) {
        for (let i = 0; i < ownProps.length; i++) {
          const entry = ownProps[i];
          if (entry) {
            const base = propertyMap.get(entry.propertyKey);
            const mergedEntry = base ? { ...base, ...entry } : entry;
            if (hasExplicitApiRequired(entry)) {
              Object.defineProperty(
                mergedEntry,
                API_PROPERTY_EXPLICIT_REQUIRED,
                {
                  value: true,
                  enumerable: false,
                },
              );
            }
            propertyMap.set(entry.propertyKey, mergedEntry);
          }
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

    // Collect class-validator hints across the DTO class
    const validatorHints = extractClassValidatorHints(dto);

    const allPropertyNames = new Set<string>([
      ...entityColumnMap.keys(),
      ...propertyMap.keys(),
      ...validatorHints.properties.keys(),
    ]);

    const properties: Record<string, OpenApiSchema> = {};
    const required: string[] = [];

    for (const propKey of allPropertyNames) {
      if (hiddenProps.has(propKey)) {
        continue;
      }
      const entityCol = entityColumnMap.get(propKey);
      const apiMeta = propertyMap.get(propKey);
      const valHints = validatorHints.properties.get(propKey);
      const isOptionalByValidator =
        validatorHints.optionalProperties.has(propKey);

      const outputName = apiMeta?.name ?? propKey;
      const propSchema = this.buildPropertySchema(
        dto,
        propKey,
        apiMeta,
        valHints,
        entityCol,
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
      if (isRequired) {
        required.push(outputName);
      }
    }

    dtoSchema.properties = properties;
    if (required.length > 0) {
      dtoSchema.required = required;
    }

    return schemaName;
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
    return applyNullable31(schema, opts.nullable);
  }

  private applyApiPropertyOptionsToSchema(
    schema: OpenApiSchema,
    apiMeta: ApiPropertyOptions,
  ): void {
    if (apiMeta.title !== undefined) schema.title = apiMeta.title;
    if (apiMeta.description !== undefined) {
      schema.description = apiMeta.description;
    }
    if (apiMeta.format !== undefined) schema.format = apiMeta.format;
    if (apiMeta.default !== undefined) {
      const isDynamic =
        typeof apiMeta.default === "function" ||
        apiMeta.default instanceof Date;
      if (!(this.options.excludeDynamicDefaults && isDynamic)) {
        schema.default =
          typeof apiMeta.default === "function"
            ? (apiMeta.default as () => unknown)()
            : apiMeta.default;
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
      schema.enum = normalizeEnumValues(apiMeta.enum);
    }
    if (apiMeta["x-enumNames"] !== undefined) {
      schema["x-enumNames"] = [...apiMeta["x-enumNames"]];
    }
    if (apiMeta.const !== undefined) schema.const = apiMeta.const;
    if (apiMeta.minimum !== undefined) schema.minimum = apiMeta.minimum;
    if (apiMeta.maximum !== undefined) schema.maximum = apiMeta.maximum;
    if (apiMeta.exclusiveMinimum !== undefined) {
      schema.exclusiveMinimum = apiMeta.exclusiveMinimum;
    }
    if (apiMeta.exclusiveMaximum !== undefined) {
      schema.exclusiveMaximum = apiMeta.exclusiveMaximum;
    }
    if (apiMeta.multipleOf !== undefined) {
      schema.multipleOf = apiMeta.multipleOf;
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
    if (apiMeta.allOf !== undefined) schema.allOf = [...apiMeta.allOf];
    if (apiMeta.anyOf !== undefined) schema.anyOf = [...apiMeta.anyOf];
    if (apiMeta.oneOf !== undefined) schema.oneOf = [...apiMeta.oneOf];
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
  }

  private resolveEntityColumnBaseSchema(
    col: EntityColumnMetadata,
  ): OpenApiSchema {
    switch (col.type) {
      case "integer":
        return { type: "integer" };
      case "bigint":
        return { type: "integer", format: "int64" };
      case "real":
        return { type: "number" };
      case "boolean":
        return { type: "boolean" };
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

  private buildPropertySchema(
    dto: Type<unknown> | Function,
    propKey: string,
    apiMeta: ApiPropertyMetadata | undefined,
    valHints: Partial<OpenApiSchema> | undefined,
    entityCol?: EntityColumnMetadata,
  ): OpenApiSchema {
    if (apiMeta?.schema) {
      return applyNullable31(
        { ...apiMeta.schema },
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
      const base: OpenApiSchema = apiMeta.isArray
        ? { type: "array", items: enumRef }
        : enumRef;
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
      return applyNullable31(base, apiMeta.nullable ?? entityCol?.nullable);
    }

    const reflectedDesignType =
      apiMeta?.designType ??
      entityCol?.designType ??
      MetadataRegistry.getType(dto.prototype, propKey);

    const explicitType = apiMeta?.type;
    const isArray =
      apiMeta?.isArray === true ||
      Array.isArray(explicitType) ||
      (explicitType === undefined &&
        entityCol === undefined &&
        reflectedDesignType === Array);

    let schema: OpenApiSchema;
    if (explicitType !== undefined) {
      schema = this.resolveTypeSchema(explicitType, apiMeta?.isArray === true);
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

    // Apply class-validator inferred hints next (explicit @ApiProperty overrides both)
    if (valHints) {
      if (!schema.$ref) {
        if (valHints.type !== undefined && schema.type === undefined) {
          schema.type = valHints.type;
        } else if (valHints.type === "integer" && schema.type === "number") {
          schema.type = "integer";
        }
        if (valHints.format !== undefined && schema.format === undefined) {
          schema.format = valHints.format;
        }
        if (valHints.minLength !== undefined) {
          schema.minLength = valHints.minLength;
        }
        if (valHints.maxLength !== undefined) {
          schema.maxLength = valHints.maxLength;
        }
        if (valHints.minimum !== undefined) schema.minimum = valHints.minimum;
        if (valHints.maximum !== undefined) schema.maximum = valHints.maximum;
        if (valHints.pattern !== undefined) schema.pattern = valHints.pattern;
        if (valHints.enum !== undefined && schema.enum === undefined) {
          schema.enum = valHints.enum;
        }
        if (valHints.minItems !== undefined)
          schema.minItems = valHints.minItems;
        if (valHints.maxItems !== undefined)
          schema.maxItems = valHints.maxItems;
        if (valHints.uniqueItems !== undefined) {
          schema.uniqueItems = valHints.uniqueItems;
        }
      }
    }

    // Apply explicit @ApiProperty options (highest precedence)
    if (apiMeta) {
      this.applyApiPropertyOptionsToSchema(schema, apiMeta);
    }

    const effectiveNullable =
      apiMeta?.nullable !== undefined ? apiMeta.nullable : entityCol?.nullable;
    return applyNullable31(schema, effectiveNullable);
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
