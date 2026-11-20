import {
  APP_INTERCEPTOR,
  Module,
  type BunestModule,
  type DynamicModule,
  type MiddlewareConsumer,
} from "@bunest/common";
import { I18nContext } from "./context/i18n.context";
import { I18N_CATALOGS, I18N_MODULE_OPTIONS } from "./i18n.constants";
import {
  ConfigurableModuleClass,
  missingLoaderError,
  type I18nForRootOptions,
  type I18nModuleAsyncOptions,
} from "./i18n.module-definition";
import { I18nService } from "./i18n.service";
import { I18nInterceptor } from "./interceptors/i18n.interceptor";
import { I18nLoader } from "./loaders/i18n.loader";
import { I18nMiddleware } from "./middleware/i18n.middleware";
import { LocaleResolution } from "./services/locale-resolution.service";

/**
 * The generated class types its statics as properties, which can't be
 * narrowed. Declared as methods, `forRoot()` can take loader and resolver
 * classes and require `loader`.
 */
interface ConfigurableI18nModule {
  new (): object;
  forRoot(options: I18nForRootOptions): DynamicModule;
  forRootAsync(options: I18nModuleAsyncOptions): DynamicModule;
}

const I18nModuleBase =
  ConfigurableModuleClass as unknown as ConfigurableI18nModule;

/**
 * `I18nModule.forRoot({ loader, resolvers?, imports?, ...options })` or
 * `forRootAsync({ loader?, resolvers?, imports, inject, useFactory })`, whose
 * factory can also return `loader` and `resolvers` instances.
 * Global by default. Mounts the locale middleware on every route and a global
 * interceptor for entry points the middleware doesn't wrap.
 */
@Module({
  providers: [
    {
      provide: I18N_CATALOGS,
      useFactory: (loader: I18nLoader) => loader.load(),
      inject: [I18nLoader],
    },
    I18nService,
    I18nContext,
    LocaleResolution,
    I18nMiddleware,
    { provide: APP_INTERCEPTOR, useClass: I18nInterceptor },
  ],
  exports: [I18nService, I18nContext, I18N_MODULE_OPTIONS],
})
export class I18nModule extends I18nModuleBase implements BunestModule {
  static override forRoot(options: I18nForRootOptions): DynamicModule {
    if (options?.loader === undefined) {
      throw missingLoaderError();
    }
    return super.forRoot(options);
  }

  static override forRootAsync(
    options: I18nModuleAsyncOptions,
  ): DynamicModule {
    return super.forRootAsync(options);
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(I18nMiddleware).forRoutes("*");
  }
}
