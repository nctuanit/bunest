import {
  Module,
  type DynamicModule,
  type Provider,
} from "@bunest/common";
import { HttpService } from "./http.service";
import type {
  HttpModuleAsyncOptions,
  HttpModuleOptions,
  HttpModuleOptionsFactory,
} from "./interfaces";
import { HTTP_MODULE_ID, HTTP_MODULE_OPTIONS } from "./tokens";

function createAsyncOptionsProviders(
  options: HttpModuleAsyncOptions,
): Provider[] {
  if (options.useFactory) {
    return [
      {
        provide: HTTP_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      },
    ];
  }

  if (options.useClass) {
    const factoryCls = options.useClass;
    return [
      {
        provide: factoryCls,
        useClass: factoryCls,
      },
      {
        provide: HTTP_MODULE_OPTIONS,
        useFactory: (factory: HttpModuleOptionsFactory) =>
          factory.createHttpOptions(),
        inject: [factoryCls],
      },
    ];
  }

  if (options.useExisting !== undefined) {
    return [
      {
        provide: HTTP_MODULE_OPTIONS,
        useFactory: (factory: HttpModuleOptionsFactory) =>
          factory.createHttpOptions(),
        inject: [options.useExisting],
      },
    ];
  }

  return [
    {
      provide: HTTP_MODULE_OPTIONS,
      useValue: {},
    },
  ];
}

/**
 * NestJS `@nestjs/axios`-compatible `HttpModule` registering `HttpService`
 * backed natively by Bun's `fetch()` API.
 */
@Module({
  providers: [HttpService],
  exports: [HttpService],
})
export class HttpModule {
  static register(config: HttpModuleOptions = {}): DynamicModule {
    return {
      module: HttpModule,
      global: config.global ?? false,
      providers: [
        {
          provide: HTTP_MODULE_OPTIONS,
          useValue: config,
        },
        {
          provide: HTTP_MODULE_ID,
          useValue: crypto.randomUUID(),
        },
      ],
      exports: [HttpService],
    };
  }

  static registerAsync(options: HttpModuleAsyncOptions): DynamicModule {
    return {
      module: HttpModule,
      global: options.global ?? false,
      imports: options.imports ?? [],
      providers: [
        ...createAsyncOptionsProviders(options),
        {
          provide: HTTP_MODULE_ID,
          useValue: crypto.randomUUID(),
        },
        ...(options.extraProviders ?? []),
      ],
      exports: [HttpService],
    };
  }
}
