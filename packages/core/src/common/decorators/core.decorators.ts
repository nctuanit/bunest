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
import { Logger } from "../logger/logger";
import { DecoratorRegistry } from "../metadata/decorator-registry";
import { MetadataRegistry } from "../metadata/metadata-registry";
import type { CustomDecorator } from "../metadata/reflector";
import { dirname } from "../utils/path.util";

/**
 * Symbol metadata key storing extended `@AutoModule` scan/manifest/filter/profile options.
 */
export const AUTO_MODULE_METADATA_KEY = Symbol.for(
  "bunest:metadata:auto_module",
);

/**
 * Default glob exclusions applied by `@AutoModule({ scan })`.
 */
export const DEFAULT_AUTO_MODULE_EXCLUDES: readonly string[] = Object.freeze([
  "**/*.spec.ts",
  "**/*.test.ts",
  "**/*.d.ts",
]);

/**
 * Build-time static dynamic-import manifest entry emitted by `Bun.plugin`
 * for single-file executables (`bun build --compile`) or supplied manually.
 */
export type AutoModuleManifestLoader = () => Promise<
  Record<string, unknown> | object
>;

/**
 * Extended metadata accepted by `@AutoModule(...)`, supporting zero-boilerplate
 * `DecoratorRegistry` auto-discovery, native `Bun.Glob` directory scanning,
 * compile-time static import manifests, custom filters, and active profiles.
 */
export interface AutoModuleMetadata extends ModuleMetadata {
  /**
   * Glob pattern(s) resolved via native `Bun.Glob` relative to `cwd` (or the
   * caller file's directory). Scopes auto-discovery strictly to classes loaded
   * from matched files.
   */
  readonly scan?: string | readonly string[];
  /**
   * Glob patterns excluded from `scan`.
   * @default ["**\/*.spec.ts", "**\/*.test.ts", "**\/*.d.ts"]
   */
  readonly exclude?: readonly string[];
  /**
   * Base directory for resolving relative `scan` globs.
   */
  readonly cwd?: string;
  /**
   * Build-time static dynamic-import manifest loaders. When specified, takes
   * precedence over runtime `Bun.Glob` filesystem scanning.
   */
  readonly manifest?: readonly AutoModuleManifestLoader[];
  /**
   * Optional predicate filtering discovered controller/provider classes.
   */
  readonly filter?: (target: Type<unknown>) => boolean;
}

/**
 * Normalized internal `@AutoModule` metadata stored under `AUTO_MODULE_METADATA_KEY`.
 */
export interface StoredAutoModuleMetadata {
  readonly scan?: readonly string[];
  readonly exclude?: readonly string[];
  readonly cwd?: string;
  readonly callerDir?: string;
  readonly manifest?: readonly AutoModuleManifestLoader[];
  readonly filter?: (target: Type<unknown>) => boolean;
}

function parseStackFramePath(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("at ")) {
    return undefined;
  }
  const parenStart = trimmed.lastIndexOf("(");
  const parenEnd = trimmed.lastIndexOf(")");
  let location =
    parenStart !== -1 && parenEnd > parenStart
      ? trimmed.slice(parenStart + 1, parenEnd)
      : trimmed.slice(3).trim();

  if (
    !location ||
    location.startsWith("native") ||
    location.startsWith("bun:") ||
    location.startsWith("[")
  ) {
    return undefined;
  }

  // Strip trailing :line:col or :line
  location = location.replace(/:\d+(?::\d+)?$/, "");
  if (location.startsWith("file://")) {
    try {
      return Bun.fileURLToPath(location);
    } catch {
      return undefined;
    }
  }
  return location;
}

/**
 * Extracts the directory of the first user stack frame outside internal
 * decorator/factory files so `@AutoModule({ scan })` can resolve relative globs
 * when `cwd` is omitted.
 */
