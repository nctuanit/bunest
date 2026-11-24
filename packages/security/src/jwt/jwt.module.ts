import { Module, type DynamicModule, type Provider } from "@bunest/core";
import {
  JWT_MODULE_OPTIONS,
  type JwtModuleAsyncOptions,
  type JwtModuleOptions,
  type JwtOptionsFactory,
} from "./jwt.interface";
import { JwtService } from "./jwt.service";

@Module({})
export class JwtModule {
  static register(options: JwtModuleOptions = {}): DynamicModule {
    return {
      module: JwtModule,
      global: options.global,
      providers: [
        { provide: JWT_MODULE_OPTIONS, useValue: options },
        JwtService,
      ],
      exports: [JwtService, JWT_MODULE_OPTIONS],
    };
  }

  static registerAsync(options: JwtModuleAsyncOptions): DynamicModule {
    return {
      module: JwtModule,
      global: options.global,
      imports: options.imports,
      providers: [
        ...this.createAsyncProviders(options),
        JwtService,
        ...(options.extraProviders ?? []),
      ],
      exports: [JwtService, JWT_MODULE_OPTIONS],
    };
  }

  private static createAsyncProviders(
    options: JwtModuleAsyncOptions,
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
      "JwtModule.registerAsync requires one of useFactory, useClass, or useExisting",
    );
  }

  private static createAsyncOptionsProvider(
    options: JwtModuleAsyncOptions,
  ): Provider {
    if (options.useFactory) {
      return {
        provide: JWT_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      };
    }
    const injectToken = options.useExisting ?? options.useClass;
    if (!injectToken) {
      throw new Error(
        "JwtModule.registerAsync requires one of useFactory, useClass, or useExisting",
      );
    }
    return {
      provide: JWT_MODULE_OPTIONS,
      useFactory: async (optionsFactory: JwtOptionsFactory) =>
        await optionsFactory.createJwtOptions(),
      inject: [injectToken],
    };
  }
}
