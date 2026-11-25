import { METADATA_KEYS, type MetadataKey } from "../constants/metadata-keys";
import type { PipeLike } from "../interfaces/http.interface";
import type {
  ExceptionFilterLike,
  GuardLike,
  InterceptorLike,
  MiddlewareLike,
} from "../interfaces/pipeline.interface";
import { MetadataRegistry } from "../metadata/metadata-registry";

export type { ExceptionFilterLike, GuardLike, InterceptorLike, MiddlewareLike };

function validateEnhancerItem(
  decoratorName: string,
  requiredMethod: string | undefined,
  item: unknown,
): void {
  if (!requiredMethod) return;
  const isValid =
    typeof item === "function" ||
    (typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>)[requiredMethod] === "function");
  if (!isValid) {
    throw new Error(
      `Invalid item passed to ${decoratorName}() decorator (expected a class or an object with a ${requiredMethod}() method).`,
    );
  }
}

function createEnhancerDecorator<T>(
  metadataKey: MetadataKey,
  decoratorName?: string,
  requiredMethod?: string,
): (...items: T[]) => ClassDecorator & MethodDecorator {
  return (...items: T[]): ClassDecorator & MethodDecorator => {
    if (decoratorName && requiredMethod) {
      for (const item of items) {
        validateEnhancerItem(decoratorName, requiredMethod, item);
      }
    }
    return (
      target: object,
      _propertyKey?: string | symbol,
      descriptor?: PropertyDescriptor,
    ): void => {
      if (descriptor && descriptor.value !== undefined) {
        MetadataRegistry.prependOwnArray<T>(
          metadataKey,
          items,
          descriptor.value,
        );
        return;
      }

      // Copy-on-write on the class constructor itself; never mutates parent class metadata
      MetadataRegistry.prependOwnArray<T>(metadataKey, items, target);
    };
  };
}

export const UseGuards = createEnhancerDecorator<GuardLike>(
  METADATA_KEYS.GUARDS,
  "@UseGuards",
  "canActivate",
);

export const UsePipes = createEnhancerDecorator<PipeLike>(
  METADATA_KEYS.PIPES,
  "@UsePipes",
  "transform",
);

export const UseInterceptors = createEnhancerDecorator<InterceptorLike>(
  METADATA_KEYS.INTERCEPTORS,
  "@UseInterceptors",
  "intercept",
);

export const UseFilters = createEnhancerDecorator<ExceptionFilterLike>(
  METADATA_KEYS.EXCEPTION_FILTERS,
  "@UseFilters",
  "catch",
);

/**
 * Declaratively attaches HTTP middlewares (class constructors, instances, or
 * middleware functions) to a controller class or individual route method.
 * Executes after global/module middleware and before guards/interceptors/handler.
 */
export const UseMiddleware = createEnhancerDecorator<MiddlewareLike>(
  METADATA_KEYS.MIDDLEWARES,
);

/**
 * Controls whether an overridden controller route method inherits parent method
 * enhancers (`@UseGuards`, `@UsePipes`, `@UseInterceptors`, `@UseFilters`,
 * `@UseMiddleware`, and custom metadata such as `@Roles`).
 * Pass `false` on a subclass method or class to opt out of parent method enhancer inheritance.
 */
export function InheritMethodEnhancers(
  inherit = true,
): ClassDecorator & MethodDecorator {
  return (
    target: object,
    _propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): void => {
    if (descriptor && descriptor.value !== undefined) {
      MetadataRegistry.define<boolean>(
        METADATA_KEYS.INHERIT_METHOD_ENHANCERS,
        inherit,
        descriptor.value,
      );
      return;
    }
    MetadataRegistry.define<boolean>(
      METADATA_KEYS.INHERIT_METHOD_ENHANCERS,
      inherit,
      target,
    );
  };
}
