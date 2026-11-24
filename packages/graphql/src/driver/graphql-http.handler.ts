import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  ApplicationConfig,
  type BunestInterceptor,
  type CanActivate,
  type ContextId,
  ContextIdFactory,
  type ExceptionFilter,
  type ExceptionFilterLike,
  type GuardLike,
  HttpAdapterHost,
  HttpException,
  Inject,
  Injectable,
  type InterceptorLike,
  Logger,
  type LoggerService,
  METADATA_KEYS,
  MetadataRegistry,
  ModulesContainer,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  Optional,
  type PipeLike,
  type PipeTransform,
  type ResponseContext,
  type Type,
} from "@bunest/core";
import { DiscoveryService, MetadataScanner, ModuleRef } from "@bunest/core";
import {
  type BunHttpAdapter,
  normalizePath,
  sanitizeObject,
} from "@bunest/core/http";
import {
  type DocumentNode,
  execute,
  type ExecutionResult,
  getOperationAST,
  type GraphQLError,
  type GraphQLFormattedError,
  type GraphQLSchema,
  NoSchemaIntrospectionCustomRule,
  parse,
  printSchema,
  specifiedRules,
  subscribe,
  validate,
  type ValidationRule,
} from "../engine";
import { GRAPHQL_METADATA_KEYS, GRAPHQL_MODULE_OPTIONS } from "../constants";
import {
  getResolverFields,
  getResolverOperations,
} from "../decorators/resolver.decorators";
import type {
  GraphQLModuleOptions,
  GraphQLRequestPayload,
  GraphQLWsOptions,
} from "../interfaces/graphql.interface";
import { FileSystemHelper } from "../schema/file-system.helper";
import { GraphQLDefinitionsFactory } from "../schema/graphql-definitions.factory";
import {
  createRequestScopedResolverProxy,
  createScopedEnhancer,
  getGraphQLContextId,
  GraphQLSchemaFactory,
  type ScopedGqlEnhancer,
  setGraphQLContextId,
} from "../schema/graphql-schema.factory";
import { createDepthLimitRule } from "../security/validation-rules";
import { ResolverDecoratorHost } from "../services/resolver-decorator-host";
import { GraphQLWsHandler } from "../subscriptions/graphql-ws.handler";
import { renderGraphiqlHtml } from "./graphiql-ui";

const textEncoder = new TextEncoder();

function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAsyncIterable(
  value: unknown,
): value is AsyncIterable<ExecutionResult> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
      "function"
  );
}

function resolveWsOptionsFromModule(
  options: GraphQLModuleOptions,
): GraphQLWsOptions | undefined {
  const subs = options.subscriptions;
  if (subs === false) return undefined;
  if (subs && typeof subs === "object") {
    const raw = subs["graphql-ws"] ?? subs.ws;
    if (raw === false) return undefined;
    if (raw && typeof raw === "object") {
      return raw;
    }
    if (raw === true) {
      return {};
    }
  }
  return undefined;
}

function isSseSubscriptionsEnabled(options: GraphQLModuleOptions): boolean {
  const subs = options.subscriptions;
  if (subs === false) return false;
  if (subs && typeof subs === "object") {
    return subs.sse !== false;
  }
  return true;
}

/**
 * Core GraphQL execution service managing schema compilation, validation
 * (`maxDepth`, `introspection`), error formatting (production stack hiding),
 * HTTP query/mutation handling, GraphiQL UI, SSE subscriptions, and
 * `graphql-transport-ws` WebSocket subscriptions.
 */
