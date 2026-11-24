import { ClassTransformer } from "./engine/class-transformer";
import type {
  ClassConstructor,
  ClassTransformOptions,
} from "./interfaces/class-transform-options.interface";
import {
  defaultMetadataStorage,
  getMetadataStorage,
} from "./storage/metadata-storage";

export { TransformationType } from "./enums/transformation-type.enum";
export {
  DEFAULT_TRANSFORM_OPTIONS,
  type ClassConstructor,
  type ClassTransformOptions,
  type TargetMap,
} from "./interfaces/class-transform-options.interface";
export type {
  Discriminator,
  ExcludeOptions,
  ExposeOptions,
  JsonSubType,
  TransformFn,
  TransformFnParams,
  TransformOptions,
  TypeHelpOptions,
  TypeOptions,
} from "./interfaces/decorator-options.interface";
export type {
  CloneMetadataOptions,
  ExcludeMetadata,
  ExposeMetadata,
  TransformMetadata,
  TypeMetadata,
} from "./interfaces/metadata.interface";
export {
  BUNEST_TRANSFORMER_STORAGE_SYMBOL,
  TransformMetadataStorage,
  defaultMetadataStorage,
  getMetadataStorage,
} from "./storage/metadata-storage";
export {
  getCompiledTransformPlan,
  type CompiledDirectionPlan,
  type CompiledTransformClassPlan,
} from "./compiler/transform-plan-compiler";
export { ClassTransformer } from "./engine/class-transformer";
export { Expose } from "./decorators/expose.decorator";
export { Exclude } from "./decorators/exclude.decorator";
export { Type } from "./decorators/type.decorator";
export { Transform } from "./decorators/transform.decorator";
export {
  TransformInstanceToInstance,
  TransformInstanceToPlain,
  TransformPlainToInstance,
} from "./decorators/method.decorators";

const defaultTransformer = new ClassTransformer();

export function instanceToPlain<T>(
  object: T[],
  options?: ClassTransformOptions,
): Record<string, unknown>[];
export function instanceToPlain<T>(
  object: T,
  options?: ClassTransformOptions,
): Record<string, unknown>;
export function instanceToPlain<T>(
  object: T | T[],
  options?: ClassTransformOptions,
): Record<string, unknown> | Record<string, unknown>[] {
  return defaultTransformer.instanceToPlain(object as T, options);
}

export const classToPlain = instanceToPlain;

export function classToPlainFromExist<T>(
  object: T[],
  plainObjects: Record<string, unknown>[],
  options?: ClassTransformOptions,
): Record<string, unknown>[];
export function classToPlainFromExist<T>(
  object: T,
  plainObject: Record<string, unknown>,
  options?: ClassTransformOptions,
): Record<string, unknown>;
export function classToPlainFromExist<T>(
  object: T | T[],
  plainObject: Record<string, unknown> | Record<string, unknown>[],
  options?: ClassTransformOptions,
): Record<string, unknown> | Record<string, unknown>[] {
  return defaultTransformer.classToPlainFromExist(
    object as T,
    plainObject as Record<string, unknown>,
    options,
  );
}

export function plainToInstance<T, V>(
  cls: ClassConstructor<T>,
  plain: V[],
  options?: ClassTransformOptions,
): T[];
export function plainToInstance<T, V>(
  cls: ClassConstructor<T>,
  plain: V,
  options?: ClassTransformOptions,
): T;
export function plainToInstance<T, V>(
  cls: ClassConstructor<T>,
  plain: V | V[],
  options?: ClassTransformOptions,
): T | T[] {
  return defaultTransformer.plainToInstance(cls, plain as V, options);
}

export const plainToClass = plainToInstance;

export function plainToClassFromExist<T, V>(
  clsObject: T[],
  plain: V[],
  options?: ClassTransformOptions,
): T[];
export function plainToClassFromExist<T, V>(
  clsObject: T,
  plain: V,
  options?: ClassTransformOptions,
): T;
export function plainToClassFromExist<T, V>(
  clsObject: T | T[],
  plain: V | V[],
  options?: ClassTransformOptions,
): T | T[] {
  return defaultTransformer.plainToClassFromExist(
    clsObject as T,
    plain as V,
    options,
  );
}

export function instanceToInstance<T>(
  object: T[],
  options?: ClassTransformOptions,
): T[];
export function instanceToInstance<T>(
  object: T,
  options?: ClassTransformOptions,
): T;
export function instanceToInstance<T>(
  object: T | T[],
  options?: ClassTransformOptions,
): T | T[] {
  return defaultTransformer.instanceToInstance(object as T, options);
}

export function classToClassFromExist<T>(
  object: T[],
  fromObjects: T[],
  options?: ClassTransformOptions,
): T[];
export function classToClassFromExist<T>(
  object: T,
  fromObject: T,
  options?: ClassTransformOptions,
): T;
export function classToClassFromExist<T>(
  object: T | T[],
  fromObject: T | T[],
  options?: ClassTransformOptions,
): T | T[] {
  return defaultTransformer.classToClassFromExist(
    object as T,
    fromObject as T,
    options,
  );
}

export function serialize<T>(
  object: T,
  options?: ClassTransformOptions,
): string {
  return defaultTransformer.serialize(object, options);
}

export function deserialize<T>(
  cls: ClassConstructor<T>,
  json: string,
  options?: ClassTransformOptions,
): T {
  return defaultTransformer.deserialize(cls, json, options);
}

export function deserializeArray<T>(
  cls: ClassConstructor<T>,
  json: string,
  options?: ClassTransformOptions,
): T[] {
  return defaultTransformer.deserializeArray(cls, json, options);
}

/**
 * Self-register Bunest's native transformer engine on globalThis so `@bunest/core`
 * (`ValidationPipe`, `ClassSerializerInterceptor`, `mapped-types`) resolves it in O(1)
 * with zero circular package dependencies.
 */
const BUNEST_TRANSFORMER_ENGINE_SYMBOL = Symbol.for(
  "bunest:class-transformer:engine",
);
const BUNEST_TRANSFORMER_PACKAGE_SYMBOL = Symbol.for(
  "bunest:class-transformer:package",
);

const nativeTransformerEngine = {
  ClassTransformer,
  plainToInstance,
  plainToClass,
  plainToClassFromExist,
  instanceToPlain,
  classToPlain,
  classToPlainFromExist,
  instanceToInstance,
  classToClassFromExist,
  serialize,
  deserialize,
  deserializeArray,
  getMetadataStorage,
  defaultMetadataStorage,
};

const g = globalThis as Record<PropertyKey, unknown>;
g[BUNEST_TRANSFORMER_ENGINE_SYMBOL] = nativeTransformerEngine;
g[BUNEST_TRANSFORMER_PACKAGE_SYMBOL] = nativeTransformerEngine;

export default nativeTransformerEngine;
