import { MetadataRegistry, PartialType, type Type } from "@bunest/core";
import { SWAGGER_METADATA_KEYS } from "../constants";
import type {
  ApiPropertyMetadata,
  ApiPropertyOptions,
  DeepPartial,
} from "../interfaces/openapi.interface";
import { getPluginModelMetadata } from "../plugin-metadata-store";
import { isDtoConstructor } from "../schema-explorer";
import {
  SWAGGER_MAPPED_TYPE_META,
  type SwaggerMappedTypeMeta,
} from "./mapped-types.helper";

const deepPartialCacheSkipNull = new WeakMap<Function, Type<unknown>>();
const deepPartialCacheKeepNull = new WeakMap<Function, Type<unknown>>();

function unwrapNestedDtoType(
  rawType: unknown,
  designType: Function | undefined,
): { ctor: Type<unknown>; isArray: boolean } | undefined {
  let candidate: unknown = rawType ?? designType;
  if (typeof candidate === "function" && candidate.prototype === undefined) {
    try {
      candidate = (candidate as () => unknown)();
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(candidate)) {
    const inner = candidate[0];
    if (isDtoConstructor(inner)) {
      return { ctor: inner, isArray: true };
    }
    return undefined;
  }
  if (isDtoConstructor(candidate)) {
    return { ctor: candidate, isArray: false };
  }
  return undefined;
}

function buildDeepPartialType<T>(
  classRef: Type<T>,
  options: { skipNullProperties?: boolean } | undefined,
  cache: WeakMap<Function, Type<unknown>>,
): Type<DeepPartial<T>> {
  const cached = cache.get(classRef);
  if (cached) {
    return cached as Type<DeepPartial<T>>;
  }

  // Create partial base class inheriting class-validator, class-transformer, and Swagger metadata
  const PartialBase = PartialType(classRef, options);

  class DeepPartialClass extends (PartialBase as Type<object>) {}

  const derivedName = `DeepPartial${classRef.name || "Type"}`;
  Object.defineProperty(DeepPartialClass, "name", {
    value: derivedName,
    configurable: true,
  });

  // Register early in cache to break circular nested DTO recursion safely
  cache.set(classRef, DeepPartialClass as unknown as Type<unknown>);

  // Attach mapped-type metadata so SchemaExplorer can resolve plugin metadata,
  // _OPENAPI_METADATA_FACTORY(), and lazy enums dynamically without losing them.
  const mappedMeta: SwaggerMappedTypeMeta = {
    kind: "deepPartial",
    sources: [classRef],
    wrapNestedDto: (nestedCtor) =>
      buildDeepPartialType(nestedCtor, options, cache) as Type<unknown>,
  };
  Object.defineProperty(DeepPartialClass, SWAGGER_MAPPED_TYPE_META, {
    value: mappedMeta,
    enumerable: false,
    configurable: true,
  });

  // Collect all @ApiProperty, plugin metadata, and _OPENAPI_METADATA_FACTORY entries across prototype chain
  const collected = new Map<string, ApiPropertyMetadata>();
  for (const ctor of MetadataRegistry.getPrototypeChain(classRef)) {
    const pluginProps = getPluginModelMetadata(ctor);
    if (pluginProps) {
      for (const p of pluginProps) {
        if (p && p.propertyKey) {
          collected.set(p.propertyKey, {
            ...(collected.get(p.propertyKey) ?? {}),
            ...(p as unknown as ApiPropertyMetadata),
            propertyKey: p.propertyKey,
          });
        }
      }
    }
    if (
      Object.prototype.hasOwnProperty.call(ctor, "_OPENAPI_METADATA_FACTORY") &&
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
          if (!propOpts || typeof propOpts !== "object") continue;
          collected.set(propKey, {
            ...(collected.get(propKey) ?? {}),
            ...propOpts,
            propertyKey: propKey,
            required: false,
          });
        }
      }
    }
    const own = MetadataRegistry.getOwn<readonly ApiPropertyMetadata[]>(
      SWAGGER_METADATA_KEYS.API_PROPERTIES,
      ctor,
    );
    if (!own) continue;
    for (const entry of own) {
      if (entry && entry.propertyKey) {
        collected.set(entry.propertyKey, {
          ...(collected.get(entry.propertyKey) ?? {}),
          ...entry,
        });
      }
    }
  }

  const rewrittenProps: ApiPropertyMetadata[] = [];
  for (const entry of collected.values()) {
    const nested = unwrapNestedDtoType(entry.type, entry.designType);
    if (nested) {
      const nestedPartial = buildDeepPartialType(nested.ctor, options, cache);
      const isArray = entry.isArray === true || nested.isArray;
      rewrittenProps.push({
        ...entry,
        required: false,
        type: () => nestedPartial,
        isArray,
      });
    } else {
      rewrittenProps.push({
        ...entry,
        required: false,
      });
    }
  }

  if (rewrittenProps.length > 0) {
    MetadataRegistry.define(
      SWAGGER_METADATA_KEYS.API_PROPERTIES,
      rewrittenProps,
      DeepPartialClass,
    );
  }

  // Handle `skipNullProperties: false` across both native & upstream validation storages
  if (options?.skipNullProperties === false) {
    const g = globalThis as Record<PropertyKey, unknown>;
    const storages = [
      g[Symbol.for("bunest:class-validator:storage")],
      g.classValidatorMetadataStorage,
    ] as Array<
      | {
          getTargetValidationMetadatas?: (
            target: Function,
            schema: string,
            always: boolean,
            strict: boolean,
          ) => Array<{
            type: string;
            name?: string;
            target: Function | string;
            propertyName: string;
            constraints?: unknown[];
          }>;
        }
      | undefined
    >;
    const seenStorages = new Set<unknown>();
    for (const cvStorage of storages) {
      if (!cvStorage || seenStorages.has(cvStorage)) continue;
      seenStorages.add(cvStorage);
      if (cvStorage.getTargetValidationMetadatas) {
        const metas = cvStorage.getTargetValidationMetadatas(
          PartialBase,
          "",
          false,
          false,
        );
        for (const meta of metas) {
          if (
            meta.type === "conditionalValidation" &&
            meta.name === "isOptional"
          ) {
            meta.constraints = [
              (_object: unknown, value: unknown) => value !== undefined,
            ];
          }
        }
      }
    }
  }

  return DeepPartialClass as unknown as Type<DeepPartial<T>>;
}

/**
 * Recursively transforms a DTO class and all of its nested DTO properties into
 * optional `DeepPartial` types, preserving and updating `@ApiProperty` & validation metadata.
 */
export function DeepPartialType<T>(
  classRef: Type<T>,
  options?: { skipNullProperties?: boolean },
): Type<DeepPartial<T>> {
  const cache =
    options?.skipNullProperties === false
      ? deepPartialCacheKeepNull
      : deepPartialCacheSkipNull;
  return buildDeepPartialType(classRef, options, cache);
}
