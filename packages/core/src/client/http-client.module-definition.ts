import {
  ConfigurableModuleBuilder,
  type DynamicModule,
  type ModuleMetadata,
  type Provider,
  type Type,
} from "../common/index";
import { ModuleRef } from "../index";
import { HttpClient, createHttpClient, initHttpClient } from "./http-client";
import type {
  HttpClientInterceptor,
  HttpClientInterceptorFn,
  HttpClientInterceptorLike,
} from "./interfaces/http-client-interceptor.interface";
import type {
  HttpClientModuleOptions,
  HttpClientOptions,
} from "./interfaces/http-client-options.interface";
import {
  isInterceptorClass,
  mergeClientOptions,
} from "./utils/client-options.util";

/**
 * The `forRoot()`/`forRootAsync()` options: defaults for every client. Its
 * top-level interceptors are kept apart, so overriding this token in a test
 * keeps them.
 */
export const HTTP_CLIENT_MODULE_OPTIONS: unique symbol = Symbol(
  "HTTP_CLIENT_MODULE_OPTIONS",
);

/** The default client is the `HttpClient` class token; named ones get a string token. */
export function getHttpClientToken(name?: string): string | typeof HttpClient {
  return name ? `HttpClient:${name}` : HttpClient;
}

/**
 * What an async factory may return in `interceptors`: instances and
 * functions, built from what it injects. Classes are created with DI, so
 * they go next to `useFactory`.
 */
type InterceptorInstance = HttpClientInterceptorFn | HttpClientInterceptor;

/** What `registerAsync()`'s factory (or `createHttpClientOptions()`) returns. */
export type HttpClientFactoryOptions = Omit<
  HttpClientOptions,
  "interceptors"
> & {
  interceptors?: InterceptorInstance[] | undefined;
};

/** What `forRootAsync()`'s factory (or `createHttpClientModuleOptions()`) returns. */
export type HttpClientModuleFactoryOptions = Omit<
  HttpClientModuleOptions,
  "interceptors"
> & {
  interceptors?: InterceptorInstance[] | undefined;
};

/**
 * Structural options: interceptor classes are created with DI, so they, and
 * the `imports` they inject from, have to be known when the module is
 * defined. They are passed next to `useFactory`, never returned from it.
 */
interface StructuralExtras {
  /** Classes (created with DI), instances and functions. */
  interceptors?: HttpClientInterceptorLike[] | undefined;
  /** Modules whose exported providers the interceptor classes inject. */
  imports?: ModuleMetadata["imports"] | undefined;
}

export interface HttpClientRegistrationExtras extends StructuralExtras {
  /** Inject with `@InjectHttpClient(name)`. Without one, this is the default client, injected as `HttpClient`. */
  name?: string | undefined;
  /** Make the client injectable everywhere, not only in the importing module. Default `false`. */
  isGlobal?: boolean | undefined;
}

/** What `register()` takes. */
export type HttpClientRegisterOptions = Omit<
  HttpClientOptions,
  "interceptors"
> &
  HttpClientRegistrationExtras;

/** What `forRoot()` takes: the defaults, and the modules its interceptor classes inject from. */
export type HttpClientRootOptions = HttpClientModuleOptions &
  Pick<StructuralExtras, "imports">;

/** Each `register*()` module's own options (internal: one per dynamic module). */
const CLIENT_OPTIONS = Symbol("HTTP_CLIENT_OPTIONS");
const CLIENT_INTERCEPTORS = Symbol("HTTP_CLIENT_INTERCEPTORS");
const ROOT_INTERCEPTORS = Symbol("HTTP_CLIENT_ROOT_INTERCEPTORS");
/** Resolves the client's interceptors on `onModuleInit`, once every provider exists. */
const HTTP_CLIENT_INITIALIZER = Symbol("HTTP_CLIENT_INITIALIZER");

let registrationSeq = 0;

interface RootInterceptorsState {
  entries: HttpClientInterceptorLike[];
  classes: Set<Type<HttpClientInterceptor>>;
  moduleRef: ModuleRef;
}

export const { ConfigurableModuleClass, OPTIONS_TYPE, ASYNC_OPTIONS_TYPE } =
  new ConfigurableModuleBuilder<HttpClientFactoryOptions>({
    optionsInjectionToken: CLIENT_OPTIONS,
  })
    .setClassMethodName("register")
    .setFactoryMethodName("createHttpClientOptions")
    .setExtras<HttpClientRegistrationExtras>(
      {
        name: undefined,
        isGlobal: false,
        interceptors: undefined,
        imports: undefined,
      },
      (definition, extras) => {
        const token = getHttpClientToken(extras.name);
        const instanceId = Symbol(`HTTP_CLIENT_REG_${++registrationSeq}`);
        return {
          ...definition,
          global: extras.isGlobal ?? false,
          imports: withImports(definition, extras.imports),
          providers: [
            ...(definition.providers ?? []),
            { provide: instanceId, useValue: undefined },
            { provide: CLIENT_INTERCEPTORS, useValue: extras.interceptors },
            createClientProvider(token),
            createInitializer(token),
          ],
          exports: [token],
        };
      },
    )
    .build();

