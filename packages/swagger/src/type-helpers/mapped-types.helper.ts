import { capitalize, isObject, isPromiseLike } from "@bunest/core/common";
import {
  CompositionType as CoreCompositionType,
  IntersectionType as CoreIntersectionType,
  OmitType as CoreOmitType,
  PartialType as CorePartialType,
  PickType as CorePickType,
  MetadataRegistry,
  getValidationMetadatasForTarget,
  type StandardSchemaV1,
  type StandardSchemaV1Issue,
  type StandardSchemaV1Result,
  type Type,
} from "@bunest/core";
import { SWAGGER_METADATA_KEYS } from "../constants";
import type {
  ApiPropertyMetadata,
  StandardJsonSchemaOptions,
} from "../interfaces/openapi.interface";
import { getPluginModelMetadata } from "../plugin-metadata-store";

export const SWAGGER_MAPPED_TYPE_META = Symbol.for(
  "bunest:swagger:mapped_type_meta",
);

const STANDARD_SCHEMA_DTO_KEY = Symbol.for("bunest:standard-schema-dto");
const STANDARD_SCHEMA_DTO_METADATA_KEY = "bunest:standard-schema-dto";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface SwaggerMappedTypeMeta {
  readonly kind:
    | "partial"
    | "deepPartial"
    | "pick"
    | "omit"
    | "intersection"
    | "composition";
  readonly sources: readonly Function[];
  readonly keys?: readonly string[];
  readonly wrapNestedDto?: (ctor: Type<unknown>) => Type<unknown>;
}

interface DuckTypedStandardSchema {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
      options?: unknown,
    ) => StandardSchemaV1Result<unknown> | Promise<StandardSchemaV1Result<unknown>>;
    readonly jsonSchema?: {
      readonly input?: (
        options: StandardJsonSchemaOptions,
      ) => Record<string, unknown>;
      readonly output?: (
        options: StandardJsonSchemaOptions,
      ) => Record<string, unknown>;
    };
  };
  readonly partial?: () => unknown;
  readonly pick?: (mask: Record<string, true>) => unknown;
  readonly omit?: (mask: Record<string, true>) => unknown;
  readonly extend?: (shape: Record<string, unknown>) => unknown;
  readonly merge?: (other: unknown) => unknown;
  readonly shape?: Record<string, unknown>;
}

function isStandardSchemaCandidate(
  value: unknown,
): value is DuckTypedStandardSchema {
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
  return (
    props.version === 1 &&
    (typeof props.validate === "function" ||
      (typeof props.jsonSchema === "object" && props.jsonSchema !== null))
  );
}

function getStandardSchemaFromClass(
  target: unknown,
): DuckTypedStandardSchema | undefined {
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) {
    return false;
  }
  return (
    !(value instanceof Date) &&
    !(value instanceof RegExp) &&
    !(value instanceof Map) &&
    !(value instanceof Set) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof ArrayBuffer)
  );
}

function getIssueRootKey(issue: StandardSchemaV1Issue): string | undefined {
  if (!Array.isArray(issue.path) || issue.path.length === 0) {
    return undefined;
  }
  const first = issue.path[0];
  const raw =
    typeof first === "object" && first !== null && "key" in first
      ? first.key
      : first;
  return raw !== undefined ? String(raw) : undefined;
}

function invokeJsonSchema(
  schema: DuckTypedStandardSchema,
  io: "input" | "output",
  options: StandardJsonSchemaOptions,
): Record<string, unknown> | undefined {
  const conv = schema["~standard"].jsonSchema;
  if (!conv) return undefined;
  const fn =
    io === "output" ? (conv.output ?? conv.input) : (conv.input ?? conv.output);
  if (typeof fn !== "function") return undefined;
  const res = fn(options);
  return res && typeof res === "object" ? res : undefined;
}

function transformJsonSchemaObject(
  raw: Record<string, unknown>,
  op: "partial" | "pick" | "omit",
  keySet?: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  const rawProps =
    raw.properties && typeof raw.properties === "object" && !Array.isArray(raw.properties)
      ? (raw.properties as Record<string, unknown>)
      : undefined;
  const rawReq = Array.isArray(raw.required)
    ? (raw.required as string[])
    : undefined;

  if (op === "partial") {
    delete out.required;
    return out;
  }

  if (rawProps && keySet) {
    const nextProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawProps)) {
      const keep = op === "pick" ? keySet.has(k) : !keySet.has(k);
      if (keep) {
        nextProps[k] = v;
      }
    }
    out.properties = nextProps;
  }

  if (rawReq && keySet) {
    const nextReq = rawReq.filter((k) =>
      op === "pick" ? keySet.has(k) : !keySet.has(k),
    );
    if (nextReq.length > 0) {
      out.required = nextReq;
    } else {
      delete out.required;
    }
  }

  return out;
}