export function extractCallerDir(
  skipSubstrings: readonly string[] = [
    "core.decorators.",
    "bunest-factory.",
    "module-scanner.",
  ],
): string | undefined {
  const stack = new Error().stack;
  if (!stack) {
    return undefined;
  }
  const lines = stack.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const filePath = parseStackFramePath(lines[i]!);
    if (!filePath) {
      continue;
    }
    let shouldSkip = false;
    for (let j = 0; j < skipSubstrings.length; j++) {
      if (filePath.includes(skipSubstrings[j]!)) {
        shouldSkip = true;
        break;
      }
    }
    if (!shouldSkip) {
      return dirname(filePath);
    }
  }
  return undefined;
}

/**
 * Reads extended `@AutoModule` metadata (`scan`, `exclude`, `cwd`, `manifest`,
 * `filter`, `profiles`) attached to a module class.
 */
export function getAutoModuleMetadata(
  target: Function,
): StoredAutoModuleMetadata | undefined {
  return MetadataRegistry.getOwn<StoredAutoModuleMetadata>(
    AUTO_MODULE_METADATA_KEY,
    target,
  );
}

const VALID_MODULE_METADATA_KEYS = new Set([
  "imports",
  "controllers",
  "providers",
  "exports",
  "autoDiscover",
]);

/**
 * Lazily attaches a non-enumerable `logger` property (`new Logger(target.name)`)
 * onto `target.prototype` if the class has not already defined its own `logger`.
 */
