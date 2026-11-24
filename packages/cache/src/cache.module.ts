import { Module, type DynamicModule, type Provider } from "@bunest/core";
import { Cache } from "./cache.abstract";
import { CacheInterceptor } from "./cache.interceptor";
import { CacheService } from "./cache.service";
import { CACHE_MANAGER, CACHE_MODULE_OPTIONS, CACHE_STORE } from "./constants";
import {
  CacheEvictAspectHandler,
  CachePutAspectHandler,
  CacheableAspectHandler,
} from "./decorators/cache-aspect.decorators";
import type {
  CacheModuleAsyncOptions,
  CacheModuleOptions,
  CacheOptionsFactory,
  CacheStore,
} from "./interfaces/cache.interface";
import { MemoryCacheStore } from "./stores/memory-cache.store";

function createStoreFromOptions(options: CacheModuleOptions): CacheStore {
  if (Array.isArray(options.stores) && options.stores.length > 0) {
    return options.stores[0]!;
  }
  if (options.stores && !Array.isArray(options.stores)) {
    return options.stores as CacheStore;
  }
  if (options.store) {
    return options.store;
  }
  return new MemoryCacheStore({
    defaultTtlMs: options.ttl ?? options.ttlMs,
    maxItems: options.maxItems,
    cleanupIntervalMs: options.cleanupIntervalMs,
  });
}

@Module({})
export class CacheModule {
  static register<
    StoreConfig extends Record<PropertyKey, unknown> = Record<string, unknown>,
  >(
    options: CacheModuleOptions<StoreConfig> = {} as CacheModuleOptions<StoreConfig>,
  ): DynamicModule {
    const optionsProvider: Provider = {
      provide: CACHE_MODULE_OPTIONS,
      useValue: { ...options },
    };
    const storeProvider: Provider = {
      provide: CACHE_STORE,
      useFactory: (opts: CacheModuleOptions) => createStoreFromOptions(opts),
      inject: [CACHE_MODULE_OPTIONS],
    };
    const cacheAliasProvider: Provider = {
      provide: Cache,
      useExisting: CacheService,
    };
    const cacheManagerProvider: Provider = {
      provide: CACHE_MANAGER,
      useExisting: CacheService,
    };

    return {
      module: CacheModule,
      global: options.isGlobal ?? false,
      providers: [
        optionsProvider,
        storeProvider,
        CacheService,
        cacheAliasProvider,
        cacheManagerProvider,
        CacheInterceptor,
        CacheableAspectHandler,
        CacheEvictAspectHandler,
        CachePutAspectHandler,
      ],
      exports: [
        CACHE_MODULE_OPTIONS,
        CACHE_STORE,
        CACHE_MANAGER,
        Cache,
        CacheService,
        CacheInterceptor,
        CacheableAspectHandler,
        CacheEvictAspectHandler,
        CachePutAspectHandler,
      ],
    };
  }

  static registerAsync<
    StoreConfig extends Record<PropertyKey, unknown> = Record<string, unknown>,
  >(options: CacheModuleAsyncOptions<StoreConfig>): DynamicModule {
    const asyncProviders = CacheModule.createAsyncOptionsProviders(options);
    const storeProvider: Provider = {
      provide: CACHE_STORE,
      useFactory: (opts: CacheModuleOptions) => createStoreFromOptions(opts),
      inject: [CACHE_MODULE_OPTIONS],
    };
    const cacheAliasProvider: Provider = {
      provide: Cache,
      useExisting: CacheService,
    };
    const cacheManagerProvider: Provider = {
      provide: CACHE_MANAGER,
      useExisting: CacheService,
    };

    return {
      module: CacheModule,
      global: options.isGlobal ?? false,
      imports: options.imports ?? [],
      providers: [
        ...(options.provideInjectionTokensFrom ?? []),
        ...asyncProviders,
        storeProvider,
        CacheService,
        cacheAliasProvider,
        cacheManagerProvider,
        CacheInterceptor,
        CacheableAspectHandler,
        CacheEvictAspectHandler,
        CachePutAspectHandler,
        ...(options.extraProviders ?? []),
      ],
      exports: [
        CACHE_MODULE_OPTIONS,
        CACHE_STORE,
        CACHE_MANAGER,
        Cache,
        CacheService,
        CacheInterceptor,
        CacheableAspectHandler,
        CacheEvictAspectHandler,
        CachePutAspectHandler,
      ],
    };
  }

  private static createAsyncOptionsProviders<
    StoreConfig extends Record<any, any>,
  >(options: CacheModuleAsyncOptions<StoreConfig>): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: CACHE_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ];
    }

    if (options.useClass) {
      return [
        {
          provide: options.useClass,
          useClass: options.useClass,
        },
        {
          provide: CACHE_MODULE_OPTIONS,
          useFactory: (factory: CacheOptionsFactory<StoreConfig>) =>
            factory.createCacheOptions(),
          inject: [options.useClass],
        },
      ];
    }

    if (options.useExisting) {
      return [
        {
          provide: CACHE_MODULE_OPTIONS,
          useFactory: (factory: CacheOptionsFactory<StoreConfig>) =>
            factory.createCacheOptions(),
          inject: [options.useExisting],
        },
      ];
    }

    throw new Error(
      "CacheModule.registerAsync() requires one of useFactory, useClass, or useExisting.",
    );
  }
}