function derivePartialStandardSchema(
  base: DuckTypedStandardSchema,
): DuckTypedStandardSchema {
  if (typeof base.partial === "function") {
    try {
      const derived = base.partial();
      if (isStandardSchemaCandidate(derived)) {
        return derived;
      }
    } catch {
      // Fall back to generic Standard Schema wrapper
    }
  }

  const baseStd = base["~standard"];
  const hasJson =
    typeof baseStd.jsonSchema?.input === "function" ||
    typeof baseStd.jsonSchema?.output === "function";

  const finishPartialValidate = (
    input: Record<string, unknown>,
    res: StandardSchemaV1Result<unknown>,
  ): StandardSchemaV1Result<unknown> => {
    if (!res.issues) {
      return res;
    }
    const remaining = res.issues.filter((issue) => {
      const rootKey = getIssueRootKey(issue);
      if (rootKey === undefined) return true;
      return (
        Object.prototype.hasOwnProperty.call(input, rootKey) &&
        input[rootKey] !== undefined
      );
    });
    if (remaining.length > 0) {
      return { issues: remaining };
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(input)) {
      if (!FORBIDDEN_KEYS.has(k) && input[k] !== undefined) {
        out[k] = input[k];
      }
    }
    return { value: out };
  };

  return {
    "~standard": {
      version: 1,
      vendor: baseStd.vendor,
      validate(value: unknown, options?: unknown) {
        if (!isPlainRecord(value)) {
          return baseStd.validate(value, options);
        }
        const res = baseStd.validate(value, options);
        if (isPromiseLike(res)) {
          return Promise.resolve(res).then((resolved) =>
            finishPartialValidate(value, resolved),
          );
        }
        return finishPartialValidate(value, res);
      },
      ...(hasJson
        ? {
            jsonSchema: {
              input(options: StandardJsonSchemaOptions) {
                const raw = invokeJsonSchema(base, "input", options) ?? {
                  type: "object",
                  properties: {},
                };
                return transformJsonSchemaObject(raw, "partial");
              },
              output(options: StandardJsonSchemaOptions) {
                const raw = invokeJsonSchema(base, "output", options) ?? {
                  type: "object",
                  properties: {},
                };
                return transformJsonSchemaObject(raw, "partial");
              },
            },
          }
        : {}),
    },
  };
}

function derivePickOrOmitStandardSchema(
  base: DuckTypedStandardSchema,
  op: "pick" | "omit",
  keys: readonly string[],
): DuckTypedStandardSchema {
  const keySet = new Set(keys);
  const mask: Record<string, true> = {};
  for (const k of keySet) {
    mask[k] = true;
  }

  const nativeMethod = op === "pick" ? base.pick : base.omit;
  if (typeof nativeMethod === "function") {
    try {
      const derived = nativeMethod.call(base, mask);
      if (isStandardSchemaCandidate(derived)) {
        return derived;
      }
    } catch {
      // Fall back to generic Standard Schema wrapper
    }
  }

  const baseStd = base["~standard"];
  const hasJson =
    typeof baseStd.jsonSchema?.input === "function" ||
    typeof baseStd.jsonSchema?.output === "function";

  const filterRecord = (src: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      const keep = op === "pick" ? keySet.has(k) : !keySet.has(k);
      if (keep) {
        out[k] = src[k];
      }
    }
    return out;
  };

  const finishValidate = (
    filteredInput: Record<string, unknown>,
    res: StandardSchemaV1Result<unknown>,
  ): StandardSchemaV1Result<unknown> => {
    if (!res.issues) {
      if (isPlainRecord(res.value)) {
        return { value: filterRecord(res.value) };
      }
      return { value: filteredInput };
    }
    const remaining = res.issues.filter((issue) => {
      const rootKey = getIssueRootKey(issue);
      if (rootKey === undefined) return true;
      return op === "pick" ? keySet.has(rootKey) : !keySet.has(rootKey);
    });
    if (remaining.length > 0) {
      return { issues: remaining };
    }
    return { value: filteredInput };
  };

  return {
    "~standard": {
      version: 1,
      vendor: baseStd.vendor,
      validate(value: unknown, options?: unknown) {
        if (!isPlainRecord(value)) {
          return baseStd.validate(value, options);
        }
        const filteredInput = filterRecord(value);
        const res = baseStd.validate(filteredInput, options);
        if (isPromiseLike(res)) {
          return Promise.resolve(res).then((resolved) =>
            finishValidate(filteredInput, resolved),
          );
        }
        return finishValidate(filteredInput, res);
      },
      ...(hasJson
        ? {
            jsonSchema: {
              input(options: StandardJsonSchemaOptions) {
                const raw = invokeJsonSchema(base, "input", options) ?? {
                  type: "object",
                  properties: {},
                };
                return transformJsonSchemaObject(raw, op, keySet);
              },
              output(options: StandardJsonSchemaOptions) {
                const raw = invokeJsonSchema(base, "output", options) ?? {
                  type: "object",
                  properties: {},
                };
                return transformJsonSchemaObject(raw, op, keySet);
              },
            },
          }
        : {}),
    },
  };
}

