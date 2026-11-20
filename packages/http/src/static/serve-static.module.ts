import { join, resolve } from "node:path";
import {
  DecoratorRegistry,
  Inject,
  Injectable,
  Module,
  Optional,
  type DynamicModule,
  type ModuleMetadata,
  type OnModuleInit,
  type Provider,
  type Type,
} from "@bunest/common";
import type { AbstractHttpAdapter } from "../adapter/abstract-http.adapter";
import { normalizePath } from "../scanner/path-normalizer";
import {
  createStaticAssetsMount,
  type ExtendedStaticAssetsOptions,
  type StaticAssetsMount,
} from "./static-assets";

export const SERVE_STATIC_MODULE_OPTIONS = "SERVE_STATIC_MODULE_OPTIONS";
export const DEFAULT_ROOT_PATH = "client";
export const DEFAULT_RENDER_PATH = "*";
export const DEFAULT_EXPRESS_RENDER_PATH = "{*any}";
export const DEFAULT_FASTIFY_RENDER_PATH = "*";

/**
 * Shared internal symbols resolved automatically by `@bunest/core`'s `DIContainer`
 * so `@bunest/http` stays strictly acyclic with zero dependency on `@bunest/core`.
 */
export const BUNEST_HTTP_ADAPTER_HOST_TOKEN = Symbol.for(
  "bunest:http-adapter-host",
);
export const BUNEST_APPLICATION_CONFIG_TOKEN = Symbol.for(
  "bunest:application-config",
);

export interface ServeStaticApplicationConfigLike {
  getGlobalPrefix(): string;
}

export interface ServeStaticHttpAdapterHostLike {
  readonly httpAdapter?: AbstractHttpAdapter & {
    addStaticAssetsMount?(mount: StaticAssetsMount): unknown;
  };
}

export interface ServeStaticModuleOptions {
  rootPath?: string;
  renderPath?: string | RegExp;
  useGlobalPrefix?: boolean;
  serveRoot?: string;
  exclude?: string[] | RegExp;
  transformIndexHtml?: (
    indexHtml: string,
    req: unknown,
  ) => string | Promise<string>;
  serveStaticOptions?: {
    acceptRanges?: boolean;
    cacheControl?: boolean;
    dotfiles?: string;
    etag?: boolean;
    fallthrough?: boolean;
    extensions?: string[];
    immutable?: boolean;
    index?: boolean | string | string[];
    lastModified?: boolean;
    maxAge?: number | string;
    redirect?: boolean;
    setHeaders?: (res: any, path: string, stat: any) => any;
    preCompressed?: boolean;
    decorateReply?: boolean;
  };
}

export interface ServeStaticModuleOptionsFactory {
  /**
   * Matches upstream `@nestjs/serve-static@12.1.1` method name verbatim.
   */
  createLoggerOptions():
    | Promise<ServeStaticModuleOptions[]>
    | ServeStaticModuleOptions[];
}

export interface ServeStaticModuleAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  isGlobal?: boolean;
  useExisting?: Type<ServeStaticModuleOptionsFactory>;
  useClass?: Type<ServeStaticModuleOptionsFactory>;
  useFactory?: (
    ...args: any[]
  ) => Promise<ServeStaticModuleOptions[]> | ServeStaticModuleOptions[];
  inject?: any[];
  extraProviders?: Provider[];
}

/**
 * Abstract static-file loader matching `@nestjs/serve-static@12.1.1` `AbstractLoader`.
 */
@Injectable()
export abstract class AbstractLoader {
  abstract register(
    httpAdapter: AbstractHttpAdapter,
    config: ServeStaticApplicationConfigLike | undefined,
    options: ServeStaticModuleOptions[],
  ): any;

  getIndexFilePath(clientPath: string): string {
    return join(clientPath, "index.html");
  }
}

/**
 * No-op loader used when no HTTP adapter is available (matching `@nestjs/serve-static` `NoopLoader`).
 */
@Injectable()
export class NoopLoader extends AbstractLoader {
  register(): void {
    // Intentionally empty
  }
}

/**
 * Bun-native static asset loader (ADR-001: zero Express, Fastify, or `node:http`).
 * Mounts each `ServeStaticModuleOptions` entry onto `BunHttpAdapter` via `Bun.file()`.
 */