export function attachAutoLogger(
  target: Function,
  fallbackContext: string,
): void {
  if (
    !target.prototype ||
    Object.prototype.hasOwnProperty.call(target.prototype, "logger")
  ) {
    return;
  }
  const loggerContext = target.name || fallbackContext;
  Object.defineProperty(target.prototype, "logger", {
    configurable: true,
    enumerable: false,
    get(this: object): Logger {
      const instance = new Logger(loggerContext);
      Object.defineProperty(this, "logger", {
        value: instance,
        writable: true,
        enumerable: false,
        configurable: true,
      });
      return instance;
    },
    set(this: object, value: unknown): void {
      Object.defineProperty(this, "logger", {
        value,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    },
  });
}

/**
 * Defines a Bunest module organizing imports, controllers, providers, and exports.
 */
export function Module(metadata: ModuleMetadata): ClassDecorator {
  const hasOwn = Object.prototype.hasOwnProperty;
  for (const key of Object.keys(metadata)) {
    if (!VALID_MODULE_METADATA_KEYS.has(key)) {
      throw new Error(
        `Invalid property '${key}' passed into the @Module() decorator.`,
      );
    }
  }
  const ownImports = hasOwn.call(metadata, "imports")
    ? metadata.imports
    : undefined;
  const ownControllers = hasOwn.call(metadata, "controllers")
    ? metadata.controllers
    : undefined;
  const ownProviders = hasOwn.call(metadata, "providers")
    ? metadata.providers
    : undefined;
  const ownExports = hasOwn.call(metadata, "exports")
    ? metadata.exports
    : undefined;
  const ownAutoDiscover = hasOwn.call(metadata, "autoDiscover")
    ? metadata.autoDiscover
    : undefined;

  return (target: Function) => {
    MetadataRegistry.define<ModuleMetadata>(
      METADATA_KEYS.MODULE,
      {
        imports: ownImports ? [...ownImports] : undefined,
        controllers: ownControllers ? [...ownControllers] : undefined,
        providers: ownProviders ? [...ownProviders] : undefined,
        exports: ownExports ? [...ownExports] : undefined,
        ...(ownAutoDiscover !== undefined
          ? {
              autoDiscover:
                typeof ownAutoDiscover === "object"
                  ? {
                      ...ownAutoDiscover,
                      ...(ownAutoDiscover.include
                        ? { include: [...ownAutoDiscover.include] }
                        : {}),
                      ...(ownAutoDiscover.exclude
                        ? { exclude: [...ownAutoDiscover.exclude] }
                        : {}),
                    }
                  : ownAutoDiscover,
            }
          : {}),
      },
      target,
    );
    attachAutoLogger(target, "Module");
  };
}

/**
 * Shorthand `@Module` decorator with `autoDiscover: true` enabled by default,
 * automatically wiring self-registered `@Controller` and `@Injectable` classes
 * from `DecoratorRegistry`, or scoped to files matched by `scan` / `manifest`.
 */
export function AutoModule(metadata: AutoModuleMetadata = {}): ClassDecorator {
  const { scan, exclude, cwd, manifest, filter, ...moduleMeta } = metadata;

  const hasExtended =
    scan !== undefined ||
    exclude !== undefined ||
    cwd !== undefined ||
    manifest !== undefined ||
    filter !== undefined;

  const callerDir =
    hasExtended && cwd === undefined && scan !== undefined
      ? extractCallerDir()
      : undefined;

  const applyModule = Module({
    ...moduleMeta,
    autoDiscover: moduleMeta.autoDiscover ?? true,
  });

  return (target: Function) => {
    applyModule(target);
    if (hasExtended) {
      const stored: StoredAutoModuleMetadata = {
        ...(scan !== undefined
          ? { scan: typeof scan === "string" ? [scan] : [...scan] }
          : {}),
        ...(exclude !== undefined ? { exclude: [...exclude] } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(callerDir !== undefined ? { callerDir } : {}),
        ...(manifest !== undefined ? { manifest: [...manifest] } : {}),
        ...(filter !== undefined ? { filter } : {}),
      };
      MetadataRegistry.define<StoredAutoModuleMetadata>(
        AUTO_MODULE_METADATA_KEY,
        stored,
        target,
      );
    }
  };
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
    attachAutoLogger(target, "Injectable");
  };
}

/**
 * Overrides the DI injection token for a constructor parameter or class property.
 * Copy-on-write: never mutates parent class metadata.
 */
export function Inject<T = unknown>(
  token?: InjectionToken<T> | ForwardReference<T>,
): ParameterDecorator & PropertyDecorator {
  const hasExplicitToken = arguments.length > 0;
  return (
    target: object,
    propertyKey: string | symbol | undefined,
    parameterIndex?: number,
  ) => {
    // Constructor parameter injection
    if (typeof parameterIndex === "number" && propertyKey === undefined) {
      const resolvedToken = hasExplicitToken
        ? (token as InjectionToken | ForwardReference | undefined)
        : (MetadataRegistry.getParamTypes(target)?.[parameterIndex] as
            InjectionToken | undefined);

      if (!hasExplicitToken && resolvedToken === undefined) {
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
        { index: parameterIndex, token: resolvedToken as InjectionToken },
      ].sort((a, b) => a.index - b.index);

      MetadataRegistry.define(METADATA_KEYS.INJECT_TOKENS, next, target);
      return;
    }

    // Property injection
    if (propertyKey !== undefined) {
      const ctor = target.constructor;
      const resolvedToken = hasExplicitToken
        ? (token as InjectionToken | ForwardReference | undefined)
        : (MetadataRegistry.getType(target, propertyKey) as
            InjectionToken | undefined);

      if (!hasExplicitToken && resolvedToken === undefined) {
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
        { propertyKey, token: resolvedToken as InjectionToken },
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
export function Catch(...exceptions: Type<unknown>[]): ClassDecorator {
  return (target: Function) => {
    const copy = [...exceptions];
    MetadataRegistry.define<readonly Type<unknown>[]>(
      METADATA_KEYS.CATCH_EXCEPTIONS,
      copy,
      target,
    );
    if (target.prototype) {
      MetadataRegistry.define<readonly Type<unknown>[]>(
        METADATA_KEYS.CATCH_EXCEPTIONS,
        [...exceptions],
        target.prototype,
      );
    }
  };
}

/**
 * Declares constructor dependencies explicitly (matching NestJS `@Dependencies()`
 * for JavaScript / non-`emitDecoratorMetadata` usage).
 */
export function Dependencies(
  ...dependencies: Array<unknown>
): ClassDecorator {
  const flatDeps: Array<InjectionToken | ForwardReference> = [];
  const flattenInto = (items: readonly unknown[]): void => {
    for (const item of items) {
      if (Array.isArray(item)) {
        flattenInto(item);
      } else {
        flatDeps.push(item as InjectionToken | ForwardReference);
      }
    }
  };
  flattenInto(dependencies);
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