function mergeJsonSchemas(
  schemas: readonly DuckTypedStandardSchema[],
  io: "input" | "output",
  options: StandardJsonSchemaOptions,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const requiredSet = new Set<string>();
  const defs: Record<string, unknown> = {};
  const nonObjectBranches: Record<string, unknown>[] = [];
  let schemaUri: string | undefined;

  for (const s of schemas) {
    const raw = invokeJsonSchema(s, io, options);
    if (!raw) continue;
    if (typeof raw.$schema === "string" && !schemaUri) {
      schemaUri = raw.$schema;
    }
    if (raw.$defs && typeof raw.$defs === "object") {
      Object.assign(defs, raw.$defs as Record<string, unknown>);
    }
    if (raw.definitions && typeof raw.definitions === "object") {
      Object.assign(defs, raw.definitions as Record<string, unknown>);
    }
    if (
      raw.properties &&
      typeof raw.properties === "object" &&
      !Array.isArray(raw.properties)
    ) {
      Object.assign(properties, raw.properties as Record<string, unknown>);
      if (Array.isArray(raw.required)) {
        for (const r of raw.required) {
          if (typeof r === "string") requiredSet.add(r);
        }
      }
    } else {
      const { $schema: _s, $defs: _d, definitions: _defs, ...rest } = raw;
      if (Object.keys(rest).length > 0) {
        nonObjectBranches.push(rest);
      }
    }
  }

  const baseObject: Record<string, unknown> = {
    ...(schemaUri ? { $schema: schemaUri } : {}),
    type: "object",
    properties,
    ...(requiredSet.size > 0 ? { required: [...requiredSet] } : {}),
    ...(Object.keys(defs).length > 0 ? { $defs: defs } : {}),
  };

  if (nonObjectBranches.length > 0) {
    const branches: Record<string, unknown>[] = [];
    if (Object.keys(properties).length > 0) {
      branches.push({
        type: "object",
        properties,
        ...(requiredSet.size > 0 ? { required: [...requiredSet] } : {}),
      });
    }
    branches.push(...nonObjectBranches);
    return {
      ...(schemaUri ? { $schema: schemaUri } : {}),
      allOf: branches,
      ...(Object.keys(defs).length > 0 ? { $defs: defs } : {}),
    };
  }

  return baseObject;
}

