import {
  Module,
  type DynamicModule,
  type Provider,
  type Type,
} from "@bunest/core";
import { ELASTICSEARCH_MODULE_OPTIONS } from "./elasticsearch.constants";
import { ElasticsearchService } from "./elasticsearch.service";
import type {
  ElasticsearchModuleAsyncOptions,
  ElasticsearchModuleOptions,
  ElasticsearchOptionsFactory,
} from "./interfaces/elasticsearch-module-options.interface";

@Module({
  providers: [ElasticsearchService],
  exports: [ElasticsearchService],
})
export class ElasticsearchModule {
  static register(options: ElasticsearchModuleOptions): DynamicModule {
    return {
      module: ElasticsearchModule,
      providers: [
        {
          provide: ELASTICSEARCH_MODULE_OPTIONS,
          useValue: options,
        },
      ],
      exports: [ElasticsearchService, ELASTICSEARCH_MODULE_OPTIONS],
    };
  }

  static registerAsync(
    options: ElasticsearchModuleAsyncOptions,
  ): DynamicModule {
    return {
      module: ElasticsearchModule,
      imports: options.imports ?? [],
      providers: [...this.createAsyncProviders(options)],
      exports: [ElasticsearchService, ELASTICSEARCH_MODULE_OPTIONS],
    };
  }

  private static createAsyncProviders(
    options: ElasticsearchModuleAsyncOptions,
  ): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options)];
    }
    const useClass = options.useClass as Type<ElasticsearchOptionsFactory>;
    return [
      this.createAsyncOptionsProvider(options),
      {
        provide: useClass,
        useClass,
      },
    ];
  }

  private static createAsyncOptionsProvider(
    options: ElasticsearchModuleAsyncOptions,
  ): Provider {
    if (options.useFactory) {
      return {
        provide: ELASTICSEARCH_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      };
    }
    const inject = [
      (options.useExisting ??
        options.useClass) as Type<ElasticsearchOptionsFactory>,
    ];
    return {
      provide: ELASTICSEARCH_MODULE_OPTIONS,
      useFactory: async (optionsFactory: ElasticsearchOptionsFactory) =>
        await optionsFactory.createElasticsearchOptions(),
      inject,
    };
  }
}
