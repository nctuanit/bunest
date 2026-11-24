import {
  ConfigurableModuleBuilder,
  type FactoryProvider,
  type ModuleMetadata,
  type Provider,
  type Type,
} from "../common/index";
import { I18nMessageFormatter } from "./formatters/i18n-message.formatter";
import { PlaceholderMessageFormatter } from "./formatters/placeholder-message.formatter";
import { I18N_MODULE_OPTIONS, I18N_RESOLVERS } from "./i18n.constants";
import type { I18nModuleOptions } from "./interfaces/i18n-module-options.interface";
import { I18nLoader } from "./loaders/i18n.loader";
import { AcceptLanguageLocaleResolver } from "./resolvers/accept-language-locale.resolver";
import type { LocaleResolver } from "./resolvers/locale.resolver";

/**
 * Top-level options of `forRoot()` and `forRootAsync()`. They decide which
 * providers exist, so they're known when the module is defined. Only here can
 * `loader`, `resolvers` and `formatter` be classes, which Bunest instantiates
 * with DI.
 */
export interface I18nModuleExtras {
  /** An `I18nLoader` instance, or a loader class Bunest instantiates. */
  loader?: I18nLoader | Type<I18nLoader>;
  /** Locale resolvers, tried in order: instances, or classes Bunest instantiates. */
  resolvers?: Array<LocaleResolver | Type<LocaleResolver>>;
  /** An `I18nMessageFormatter` instance, or a formatter class Bunest instantiates. */
  formatter?: I18nMessageFormatter | Type<I18nMessageFormatter>;
  /** Modules whose exported providers the loader, resolver and formatter classes inject. */
  imports?: ModuleMetadata["imports"];
  /** Register the module globally. Default `true`. */
  isGlobal?: boolean;
}

/** `forRoot()` takes the values and the top-level options together. `loader` is required. */
export type I18nForRootOptions = Omit<
  I18nModuleOptions,
  "loader" | "resolvers" | "formatter"
> &
  I18nModuleExtras &
  Required<Pick<I18nModuleExtras, "loader">>;

/**
 * Implemented by a `forRootAsync({ useClass })` class. Bunest calls
 * `createI18nOptions()`, matching NestJS's options factory convention.
 */
export interface I18nOptionsFactory {
  createI18nOptions(): I18nModuleOptions | Promise<I18nModuleOptions>;
}

export const { ConfigurableModuleClass, ASYNC_OPTIONS_TYPE } =
  new ConfigurableModuleBuilder<I18nModuleOptions>({
    optionsInjectionToken: I18N_MODULE_OPTIONS,
  })
    .setClassMethodName("forRoot")
    .setFactoryMethodName("createI18nOptions")
    .setExtras<I18nModuleExtras>(
      {
        isGlobal: true,
        imports: undefined,
        loader: undefined,
        resolvers: undefined,
        formatter: undefined,
      },
      (definition, extras) => ({
        ...definition,
        global: extras.isGlobal ?? true,
        // forRootAsync() already put `imports` on the definition; forRoot() doesn't.
        imports: [
          ...new Set([
            ...(definition.imports ?? []),
            ...(extras.imports ?? []),
          ]),
        ],
        providers: [
          ...(definition.providers ?? []).map((provider) =>
            checkingResult(provider, extras),
          ),
          loaderProvider(extras.loader),
          ...resolverProviders(extras.resolvers),
          formatterProvider(extras.formatter),
        ],
      }),
    )
    .build();

/**
 * What `forRootAsync()` takes: `useFactory` (with `inject`), `useClass` or
 * `useExisting`, next to the top-level options (`loader`, `resolvers`,
 * `formatter`, `imports`, `isGlobal`).
 */
export type I18nModuleAsyncOptions = typeof ASYNC_OPTIONS_TYPE;

/** `forRoot()` fails when it's called; `forRootAsync()` once its factory has run. */
export function missingLoaderError(): Error {
  return new Error(
    'I18nModule: the "loader" option is required, for example ' +
      "loader: new JsonI18nLoader({ path: join(import.meta.dirname, 'i18n') }). " +
      "In forRootAsync(), pass it next to useFactory or return it from the factory.",
  );
}

/**
 * Wraps `forRootAsync()`'s options provider (`useFactory`, `useClass` or
 * `useExisting`), so what it returns is checked before anything reads it.
 * `forRoot()` needs no check: its top-level options never reach the options
 * object.
 */