function deriveIntersectionStandardSchema(
  schemas: readonly DuckTypedStandardSchema[],
): DuckTypedStandardSchema {
  if (schemas.length === 1) {
    return schemas[0]!;
  }

  // Fast path: native `.extend(shape)` or `.merge(other)` (works for `@bunest/validation/schema` `s.object` & Zod)
  let acc: DuckTypedStandardSchema | undefined = schemas[0];
  let nativeMerged = true;
  for (let i = 1; i < schemas.length; i++) {
    const next = schemas[i]!;
    if (
      acc &&
      typeof acc.extend === "function" &&
      next.shape &&
      typeof next.shape === "object"
    ) {
      try {
        const extended = acc.extend(next.shape);
        if (isStandardSchemaCandidate(extended)) {
          acc = extended;
          continue;
        }
      } catch {
        // Fall through to generic composite
      }
    } else if (acc && typeof acc.merge === "function") {
      try {
        const merged = acc.merge(next);
        if (isStandardSchemaCandidate(merged)) {
          acc = merged;
          continue;
        }
      } catch {
        // Fall through to generic composite
      }
    }
    nativeMerged = false;
    break;
  }
  if (nativeMerged && acc) {
    return acc;
  }

  const vendor = schemas[0]?.["~standard"].vendor ?? "bunest";
  const hasJson = schemas.some(
    (s) =>
      typeof s["~standard"].jsonSchema?.input === "function" ||
      typeof s["~standard"].jsonSchema?.output === "function",
  );

  const combineResults = (
    results: readonly StandardSchemaV1Result<unknown>[],
  ): StandardSchemaV1Result<unknown> => {
    const allIssues: StandardSchemaV1Issue[] = [];
    const mergedValue: Record<string, unknown> = {};
    for (const res of results) {
      if (res.issues) {
        allIssues.push(...res.issues);
      } else if (isPlainRecord(res.value)) {
        for (const k of Object.keys(res.value)) {
          if (!FORBIDDEN_KEYS.has(k)) {
            mergedValue[k] = res.value[k];
          }
        }
      }
    }
    return allIssues.length > 0 ? { issues: allIssues } : { value: mergedValue };
  };

  return {
    "~standard": {
      version: 1,
      vendor,
      validate(value: unknown, options?: unknown) {
        const syncResults: StandardSchemaV1Result<unknown>[] = [];
        let hasAsync = false;
        const rawResults: Array<
          StandardSchemaV1Result<unknown> | PromiseLike<StandardSchemaV1Result<unknown>>
        > = [];
        for (const s of schemas) {
          const r = s["~standard"].validate(value, options);
          rawResults.push(r);
          if (isPromiseLike(r)) {
            hasAsync = true;
          } else {
            syncResults.push(r);
          }
        }
        if (hasAsync) {
          return Promise.all(rawResults.map((r) => Promise.resolve(r))).then(
            combineResults,
          );
        }
        return combineResults(syncResults);
      },
      ...(hasJson
        ? {
            jsonSchema: {
              input(options: StandardJsonSchemaOptions) {
                return mergeJsonSchemas(schemas, "input", options);
              },
              output(options: StandardJsonSchemaOptions) {
                return mergeJsonSchemas(schemas, "output", options);
              },
            },
          }
        : {}),
    },
  };
}

function createDerivedSchemaDtoClass(
  derivedSchema: DuckTypedStandardSchema,
  derivedName: string,
): Type<unknown> {
  class DerivedSchemaDto {
    constructor(data?: Record<string, unknown>) {
      if (data && typeof data === "object") {
        for (const key of Object.keys(data)) {
          if (FORBIDDEN_KEYS.has(key)) continue;
          (this as Record<string, unknown>)[key] = data[key];
        }
      }
    }
  }

  Object.defineProperty(DerivedSchemaDto, "name", {
    value: derivedName,
    configurable: true,
  });

  Object.defineProperty(DerivedSchemaDto, STANDARD_SCHEMA_DTO_KEY, {
    value: derivedSchema,
    enumerable: false,
    configurable: true,
    writable: false,
  });

  Object.defineProperty(DerivedSchemaDto, "schema", {
    value: derivedSchema,
    enumerable: false,
    configurable: true,
    writable: false,
  });

  MetadataRegistry.define(
    STANDARD_SCHEMA_DTO_METADATA_KEY,
    derivedSchema as unknown as StandardSchemaV1,
    DerivedSchemaDto,
  );

  return DerivedSchemaDto as unknown as Type<unknown>;
}

function attachMappedTypeMeta(
  target: Function,
  meta: SwaggerMappedTypeMeta,
): void {
  Object.defineProperty(target, SWAGGER_MAPPED_TYPE_META, {
    value: meta,
    enumerable: false,
    configurable: true,
  });
}

