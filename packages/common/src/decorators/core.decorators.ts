import { METADATA_KEYS, type MetadataKey } from "../constants/metadata-keys";
import { Scope } from "../enums/scope.enum";
import type { ModuleMetadata } from "../interfaces/module.interface";
import type {
  InjectableMetadata,
  InjectableOptions,
  InjectTokenMetadata,
  PropertyInjectMetadata,
} from "../interfaces/provider.interface";
import type {
  ForwardReference,
  InjectionToken,
  Type,
} from "../interfaces/type.interface";
import { DecoratorRegistry } from "../metadata/decorator-registry";
import { MetadataRegistry } from "../metadata/metadata-registry";
import type { CustomDecorator } from "../metadata/reflector";

/**
 * Defines a Bunest module organizing imports, controllers, providers, and exports.
 */
export function Module(metadata: ModuleMetadata): ClassDecorator {
  return (target: Function) => {
    MetadataRegistry.define<ModuleMetadata>(
      METADATA_KEYS.MODULE,
      {
        imports: metadata.imports ? [...metadata.imports] : undefined,
        controllers: metadata.controllers
          ? [...metadata.controllers]
          : undefined,
        providers: metadata.providers ? [...metadata.providers] : undefined,
        exports: metadata.exports ? [...metadata.exports] : undefined,
        ...(metadata.autoDiscover !== undefined
          ? {
              autoDiscover:
                typeof metadata.autoDiscover === "object"
                  ? {
                      ...metadata.autoDiscover,
                      ...(metadata.autoDiscover.include
                        ? { include: [...metadata.autoDiscover.include] }
                        : {}),
                      ...(metadata.autoDiscover.exclude
                        ? { exclude: [...metadata.autoDiscover.exclude] }
                        : {}),
                    }
                  : metadata.autoDiscover,
            }
          : {}),
      },
      target,
    );
  };
}

/**
 * Shorthand `@Module` decorator with `autoDiscover: true` enabled by default,
 * automatically wiring self-registered `@Controller` and `@Injectable` classes
 * from `DecoratorRegistry`.
 */
export function AutoModule(metadata: ModuleMetadata = {}): ClassDecorator {
  return Module({
    ...metadata,
    autoDiscover: metadata.autoDiscover ?? true,
  });
}

/**
 * Marks a module as global so its exported providers are visible across all modules.
 */
export function Global(): ClassDecorator {
  return (target: Function) => {
    MetadataRegistry.define<boolean>(METADATA_KEYS.GLOBAL_MODULE, true, target);
  };
}

/**
 * Marks a class as an injectable provider managed by the Bunest DI container
 * and self-registers it in `DecoratorRegistry` at class-evaluation time.
 */
export function Injectable(options?: InjectableOptions): ClassDecorator {
  return (target: Function) => {
    const meta: InjectableMetadata = {
      scope: options?.scope ?? Scope.SINGLETON,
      ...(options?.durable !== undefined ? { durable: options.durable } : {}),
    };
    MetadataRegistry.define<InjectableMetadata>(
      METADATA_KEYS.INJECTABLE,
      meta,
      target,
    );
    DecoratorRegistry.registerInjectable(target, meta);
  };
}

/**
 * Overrides the DI injection token for a constructor parameter or class property.
 * Copy-on-write: never mutates parent class metadata.
 */
export function Inject<T = unknown>(
  token?: InjectionToken<T> | ForwardReference<T>,
): ParameterDecorator & PropertyDecorator {
  return (
    target: object,
    propertyKey: string | symbol | undefined,
    parameterIndex?: number,
  ) => {
    // Constructor parameter injection
    if (typeof parameterIndex === "number" && propertyKey === undefined) {
      const resolvedToken =
        token ??
        (MetadataRegistry.getParamTypes(target)?.[parameterIndex] as
          | InjectionToken
          | undefined);

      if (resolvedToken === undefined) {
        throw new Error(
          `@Inject() on ${(target as Function).name ?? "unknown"} constructor parameter #${parameterIndex} requires an explicit token.`,
        );
      }

      const existing =
        MetadataRegistry.getOwn<readonly InjectTokenMetadata[]>(
          METADATA_KEYS.INJECT_TOKENS,
          target,
        ) ?? [];

      const filtered = existing.filter((item) => item.index !== parameterIndex);
      const next: InjectTokenMetadata[] = [
        ...filtered,
        { index: parameterIndex, token: resolvedToken },
      ].sort((a, b) => a.index - b.index);

      MetadataRegistry.define(METADATA_KEYS.INJECT_TOKENS, next, target);
      return;
    }

    // Property injection
    if (propertyKey !== undefined) {
      const ctor = target.constructor;
      const resolvedToken =
        token ??
        (MetadataRegistry.getType(target, propertyKey) as
          | InjectionToken
          | undefined);

      if (resolvedToken === undefined) {
        throw new Error(
          `@Inject() on ${ctor.name}.${String(propertyKey)} requires an explicit token.`,
        );
      }

      const existing =
        MetadataRegistry.getOwn<readonly PropertyInjectMetadata[]>(
          METADATA_KEYS.PROPERTY_INJECT_TOKENS,
          ctor,
        ) ?? [];

      const filtered = existing.filter(
        (item) => item.propertyKey !== propertyKey,
      );
      const next: PropertyInjectMetadata[] = [
        ...filtered,
        { propertyKey, token: resolvedToken },
      ];

      MetadataRegistry.define(METADATA_KEYS.PROPERTY_INJECT_TOKENS, next, ctor);
    }
  };
}

