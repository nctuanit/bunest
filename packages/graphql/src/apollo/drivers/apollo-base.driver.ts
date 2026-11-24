import {
  HttpException,
  HttpStatus,
  Optional,
  type ResponseContext,
} from "@bunest/core";
import {
  ApplicationConfig,
  DiscoveryService,
  HttpAdapterHost,
} from "@bunest/core";
import {
  AbstractGraphQLDriver,
  GraphQLFactory,
  GraphQLService,
  ResolverDecoratorHost,
  type GraphQLWsOptions,
  type SubscriptionConfig,
} from "../../index";
import {
  type DocumentNode,
  GraphQLError,
  type GraphQLFormattedError,
  type GraphQLSchema,
  specifiedRules,
  validate,
  type ValidationRule,
} from "../../engine";
import { ApolloServerErrorCode } from "../constants/apollo.constants";
import { GraphiQLPlaygroundPlugin } from "../graphiql/graphiql-playground.plugin";
import type { ApolloDriverConfig } from "../interfaces/apollo-driver-config.interface";
import {
  ApolloServerPluginDrainHttpServer,
  ApolloServerPluginLandingPageDisabled,
} from "../server/apollo-plugins";
import {
  BunestApolloServer,
  unwrapResolverError,
} from "../server/apollo-server";
import type {
  ApolloServerPlugin,
  BaseContext,
  GatewayInterface,
  GraphQLRequestContext,
  GraphQLResponse,
} from "../server/apollo-server.types";
import { HeaderMap } from "../server/header-map";
import { createAsyncIterator } from "../utils/async-iterator.util";

const apolloPredefinedExceptions: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: ApolloServerErrorCode.BAD_REQUEST,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ApolloServerErrorCode.BAD_USER_INPUT,
  [HttpStatus.UNAUTHORIZED]: "UNAUTHENTICATED",
  [HttpStatus.FORBIDDEN]: "FORBIDDEN",
};