function collectVisibleDocumentedKeys(classRef: Function): Set<string> {
  const documented = new Set<string>();
  const hidden = new Set<string>();

  const walk = (cls: Function): void => {
    const stdSchema = getStandardSchemaFromClass(cls);
    if (stdSchema) {
      if (stdSchema.shape && typeof stdSchema.shape === "object") {
        for (const k of Object.keys(stdSchema.shape)) {
          documented.add(k);
        }
      } else {
        try {
          const json = invokeJsonSchema(stdSchema, "input", {
            target: "draft-2020-12",
          });
          if (json && typeof json.properties === "object" && json.properties) {
            for (const k of Object.keys(json.properties)) {
              documented.add(k);
            }
          }
        } catch {
          // Ignore if schema cannot emit JSON Schema eagerly
        }
      }
    }

    for (const ctor of MetadataRegistry.getPrototypeChain(cls)) {
      const ownMeta = Object.prototype.hasOwnProperty.call(
        ctor,
        SWAGGER_MAPPED_TYPE_META,
      )
        ? (ctor as unknown as Record<symbol, SwaggerMappedTypeMeta>)[
            SWAGGER_MAPPED_TYPE_META
          ]
        : undefined;
      if (ownMeta) {
        const sub = new Set<string>();
        for (const src of ownMeta.sources) {
          for (const k of collectVisibleDocumentedKeys(src)) {
            sub.add(k);
          }
        }
        if (ownMeta.kind === "pick" && ownMeta.keys) {
          const allowed = new Set(ownMeta.keys);
          for (const k of sub) {
            if (allowed.has(k)) documented.add(k);
          }
        } else if (ownMeta.kind === "omit" && ownMeta.keys) {
          const omitted = new Set(ownMeta.keys);
          for (const k of sub) {
            if (!omitted.has(k)) documented.add(k);
          }
        } else {
          for (const k of sub) documented.add(k);
        }
        continue;
      }

      const pluginProps = getPluginModelMetadata(ctor);
      if (pluginProps) {
        for (const p of pluginProps) documented.add(p.propertyKey);
      }
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
            _OPENAPI_METADATA_FACTORY: () => Record<string, unknown>;
          }
        )._OPENAPI_METADATA_FACTORY();
        if (factoryResult && typeof factoryResult === "object") {
          for (const k of Object.keys(factoryResult)) documented.add(k);
        }
      }
      const ownProps = MetadataRegistry.getOwn<readonly ApiPropertyMetadata[]>(
        SWAGGER_METADATA_KEYS.API_PROPERTIES,
        ctor,
      );
      const ownApiKeys = new Set<string>();
      if (ownProps) {
        for (const p of ownProps) {
          documented.add(p.propertyKey);
          ownApiKeys.add(p.propertyKey);
        }
      }
      const ownHidden = MetadataRegistry.getOwn<readonly string[]>(
        SWAGGER_METADATA_KEYS.API_HIDDEN_PROPERTIES,
        ctor,
      );
      if (ownHidden) {
        for (const k of ownHidden) hidden.add(k);
      }
      try {
        const g = globalThis as Record<PropertyKey, unknown>;
        const propDocStorage = g[
          Symbol.for("bunest:dto:prop:doc-storage")
        ] as
          | {
              getOwn?(
                target: Function,
              ): ReadonlyMap<string, { readonly hide?: boolean }> | undefined;
            }
          | undefined;
        const ownPropDocs = propDocStorage?.getOwn?.(ctor);
        if (ownPropDocs) {
          for (const [k, meta] of ownPropDocs.entries()) {
            if (meta.hide === true && !ownApiKeys.has(k)) {
              hidden.add(k);
            } else {
              documented.add(k);
            }
          }
        }
      } catch {
        // Gracefully skip if @bunest/validation prop doc storage is unavailable
      }
      try {
        for (const meta of getValidationMetadatasForTarget(ctor, false, false)) {
          if (meta.target === ctor && meta.propertyName) {
            documented.add(meta.propertyName);
          }
        }
      } catch {
        // Gracefully skip if validation metadata storage is unavailable
      }
    }
  };

  walk(classRef);
  for (const h of hidden) {
    documented.delete(h);
  }
  return documented;
}

function buildKeySuffixedName(
  prefix: "Pick" | "Omit",
  classRef: Function,
  keys: readonly PropertyKey[],
): string {
  const baseName = classRef.name || "Type";
  const visible = collectVisibleDocumentedKeys(classRef);
  const keySuffix = keys
    .map((k) => String(k))
    .filter((k) => visible.has(k))
    .map(capitalize)
    .join("");
  return `${prefix}${baseName}${keySuffix}`;
}

export function PartialType<T>(
  classRef: Type<T>,
  options?: { skipNullProperties?: boolean },
): ReturnType<typeof CorePartialType<T>> {
  const stdSchema = getStandardSchemaFromClass(classRef);
  if (stdSchema) {
    const derivedSchema = derivePartialStandardSchema(stdSchema);
    const derivedName = `Partial${classRef.name || "Dto"}`;
    const Derived = createDerivedSchemaDtoClass(derivedSchema, derivedName);
    attachMappedTypeMeta(Derived, {
      kind: "partial",
      sources: [classRef],
    });
    return Derived as unknown as ReturnType<typeof CorePartialType<T>>;
  }

  const Mapped = CorePartialType(classRef, options);
  attachMappedTypeMeta(Mapped, {
    kind: "partial",
    sources: [classRef],
  });
  return Mapped;
}

