import { Module, type DynamicModule, type Provider } from "@bunest/core";
import { MemoryThrottlerStorage } from "./memory-throttler.storage";
import { ThrottlerGuard } from "./throttler.guard";
import {
  THROTTLER_OPTIONS,
  THROTTLER_STORAGE,
  isThrottlerOptionsArray,
  type ThrottlerAsyncOptions,
  type ThrottlerModuleOptions,
  type ThrottlerOptionsFactory,
} from "./throttler.interface";

@Module({})
export class ThrottlerModule {
  static forRoot(options: ThrottlerModuleOptions = []): DynamicModule {
    const customStorage = !isThrottlerOptionsArray(options)
      ? options.storage
      : undefined;
    const isGlobal = !isThrottlerOptionsArray(options)
      ? (options.global ?? true)
      : true;

    const storageProvider: Provider = customStorage
      ? { provide: THROTTLER_STORAGE, useValue: customStorage }
      : { provide: THROTTLER_STORAGE, useClass: MemoryThrottlerStorage };

    return {
      module: ThrottlerModule,
      global: isGlobal,
      providers: [
        { provide: THROTTLER_OPTIONS, useValue: options },
        storageProvider,
        ThrottlerGuard,
      ],
      exports: [THROTTLER_OPTIONS, THROTTLER_STORAGE, ThrottlerGuard],
    };
  }

  static forRootAsync(options: ThrottlerAsyncOptions): DynamicModule {
    return {
      module: ThrottlerModule,
      global: options.global ?? true,
      imports: options.imports,
      providers: [
        ...this.createAsyncProviders(options),
        {
          provide: THROTTLER_STORAGE,
          inject: [THROTTLER_OPTIONS],
          useFactory: (opts: ThrottlerModuleOptions) =>
            !isThrottlerOptionsArray(opts) && opts.storage
              ? opts.storage
              : new MemoryThrottlerStorage(),
        },
        ThrottlerGuard,
      ],
      exports: [THROTTLER_OPTIONS, THROTTLER_STORAGE, ThrottlerGuard],
    };
  }

  private static createAsyncProviders(
    options: ThrottlerAsyncOptions,
  ): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options)];
    }
    if (options.useClass) {
      return [
        this.createAsyncOptionsProvider(options),
        {
          provide: options.useClass,
          useClass: options.useClass,
        },
      ];
    }
    throw new Error(
      "ThrottlerModule.forRootAsync requires one of useFactory, useClass, or useExisting",
    );
  }

  private static createAsyncOptionsProvider(
    options: ThrottlerAsyncOptions,
  ): Provider {
    if (options.useFactory) {
      return {
        provide: THROTTLER_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      };
    }
    const injectToken = options.useExisting ?? options.useClass;
    if (!injectToken) {
      throw new Error(
        "ThrottlerModule.forRootAsync requires one of useFactory, useClass, or useExisting",
      );
    }
    return {
      provide: THROTTLER_OPTIONS,
      useFactory: async (optionsFactory: ThrottlerOptionsFactory) =>
        await optionsFactory.createThrottlerOptions(),
      inject: [injectToken],
    };
  }
}