/**
 * Marks a constructor parameter or property dependency as optional.
 * Copy-on-write: never mutates parent class metadata.
 */
export function Optional(): ParameterDecorator & PropertyDecorator {
  return (
    target: object,
    propertyKey: string | symbol | undefined,
    parameterIndex?: number,
  ) => {
    if (typeof parameterIndex === "number" && propertyKey === undefined) {
      const existing =
        MetadataRegistry.getOwn<readonly number[]>(
          METADATA_KEYS.OPTIONAL_DEPS,
          target,
        ) ?? [];

      if (!existing.includes(parameterIndex)) {
        const next = [...existing, parameterIndex].sort((a, b) => a - b);
        MetadataRegistry.define(METADATA_KEYS.OPTIONAL_DEPS, next, target);
      }
      return;
    }

    if (propertyKey !== undefined) {
      const ctor = target.constructor;
      const existing =
        MetadataRegistry.getOwn<readonly (string | symbol)[]>(
          METADATA_KEYS.OPTIONAL_PROPERTY_DEPS,
          ctor,
        ) ?? [];

      if (!existing.includes(propertyKey)) {
        MetadataRegistry.define(
          METADATA_KEYS.OPTIONAL_PROPERTY_DEPS,
          [...existing, propertyKey],
          ctor,
        );
      }
    }
  };
}

/**
 * Attaches custom key/value metadata to a class or route handler method.
 * On methods, metadata is attached to `descriptor.value` so `Reflector` can read it
 * directly from `context.getHandler()`.
 */
export function SetMetadata<K extends MetadataKey = string, V = unknown>(
  metadataKey: K,
  metadataValue: V,
): CustomDecorator<K> {
  const decorator = (
    target: object,
    _propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) => {
    if (descriptor && descriptor.value !== undefined) {
      MetadataRegistry.define(metadataKey, metadataValue, descriptor.value);
      return descriptor;
    }
    MetadataRegistry.define(metadataKey, metadataValue, target);
    return target;
  };
  decorator.KEY = metadataKey;
  return decorator as CustomDecorator<K>;
}

/**
 * Binds an exception filter class to one or more exception constructors.
 * Passing no arguments catches all exceptions.
 */
export function Catch(...exceptions: Type<any>[]): ClassDecorator {
  return (target: Function) => {
    MetadataRegistry.define<readonly Type<any>[]>(
      METADATA_KEYS.CATCH_EXCEPTIONS,
      [...exceptions],
      target,
    );
  };
}

/**
 * Declares constructor dependencies explicitly (matching NestJS `@Dependencies()`
 * for JavaScript / non-`emitDecoratorMetadata` usage).
 */
export function Dependencies(
  ...dependencies: Array<InjectionToken | ForwardReference | Array<InjectionToken | ForwardReference>>
): ClassDecorator {
  const flatDeps: Array<InjectionToken | ForwardReference> = [];
  for (const dep of dependencies) {
    if (Array.isArray(dep)) {
      flatDeps.push(...dep);
    } else {
      flatDeps.push(dep);
    }
  }
  return (target: Function) => {
    MetadataRegistry.define(METADATA_KEYS.DEPENDENCIES, flatDeps, target);
    const existing =
      MetadataRegistry.getOwn<readonly InjectTokenMetadata[]>(
        METADATA_KEYS.INJECT_TOKENS,
        target,
      ) ?? [];
    const byIndex = new Map<number, InjectTokenMetadata>();
    for (const item of existing) {
      byIndex.set(item.index, item);
    }
    for (let i = 0; i < flatDeps.length; i++) {
      const token = flatDeps[i];
      if (token !== undefined && !byIndex.has(i)) {
        byIndex.set(i, { index: i, token });
      }
    }
    const merged = [...byIndex.values()].sort((a, b) => a.index - b.index);
    MetadataRegistry.define(METADATA_KEYS.INJECT_TOKENS, merged, target);
  };
}