@Injectable()
export class BunStaticLoader extends AbstractLoader {
  register(
    httpAdapter: AbstractHttpAdapter & {
      addStaticAssetsMount?(mount: StaticAssetsMount): unknown;
    },
    config: ServeStaticApplicationConfigLike | undefined,
    optionsArr: ServeStaticModuleOptions[],
  ): void {
    if (!httpAdapter) {
      return;
    }

    const globalPrefix = config?.getGlobalPrefix?.() ?? "";

    for (const options of optionsArr) {
      const rootPath = options.rootPath ?? resolve(process.cwd(), DEFAULT_ROOT_PATH);
      const baseRoot = options.serveRoot ?? "/";
      const effectivePrefix =
        options.useGlobalPrefix && globalPrefix
          ? normalizePath(globalPrefix, baseRoot)
          : normalizePath(baseRoot);

      const staticOpts = options.serveStaticOptions ?? {};
      const renderPath = options.renderPath ?? DEFAULT_RENDER_PATH;
      const spaEnabled =
        staticOpts.index !== false &&
        (options.renderPath !== undefined ||
          options.transformIndexHtml !== undefined ||
          options.serveStaticOptions?.index !== false);

      const spaIndexFile =
        typeof staticOpts.index === "string"
          ? staticOpts.index
          : Array.isArray(staticOpts.index) && staticOpts.index.length > 0
            ? staticOpts.index[0]
            : "index.html";

      const mountOptions: ExtendedStaticAssetsOptions = {
        prefix: effectivePrefix,
        index: staticOpts.index,
        cacheControl: staticOpts.cacheControl,
        dotfiles:
          staticOpts.dotfiles === "allow" || staticOpts.dotfiles === "deny"
            ? staticOpts.dotfiles
            : "ignore",
        etag: staticOpts.etag,
        immutable: staticOpts.immutable,
        maxAge: staticOpts.maxAge,
        exclude: options.exclude,
        renderPath,
        spaFallback: spaEnabled ? spaIndexFile : undefined,
        transformIndexHtml: options.transformIndexHtml,
        extensions: staticOpts.extensions,
        setHeaders: staticOpts.setHeaders,
        preCompressed: staticOpts.preCompressed,
        acceptRanges: staticOpts.acceptRanges,
        lastModified: staticOpts.lastModified,
        fallthrough: staticOpts.fallthrough,
        redirect: staticOpts.redirect,
      };

      if (typeof httpAdapter.addStaticAssetsMount === "function") {
        httpAdapter.addStaticAssetsMount(
          createStaticAssetsMount(rootPath, mountOptions),
        );
      } else {
        httpAdapter.useStaticAssets(rootPath, mountOptions);
      }
    }
  }
}

export const serveStaticProviders: Provider[] = [
  {
    provide: AbstractLoader,
    useFactory: (httpAdapterHost?: ServeStaticHttpAdapterHostLike) => {
      if (!httpAdapterHost) {
        return new NoopLoader();
      }
      const adapterType = httpAdapterHost.httpAdapter?.getType?.();
      if (adapterType === "noop") {
        return new NoopLoader();
      }
      return new BunStaticLoader();
    },
    inject: [
      {
        token: BUNEST_HTTP_ADAPTER_HOST_TOKEN,
        optional: true,
      },
    ],
  },
];

/**
 * Dynamic NestJS v12-compatible `ServeStaticModule` powered natively by `Bun.file()`
 * (zero Express/Fastify/Node HTTP runtime dependencies per ADR-001).
 */
@Module({
  providers: [...serveStaticProviders],
})
export class ServeStaticModule implements OnModuleInit {
  constructor(
    @Inject(SERVE_STATIC_MODULE_OPTIONS)
    private readonly moduleOptions: ServeStaticModuleOptions[],
    private readonly loader: AbstractLoader,
    @Optional()
    @Inject(BUNEST_APPLICATION_CONFIG_TOKEN)
    private readonly config?: ServeStaticApplicationConfigLike,
    @Optional()
    @Inject(BUNEST_HTTP_ADAPTER_HOST_TOKEN)
    private readonly httpAdapterHost?: ServeStaticHttpAdapterHostLike,
  ) {}

  static forRoot(...options: ServeStaticModuleOptions[]): DynamicModule {
    const normalizedOptions = options.length > 0 ? options : [{}];
    return {
      module: ServeStaticModule,
      providers: [
        {
          provide: SERVE_STATIC_MODULE_OPTIONS,
          useValue: normalizedOptions,
        },
      ],
    };
  }

  static forRootAsync(options: ServeStaticModuleAsyncOptions): DynamicModule {
    return {
      module: ServeStaticModule,
      global: options.isGlobal,
      imports: options.imports ?? [],
      providers: [
        ...ServeStaticModule.createAsyncProviders(options),
        ...(options.extraProviders ?? []),
      ],
    };
  }

  private static createAsyncProviders(
    options: ServeStaticModuleAsyncOptions,
  ): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [ServeStaticModule.createAsyncOptionsProvider(options)];
    }
    if (options.useClass) {
      return [
        ServeStaticModule.createAsyncOptionsProvider(options),
        {
          provide: options.useClass,
          useClass: options.useClass,
        },
      ];
    }
    return [ServeStaticModule.createAsyncOptionsProvider(options)];
  }

  private static createAsyncOptionsProvider(
    options: ServeStaticModuleAsyncOptions,
  ): Provider {
    if (options.useFactory) {
      return {
        provide: SERVE_STATIC_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      };
    }
    const injectTarget = options.useExisting ?? options.useClass;
    if (!injectTarget) {
      return {
        provide: SERVE_STATIC_MODULE_OPTIONS,
        useValue: [{}],
      };
    }
    return {
      provide: SERVE_STATIC_MODULE_OPTIONS,
      useFactory: async (optionsFactory: ServeStaticModuleOptionsFactory) =>
        await optionsFactory.createLoggerOptions(),
      inject: [injectTarget],
    };
  }

  onModuleInit(): void {
    const httpAdapter = this.httpAdapterHost?.httpAdapter;
    if (!httpAdapter) {
      return;
    }
    const opts = Array.isArray(this.moduleOptions)
      ? this.moduleOptions
      : [this.moduleOptions];
    this.loader.register(httpAdapter, this.config, opts);
  }
}

DecoratorRegistry.markInternal(AbstractLoader, NoopLoader, BunStaticLoader);
