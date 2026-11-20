import type { FactoryProvider } from "@bunest/common";
import { NAMESPACED_CONFIG_MARKER } from "./constants";
import type {
  ConfigObject,
  NamespacedConfigFactory,
} from "./interfaces/config.interface";

/**
 * Returns the canonical DI injection token for a configuration namespace registered
 * via `registerAs(token, factory)`.
 */
export function getConfigToken(token: string | symbol): string {
  return `CONFIGURATION(${token.toString()})`;
}

/**
 * Registers a typed configuration namespace injectable via `@Inject(config.KEY)`
 * or `@Inject(getConfigToken(namespace))` and accessible on `ConfigService` via
 * dot-path (`configService.get("namespace.prop")`).
 */
export function registerAs<
  TConfig extends ConfigObject,
  TNamespace extends string | symbol = string,
>(
  namespace: TNamespace,
  configFactory: () => TConfig | Promise<TConfig>,
): NamespacedConfigFactory<TConfig, TNamespace> {
  if (
    !namespace ||
    (typeof namespace !== "string" && typeof namespace !== "symbol")
  ) {
    throw new TypeError(
      "registerAs() requires a non-empty namespace string or symbol.",
    );
  }

  const key = getConfigToken(namespace);

  const factory = (() => configFactory()) as NamespacedConfigFactory<
    TConfig,
    TNamespace
  >;

  Object.defineProperties(factory, {
    KEY: { value: key, enumerable: true, writable: false },
    namespace: { value: namespace, enumerable: true, writable: false },
    [NAMESPACED_CONFIG_MARKER]: {
      value: true,
      enumerable: false,
      writable: false,
    },
    asProvider: {
      value: (): FactoryProvider<TConfig> => ({
        provide: key,
        useFactory: configFactory,
      }),
      enumerable: true,
      writable: false,
    },
  });

  return factory;
}

export function isNamespacedConfigFactory(
  value: unknown,
): value is NamespacedConfigFactory<ConfigObject, string | symbol> {
  return (
    typeof value === "function" &&
    (value as unknown as Record<symbol, unknown>)[NAMESPACED_CONFIG_MARKER] ===
      true
  );
}