@Injectable()
export class GraphQLService
  implements OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown
{
  private readonly options: GraphQLModuleOptions;
  private readonly logger: LoggerService;
  private schema?: GraphQLSchema;
  private schemaPromise?: Promise<GraphQLSchema>;
  private wsHandler?: GraphQLWsHandler;

  constructor(
    @Optional()
    @Inject(GRAPHQL_MODULE_OPTIONS)
    options: GraphQLModuleOptions = {},
    @Optional()
    private readonly moduleRef?: ModuleRef,
    @Optional()
    private readonly discoveryService?: DiscoveryService,
    @Optional()
    private readonly metadataScanner?: MetadataScanner,
    @Optional()
    private readonly resolverDecoratorHost?: ResolverDecoratorHost,
  ) {
    this.options = options;
    this.logger = new Logger("GraphQLService");
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureSchema();

    const wsConfig = resolveWsOptionsFromModule(this.options);
    if (wsConfig !== undefined) {
      if (wsConfig.server && wsConfig.server.options?.noServer !== true) {
        throw new Error(
          'Custom WebSocketServer passed to "graphql-ws" must be instantiated with "noServer: true".',
        );
      }
      let adapter: BunHttpAdapter | undefined = this.options.httpAdapter;
      if (!adapter && this.moduleRef) {
        try {
          const host = this.moduleRef.get(HttpAdapterHost, { strict: false });
          adapter = host?.httpAdapter as BunHttpAdapter | undefined;
        } catch {
          // HttpAdapterHost not registered
        }
      }
      if (adapter) {
        const mergedWsConfig: GraphQLWsOptions = {
          ...wsConfig,
          context:
            wsConfig.context ??
            (this.options.context
              ? async (connCtx) => {
                  const raw =
                    typeof this.options.context === "function"
                      ? await this.options.context({
                          req: connCtx.request,
                        })
                      : this.options.context;
                  return raw && typeof raw === "object"
                    ? (raw as Record<string, unknown>)
                    : {};
                }
              : undefined),
        };
        this.attachWebSocket(adapter, mergedWsConfig);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.options.stopOnApplicationShutdown) {
      await this.stopWebSocket();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stopWebSocket();
  }

  private async stopWebSocket(): Promise<void> {
    if (this.wsHandler) {
      const handler = this.wsHandler;
      this.wsHandler = undefined;
      await handler.closeAll();
    }
  }

  /**
   * Attaches a `graphql-transport-ws` WebSocket handler onto a `BunestApplication`
   * or `BunHttpAdapter` so real-time GraphQL subscriptions run natively on `Bun.serve({ websocket })`.
   */
  attachWebSocket(
    appOrAdapter: BunHttpAdapter | { getHttpAdapter(): BunHttpAdapter },
    wsOptions?: GraphQLWsOptions,
  ): GraphQLWsHandler {
    const adapter =
      "getHttpAdapter" in appOrAdapter &&
      typeof appOrAdapter.getHttpAdapter === "function"
        ? appOrAdapter.getHttpAdapter()
        : (appOrAdapter as BunHttpAdapter);

    const moduleWsOpts = resolveWsOptionsFromModule(this.options) ?? {};
    const merged: GraphQLWsOptions = {
      ...moduleWsOpts,
      ...wsOptions,
    };

    const handler = new GraphQLWsHandler(this, merged);
    handler.attachToHttpAdapter(adapter, merged.path ?? this.getPath());
    this.wsHandler = handler;
    return handler;
  }

  getWebSocketHandler(): GraphQLWsHandler | undefined {
    return this.wsHandler;
  }

  getPath(): string {
    return normalizePath(this.options.path ?? "/graphql");
  }

  async ensureSchema(): Promise<GraphQLSchema> {
    if (this.schema) {
      return this.schema;
    }
    if (!this.schemaPromise) {
      this.schemaPromise = this.buildSchema();
    }
    this.schema = await this.schemaPromise;
    return this.schema;
  }

  getSchema(): GraphQLSchema {
    if (!this.schema) {
      throw new Error(
        "GraphQL schema has not been initialized yet. Call await app.init() or await graphqlService.ensureSchema() first.",
      );
    }
    return this.schema;
  }

  printSDL(): string {
    return printSchema(this.getSchema());
  }

  private async buildSchema(): Promise<GraphQLSchema> {
    const resolverInstances: object[] = [];
    const seen = new Set<object>();
    const seenScopedTokens = new Set<unknown>();
    const scopedEnhancerClasses = new Set<Function>();

    const globalFilters: (
      | ExceptionFilterLike
      | ScopedGqlEnhancer<ExceptionFilter>
    )[] = [];
    const globalPipes: (PipeLike | ScopedGqlEnhancer<PipeTransform>)[] = [];
    const globalGuards: (GuardLike | ScopedGqlEnhancer<CanActivate>)[] = [];
    const globalInterceptors: (
      | InterceptorLike
      | ScopedGqlEnhancer<BunestInterceptor>
    )[] = [];
    const scopedGlobalEnhancerNames: string[] = [];
    const nonEntryResolverWrappers: Array<{
      ctor: Function;
      token: unknown;
      moduleId: string;
    }> = [];

    if (this.discoveryService) {
      const discoveryOpts =
        this.options.include && this.options.include.length > 0
          ? { include: this.options.include as Type<unknown>[] }
          : undefined;

      // Map (moduleId, token) -> { kind, moduleName } from ModuleNode.providers
      const providerKindMap = new Map<
        string,
        Map<unknown, { kind: string; moduleName: string }>
      >();
      for (const mod of this.discoveryService.getModules()) {
        const modMap = new Map<unknown, { kind: string; moduleName: string }>();
        const modName = mod.metatype?.name ?? mod.id;
        for (const provider of mod.providers.values()) {
          modMap.set(provider.token, {
            kind: provider.kind,
            moduleName: modName,
          });
        }
        providerKindMap.set(mod.id, modMap);
      }

      const wrappers = [
        ...this.discoveryService.getProviders(discoveryOpts),
        ...this.discoveryService.getControllers(discoveryOpts),
      ];
      for (const wrapper of wrappers) {
        if (!wrapper.isDependencyTreeStatic && typeof wrapper.metatype === "function") {
          scopedEnhancerClasses.add(wrapper.metatype);
        }

        // Collect request-scoped APP_* global enhancers
        if (!wrapper.isDependencyTreeStatic) {
          const resolveToken =
            typeof wrapper.metatype === "function"
              ? (wrapper.metatype as Type<unknown>)
              : undefined;
          if (wrapper.token === APP_GUARD) {
            scopedGlobalEnhancerNames.push(resolveToken?.name ?? "APP_GUARD");
            globalGuards.push(
              createScopedEnhancer<CanActivate>(
                (ctxId) =>
                  wrapper.moduleRef.resolve(wrapper.token, ctxId, {
                    strict: false,
                  }) as Promise<CanActivate>,
                resolveToken,
              ),
            );
            continue;
          }
          if (wrapper.token === APP_INTERCEPTOR) {
            scopedGlobalEnhancerNames.push(
              resolveToken?.name ?? "APP_INTERCEPTOR",
            );
            globalInterceptors.push(
              createScopedEnhancer<BunestInterceptor>(
                (ctxId) =>
                  wrapper.moduleRef.resolve(wrapper.token, ctxId, {
                    strict: false,
                  }) as Promise<BunestInterceptor>,
                resolveToken,
              ),
            );
            continue;
          }
          if (wrapper.token === APP_PIPE) {
            scopedGlobalEnhancerNames.push(resolveToken?.name ?? "APP_PIPE");
            globalPipes.push(
              createScopedEnhancer<PipeTransform>(
                (ctxId) =>
                  wrapper.moduleRef.resolve(wrapper.token, ctxId, {
                    strict: false,
                  }) as Promise<PipeTransform>,
                resolveToken,
              ),
            );
            continue;
          }
          if (wrapper.token === APP_FILTER) {
            scopedGlobalEnhancerNames.push(resolveToken?.name ?? "APP_FILTER");
            globalFilters.push(
              createScopedEnhancer<ExceptionFilter>(
                (ctxId) =>
                  wrapper.moduleRef.resolve(wrapper.token, ctxId, {
                    strict: false,
                  }) as Promise<ExceptionFilter>,
                resolveToken,
              ),
            );
            continue;
          }
        }

        const instance = wrapper.instance;
        if (
          instance &&
          typeof instance === "object" &&
          wrapper.isDependencyTreeStatic
        ) {
          if (seen.has(instance)) {
            continue;
          }
          const ctor = (instance as { constructor?: Function }).constructor;
          if (
            typeof ctor === "function" &&
            (MetadataRegistry.has(GRAPHQL_METADATA_KEYS.RESOLVER, ctor) ||
              MetadataRegistry.has(GRAPHQL_METADATA_KEYS.SCALAR, ctor))
          ) {
            seen.add(instance);
            const pInfo = providerKindMap
              .get(wrapper.moduleId)
              ?.get(wrapper.token);
            if (
              MetadataRegistry.has(GRAPHQL_METADATA_KEYS.RESOLVER, ctor) &&
              (pInfo?.kind === "factory" || pInfo?.kind === "value")
            ) {
              nonEntryResolverWrappers.push({
                ctor,
                token: wrapper.token,
                moduleId: pInfo.moduleName,
              });
            }
            if (this.metadataScanner) {
              this.metadataScanner.getAllMethodNames(ctor.prototype as object);
            }
            resolverInstances.push(instance);
          }
        } else if (typeof wrapper.metatype === "function") {
          const ctor = wrapper.metatype;
          if (
            !seenScopedTokens.has(wrapper.token) &&
            (MetadataRegistry.has(GRAPHQL_METADATA_KEYS.RESOLVER, ctor) ||
              MetadataRegistry.has(GRAPHQL_METADATA_KEYS.SCALAR, ctor))
          ) {
            seenScopedTokens.add(wrapper.token);
            if (this.metadataScanner) {
              this.metadataScanner.getAllMethodNames(ctor.prototype as object);
            }
            const proxy = createRequestScopedResolverProxy(
              ctor as Type<unknown>,
              async (contextId: ContextId) =>
                (await wrapper.moduleRef.resolve(wrapper.token, contextId, {
                  strict: false,
                })) as object,
            );
            resolverInstances.push(proxy);
          }
        }
      }

      // Validate non-entry (useFactory / useValue) resolvers against class-referenced and request-scoped global enhancers
      if (nonEntryResolverWrappers.length > 0) {
        let modulesContainer: ModulesContainer | undefined;
        if (this.moduleRef) {
          try {
            modulesContainer = this.moduleRef.get(ModulesContainer, {
              strict: false,
            });
          } catch {
            // ModulesContainer not available
          }
        }
        const enhancerMetaKeys = [
          METADATA_KEYS.GUARDS,
          METADATA_KEYS.INTERCEPTORS,
          METADATA_KEYS.PIPES,
          METADATA_KEYS.EXCEPTION_FILTERS,
        ];
        for (const entry of nonEntryResolverWrappers) {
          const tokenName =
            typeof entry.token === "function"
              ? entry.token.name
              : String(entry.token);
          const handlerKeys = [
            ...getResolverOperations(
              entry.ctor,
              GRAPHQL_METADATA_KEYS.QUERIES,
            ).map((o) => o.handlerKey),
            ...getResolverOperations(
              entry.ctor,
              GRAPHQL_METADATA_KEYS.MUTATIONS,
            ).map((o) => o.handlerKey),
            ...getResolverOperations(
              entry.ctor,
              GRAPHQL_METADATA_KEYS.SUBSCRIPTIONS,
            ).map((o) => o.handlerKey),
            ...getResolverFields(entry.ctor).map((rf) => rf.handlerKey),
          ];

          for (const handlerKey of handlerKeys) {
            const handlerFn = (
              entry.ctor.prototype as Record<string | symbol, unknown>
            )[handlerKey];
            for (const metaKey of enhancerMetaKeys) {
              const classEnhancers = MetadataRegistry.getMergedClassArray<unknown>(
                metaKey,
                entry.ctor,
              );
              const methodEnhancers =
                typeof handlerFn === "function"
                  ? (MetadataRegistry.get<readonly unknown[]>(
                      metaKey,
                      handlerFn,
                    ) ?? [])
                  : [];
              for (const enh of [...classEnhancers, ...methodEnhancers]) {
                if (typeof enh === "function") {
                  throw new Error(
                    `The "${entry.ctor.name}.${String(handlerKey)}" GraphQL handler of the "${tokenName}" provider references "${enh.name}" by class, but Nest did not register this enhancer for the provider, so it would never run.`,
                  );
                }
              }
            }
          }

          if (scopedGlobalEnhancerNames.length === 0 && this.moduleRef) {
            try {
              const appCfg = this.moduleRef.get(ApplicationConfig, {
                strict: false,
              }) as
                | {
                    getGlobalRequestGuards?: () => readonly { metatype?: Function }[];
                    getGlobalRequestInterceptors?: () => readonly { metatype?: Function }[];
                    getGlobalRequestPipes?: () => readonly { metatype?: Function }[];
                    getGlobalRequestFilters?: () => readonly { metatype?: Function }[];
                  }
                | undefined;
              const reqEnhancers = [
                ...(appCfg?.getGlobalRequestGuards?.() ?? []),
                ...(appCfg?.getGlobalRequestInterceptors?.() ?? []),
                ...(appCfg?.getGlobalRequestPipes?.() ?? []),
                ...(appCfg?.getGlobalRequestFilters?.() ?? []),
              ];
              for (const reqEnh of reqEnhancers) {
                const name =
                  typeof reqEnh === "function"
                    ? (reqEnh as Function).name
                    : reqEnh?.metatype?.name;
                if (name) scopedGlobalEnhancerNames.push(name);
              }
            } catch {
              // Ignore if ApplicationConfig unavailable
            }
          }

          if (scopedGlobalEnhancerNames.length > 0 && handlerKeys.length > 0) {
            const modNode = modulesContainer?.get(entry.moduleId);
            const moduleName =
              modNode?.metatype?.name ?? entry.moduleId ?? "UnknownModule";
            throw new Error(
              `The "${tokenName}" provider of the "${moduleName}" module hosts GraphQL handlers but is not an entry provider, so the request or transient-scoped global enhancer "${scopedGlobalEnhancerNames[0]}" would not run for them.`,
            );
          }
        }
      }
    }

    if (this.moduleRef) {
      try {
        const appConfig = this.moduleRef.get(ApplicationConfig, {
          strict: false,
        });
        if (appConfig) {
          globalPipes.push(...appConfig.getGlobalPipes());
          globalGuards.push(...appConfig.getGlobalGuards());
          globalInterceptors.push(...appConfig.getGlobalInterceptors());
          globalFilters.push(...appConfig.getGlobalFilters());
        }
      } catch {
        // ApplicationConfig not registered (standalone testing module)
      }
      try {
        const diFilters = this.moduleRef.get<
          ExceptionFilterLike,
          ExceptionFilterLike
        >(APP_FILTER, { strict: false, each: true });
        if (Array.isArray(diFilters)) {
          globalFilters.push(...diFilters);
        }
      } catch {
        // No static APP_FILTER multi-providers registered
      }
      try {
        const diPipes = this.moduleRef.get<PipeLike, PipeLike>(APP_PIPE, {
          strict: false,
          each: true,
        });
        if (Array.isArray(diPipes)) {
          globalPipes.push(...diPipes);
        }
      } catch {
        // No static APP_PIPE multi-providers registered
      }
      try {
        const diGuards = this.moduleRef.get<GuardLike, GuardLike>(APP_GUARD, {
          strict: false,
          each: true,
        });
        if (Array.isArray(diGuards)) {
          globalGuards.push(...diGuards);
        }
      } catch {
        // No static APP_GUARD multi-providers registered
      }
      try {
        const diInterceptors = this.moduleRef.get<
          InterceptorLike,
          InterceptorLike
        >(APP_INTERCEPTOR, { strict: false, each: true });
        if (Array.isArray(diInterceptors)) {
          globalInterceptors.push(...diInterceptors);
        }
      } catch {
        // No static APP_INTERCEPTOR multi-providers registered
      }
    }

    const moduleRef = this.moduleRef;
    let fsHelper: FileSystemHelper | undefined;
    if (moduleRef) {
      try {
        fsHelper = moduleRef.get(FileSystemHelper, { strict: false });
      } catch {
        // Fallback to default FileSystemHelper
      }
    }
    const factory = new GraphQLSchemaFactory(
      async <T>(enhancer: Type<T> | T): Promise<T> => {
        if (typeof enhancer !== "function") {
          return enhancer;
        }
        const cls = enhancer as Type<T>;
        if (moduleRef) {
          try {
            return moduleRef.get(cls, { strict: false });
          } catch {
            return await moduleRef.create(cls);
          }
        }
        return new cls();
      },
      [],
      {
        pipes: globalPipes,
        guards: globalGuards,
        interceptors: globalInterceptors,
        filters: globalFilters,
        isRequestScopedEnhancer: (enhancer) =>
          typeof enhancer === "function" && scopedEnhancerClasses.has(enhancer),
        resolveScopedEnhancer: async <T>(
          enhancer: Type<T> | T,
          contextId: ContextId,
        ): Promise<T> => {
          if (typeof enhancer !== "function") {
            return enhancer;
          }
          const cls = enhancer as Type<T>;
          if (moduleRef) {
            return await moduleRef.resolve(cls, contextId, { strict: false });
          }
          return new cls();
        },
        ensureContextId: (ctx) => {
          let id = getGraphQLContextId(ctx);
          if (!id) {
            id = ContextIdFactory.create();
            setGraphQLContextId(ctx, id);
            moduleRef?.registerRequestByContextId(ctx, id);
          }
          return id;
        },
      },
      fsHelper,
    );

    const builtSchema = await factory.create(resolverInstances, this.options);

    if (this.options.definitions?.path) {
      const {
        path: outputPath,
        outputAs = "interface",
        ...genOpts
      } = this.options.definitions;
      const defsFactory = new GraphQLDefinitionsFactory();
      await defsFactory.generate({
        ...genOpts,
        typePaths: this.options.typePaths ?? [],
        path: outputPath,
        outputAs,
        typeDefs: printSchema(builtSchema),
      });
    }

    return builtSchema;
  }

  private getValidationRules(): ValidationRule[] {
    const rules: ValidationRule[] = [...specifiedRules];
    const introspectionEnabled =
      this.options.introspection ?? !isProductionEnv();
    if (!introspectionEnabled) {
      rules.push(NoSchemaIntrospectionCustomRule);
    }
    if (this.options.maxDepth !== undefined && this.options.maxDepth > 0) {
      rules.push(createDepthLimitRule(this.options.maxDepth));
    }
    if (Array.isArray(this.options.validationRules)) {
      rules.push(...(this.options.validationRules as ValidationRule[]));
    }
    return rules;
  }

  private formatSingleError(err: GraphQLError): GraphQLFormattedError {
    const isProd = isProductionEnv();
    const includeStack =
      this.options.includeStacktraceInErrorResponses ?? !isProd;
    const original = err.originalError;
    const preserveHttp200 =
      this.options.preserveHttpStatusForExecutionErrors !== false;

    let formatted: GraphQLFormattedError = err.toJSON();

    const HTTP_STATUS_TO_GQL_CODE: Record<number, string> = {
      400: "BAD_REQUEST",
      401: "UNAUTHENTICATED",
      403: "FORBIDDEN",
      408: "REQUEST_TIMEOUT",
      413: "PAYLOAD_TOO_LARGE",
      415: "UNSUPPORTED_MEDIA_TYPE",
      422: "UNPROCESSABLE_ENTITY",
      429: "TOO_MANY_REQUESTS",
      501: "NOT_IMPLEMENTED",
      502: "BAD_GATEWAY",
      503: "SERVICE_UNAVAILABLE",
      504: "GATEWAY_TIMEOUT",
    };

    if (
      original instanceof HttpException &&
      this.options.autoTransformHttpErrors !== false
    ) {
      const httpJson = original.toJSON();
      const status = original.getStatus();
      const rawResponse = original.getResponse();
      const mappedCode = HTTP_STATUS_TO_GQL_CODE[status];
      const ext: Record<string, unknown> = {
        ...(formatted.extensions ?? {}),
        code: mappedCode ?? "INTERNAL_SERVER_ERROR",
        ...(mappedCode ? {} : { status }),
        originalError: rawResponse,
        ...(httpJson.details !== undefined
          ? { details: httpJson.details }
          : {}),
      };
      formatted = {
        ...formatted,
        message: Array.isArray(httpJson.message)
          ? httpJson.message.join("; ")
          : httpJson.message,
        extensions: ext,
      };
    } else if (original !== undefined && original !== null) {
      // Unexpected resolver error
      if (isProd && !includeStack) {
        formatted = {
          message: "Internal server error",
          ...(formatted.locations ? { locations: formatted.locations } : {}),
          ...(formatted.path ? { path: formatted.path } : {}),
          extensions: {
            code: "INTERNAL_SERVER_ERROR",
          },
        };
      } else {
        const stack =
          includeStack && original instanceof Error && original.stack
            ? original.stack.split("\n")
            : undefined;
        formatted = {
          ...formatted,
          extensions: {
            ...(formatted.extensions ?? {}),
            code:
              (formatted.extensions?.code as string | undefined) ??
              "INTERNAL_SERVER_ERROR",
            ...(stack ? { stacktrace: stack } : {}),
          },
        };
      }
    } else if (isProd && !includeStack && formatted.extensions) {
      const cleaned = { ...formatted.extensions };
      delete cleaned.stacktrace;
      delete cleaned.stack;
      formatted = { ...formatted, extensions: cleaned };
    }

    if (preserveHttp200 && formatted.extensions && "http" in formatted.extensions) {
      const cleaned = { ...formatted.extensions };
      delete cleaned.http;
      formatted = { ...formatted, extensions: cleaned };
    }

    if (this.options.formatError) {
      return this.options.formatError(formatted, original ?? err);
    }
    return formatted;
  }

  private formatExecutionResult(result: ExecutionResult): {
    data?: Record<string, unknown> | null;
    errors?: readonly GraphQLFormattedError[];
  } {
    const out: {
      data?: Record<string, unknown> | null;
      errors?: readonly GraphQLFormattedError[];
    } = {};

    if (result.data !== undefined) {
      out.data = result.data as Record<string, unknown> | null;
    }

    if (result.errors && result.errors.length > 0) {
      out.errors = result.errors.map((err) => this.formatSingleError(err));
    }

    return out;
  }

  /**
   * Programmatically parses, validates (with `introspection` and `maxDepth`),
   * and executes a GraphQL query or mutation.
   */
  async executeQuery(params: {
    query: string;
    variables?: Record<string, unknown> | null;
    operationName?: string | null;
    contextValue?: Record<string, unknown>;
  }): Promise<{
    status: number;
    result: {
      data?: Record<string, unknown> | null;
      errors?: readonly GraphQLFormattedError[];
    };
  }> {
    const schema = await this.ensureSchema();
    const sanitizedVars =
      params.variables && isPlainRecord(params.variables)
        ? sanitizeObject(params.variables)
        : undefined;

    const hasHooks = this.resolverDecoratorHost?.hasRequestHooks() ?? false;
    const hookBaseCtx = hasHooks
      ? {
          query: params.query,
          operationName: params.operationName ?? undefined,
          variables: sanitizedVars,
          context: params.contextValue ?? {},
        }
      : undefined;

    let hookState: unknown;
    if (hasHooks && hookBaseCtx && this.resolverDecoratorHost) {
      try {
        hookState = await this.resolverDecoratorHost.onRequestStart(hookBaseCtx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.resolverDecoratorHost.onRequestEnd({
          ...hookBaseCtx,
          state: undefined,
          errors: [err as GraphQLError],
        });
        return {
          status: 200,
          result: { errors: [{ message }] },
        };
      }
    }

    let document: DocumentNode;
    try {
      document = parse(params.query);
    } catch (err) {
      const formatted = this.formatSingleError(err as GraphQLError);
      if (hasHooks && hookBaseCtx && this.resolverDecoratorHost) {
        await this.resolverDecoratorHost.onRequestEnd({
          ...hookBaseCtx,
          state: hookState,
          errors: [err as GraphQLError],
        });
      }
      return {
        status: 400,
        result: {
          errors: [formatted],
        },
      };
    }

    const validationErrors = validate(
      schema,
      document,
      this.getValidationRules(),
    );
    if (validationErrors.length > 0) {
      const formattedErrors = validationErrors.map((e) =>
        this.formatSingleError(e),
      );
      if (hasHooks && hookBaseCtx && this.resolverDecoratorHost) {
        await this.resolverDecoratorHost.onRequestEnd({
          ...hookBaseCtx,
          state: hookState,
          errors: validationErrors,
        });
      }
      return {
        status: 400,
        result: {
          errors: formattedErrors,
        },
      };
    }

    if (
      params.variables !== undefined &&
      params.variables !== null &&
      !isPlainRecord(params.variables)
    ) {
      return {
        status: 400,
        result: {
          errors: [{ message: "GraphQL variables must be a JSON object." }],
        },
      };
    }

    if (
      params.operationName !== undefined &&
      params.operationName !== null &&
      typeof params.operationName !== "string"
    ) {
      return {
        status: 400,
        result: {
          errors: [{ message: "GraphQL operationName must be a string." }],
        },
      };
    }

    const execResult = await execute({
      schema,
      document,
      variableValues: sanitizedVars,
      operationName: params.operationName ?? undefined,
      contextValue: params.contextValue ?? {},
    });

    if (hasHooks && hookBaseCtx) {
      await this.resolverDecoratorHost!.onRequestEnd({
        ...hookBaseCtx,
        errors: execResult.errors,
        state: hookState,
      });
    }

    const formattedResult = this.formatExecutionResult(execResult);
    let httpStatus = 200;
    if (
      this.options.preserveHttpStatusForExecutionErrors === false &&
      execResult.errors &&
      execResult.errors.length > 0
    ) {
      for (const err of execResult.errors) {
        const httpExt = (
          err.extensions as { http?: { status?: unknown } } | undefined
        )?.http;
        if (
          httpExt &&
          typeof httpExt.status === "number" &&
          httpExt.status >= 100 &&
          httpExt.status < 600
        ) {
          httpStatus = httpExt.status;
          break;
        }
      }
    }

    return {
      status: httpStatus,
      result: formattedResult,
    };
  }

  /**
   * Programmatically subscribes to a GraphQL subscription operation, returning an
   * `AsyncIterableIterator` (or an error result if validation fails) with optional
   * `AbortSignal` teardown.
   */
  async subscribeQuery(params: {
    query: string;
    variables?: Record<string, unknown> | null;
    operationName?: string | null;
    contextValue?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<
    | AsyncIterableIterator<{
        data?: Record<string, unknown> | null;
        errors?: readonly GraphQLFormattedError[];
      }>
    | {
        data?: Record<string, unknown> | null;
        errors?: readonly GraphQLFormattedError[];
      }
  > {
    const schema = await this.ensureSchema();
    let document: DocumentNode;
    try {
      document = parse(params.query);
    } catch (err) {
      return { errors: [this.formatSingleError(err as GraphQLError)] };
    }

    const validationErrors = validate(
      schema,
      document,
      this.getValidationRules(),
    );
    if (validationErrors.length > 0) {
      return {
        errors: validationErrors.map((e) => this.formatSingleError(e)),
      };
    }

    if (
      params.variables !== undefined &&
      params.variables !== null &&
      !isPlainRecord(params.variables)
    ) {
      return {
        errors: [{ message: "GraphQL variables must be a JSON object." }],
      };
    }

    if (
      params.operationName !== undefined &&
      params.operationName !== null &&
      typeof params.operationName !== "string"
    ) {
      return {
        errors: [{ message: "GraphQL operationName must be a string." }],
      };
    }

    const sanitizedVars = params.variables
      ? sanitizeObject(params.variables)
      : undefined;

    const subResult = await subscribe({
      schema,
      document,
      variableValues: sanitizedVars,
      operationName: params.operationName ?? undefined,
      contextValue: params.contextValue ?? {},
    });

    if (!isAsyncIterable(subResult)) {
      return this.formatExecutionResult(subResult);
    }

    const source = subResult[Symbol.asyncIterator]();
    let closed = false;

    const stop = async () => {
      if (closed) return;
      closed = true;
      params.signal?.removeEventListener("abort", onAbort);
      if (typeof source.return === "function") {
        await source.return().catch(() => {});
      }
    };

    const onAbort = () => {
      void stop();
    };

    if (params.signal) {
      if (params.signal.aborted) {
        await stop();
      } else {
        params.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const formattedIterator: AsyncIterableIterator<{
      data?: Record<string, unknown> | null;
      errors?: readonly GraphQLFormattedError[];
    }> = {
      [Symbol.asyncIterator]() {
        return formattedIterator;
      },
      async next() {
        if (closed) {
          return { value: undefined, done: true };
        }
        const step = await source.next();
        if (step.done || closed) {
          await stop();
          return { value: undefined, done: true };
        }
        return {
          value: this.formatResult(step.value),
          done: false,
        };
      },
      async return() {
        await stop();
        return { value: undefined, done: true };
      },
      async throw(err?: unknown) {
        await stop();
        return Promise.reject(err);
      },
      formatResult: (r: ExecutionResult) => this.formatExecutionResult(r),
    } as AsyncIterableIterator<{
      data?: Record<string, unknown> | null;
      errors?: readonly GraphQLFormattedError[];
    }> & {
      formatResult: (r: ExecutionResult) => {
        data?: Record<string, unknown> | null;
        errors?: readonly GraphQLFormattedError[];
      };
    };

    return formattedIterator;
  }

  /**
   * Handles incoming HTTP requests for the GraphQL endpoint (queries, mutations,
   * SSE subscriptions via `Accept: text/event-stream`, and optional GraphiQL HTML).
   */
  async handleHttpRequest(
    req: Request,
    res?: ResponseContext,
  ): Promise<Response> {
    const method = req.method.toUpperCase();
    const accept = req.headers.get("accept") ?? "";
    const wantsSse = accept.includes("text/event-stream");

    if (method === "GET") {
      const url = new URL(req.url);
      const query = url.searchParams.get("query");

      if (!query) {
        const graphiqlConfig =
          this.options.graphiql ??
          this.options.playground ??
          !isProductionEnv();
        if (graphiqlConfig && accept.includes("text/html")) {
          const graphiqlOpts =
            typeof graphiqlConfig === "object" ? graphiqlConfig : undefined;
          const html = renderGraphiqlHtml(
            this.getPath(),
            undefined,
            graphiqlOpts,
          );
          return new Response(html, {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }
        return Response.json(
          { errors: [{ message: "Missing GraphQL query parameter." }] },
          { status: 400 },
        );
      }

      let variables: Record<string, unknown> | undefined;
      const rawVars = url.searchParams.get("variables");
      if (rawVars) {
        let parsedVars: unknown;
        try {
          parsedVars = JSON.parse(rawVars);
        } catch {
          return Response.json(
            { errors: [{ message: "Invalid JSON in variables parameter." }] },
            { status: 400 },
          );
        }
        if (parsedVars !== null) {
          if (!isPlainRecord(parsedVars)) {
            return Response.json(
              {
                errors: [
                  {
                    message:
                      "GraphQL variables parameter must be a JSON object.",
                  },
                ],
              },
              { status: 400 },
            );
          }
          variables = parsedVars;
        }
      }
      const operationName = url.searchParams.get("operationName");

      return this.executeHttpOperation(
        { query, variables, operationName },
        req,
        res,
        wantsSse,
        true,
      );
    }

    if (method === "POST") {
      let parsedBody: unknown;
      try {
        const raw = await req.text();
        parsedBody = raw ? JSON.parse(raw) : {};
      } catch {
        return Response.json(
          { errors: [{ message: "Malformed JSON request body." }] },
          { status: 400 },
        );
      }

      if (!isPlainRecord(parsedBody)) {
        return Response.json(
          {
            errors: [
              { message: "GraphQL request body must be a JSON object." },
            ],
          },
          { status: 400 },
        );
      }

      const rawQuery = parsedBody.query;
      if (typeof rawQuery !== "string" || rawQuery.trim().length === 0) {
        return Response.json(
          {
            errors: [
              {
                message:
                  "GraphQL request body must include a non-empty query string.",
              },
            ],
          },
          { status: 400 },
        );
      }

      const rawVariables = parsedBody.variables;
      if (
        rawVariables !== undefined &&
        rawVariables !== null &&
        !isPlainRecord(rawVariables)
      ) {
        return Response.json(
          { errors: [{ message: "GraphQL variables must be a JSON object." }] },
          { status: 400 },
        );
      }

      const rawOperationName = parsedBody.operationName;
      if (
        rawOperationName !== undefined &&
        rawOperationName !== null &&
        typeof rawOperationName !== "string"
      ) {
        return Response.json(
          { errors: [{ message: "GraphQL operationName must be a string." }] },
          { status: 400 },
        );
      }

      return this.executeHttpOperation(
        {
          query: rawQuery,
          variables:
            rawVariables !== undefined && rawVariables !== null
              ? rawVariables
              : undefined,
          operationName:
            rawOperationName !== undefined && rawOperationName !== null
              ? rawOperationName
              : undefined,
        },
        req,
        res,
        wantsSse,
        false,
      );
    }

    return Response.json(
      { errors: [{ message: `Method ${method} not allowed` }] },
      { status: 405, headers: { Allow: "GET, POST" } },
    );
  }

  private async executeHttpOperation(
    payload: GraphQLRequestPayload,
    req: Request,
    res: ResponseContext | undefined,
    wantsSse: boolean,
    isGetRequest: boolean,
  ): Promise<Response> {
    const rawContext =
      typeof this.options.context === "function"
        ? await this.options.context({ req, res })
        : this.options.context && typeof this.options.context === "object"
          ? this.options.context
          : undefined;
    const contextValue: Record<string, unknown> =
      rawContext && typeof rawContext === "object"
        ? Object.assign(
            Object.create(Object.getPrototypeOf(rawContext) as object | null),
            rawContext,
          )
        : {};
    if (!("req" in contextValue)) {
      contextValue.req = req;
    }
    if (res && !("res" in contextValue)) {
      contextValue.res = res;
    }
    if (this.moduleRef) {
      const contextId = ContextIdFactory.create();
      setGraphQLContextId(contextValue, contextId);
      this.moduleRef.registerRequestByContextId(contextValue, contextId);
    }

    // Parse early to inspect operation kind (mutation over GET / subscription over SSE)
    let doc: DocumentNode;
    try {
      doc = parse(payload.query);
    } catch (err) {
      return Response.json(
        { errors: [this.formatSingleError(err as GraphQLError)] },
        { status: 400 },
      );
    }

    const opAst = getOperationAST(doc, payload.operationName ?? undefined);
    if (isGetRequest && opAst?.operation === "mutation") {
      return Response.json(
        {
          errors: [
            {
              message:
                "Can only perform a mutation operation from a POST request.",
            },
          ],
        },
        { status: 405, headers: { Allow: "POST" } },
      );
    }

    if (opAst?.operation === "subscription") {
      if (!isSseSubscriptionsEnabled(this.options)) {
        return Response.json(
          { errors: [{ message: "GraphQL subscriptions are disabled." }] },
          { status: 400 },
        );
      }
      return this.handleSseSubscription(payload, contextValue, req.signal);
    }

    const { status, result } = await this.executeQuery({
      query: payload.query,
      variables: payload.variables,
      operationName: payload.operationName,
      contextValue,
    });

    if (wantsSse) {
      const sseBody = `event: next\ndata: ${JSON.stringify(result)}\n\nevent: complete\ndata: \n\n`;
      return new Response(sseBody, {
        status,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
      });
    }

    return new Response(JSON.stringify(result), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  private async handleSseSubscription(
    payload: GraphQLRequestPayload,
    contextValue: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Response> {
    const subOrError = await this.subscribeQuery({
      query: payload.query,
      variables: payload.variables,
      operationName: payload.operationName,
      contextValue,
      signal,
    });

    if (!isAsyncIterable(subOrError)) {
      return new Response(JSON.stringify(subOrError), {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    const iterator = subOrError[Symbol.asyncIterator]();
    let closed = false;
    let streamController:
      ReadableStreamDefaultController<Uint8Array> | undefined;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      signal.removeEventListener("abort", onAbort);
      if (typeof iterator.return === "function") {
        void iterator.return().catch(() => {});
      }
    };

    const onAbort = () => {
      cleanup();
      try {
        streamController?.close();
      } catch {
        // Already closed
      }
    };

    const logger = this.logger;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        if (signal.aborted) {
          onAbort();
          return;
        }
        // Flush HTTP 200 SSE headers immediately via standard SSE comment heartbeat
        controller.enqueue(textEncoder.encode(": connected\n\n"));
        signal.addEventListener("abort", onAbort, { once: true });
      },
      async pull(controller) {
        if (closed || signal.aborted) {
          cleanup();
          try {
            controller.close();
          } catch {
            // Already closed
          }
          return;
        }
        try {
          const step = await iterator.next();
          if (step.done || closed || signal.aborted) {
            if (!signal.aborted && !closed) {
              controller.enqueue(
                textEncoder.encode("event: complete\ndata: \n\n"),
              );
            }
            cleanup();
            try {
              controller.close();
            } catch {
              // Already closed
            }
            return;
          }
          const chunk = `event: next\ndata: ${JSON.stringify(step.value)}\n\n`;
          controller.enqueue(textEncoder.encode(chunk));
        } catch (err) {
          logger.error("GraphQL SSE subscription error", err);
          cleanup();
          try {
            controller.close();
          } catch {
            // Already closed
          }
        }
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }
}
