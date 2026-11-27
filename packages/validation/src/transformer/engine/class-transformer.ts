import {
  SCHEMA_DTO_RAW_INPUT_KEY,
  isStandardSchemaDto,
} from "../../schema/dto-bridge";
import { TransformationType } from "../enums/transformation-type.enum";
import type {
  ClassConstructor,
  ClassTransformOptions,
} from "../interfaces/class-transform-options.interface";
import {
  TransformMetadataStorage,
  defaultMetadataStorage,
} from "../storage/metadata-storage";
import {
  TransformExecutor,
  tryFastPlainToInstance,
} from "./transform-executor";

function instantiateStandardSchemaDto<T>(
  cls: ClassConstructor<T>,
  plain: unknown,
): T {
  if (
    plain === null ||
    plain === undefined ||
    typeof plain !== "object" ||
    Array.isArray(plain)
  ) {
    return plain as T;
  }
  const instance = new cls() as Record<PropertyKey, unknown>;
  const src = plain as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    instance[key] = src[key];
  }
  Object.defineProperty(instance, SCHEMA_DTO_RAW_INPUT_KEY, {
    value: plain,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return instance as T;
}

export class ClassTransformer {
  private readonly storage: TransformMetadataStorage;

  constructor(storage: TransformMetadataStorage = defaultMetadataStorage) {
    this.storage = storage;
  }

  instanceToPlain<T>(
    object: T,
    options?: ClassTransformOptions,
  ): Record<string, unknown>;
  instanceToPlain<T>(
    object: T[],
    options?: ClassTransformOptions,
  ): Record<string, unknown>[];
  instanceToPlain<T>(
    object: T | T[],
    options?: ClassTransformOptions,
  ): Record<string, unknown> | Record<string, unknown>[] {
    const executor = new TransformExecutor(
      TransformationType.CLASS_TO_PLAIN,
      options,
      this.storage,
    );
    return executor.transform(
      undefined,
      object,
      undefined,
      undefined,
      false,
    ) as Record<string, unknown> | Record<string, unknown>[];
  }

  classToPlainFromExist<T>(
    object: T,
    plainObject: Record<string, unknown>,
    options?: ClassTransformOptions,
  ): Record<string, unknown>;
  classToPlainFromExist<T>(
    object: T[],
    plainObjects: Record<string, unknown>[],
    options?: ClassTransformOptions,
  ): Record<string, unknown>[];
  classToPlainFromExist<T>(
    object: T | T[],
    plainObject: Record<string, unknown> | Record<string, unknown>[],
    options?: ClassTransformOptions,
  ): Record<string, unknown> | Record<string, unknown>[] {
    const executor = new TransformExecutor(
      TransformationType.CLASS_TO_PLAIN,
      options,
      this.storage,
    );
    return executor.transform(
      plainObject,
      object,
      undefined,
      undefined,
      false,
    ) as Record<string, unknown> | Record<string, unknown>[];
  }

  plainToInstance<T, V>(
    cls: ClassConstructor<T>,
    plain: V[],
    options?: ClassTransformOptions,
  ): T[];
  plainToInstance<T, V>(
    cls: ClassConstructor<T>,
    plain: V,
    options?: ClassTransformOptions,
  ): T;
  plainToInstance<T, V>(
    cls: ClassConstructor<T>,
    plain: V | V[],
    options?: ClassTransformOptions,
  ): T | T[] {
    if (typeof cls === "function" && isStandardSchemaDto(cls)) {
      if (Array.isArray(plain)) {
        return plain.map((item) => instantiateStandardSchemaDto(cls, item));
      }
      return instantiateStandardSchemaDto(cls, plain);
    }
    const fast = tryFastPlainToInstance(cls, plain, options, this.storage);
    if (fast.matched) {
      return fast.result as T;
    }
    const executor = new TransformExecutor(
      TransformationType.PLAIN_TO_CLASS,
      options,
      this.storage,
    );
    return executor.transform(undefined, plain, cls, undefined, false) as
      | T
      | T[];
  }

  plainToClassFromExist<T, V>(
    clsObject: T[],
    plain: V[],
    options?: ClassTransformOptions,
  ): T[];
  plainToClassFromExist<T, V>(
    clsObject: T,
    plain: V,
    options?: ClassTransformOptions,
  ): T;
  plainToClassFromExist<T, V>(
    clsObject: T | T[],
    plain: V | V[],
    options?: ClassTransformOptions,
  ): T | T[] {
    const executor = new TransformExecutor(
      TransformationType.PLAIN_TO_CLASS,
      options,
      this.storage,
    );
    return executor.transform(
      clsObject as Record<string, unknown> | unknown[],
      plain,
      undefined,
      undefined,
      false,
    ) as T | T[];
  }

  instanceToInstance<T>(object: T[], options?: ClassTransformOptions): T[];
  instanceToInstance<T>(object: T, options?: ClassTransformOptions): T;
  instanceToInstance<T>(
    object: T | T[],
    options?: ClassTransformOptions,
  ): T | T[] {
    const executor = new TransformExecutor(
      TransformationType.CLASS_TO_CLASS,
      options,
      this.storage,
    );
    return executor.transform(
      undefined,
      object,
      undefined,
      undefined,
      false,
    ) as T | T[];
  }

  classToClassFromExist<T>(
    object: T[],
    fromObjects: T[],
    options?: ClassTransformOptions,
  ): T[];
  classToClassFromExist<T>(
    object: T,
    fromObject: T,
    options?: ClassTransformOptions,
  ): T;
  classToClassFromExist<T>(
    object: T | T[],
    fromObject: T | T[],
    options?: ClassTransformOptions,
  ): T | T[] {
    const executor = new TransformExecutor(
      TransformationType.CLASS_TO_CLASS,
      options,
      this.storage,
    );
    return executor.transform(
      fromObject as Record<string, unknown> | unknown[],
      object,
      undefined,
      undefined,
      false,
    ) as T | T[];
  }

  serialize<T>(object: T, options?: ClassTransformOptions): string {
    return JSON.stringify(this.instanceToPlain(object, options));
  }

  deserialize<T>(
    cls: ClassConstructor<T>,
    json: string,
    options?: ClassTransformOptions,
  ): T {
    const parsed: unknown = JSON.parse(json);
    return this.plainToInstance(cls, parsed, options);
  }

  deserializeArray<T>(
    cls: ClassConstructor<T>,
    json: string,
    options?: ClassTransformOptions,
  ): T[] {
    const parsed: unknown = JSON.parse(json);
    return this.plainToInstance(cls, parsed as unknown[], options);
  }
}
