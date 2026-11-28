import { Module, type DynamicModule, type InjectionToken } from "@bunest/core";
import {
  ENV_CONFIG_OPTIONS,
  type EnvConfigOptions,
} from "./env-config.constants";
import { EnvConfigService } from "./env-config.service";

export interface EnvConfigAsyncOptions {
  readonly imports?: DynamicModule["imports"];
  readonly inject?: InjectionToken[];
  readonly useFactory: (
    ...args: unknown[]
  ) => EnvConfigOptions | Promise<EnvConfigOptions>;
}

@Module({})
export class EnvConfigModule {
  static register(options: EnvConfigOptions): DynamicModule {
    return {
      module: EnvConfigModule,
      providers: [
        {
          provide: ENV_CONFIG_OPTIONS,
          useValue: options,
        },
        EnvConfigService,
      ],
      exports: [EnvConfigService],
    };
  }

  static registerAsync(options: EnvConfigAsyncOptions): DynamicModule {
    return {
      module: EnvConfigModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: ENV_CONFIG_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        EnvConfigService,
      ],
      exports: [EnvConfigService],
    };
  }
}