export function PickType<T, K extends keyof T>(
  classRef: Type<T>,
  keys: readonly K[],
): ReturnType<typeof CorePickType<T, K>> {
  const stringKeys = keys.map(String);
  const derivedName = buildKeySuffixedName("Pick", classRef, keys);
  const stdSchema = getStandardSchemaFromClass(classRef);
  if (stdSchema) {
    const derivedSchema = derivePickOrOmitStandardSchema(
      stdSchema,
      "pick",
      stringKeys,
    );
    const Derived = createDerivedSchemaDtoClass(derivedSchema, derivedName);
    attachMappedTypeMeta(Derived, {
      kind: "pick",
      sources: [classRef],
      keys: stringKeys,
    });
    return Derived as unknown as ReturnType<typeof CorePickType<T, K>>;
  }

  const Mapped = CorePickType(classRef, keys);
  Object.defineProperty(Mapped, "name", {
    value: derivedName,
    configurable: true,
  });
  attachMappedTypeMeta(Mapped, {
    kind: "pick",
    sources: [classRef],
    keys: stringKeys,
  });
  return Mapped;
}

export function OmitType<T, K extends keyof T>(
  classRef: Type<T>,
  keys: readonly K[],
): ReturnType<typeof CoreOmitType<T, K>> {
  const stringKeys = keys.map(String);
  const derivedName = buildKeySuffixedName("Omit", classRef, keys);
  const stdSchema = getStandardSchemaFromClass(classRef);
  if (stdSchema) {
    const derivedSchema = derivePickOrOmitStandardSchema(
      stdSchema,
      "omit",
      stringKeys,
    );
    const Derived = createDerivedSchemaDtoClass(derivedSchema, derivedName);
    attachMappedTypeMeta(Derived, {
      kind: "omit",
      sources: [classRef],
      keys: stringKeys,
    });
    return Derived as unknown as ReturnType<typeof CoreOmitType<T, K>>;
  }

  const Mapped = CoreOmitType(classRef, keys);
  Object.defineProperty(Mapped, "name", {
    value: derivedName,
    configurable: true,
  });
  attachMappedTypeMeta(Mapped, {
    kind: "omit",
    sources: [classRef],
    keys: stringKeys,
  });
  return Mapped;
}

export function IntersectionType<T extends Type<any>[]>(
  ...classRefs: T
): ReturnType<typeof CoreIntersectionType<T>> {
  const stdSchemas = classRefs.map((ref) => getStandardSchemaFromClass(ref));
  if (
    classRefs.length > 0 &&
    stdSchemas.every((s): s is DuckTypedStandardSchema => s !== undefined)
  ) {
    const derivedSchema = deriveIntersectionStandardSchema(stdSchemas);
    const suffix = classRefs.map((c) => c.name || "Dto").join("");
    const Derived = createDerivedSchemaDtoClass(
      derivedSchema,
      `Intersection${suffix || "Dto"}`,
    );
    attachMappedTypeMeta(Derived, {
      kind: "intersection",
      sources: [...classRefs],
    });
    return Derived as unknown as ReturnType<typeof CoreIntersectionType<T>>;
  }

  const Mapped = CoreIntersectionType(...classRefs);
  attachMappedTypeMeta(Mapped, {
    kind: "intersection",
    sources: [...classRefs],
  });
  return Mapped;
}

export function CompositionType<T extends readonly Type<any>[]>(
  ...classRefs: T
): ReturnType<typeof CoreCompositionType<T>> {
  const stdSchemas = classRefs.map((ref) => getStandardSchemaFromClass(ref));
  if (
    classRefs.length > 0 &&
    stdSchemas.every((s): s is DuckTypedStandardSchema => s !== undefined)
  ) {
    const derivedSchema = deriveIntersectionStandardSchema(stdSchemas);
    const suffix = classRefs.map((c) => c.name || "Dto").join("");
    const Derived = createDerivedSchemaDtoClass(
      derivedSchema,
      `Composed${suffix || "Dto"}`,
    );
    attachMappedTypeMeta(Derived, {
      kind: "composition",
      sources: [...classRefs],
    });
    return Derived as unknown as ReturnType<typeof CoreCompositionType<T>>;
  }

  const Mapped = CoreCompositionType(...classRefs);
  attachMappedTypeMeta(Mapped, {
    kind: "composition",
    sources: [...classRefs],
  });
  return Mapped;
}