function omitKey<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  key: K,
): Omit<T, K> {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

export abstract class ApolloBaseDriver<
  T extends Record<string, any> = ApolloDriverConfig,
> extends AbstractGraphQLDriver<T> {
  protected apolloServer!: BunestApolloServer<BaseContext>;

  constructor(
    @Optional() httpAdapterHost?: HttpAdapterHost,
    @Optional() applicationConfig?: ApplicationConfig,
    @Optional() graphQlFactory?: GraphQLFactory,
    @Optional() resolverDecoratorHost?: ResolverDecoratorHost,
    @Optional() protected readonly graphqlService?: GraphQLService,
    @Optional() protected readonly discoveryService?: DiscoveryService,
  ) {
    super(
      httpAdapterHost,
      applicationConfig,
      graphQlFactory,
      resolverDecoratorHost,
    );
  }

  get instance(): BunestApolloServer<BaseContext> {
    return this.apolloServer;
  }

  override async start(apolloOptions: T): Promise<void> {
    await this.registerBunServer(apolloOptions);
  }

  override async stop(): Promise<void> {
    await this.apolloServer?.stop();
  }

  override async mergeDefaultOptions(options: T): Promise<T> {
    let defaults: Record<string, unknown> = {
      path: "/graphql",
      fieldResolverEnhancers: [],
      stopOnTerminationSignals: false,
    };

    const useGraphiQL =
      options.graphiql ??
      options.playground ??
      process.env.NODE_ENV !== "production";

    if (useGraphiQL) {
      const graphiQlPlaygroundOpts =
        typeof useGraphiQL === "object" ? { ...useGraphiQL } : {};
      graphiQlPlaygroundOpts.url ??= options.path ?? "/graphql";
      defaults = {
        ...defaults,
        plugins: [new GraphiQLPlaygroundPlugin(graphiQlPlaygroundOpts)],
      };
    } else {
      defaults = {
        ...defaults,
        plugins: [ApolloServerPluginLandingPageDisabled()],
      };
    }

    const merged = (await super.mergeDefaultOptions(
      options,
      omitKey(defaults, "plugins"),
    )) as Record<string, unknown>;

    const defaultPlugins = Array.isArray(defaults.plugins)
      ? defaults.plugins
      : [];
    const existingPlugins = Array.isArray(merged.plugins) ? merged.plugins : [];
    merged.plugins = existingPlugins.concat(defaultPlugins);
    this.normalizeSubscriptionsPath(merged);
    this.wrapContextResolver(merged);
    this.wrapFormatErrorFn(merged);

    if (merged.preserveHttpStatusForExecutionErrors !== false) {
      merged.plugins = [
        ...(Array.isArray(merged.plugins) ? merged.plugins : []),
        this.createPreserveHttpStatusPlugin(),
      ];
    }

    merged.plugins = [
      ...(Array.isArray(merged.plugins) ? merged.plugins : []),
      this.createRequestLifecycleHooksPlugin(),
    ];

    return merged as T;
  }

  protected async registerBunServer(
    options: T & { gateway?: GatewayInterface },
    { preStartHook }: { preStartHook?: () => void } = {},
  ): Promise<void> {
    const httpAdapter = this.httpAdapterHost?.httpAdapter as
      | {
          getHttpServer?: () => { stop?: () => unknown; close?: () => unknown };
          all?: (
            path: string,
            handler: (req: Request, res: ResponseContext) => Promise<Response>,
          ) => unknown;
        }
      | undefined;
    const drainPlugin = ApolloServerPluginDrainHttpServer({
      httpServer: httpAdapter?.getHttpServer?.(),
    });

    preStartHook?.();

    const server = new BunestApolloServer<BaseContext>({
      ...options,
      schema: options.schema as GraphQLSchema | undefined,
      gateway: options.gateway,
      context: options.context,
      plugins: [
        ...(options.plugins ?? []),
        drainPlugin,
        this.createRejectSubscriptionsPlugin(),
      ],
    });

    await server.start();
    this.apolloServer = server;

    const effectivePath = this.getNormalizedPath(options);

    // Wire live BunestApolloServer into GraphQLService so GraphQLModule's controller
    // and GraphQLSchemaHost seamlessly use Apollo's execution pipeline & schema.
    if (this.graphqlService) {
      if (server.schema) {
        (this.graphqlService as unknown as { schema?: GraphQLSchema }).schema =
          server.schema;
      }
      this.graphqlService.handleHttpRequest = (
        req: Request,
        res?: ResponseContext,
      ) => server.handleHttpRequest(req, res);
    }

    // Also register imperative HTTP route on the adapter when GraphQLService is absent
    // or mounted at a different path (e.g. ApolloGatewayDriver with custom server.path).
    if (
      httpAdapter &&
      typeof httpAdapter.all === "function" &&
      (!this.graphqlService || this.graphqlService.getPath() !== effectivePath)
    ) {
      httpAdapter.all(effectivePath, (req: Request, res: ResponseContext) =>
        server.handleHttpRequest(req, res),
      );
    }
  }

  private normalizeSubscriptionsPath(options: Record<string, unknown>): void {
    const subscriptions = options.subscriptions;
    if (!subscriptions || typeof subscriptions !== "object") {
      return;
    }
    const normalized: Record<string, unknown> = {
      ...(subscriptions as Record<string, unknown>),
    };
    const config = normalized["graphql-ws"];
    if (
      config &&
      typeof config === "object" &&
      "path" in config &&
      typeof (config as { path?: unknown }).path === "string"
    ) {
      normalized["graphql-ws"] = {
        ...(config as Record<string, unknown>),
        path: this.applyGlobalPrefix(
          (config as { path: string }).path,
          options as T,
        ),
      };
    }
    options.subscriptions = normalized;
  }

  protected getSubscriptionConfig(
    options: ApolloDriverConfig,
  ): SubscriptionConfig {
    const rawSubs = options.subscriptions;
    const subscriptions: SubscriptionConfig =
      rawSubs && typeof rawSubs === "object"
        ? (rawSubs as SubscriptionConfig)
        : { "graphql-ws": {} };

    const config = subscriptions["graphql-ws"];
    if (!config) {
      return subscriptions;
    }

    const graphqlWsConfig: GraphQLWsOptions = config === true ? {} : config;
    return {
      ...subscriptions,
      "graphql-ws": {
        ...graphqlWsConfig,
        ...this.createGraphQLWsValidation(
          options.validationRules,
          graphqlWsConfig,
        ),
        ...this.createGraphQLWsErrorFormatting(
          options.formatError,
          graphqlWsConfig,
        ),
      },
    };
  }

  private createGraphQLWsValidation(
    validationRules: ValidationRule[] | undefined,
    config: GraphQLWsOptions,
  ): Partial<GraphQLWsOptions> {
    if (!validationRules?.length || config.validate) {
      return {};
    }
    const { onSubscribe } = config;
    return {
      validate: (schema: GraphQLSchema, document: DocumentNode) =>
        validate(schema, document, [...specifiedRules, ...validationRules]),
      ...(onSubscribe && {
        onSubscribe: async (...args: any[]) => {
          const result = await onSubscribe(...args);
          if (
            !result ||
            typeof result !== "object" ||
            !("document" in result) ||
            !("schema" in result)
          ) {
            return result;
          }
          const subArgs = result as {
            schema: GraphQLSchema;
            document: DocumentNode;
          };
          const errors = validate(
            subArgs.schema,
            subArgs.document,
            validationRules,
          );
          return errors.length > 0 ? errors : result;
        },
      }),
    };
  }

  private createGraphQLWsErrorFormatting(
    formatError: ApolloDriverConfig["formatError"],
    config: GraphQLWsOptions,
  ): Partial<GraphQLWsOptions> {
    if (!formatError) {
      return {};
    }
    const formatErrors = (
      errors: readonly GraphQLError[],
      getDefaultCode: (err: GraphQLError) => string,
    ): GraphQLFormattedError[] =>
      errors.map((error) => {
        const formattedError = error.toJSON();
        try {
          return formatError(
            {
              ...formattedError,
              extensions: {
                ...formattedError.extensions,
                code:
                  (formattedError.extensions?.code as string | undefined) ??
                  getDefaultCode(error),
              },
            },
            error,
          );
        } catch {
          return {
            message: "Internal server error",
            extensions: {
              code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR,
            },
          };
        }
      });

    const { onNext, onError } = config;
    return {
      onNext: async (
        ctx: unknown,
        id: unknown,
        payload: unknown,
        args: unknown,
        result: unknown,
      ) => {
        const maybeResult = await onNext?.(ctx, id, payload, args, result);
        const resultObj = result as
          | { errors?: readonly GraphQLError[]; [key: string]: unknown }
          | null
          | undefined;
        if (maybeResult || !resultObj?.errors) {
          return maybeResult;
        }
        return {
          ...resultObj,
          errors: formatErrors(
            resultObj.errors,
            () => ApolloServerErrorCode.INTERNAL_SERVER_ERROR,
          ),
        };
      },
      onError: async (
        ctx: unknown,
        id: unknown,
        payload: unknown,
        errors: GraphQLError[],
      ) => {
        const maybeErrors = await onError?.(ctx, id, payload, errors);
        if (maybeErrors) {
          return maybeErrors;
        }
        return formatErrors(errors, (error) =>
          error.originalError
            ? ApolloServerErrorCode.INTERNAL_SERVER_ERROR
            : ApolloServerErrorCode.GRAPHQL_VALIDATION_FAILED,
        );
      },
    };
  }

  override subscriptionWithFilter(
    instanceRef: unknown,
    filterFn: (
      payload: any,
      variables: any,
      context: any,
    ) => boolean | Promise<boolean>,
    createSubscribeContext: Function,
  ): <TPayload, TVariables, TContext, TInfo>(
    ...args: [TPayload, TVariables, TContext, TInfo]
  ) => any {
    return (...args: any[]) =>
      createAsyncIterator(createSubscribeContext()(...args), (payload) =>
        filterFn.call(instanceRef, payload, args[1], args[2]),
      );
  }

  private createRequestLifecycleHooksPlugin(): ApolloServerPlugin<BaseContext> {
    const getHost = () => this.resolverDecoratorHost;
    return {
      async requestDidStart(
        requestContext: GraphQLRequestContext<BaseContext>,
      ) {
        const host = getHost();
        if (!host?.hasRequestHooks()) {
          return;
        }
        const hookContext = {
          query: requestContext.request?.query,
          operationName: requestContext.request?.operationName,
          variables: requestContext.request?.variables,
          context: requestContext.contextValue,
        };
        const state = await host.onRequestStart(hookContext);
        return {
          async willSendResponse(
            endRequestContext: GraphQLRequestContext<BaseContext>,
          ) {
            const body = endRequestContext.response?.body;
            const errors =
              endRequestContext.errors ??
              (body?.kind === "single" ? body.singleResult?.errors : undefined);
            await host.onRequestEnd({
              ...hookContext,
              operationName:
                endRequestContext.operationName ?? hookContext.operationName,
              errors: errors as readonly GraphQLError[] | undefined,
              state,
            });
          },
        };
      },
    };
  }

  private createRejectSubscriptionsPlugin(): ApolloServerPlugin<BaseContext> {
    return {
      async requestDidStart() {
        return {
          async responseForOperation({
            operation,
          }): Promise<GraphQLResponse | null> {
            if (operation?.operation !== "subscription") {
              return null;
            }
            return {
              http: {
                status: HttpStatus.BAD_REQUEST,
                headers: new HeaderMap(),
              },
              body: {
                kind: "single",
                singleResult: {
                  errors: [
                    {
                      message:
                        "Subscription operations are not supported over HTTP. Use a WebSocket connection instead.",
                      extensions: { code: ApolloServerErrorCode.BAD_REQUEST },
                    },
                  ],
                },
              },
            };
          },
        };
      },
    };
  }

  private createPreserveHttpStatusPlugin(): ApolloServerPlugin<BaseContext> {
    return {
      async requestDidStart() {
        return {
          async willSendResponse(requestContext) {
            const body = requestContext.response?.body;
            if (
              body?.kind === "single" &&
              "data" in (body.singleResult ?? {}) &&
              requestContext.response?.http
            ) {
              requestContext.response.http.status = 200;
            }
          },
        };
      },
    };
  }

  private wrapFormatErrorFn(options: Record<string, unknown>): void {
    if (options.autoTransformHttpErrors === false) {
      return;
    }
    const transformHttpErrorFn = this.createTransformHttpErrorFn();
    if (typeof options.formatError === "function") {
      const origFormatError = options.formatError as (
        formattedError: GraphQLFormattedError,
        err: unknown,
      ) => GraphQLFormattedError;
      options.formatError = (
        formattedError: GraphQLFormattedError,
        err: unknown,
      ) => {
        const transformed = transformHttpErrorFn(formattedError, err);
        return origFormatError(transformed, err);
      };
    } else {
      options.formatError = transformHttpErrorFn;
    }
  }

  private createTransformHttpErrorFn(): (
    formattedError: GraphQLFormattedError,
    originalError: unknown,
  ) => GraphQLFormattedError {
    return (formattedError, originalError) => {
      const exceptionRef = unwrapResolverError(originalError);
      if (!(exceptionRef instanceof HttpException)) {
        return formattedError;
      }

      const httpStatus = exceptionRef.getStatus();
      const response = exceptionRef.getResponse();
      const extensions: Record<string, unknown> = {
        ...formattedError.extensions,
      };

      if (httpStatus in apolloPredefinedExceptions) {
        extensions.code = apolloPredefinedExceptions[httpStatus];
      } else {
        extensions.code = ApolloServerErrorCode.INTERNAL_SERVER_ERROR;
        extensions.status = httpStatus;
      }

      if (response) {
        extensions.originalError = response;
      }

      const error = new GraphQLError(exceptionRef.message, {
        path: formattedError.path,
        extensions,
      });

      return {
        ...error.toJSON(),
        ...(formattedError.locations
          ? { locations: formattedError.locations }
          : {}),
      };
    };
  }

  private wrapContextResolver(
    targetOptions: Record<string, unknown>,
    originalOptions: Record<string, unknown> = { ...targetOptions },
  ): void {
    const extractReq = (contextOrRequest: unknown): unknown =>
      typeof contextOrRequest === "object" &&
      contextOrRequest !== null &&
      "req" in contextOrRequest
        ? ((contextOrRequest as { req?: unknown }).req ?? contextOrRequest)
        : contextOrRequest;

    if (!targetOptions.context) {
      targetOptions.context = async (contextOrRequest: unknown) => ({
        req: extractReq(contextOrRequest),
      });
    } else if (typeof targetOptions.context === "function") {
      const originalContextFn = originalOptions.context as (
        ...args: unknown[]
      ) => unknown;
      targetOptions.context = async (...args: unknown[]) => {
        const ctx = await originalContextFn(...args);
        return this.assignReqProperty(ctx, extractReq(args[0]));
      };
    } else {
      targetOptions.context = async (contextOrRequest: unknown) =>
        this.assignReqProperty(
          originalOptions.context,
          extractReq(contextOrRequest),
        );
    }
  }

  private assignReqProperty(ctx: unknown, req: unknown): unknown {
    if (!ctx) {
      return { req };
    }
    if (typeof ctx !== "object") {
      return ctx;
    }
    const rec = ctx as { req?: unknown };
    return rec.req && typeof rec.req === "object"
      ? this.cloneContext(ctx)
      : this.cloneContext(ctx, { req });
  }

  private cloneContext(
    ctx: object,
    properties?: Record<string, unknown>,
  ): Record<string, unknown> {
    return Object.assign(
      Object.create(Object.getPrototypeOf(ctx)),
      ctx,
      properties,
    );
  }
}
