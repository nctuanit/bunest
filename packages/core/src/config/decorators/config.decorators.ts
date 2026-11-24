import {
  Inject,
  MetadataRegistry,
  Optional,
  type InjectionToken,
} from "../../common/index";
import { ConfigService } from "../config.service";
import type { NamespacedConfigFactory } from "../interfaces/config.interface";
import type { ConfigPathInput } from "../interfaces/config-registry.interface";
import { getConfigToken, isNamespacedConfigFactory } from "../register-as";

export const CONFIG_VALUE_METADATA = Symbol.for(
  "bunest:config:config_value_metadata",
);

const CONFIG_VALUE_INJECT_SYMBOL = Symbol.for(
  "bunest:config:config_service_ref",
);

const CONFIG_VALUE_BINDER_INSTALLED = Symbol.for(
  "bunest:config:value_binder_installed",
);

export interface InjectConfigBinding {
  readonly token: InjectionToken;
  readonly lookupKey: string | symbol;
  readonly defaultValue?: unknown;
  readonly hasDefault: boolean;
  readonly isNamespaceFactory?: boolean;
}

export interface ConfigValueMetadata {
  readonly propertyKey: string | symbol;
  readonly path: string;
  readonly defaultValue?: unknown;
  readonly hasDefault: boolean;
}

const injectConfigBindings = new Map<InjectionToken, InjectConfigBinding>();
const primitiveDefaultTokens = new Map<string, symbol>();
let injectConfigCounter = 0;

const instanceConfigServices = new WeakMap<
  object,
  ConfigService<Record<string, unknown>> | undefined
>();
const instanceValueOverrides = new WeakMap<
  object,
  Map<string | symbol, unknown>
>();
const instanceInitialFieldValues = new WeakMap<
  object,
  Map<string | symbol, unknown>
>();

/** @internal Returns all `@InjectConfig(...)` bindings registered at decoration time. */
export function getRegisteredInjectConfigBindings(): readonly InjectConfigBinding[] {
  return [...injectConfigBindings.values()];
}

function isPrimitiveKeyable(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function parseConfigurationToken(token: string): string | undefined {
  if (token.startsWith("CONFIGURATION(") && token.endsWith(")")) {
    return token.slice("CONFIGURATION(".length, -1);
  }
  return undefined;
}

function registerInjectConfigToken(
  keyOrNamespace: string | NamespacedConfigFactory<any, any>,
  defaultValue: unknown,
  hasDefault: boolean,
): InjectionToken {
  let baseToken: string;
  let lookupKey: string | symbol;

  let isNsFactory = false;
  if (typeof keyOrNamespace === "string") {
    const unwrapped = parseConfigurationToken(keyOrNamespace);
    if (unwrapped !== undefined) {
      baseToken = keyOrNamespace;
      lookupKey = unwrapped;
    } else {
      baseToken = getConfigToken(keyOrNamespace);
      lookupKey = keyOrNamespace;
    }
  } else if (isNamespacedConfigFactory(keyOrNamespace)) {
    baseToken = keyOrNamespace.KEY;
    lookupKey = keyOrNamespace.namespace;
    isNsFactory = true;
  } else {
    baseToken = keyOrNamespace.KEY;
    lookupKey = keyOrNamespace.namespace;
    isNsFactory = true;
  }

  if (!hasDefault) {
    if (!injectConfigBindings.has(baseToken)) {
      injectConfigBindings.set(baseToken, {
        token: baseToken,
        lookupKey,
        hasDefault: false,
        isNamespaceFactory: isNsFactory,
      });
    }
    return baseToken;
  }

  let token: symbol;
  if (typeof lookupKey === "string" && isPrimitiveKeyable(defaultValue)) {
    const cacheKey = `${lookupKey}\0${typeof defaultValue}\0${String(defaultValue)}`;
    const existing = primitiveDefaultTokens.get(cacheKey);
    if (existing) {
      return existing;
    }
    token = Symbol(
      `bunest:config:inject(${lookupKey},default=${String(defaultValue)})`,
    );
    primitiveDefaultTokens.set(cacheKey, token);
  } else {
    token = Symbol(
      `bunest:config:inject(${String(lookupKey)}#${++injectConfigCounter})`,
    );
  }

  injectConfigBindings.set(token, {
    token,
    lookupKey,
    defaultValue,
    hasDefault: true,
  });

  return token;
}

/**
 * Injects a configuration namespace (`registerAs(...)`) or individual config
 * key / dot-path (e.g. `"database.host"`, `"PORT"`) into a constructor parameter
 * or class property, with an optional `defaultValue`.
 */
export function InjectConfig(
  keyOrNamespace: ConfigPathInput | NamespacedConfigFactory<any, any>,
  defaultValue?: unknown,
): ParameterDecorator & PropertyDecorator {
  const hasDefault = arguments.length >= 2;
  const token = registerInjectConfigToken(
    keyOrNamespace,
    defaultValue,
    hasDefault,
  );
  return Inject(token);
}

function collectConfigValueEntries(ctor: Function): ConfigValueMetadata[] {
  const chain = MetadataRegistry.getPrototypeChain(ctor);
  const byProp = new Map<string | symbol, ConfigValueMetadata>();
  for (let i = 0; i < chain.length; i++) {
    const cls = chain[i]!;
    const own = MetadataRegistry.getOwn<readonly ConfigValueMetadata[]>(
      CONFIG_VALUE_METADATA,
      cls,
    );
    if (own) {
      for (let j = 0; j < own.length; j++) {
        const entry = own[j]!;
        byProp.set(entry.propertyKey, entry);
      }
    }
  }
  return [...byProp.values()];
}

function readConfigValue(
  instance: object,
  entry: ConfigValueMetadata,
  initialFieldValue: unknown,
  hasInitialFieldValue: boolean,
): unknown {
  const overrides = instanceValueOverrides.get(instance);
  if (overrides?.has(entry.propertyKey)) {
    return overrides.get(entry.propertyKey);
  }

  const configService = instanceConfigServices.get(instance);
  if (configService) {
    const resolved = configService.get(entry.path);
    if (resolved !== undefined) {
      return resolved;
    }
  }

  if (entry.hasDefault) {
    return entry.defaultValue;
  }
  if (hasInitialFieldValue) {
    return initialFieldValue;
  }
  return undefined;
}

function setConfigValueOverride(
  instance: object,
  propertyKey: string | symbol,
  value: unknown,
): void {
  let overrides = instanceValueOverrides.get(instance);
  if (!overrides) {
    overrides = new Map();
    instanceValueOverrides.set(instance, overrides);
  }
  overrides.set(propertyKey, value);
}

function setInitialFieldValue(
  instance: object,
  propertyKey: string | symbol,
  value: unknown,
): void {
  let initials = instanceInitialFieldValues.get(instance);
  if (!initials) {
    initials = new Map();
    instanceInitialFieldValues.set(instance, initials);
  }
  initials.set(propertyKey, value);
}

function installInstanceConfigValueGetters(instance: object): void {
  const ctor = (instance as { constructor?: Function }).constructor;
  if (typeof ctor !== "function") {
    return;
  }
  const entries = collectConfigValueEntries(ctor);
  const record = instance as Record<PropertyKey, unknown>;
  const recordedInitials = instanceInitialFieldValues.get(instance);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const ownDesc = Object.getOwnPropertyDescriptor(
      instance,
      entry.propertyKey,
    );
    const hasOwnInitial =
      Boolean(ownDesc) && "value" in ownDesc! && ownDesc!.value !== undefined;
    const hasRecordedInitial =
      Boolean(recordedInitials?.has(entry.propertyKey)) &&
      recordedInitials!.get(entry.propertyKey) !== undefined;
    const hasInitialFieldValue = hasOwnInitial || hasRecordedInitial;
    const initialFieldValue = hasOwnInitial
      ? ownDesc!.value
      : hasRecordedInitial
        ? recordedInitials!.get(entry.propertyKey)
        : undefined;

    Object.defineProperty(record, entry.propertyKey, {
      configurable: true,
      enumerable: true,
      get(this: object) {
        return readConfigValue(
          this,
          entry,
          initialFieldValue,
          hasInitialFieldValue,
        );
      },
      set(this: object, value: unknown) {
        setConfigValueOverride(this, entry.propertyKey, value);
      },
    });
  }
}

