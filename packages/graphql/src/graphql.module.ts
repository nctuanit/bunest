import {
  Controller,
  type DynamicModule,
  Get,
  Inject,
  Module,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
  Post,
  type Provider,
  Req,
  Res,
  type ResponseContext,
  Scope,
  type Type,
} from "@bunest/common";
import { normalizePath } from "@bunest/http";
import { GRAPHQL_MODULE_OPTIONS, GRAPHQL_SCHEMA_TOKEN } from "./constants";
import { AbstractGraphQLDriver } from "./driver/abstract-graphql.driver";
import { GraphQLService } from "./driver/graphql-http.handler";
import { GraphQLSchemaHost } from "./graphql-schema.host";
import type {
  GqlModuleAsyncOptions,
  GqlModuleOptions,
  GqlOptionsFactory,
  GraphQLModuleAsyncOptions,
  GraphQLModuleOptions,
} from "./interfaces/graphql.interface";
import { FileSystemHelper } from "./schema/file-system.helper";
import { GraphQLAstExplorer } from "./schema/graphql-ast.explorer";
import { GraphQLDefinitionsFactory } from "./schema/graphql-definitions.factory";
import { GraphQLSchemaFactory } from "./schema/graphql-schema.factory";
import { GraphQLTypesLoader } from "./schema/graphql-types.loader";
import {
  GraphQLFactory,
  GraphQLFederationFactory,
} from "./schema/graphql.factory";
import { ResolverDecoratorHost } from "./services/resolver-decorator-host";

function createGraphQLController(routePath: string): Type<unknown> {
  const normalized = normalizePath(routePath);

  @Controller(normalized)
  class GraphQLController {
    constructor(private readonly graphqlService: GraphQLService) {}

    @Post()
    async handlePost(
      @Req() req: Request,
      @Res() res: ResponseContext,
    ): Promise<Response> {
      return this.graphqlService.handleHttpRequest(req, res);
    }

    @Get()
    async handleGet(
      @Req() req: Request,
      @Res() res: ResponseContext,
    ): Promise<Response> {
      return this.graphqlService.handleHttpRequest(req, res);
    }
  }

  return GraphQLController;
}

const SHARED_PROVIDERS: Provider[] = [
  FileSystemHelper,
  GraphQLTypesLoader,
  GraphQLAstExplorer,
  GraphQLDefinitionsFactory,
  GraphQLSchemaFactory,
  GraphQLFactory,
  GraphQLFederationFactory,
  ResolverDecoratorHost,
  GraphQLService,
  GraphQLSchemaHost,
  {
    provide: GRAPHQL_SCHEMA_TOKEN,
    scope: Scope.TRANSIENT,
    inject: [GraphQLService],
    useFactory: (service: GraphQLService) => service.ensureSchema(),
  },
];

const SHARED_EXPORTS = [
  GraphQLService,
  GraphQLSchemaHost,
  GRAPHQL_SCHEMA_TOKEN,
  GraphQLSchemaFactory,
  GraphQLTypesLoader,
  GraphQLAstExplorer,
  GraphQLDefinitionsFactory,
  GraphQLFactory,
  GraphQLFederationFactory,
  ResolverDecoratorHost,
];

/**
 * Bunest GraphQL module integrating official `graphql-js` with Bunest DI,
 * HTTP transport (`POST`/`GET <path>`), GraphiQL UI, SSE & `graphql-ws` subscriptions,
 * `FieldMiddleware`, and NestJS `@nestjs/graphql` driver/lifecycle parity.
 */
@Module({})
export class GraphQLModule<
  TAdapter extends AbstractGraphQLDriver = AbstractGraphQLDriver,
> implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown
{
  public completeOptions: GqlModuleOptions | undefined;
  private stopPromise?: Promise<void>;

  constructor(
    @Optional()
    @Inject(GRAPHQL_MODULE_OPTIONS)
    private readonly options?: GqlModuleOptions,
    @Optional()
    private readonly _graphQlAdapter?: AbstractGraphQLDriver,
  ) {
    this.completeOptions = options;
  }

  get graphQlAdapter(): TAdapter {
    return this._graphQlAdapter as TAdapter;
  }

  async onModuleInit(): Promise<void> {
    if (this._graphQlAdapter && this.options) {
      this.completeOptions = await this._graphQlAdapter.mergeDefaultOptions(
        this.options,
      );
      await this._graphQlAdapter.start(this.completeOptions);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.options?.stopOnApplicationShutdown) {
      await this.stop();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  private async stop(): Promise<void> {
    if (!this._graphQlAdapter) {
      return;
    }
    if (!this.stopPromise) {
      this.stopPromise = this._graphQlAdapter.stop();
    }
    await this.stopPromise;
  }

  static forRoot<TOptions extends Record<string, any> = GraphQLModuleOptions>(
    options: TOptions = {} as TOptions,
  ): DynamicModule {
    const opts = options as GraphQLModuleOptions;
    const controller = createGraphQLController(opts.path ?? "/graphql");
    const driverProviders: Provider[] = opts.driver
      ? [
          opts.driver,
          {
            provide: AbstractGraphQLDriver,
            useExisting: opts.driver,
          },
        ]
      : [];

    return {
      module: GraphQLModule,
      global: opts.global ?? true,
      controllers: [controller],
      providers: [
        {
          provide: GRAPHQL_MODULE_OPTIONS,
          useValue: opts,
        },
        ...driverProviders,
        ...SHARED_PROVIDERS,
      ],
      exports: SHARED_EXPORTS,
    };
  }

  static forRootAsync<
    TOptions extends Record<string, any> = GraphQLModuleOptions,
  >(
    options: GraphQLModuleAsyncOptions<TOptions, GqlOptionsFactory<TOptions>> &
      GqlModuleAsyncOptions<TOptions, GqlOptionsFactory<TOptions>>,
  ): DynamicModule {
    const controller = createGraphQLController(options.path ?? "/graphql");
    const asyncProviders = GraphQLModule.createAsyncProviders(options);
    const driverProviders: Provider[] = options.driver
      ? [
          options.driver,
          {
            provide: AbstractGraphQLDriver,
            useExisting: options.driver,
          },
        ]
      : [];

    return {
      module: GraphQLModule,
      global: options.global ?? true,
      imports: options.imports ?? [],
      controllers: [controller],
      providers: [...asyncProviders, ...driverProviders, ...SHARED_PROVIDERS],
      exports: SHARED_EXPORTS,
    };
  }

  private static createAsyncProviders<TOptions extends Record<string, any>>(
    options: GraphQLModuleAsyncOptions<TOptions, GqlOptionsFactory<TOptions>>,
  ): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [GraphQLModule.createAsyncOptionsProvider(options)];
    }
    if (options.useClass) {
      return [
        GraphQLModule.createAsyncOptionsProvider(options),
        {
          provide: options.useClass,
          useClass: options.useClass,
        },
      ];
    }
    throw new Error(
      "GraphQLModule.forRootAsync() requires one of `useFactory`, `useClass`, or `useExisting`.",
    );
  }

  private static createAsyncOptionsProvider<
    TOptions extends Record<string, any>,
  >(
    options: GraphQLModuleAsyncOptions<TOptions, GqlOptionsFactory<TOptions>>,
  ): Provider {
    if (options.useFactory) {
      return {
        provide: GRAPHQL_MODULE_OPTIONS,
        inject: options.inject ?? [],
        useFactory: async (...args: any[]) => {
          const resolved = await options.useFactory!(...args);
          return options.driver
            ? { ...resolved, driver: options.driver }
            : resolved;
        },
      };
    }

    const injectToken = options.useExisting ?? options.useClass;
    if (!injectToken) {
      throw new Error(
        "GraphQLModule.forRootAsync() requires one of `useFactory`, `useClass`, or `useExisting`.",
      );
    }

    return {
      provide: GRAPHQL_MODULE_OPTIONS,
      inject: [injectToken],
      useFactory: async (optionsFactory: GqlOptionsFactory<TOptions>) => {
        const resolved = await optionsFactory.createGqlOptions();
        return options.driver
          ? { ...resolved, driver: options.driver }
          : resolved;
      },
    };
  }
}
