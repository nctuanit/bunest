import { MetadataRegistry, PartialType, type Type } from "@bunest/common";
import { SWAGGER_METADATA_KEYS } from "../constants";
import type {
  ApiPropertyMetadata,
  DeepPartial,
} from "../interfaces/openapi.interface";
import { isDtoConstructor } from "../schema-explorer";

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
  cache: Map<Function, Type<unknown>>,
): Type<DeepPartial<T>> {
  const cached = cache.get(classRef);
  if (cached) {
    return cached as Type<DeepPartial<T>>;
  }

  // Create partial base class inheriting class-validator, class-transformer, and Swagger metadata
  const PartialBase = PartialType(classRef);

  class DeepPartialClass extends (PartialBase as Type<object>) {}

  const derivedName = `DeepPartial${classRef.name || "Type"}`;
  Object.defineProperty(DeepPartialClass, "name", {
    value: derivedName,
    configurable: true,
  });

  // Register early in cache to break circular nested DTO recursion safely
  cache.set(classRef, DeepPartialClass as unknown as Type<unknown>);

  // Collect all @ApiProperty entries across prototype chain & recursively rewrite nested DTOs
  const collected = new Map<string, ApiPropertyMetadata>();
  for (const ctor of MetadataRegistry.getPrototypeChain(PartialBase)) {
    const own = MetadataRegistry.getOwn<readonly ApiPropertyMetadata[]>(
      SWAGGER_METADATA_KEYS.API_PROPERTIES,
      ctor,
    );
    if (!own) continue;
    for (const entry of own) {
      if (entry && entry.propertyKey) {
        collected.set(entry.propertyKey, entry);
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

  // Handle `skipNullProperties: false` if class-validator storage is present
  if (options?.skipNullProperties === false) {
    const cvStorage = (globalThis as Record<PropertyKey, unknown>)
      .classValidatorMetadataStorage as
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
      | undefined;
    if (cvStorage?.getTargetValidationMetadatas) {
      const metas = cvStorage.getTargetValidationMetadatas(
        PartialBase,
        "",
        false,
        false,
      );
      for (const meta of metas) {
        if (meta.type === "conditionalValidation" && meta.name === "isOptional") {
          meta.constraints = [
            (_object: unknown, value: unknown) => value !== undefined,
          ];
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
  return buildDeepPartialType(classRef, options, new Map());
}
