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