export const {
  ConfigurableModuleClass: RootConfigurableModuleClass,
  OPTIONS_TYPE: ROOT_OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE: ROOT_ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<HttpClientModuleFactoryOptions>({
  optionsInjectionToken: HTTP_CLIENT_MODULE_OPTIONS,
})
  .setClassMethodName("forRoot")
  .setFactoryMethodName("createHttpClientModuleOptions")
  .setExtras<StructuralExtras>(
    { interceptors: undefined, imports: undefined },
    (definition, extras) => ({
      ...definition,
      global: true,
      imports: withImports(definition, extras.imports),
      providers: [
        ...(definition.providers ?? []),
        createRootInterceptors(extras.interceptors),
      ],
      exports: [HTTP_CLIENT_MODULE_OPTIONS, ROOT_INTERCEPTORS],
    }),
  )
  .build();

/** What `registerAsync()` takes. */
export type HttpClientAsyncOptions = typeof ASYNC_OPTIONS_TYPE;

/** What `forRootAsync()` takes. */
export type HttpClientModuleAsyncOptions = typeof ROOT_ASYNC_OPTIONS_TYPE;

/**
 * Implemented by the class passed as `registerAsync({ useClass })`. Its
 * options may hold interceptor instances and functions; classes go next to
 * `useClass`.
 */
export interface HttpClientOptionsFactory {
  createHttpClientOptions():
    HttpClientFactoryOptions | Promise<HttpClientFactoryOptions>;
}

/**
 * Implemented by the class passed as `forRootAsync({ useClass })`. Its
 * options may hold interceptor instances and functions; classes go next to
 * `useClass`.
 */
export interface HttpClientModuleOptionsFactory {
  createHttpClientModuleOptions():
    HttpClientModuleFactoryOptions | Promise<HttpClientModuleFactoryOptions>;
}

function withImports(
  definition: DynamicModule,
  imports: ModuleMetadata["imports"] | undefined,
): NonNullable<DynamicModule["imports"]> {
  return [...new Set([...(definition.imports ?? []), ...(imports ?? [])])];
}

function createRootInterceptors(
  topLevel: HttpClientInterceptorLike[] | undefined,
): Provider {
  return {
    provide: ROOT_INTERCEPTORS,
    inject: [HTTP_CLIENT_MODULE_OPTIONS, ModuleRef],
    useFactory: (
      options: HttpClientModuleFactoryOptions | undefined,
      moduleRef: ModuleRef,
    ): RootInterceptorsState => {
      const entries = pickInterceptors(topLevel, options, "forRootAsync");
      return {
        entries,
        classes: new Set(entries.filter(isInterceptorClass)),
        moduleRef,
      };
    },
  };
}

function createInitializer(token: string | typeof HttpClient): Provider {
  return {
    provide: HTTP_CLIENT_INITIALIZER,
    inject: [token],
    useFactory: (client: unknown) => ({
      onModuleInit: () =>
        client instanceof HttpClient ? initHttpClient(client) : undefined,
    }),
  };
}

function createClientProvider(token: string | typeof HttpClient): Provider {
  return {
    provide: token,
    inject: [
      CLIENT_OPTIONS,
      CLIENT_INTERCEPTORS,
      { token: HTTP_CLIENT_MODULE_OPTIONS, optional: true },
      { token: ROOT_INTERCEPTORS, optional: true },
      ModuleRef,
    ],
    useFactory: (
      options: HttpClientFactoryOptions | undefined,
      topLevel: HttpClientInterceptorLike[] | undefined,
      defaults: HttpClientModuleOptions | undefined,
      root: RootInterceptorsState | undefined,
      moduleRef: ModuleRef,
    ): HttpClient => {
      const interceptors = pickInterceptors(topLevel, options, "registerAsync");
      const merged = mergeClientOptions(
        defaults ? { ...defaults, interceptors: root?.entries } : undefined,
        { ...(options ?? {}), interceptors },
      );
      return createHttpClient(merged, (type) =>
        resolveInterceptor(
          root?.classes.has(type) ? root.moduleRef : moduleRef,
          type,
        ),
      );
    },
  };
}

function pickInterceptors(
  topLevel: HttpClientInterceptorLike[] | undefined,
  options: Record<string, unknown> | HttpClientFactoryOptions | undefined,
  method: "registerAsync" | "forRootAsync",
): HttpClientInterceptorLike[] {
  const structural = ["name", "isGlobal", "imports"].find(
    (key) => options && key in options,
  );
  if (structural) {
    throw new Error(
      `HttpClientModule.${method}(): the factory returned \`${structural}\`, which decides how ` +
        "the module is registered and has to be known before the factory runs. Pass it next to " +
        "useFactory/useClass instead.",
    );
  }
  const fromFactory = (
    options as { interceptors?: HttpClientInterceptorLike[] } | undefined
  )?.interceptors;
  if (fromFactory === undefined) {
    return topLevel ?? [];
  }
  if (topLevel !== undefined) {
    throw new Error(
      `HttpClientModule.${method}(): \`interceptors\` is set both next to useFactory/useClass ` +
        "and in the options they return. Set it in one place.",
    );
  }
  const type = fromFactory.find(isInterceptorClass);
  if (type) {
    throw new Error(
      `HttpClientModule.${method}(): the factory returned the class ${type.name} in ` +
        "`interceptors`. Classes go at the top level, next to useFactory/useClass, so Bunest can " +
        "create them with their dependencies. The factory may return instances and functions.",
    );
  }
  return fromFactory;
}

/**
 * Called from `onModuleInit` (or on the first request when the app was never
 * initialized, e.g. a bare `compile()` in a test), once every provider exists,
 * so an interceptor may depend on a service that injects this client.
 */
export async function resolveInterceptor(
  moduleRef: ModuleRef,
  type: Type<HttpClientInterceptor>,
): Promise<HttpClientInterceptor> {
  try {
    return moduleRef.get(type, { strict: false });
  } catch {
    return moduleRef.create(type);
  }
}
