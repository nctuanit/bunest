export type AnyDecorator =
  ClassDecorator | MethodDecorator | PropertyDecorator | ParameterDecorator;

/**
 * Composed legacy TypeScript decorator assignable to class, method,
 * property, and parameter targets.
 */
export interface ComposedDecorator {
  <TFunction extends Function>(target: TFunction): TFunction | void;
  <T>(
    target: object,
    propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<T>,
  ): TypedPropertyDescriptor<T> | void;
  (target: object, propertyKey: string | symbol): void;
  (
    target: object,
    propertyKey: string | symbol | undefined,
    parameterIndex: number,
  ): void;
}

/**
 * Composes multiple class, method, property, or parameter decorators into a single
 * reusable decorator without mutating the input list.
 *
 * Applies decorators bottom-to-top (matching legacy TypeScript decorator stacking
 * `@D1 @D2`), preserving exact top-to-bottom declaration order for Bunest's
 * copy-on-write decorators (`@UseGuards`, `@Header`, `@Get`, etc.).
 */
export function applyDecorators(
  ...decorators: readonly AnyDecorator[]
): ComposedDecorator {
  const snapshot = [...decorators];

  function composed(
    target: object | Function,
    propertyKey?: string | symbol,
    descriptorOrIndex?: PropertyDescriptor | number,
  ): unknown {
    // Parameter decorator (constructor parameter or method parameter)
    if (typeof descriptorOrIndex === "number") {
      for (let i = snapshot.length - 1; i >= 0; i--) {
        const decorator = snapshot[i] as ParameterDecorator | undefined;
        decorator?.(target, propertyKey, descriptorOrIndex);
      }
      return undefined;
    }

    // Class or plain-object target decorator (no propertyKey / descriptor)
    if (propertyKey === undefined && descriptorOrIndex === undefined) {
      if (typeof target === "function") {
        let currentTarget: Function = target;
        for (let i = snapshot.length - 1; i >= 0; i--) {
          const decorator = snapshot[i] as ClassDecorator | undefined;
          const result = decorator?.(currentTarget);
          if (typeof result === "function") {
            currentTarget = result;
          }
        }
        return currentTarget !== target ? currentTarget : undefined;
      }
      // Plain-object target (e.g. NestJS applyDecorators(d1, d2)(obj)) runs forward
      for (let i = 0; i < snapshot.length; i++) {
        const decorator = snapshot[i] as ((t: object) => void) | undefined;
        decorator?.(target);
      }
      return undefined;
    }

    // Method / accessor decorator
    if (
      propertyKey !== undefined &&
      descriptorOrIndex !== undefined &&
      typeof descriptorOrIndex === "object"
    ) {
      let currentDescriptor: PropertyDescriptor = descriptorOrIndex;
      for (let i = snapshot.length - 1; i >= 0; i--) {
        const decorator = snapshot[i] as MethodDecorator | undefined;
        const result = decorator?.(target, propertyKey, currentDescriptor);
        if (result !== undefined && typeof result === "object") {
          currentDescriptor = result;
        }
      }
      return currentDescriptor;
    }

    // Property decorator
    if (propertyKey !== undefined) {
      for (let i = snapshot.length - 1; i >= 0; i--) {
        const decorator = snapshot[i] as PropertyDecorator | undefined;
        decorator?.(target, propertyKey);
      }
    }

    return undefined;
  }

  return composed as ComposedDecorator;
}
