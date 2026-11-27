import {
  APP_INTERCEPTOR,
  Inject,
  Module,
  Optional,
  type BunestInterceptor,
  type BunestModule,
  type DynamicModule,
  type InjectionToken,
  type MiddlewareConsumer,
  type ModuleImport,
  type Provider,
  type Type,
} from "../common/index";
import { WithClsAspect } from "./cls.decorator";
import { createClsProxyProvider } from "./cls-proxy.provider";
import {
  CLS_MODULE_OPTIONS,
  ClsInterceptor,
  ClsMiddleware,
  ClsService,
  type ClsModuleAsyncOptions,
  type ClsModuleOptions,
} from "./cls.service";

const CLS_ROOT_MODULE_MARKER = Symbol.for("bunest:core:cls_root_module");

export interface ClsFeatureOptions {
  /**
   * Register the feature proxy providers globally.
   * @default false
   */
  readonly global?: boolean;
  /**
   * Additional modules imported so feature proxy factories can inject their providers.
   */
  readonly imports?: ModuleImport[];
}

@Module({})
class ClsFeatureModule {}

/**
 * Module providing `ClsService`, `ClsMiddleware`, `ClsInterceptor`, `WithClsAspect`,
 * auto-mounted middleware/interceptor hooks, and CLS-backed proxy feature providers
 * backed by Bun's native `AsyncLocalStorage` (comparable to `nestjs-cls`).
 */
@Module({
  providers: [ClsService, ClsMiddleware, ClsInterceptor, WithClsAspect],
  exports: [ClsService, ClsMiddleware, ClsInterceptor, WithClsAspect],
})
export class ClsModule implements BunestModule {
  constructor(
    @Optional()
    @Inject(CLS_MODULE_OPTIONS)
    private readonly options: ClsModuleOptions = {},
    @Optional()
    @Inject(CLS_ROOT_MODULE_MARKER)
    private readonly isRootModule = false,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    if (!this.isRootModule || this.options.middleware?.mount !== true) {
      return;
    }

    const proxy = consumer.apply(ClsMiddleware);
    if (
      this.options.middleware.exclude &&
      this.options.middleware.exclude.length > 0
    ) {
      proxy.exclude(...this.options.middleware.exclude);
    }

    const routes =
      this.options.middleware.forRoutes &&
      this.options.middleware.forRoutes.length > 0
        ? this.options.middleware.forRoutes
        : ["*"];
    proxy.forRoutes(...routes);
  }

  static forRoot(options: ClsModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      {
        provide: CLS_MODULE_OPTIONS,
        useValue: options,
      },
      {
        provide: CLS_ROOT_MODULE_MARKER,
        useValue: true,
      },
    ];

    if (options.interceptor?.mount === true) {
      providers.push({
        provide: APP_INTERCEPTOR,
        useExisting: ClsInterceptor,
      });
    }

    return {
      module: ClsModule,
      global: options.global ?? true,
      providers,
      exports: [
        CLS_MODULE_OPTIONS,
        ClsService,
        ClsMiddleware,
        ClsInterceptor,
        WithClsAspect,
      ],
    };
  }

  static forRootAsync(options: ClsModuleAsyncOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: CLS_MODULE_OPTIONS,
        useFactory: async (...args: unknown[]): Promise<ClsModuleOptions> => {
          const resolved = (await options.useFactory(...args)) ?? {};
          const mergedMiddleware =
            options.middleware || resolved.middleware
              ? { ...options.middleware, ...resolved.middleware }
              : undefined;
          const mergedInterceptor =
            options.interceptor || resolved.interceptor
              ? { ...options.interceptor, ...resolved.interceptor }
              : undefined;
          return {
            ...resolved,
            ...(mergedMiddleware ? { middleware: mergedMiddleware } : {}),
            ...(mergedInterceptor ? { interceptor: mergedInterceptor } : {}),
          };
        },
        inject: options.inject ? [...options.inject] : [],
      },
      {
        provide: CLS_ROOT_MODULE_MARKER,
        useValue: true,
      },
      {
        provide: APP_INTERCEPTOR,
        useFactory: (
          resolvedOptions: ClsModuleOptions,
          interceptor: ClsInterceptor,
        ): BunestInterceptor | undefined => {
          return resolvedOptions.interceptor?.mount === true
            ? interceptor
            : undefined;
        },
        inject: [CLS_MODULE_OPTIONS, ClsInterceptor],
      },
    ];

    return {
      module: ClsModule,
      global: options.global ?? true,
      imports: options.imports ? [...options.imports] : [],
      providers,
      exports: [
        CLS_MODULE_OPTIONS,
        ClsService,
        ClsMiddleware,
        ClsInterceptor,
        WithClsAspect,
      ],
    };
  }

  /**
   * Registers CLS proxy providers (created via `createClsProxyProvider(...)` or plain
   * per-context state classes) and exports their tokens for injection into singletons
   * without requiring `Scope.REQUEST`.
   */
  static forFeature(
    providers: readonly (Provider | Type<object>)[],
    options: ClsFeatureOptions = {},
  ): DynamicModule {
    const registeredProviders: Provider[] = [];
    const exportedTokens: InjectionToken[] = [];

    for (const entry of providers) {
      if (typeof entry === "function") {
        registeredProviders.push(
          createClsProxyProvider(entry, () => new entry()),
        );
        exportedTokens.push(entry);
      } else {
        registeredProviders.push(entry);
        exportedTokens.push(entry.provide);
      }
    }

    return {
      module: ClsFeatureModule,
      global: options.global ?? false,
      imports: options.imports ? [...options.imports] : [],
      providers: registeredProviders,
      exports: exportedTokens,
    };
  }
}