function checkingResult(
  provider: Provider,
  extras: I18nModuleExtras,
): Provider {
  if (!isOptionsFactory(provider)) {
    return provider;
  }
  const { useFactory } = provider;
  return {
    ...provider,
    useFactory: async (...args: unknown[]) =>
      checkResult(await useFactory(...args), extras),
  };
}

function isOptionsFactory(
  provider: Provider,
): provider is FactoryProvider<I18nModuleOptions> {
  return (
    typeof provider === "object" &&
    provider !== null &&
    provider.provide === I18N_MODULE_OPTIONS &&
    "useFactory" in provider
  );
}

function checkResult(
  options: unknown,
  extras: I18nModuleExtras,
): I18nModuleOptions {
  if (options === null || typeof options !== "object") {
    throw new Error(
      `I18nModule: forRootAsync()'s factory returned ${JSON.stringify(options)}; ` +
        "return the options object, such as { defaultLocale: 'en' }.",
    );
  }

  const record = options as Record<string, unknown>;
  for (const key of ["isGlobal", "imports"] as const) {
    if (Object.hasOwn(record, key)) {
      throw new Error(
        `I18nModule: pass "${key}" to forRootAsync() next to useFactory, not in the options it returns.`,
      );
    }
  }

  for (const key of ["loader", "resolvers", "formatter"] as const) {
    if (record[key] === undefined) {
      continue;
    }
    if (extras[key] !== undefined) {
      throw new Error(
        `I18nModule: "${key}" is set both at the top level of forRootAsync() and in the ` +
          "options its factory returns. Set it in one place.",
      );
    }
    const items = Array.isArray(record[key]) ? record[key] : [record[key]];
    const cls = items.find(isClass);
    if (cls) {
      throw new Error(
        `I18nModule: forRootAsync()'s factory returned ${cls.name ? `the class ${cls.name}` : "a class"} ` +
          `in "${key}". Classes go at the top level of forRootAsync(), next to useFactory, where ` +
          "Bunest instantiates them. The factory can return instances only.",
      );
    }
  }

  if (record.loader === undefined && extras.loader === undefined) {
    throw missingLoaderError();
  }

  return options as I18nModuleOptions;
}

function loaderProvider(
  loader: I18nLoader | Type<I18nLoader> | undefined,
): Provider {
  if (loader === undefined) {
    // forRootAsync()'s factory returned it (checked above).
    return {
      provide: I18nLoader,
      inject: [I18N_MODULE_OPTIONS],
      useFactory: (options: I18nModuleOptions) => options.loader!,
    };
  }
  return isClass(loader)
    ? { provide: I18nLoader, useClass: loader }
    : { provide: I18nLoader, useValue: loader };
}

function formatterProvider(
  formatter: I18nMessageFormatter | Type<I18nMessageFormatter> | undefined,
): Provider {
  if (formatter === undefined) {
    return {
      provide: I18nMessageFormatter,
      inject: [I18N_MODULE_OPTIONS],
      useFactory: (options: I18nModuleOptions) =>
        options.formatter ?? new PlaceholderMessageFormatter(),
    };
  }
  return isClass(formatter)
    ? { provide: I18nMessageFormatter, useClass: formatter }
    : { provide: I18nMessageFormatter, useValue: formatter };
}

function resolverProviders(
  resolvers: Array<LocaleResolver | Type<LocaleResolver>> | undefined,
): Provider[] {
  if (resolvers === undefined) {
    return [
      {
        provide: I18N_RESOLVERS,
        inject: [I18N_MODULE_OPTIONS],
        useFactory: (options: I18nModuleOptions) =>
          options.resolvers ?? [new AcceptLanguageLocaleResolver()],
      },
    ];
  }
  const classes: Type<LocaleResolver>[] = [
    ...new Set(resolvers.filter((r): r is Type<LocaleResolver> => isClass(r))),
  ];
  return [
    ...classes,
    {
      provide: I18N_RESOLVERS,
      inject: classes,
      useFactory: (...instances: LocaleResolver[]) =>
        resolvers.map((resolver) =>
          isClass<LocaleResolver>(resolver)
            ? instances[classes.indexOf(resolver)]!
            : resolver,
        ),
    },
  ];
}

function isClass<T>(value: unknown): value is Type<T> {
  return typeof value === "function";
}