/**
 * Property decorator binding a class property to a live `ConfigService` lookup
 * at `path` (supports flat keys and dot-notation paths like `"database.host"`),
 * with an optional `defaultValue` fallback.
 *
 * Automatically reflects runtime `ConfigService.set()` updates and works cleanly
 * across `SINGLETON`, `TRANSIENT`, and `REQUEST` scopes (as well as plain `new`
 * instantiation in unit tests, returning `defaultValue`).
 */
export function ConfigValue(
  path: ConfigPathInput,
  defaultValue?: unknown,
): PropertyDecorator {
  const hasDefault = arguments.length >= 2;

  return (target: object, propertyKey: string | symbol) => {
    const ctor = (target as { constructor?: Function }).constructor;
    if (typeof ctor !== "function") {
      return;
    }

    const entry: ConfigValueMetadata = {
      propertyKey,
      path,
      ...(hasDefault ? { defaultValue } : {}),
      hasDefault,
    };

    const existing =
      MetadataRegistry.getOwn<readonly ConfigValueMetadata[]>(
        CONFIG_VALUE_METADATA,
        ctor,
      ) ?? [];
    const next = [
      ...existing.filter((item) => item.propertyKey !== propertyKey),
      entry,
    ];
    MetadataRegistry.define(CONFIG_VALUE_METADATA, next, ctor);

    // Register a hidden optional ConfigService property injection once per class
    if (!MetadataRegistry.hasOwn(CONFIG_VALUE_BINDER_INSTALLED, ctor)) {
      MetadataRegistry.define(CONFIG_VALUE_BINDER_INSTALLED, true, ctor);
      Optional()(target, CONFIG_VALUE_INJECT_SYMBOL);
      Inject(ConfigService)(target, CONFIG_VALUE_INJECT_SYMBOL);

      Object.defineProperty(target, CONFIG_VALUE_INJECT_SYMBOL, {
        configurable: true,
        enumerable: false,
        get(this: object) {
          return instanceConfigServices.get(this);
        },
        set(
          this: object,
          service: ConfigService<Record<string, unknown>> | undefined,
        ) {
          instanceConfigServices.set(this, service);
          installInstanceConfigValueGetters(this);
        },
      });
    }

    // Prototype fallback getter for non-DI instantiation (`new MyService()`)
    Object.defineProperty(target, propertyKey, {
      configurable: true,
      enumerable: true,
      get(this: object) {
        const initials = instanceInitialFieldValues.get(this);
        const hasInitial =
          Boolean(initials?.has(propertyKey)) &&
          initials!.get(propertyKey) !== undefined;
        return readConfigValue(
          this,
          entry,
          hasInitial ? initials!.get(propertyKey) : undefined,
          hasInitial,
        );
      },
      set(this: object, value: unknown) {
        if (!instanceConfigServices.has(this)) {
          setInitialFieldValue(this, propertyKey, value);
        } else {
          setConfigValueOverride(this, propertyKey, value);
        }
      },
    });
  };
}
