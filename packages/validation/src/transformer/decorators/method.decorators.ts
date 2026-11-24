import type {
  ClassConstructor,
  ClassTransformOptions,
} from "../interfaces/class-transform-options.interface";
import { ClassTransformer } from "../engine/class-transformer";

const sharedTransformer = new ClassTransformer();

export function TransformInstanceToPlain(
  params?: ClassTransformOptions,
): MethodDecorator {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): void => {
    const originalMethod = descriptor.value as (...args: unknown[]) => unknown;
    descriptor.value = function transformedToPlain(
      this: unknown,
      ...args: unknown[]
    ): unknown {
      const result = originalMethod.apply(this, args);
      if (result instanceof Promise) {
        return result.then((resolved) =>
          sharedTransformer.instanceToPlain(resolved, params),
        );
      }
      return sharedTransformer.instanceToPlain(result, params);
    };
  };
}

export function TransformInstanceToInstance(
  params?: ClassTransformOptions,
): MethodDecorator {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): void => {
    const originalMethod = descriptor.value as (...args: unknown[]) => unknown;
    descriptor.value = function transformedToInstance(
      this: unknown,
      ...args: unknown[]
    ): unknown {
      const result = originalMethod.apply(this, args);
      if (result instanceof Promise) {
        return result.then((resolved) =>
          sharedTransformer.instanceToInstance(resolved, params),
        );
      }
      return sharedTransformer.instanceToInstance(result, params);
    };
  };
}

export function TransformPlainToInstance<T>(
  classType: ClassConstructor<T>,
  params?: ClassTransformOptions,
): MethodDecorator {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): void => {
    const originalMethod = descriptor.value as (...args: unknown[]) => unknown;
    descriptor.value = function transformedPlainToInstance(
      this: unknown,
      ...args: unknown[]
    ): unknown {
      const result = originalMethod.apply(this, args);
      if (result instanceof Promise) {
        return result.then((resolved) =>
          sharedTransformer.plainToInstance(classType, resolved, params),
        );
      }
      return sharedTransformer.plainToInstance(classType, result, params);
    };
  };
}
