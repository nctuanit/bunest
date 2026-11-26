import { LruCache, type ResponseContext } from "@bunest/core";
import {
  type DocumentNode,
  execute,
  type ExecutionResult,
  getOperationAST,
  GraphQLError,
  type GraphQLFormattedError,
  type GraphQLSchema,
  NoSchemaIntrospectionCustomRule,
  parse,
  type SelectionSetNode,
  specifiedRules,
  validate,
  type ValidationRule,
} from "../../engine";
import { ApolloServerErrorCode } from "../constants/apollo.constants";
import type {
  ApolloLogger,
  ApolloServerOptionsBase,
  ApolloServerPlugin,
  BaseContext,
  FormattedExecutionResult,
  GatewayExecutor,
  GatewayInterface,
  GraphQLRequest,
  GraphQLRequestContext,
  GraphQLRequestListener,
  GraphQLResponse,
  GraphQLServerListener,
  KeyValueCache,
} from "./apollo-server.types";
import { HeaderMap } from "./header-map";

class InMemoryBoundedCache<V = string> implements KeyValueCache<V> {
  private readonly store: LruCache<string, V>;
  constructor(maxEntries = 2048) {
    this.store = new LruCache<string, V>({ maxSize: maxEntries });
  }

  async get(key: string): Promise<V | undefined> {
    return this.store.get(key);
  }

  async set(
    key: string,
    value: V,
    options?: { ttl?: number | null },
  ): Promise<void> {
    const ttl = options?.ttl;
    this.store.set(
      key,
      value,
      typeof ttl === "number" && ttl > 0 ? ttl * 1000 : undefined,
    );
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }
}

export function unwrapResolverError(error: unknown): unknown {
  if (error instanceof GraphQLError && error.originalError) {
    return error.originalError;
  }
  return error;
}

function createMaxRecursiveSelectionsRule(maxDepth: number): ValidationRule {
  return (context) => ({
    OperationDefinition(node) {
      const visit = (selectionSet: SelectionSetNode | undefined, depth: number) => {
        if (!selectionSet?.selections) return;
        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(
              `Query exceeds maximum selection depth of ${maxDepth}.`,
              {
                nodes: selectionSet,
                extensions: {
                  code: ApolloServerErrorCode.GRAPHQL_VALIDATION_FAILED,
                },
              },
            ),
          );
          return;
        }
        for (const sel of selectionSet.selections) {
          if ("selectionSet" in sel && sel.selectionSet) {
            visit(sel.selectionSet, depth + 1);
          }
        }
      };
      visit(node.selectionSet, 0);
    },
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface BunestApolloServerOptions<
  TContext extends BaseContext = BaseContext,
> extends ApolloServerOptionsBase<TContext> {
  schema?: GraphQLSchema;
  gateway?: GatewayInterface;
  context?: (...args: any[]) => Promise<TContext> | TContext;
}

/**
 * Bun-native Apollo Server v4-compatible execution engine with full plugin lifecycle,
 * batched HTTP requests, Automatic Persisted Queries, CSRF prevention, landing page plugins,
 * error formatting, and gateway execution support.
 */
export class BunestApolloServer<TContext extends BaseContext = BaseContext> {
  public schema?: GraphQLSchema;
  private readonly options: BunestApolloServerOptions<TContext>;
  private readonly plugins: ApolloServerPlugin<TContext>[];
  private readonly cache: KeyValueCache;
  private readonly documentStore: KeyValueCache<DocumentNode> | null;
  private readonly persistedQueryCache?: KeyValueCache;
  private readonly logger: ApolloLogger;
  private readonly gateway?: GatewayInterface;
  private gatewayExecutor?: GatewayExecutor;
  private unsubscribeGateway?: () => void;
  private serverListeners: GraphQLServerListener[] = [];
  private renderLandingPageFn?: () =>
    Promise<{ html: string }> | { html: string };
  private _started = false;
  private _stopped = false;

  constructor(options: BunestApolloServerOptions<TContext>) {
    this.options = options;
    this.schema = options.schema;
    this.gateway = options.gateway;
    this.plugins = [...(options.plugins ?? [])];
    this.cache =
      options.cache && options.cache !== "bounded"
        ? options.cache
        : new InMemoryBoundedCache<string>();
    this.documentStore =
      options.documentStore === null
        ? null
        : (options.documentStore ??
          new InMemoryBoundedCache<DocumentNode>(512));
    if (options.persistedQueries !== false) {
      this.persistedQueryCache =
        options.persistedQueries?.cache ??
        new InMemoryBoundedCache<string>(1024);
    }
    this.logger = options.logger ?? {
      debug: () => {},
      info: () => {},
      warn: (msg) => console.warn(msg),
      error: (msg) => console.error(msg),
    };
  }

  get started(): boolean {
    return this._started;
  }

  get stopped(): boolean {
    return this._stopped;
  }

  assertStarted(methodName: string): void {
    if (!this._started) {
      throw new Error(
        `You must \`await server.start()\` before calling \`server.${methodName}()\`.`,
      );
    }
  }

  async start(): Promise<void> {
    if (this._started) {
      return;
    }

    try {
      if (this.gateway) {
        this.unsubscribeGateway = this.gateway.onSchemaLoadOrUpdate((ctx) => {
          this.schema = ctx.apiSchema;
          for (const listener of this.serverListeners) {
            void Promise.resolve(listener.schemaDidLoadOrUpdate?.(ctx)).catch(
              () => {},
            );
          }
        });
        const loaded = await this.gateway.load({ apollo: this.options.apollo });
        if (loaded.schema) {
          this.schema = loaded.schema;
        }
        if (loaded.executor) {
          this.gatewayExecutor = loaded.executor;
        }
      }

      const serviceContext = {
        logger: this.logger,
        cache: this.cache,
        schema: this.schema as GraphQLSchema,
        apollo: {
          key: this.options.apollo?.key,
          graphRef: this.options.apollo?.graphRef,
        },
        startedInBackground: false,
      };

      this.serverListeners = [];
      this.renderLandingPageFn = undefined;

      for (const plugin of this.plugins) {
        if (typeof plugin.serverWillStart === "function") {
          const listener = await plugin.serverWillStart(serviceContext);
          if (listener) {
            this.serverListeners.push(listener);
            if ("renderLandingPage" in listener) {
              this.renderLandingPageFn = listener.renderLandingPage;
            }
          }
        }
      }

      this._started = true;
      this._stopped = false;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const plugin of this.plugins) {
        await plugin.startupDidFail?.({ error });
      }
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this._stopped) {
      return;
    }
    this._stopped = true;
    this._started = false;

    for (const listener of this.serverListeners) {
      if (typeof listener.drainServer === "function") {
        await listener.drainServer();
      }
    }
    for (const listener of this.serverListeners) {
      if (typeof listener.serverWillStop === "function") {
        await listener.serverWillStop();
      }
    }
    this.serverListeners = [];

    if (this.unsubscribeGateway) {
      this.unsubscribeGateway();
      this.unsubscribeGateway = undefined;
    }
    if (this.gateway) {
      await this.gateway.stop();
    }
  }

  private isProd(): boolean {
    const env =
      this.options.nodeEnv ??
      (Reflect.get(process.env, "NODE_ENV") as string | undefined);
    return env === "production";
  }

  private formatError(
    err: GraphQLError | GraphQLFormattedError,
    defaultCode: string = ApolloServerErrorCode.INTERNAL_SERVER_ERROR,
  ): GraphQLFormattedError {
    const isGraphQLErr = err instanceof GraphQLError;
    const rawFormatted: GraphQLFormattedError = isGraphQLErr
      ? err.toJSON()
      : { ...err };
    const includeStack =
      this.options.includeStacktraceInErrorResponses ?? !this.isProd();
    const originalError = isGraphQLErr ? err.originalError : undefined;

    const extensions: Record<string, unknown> = {
      ...(rawFormatted.extensions ?? {}),
      code:
        (rawFormatted.extensions?.code as string | undefined) ?? defaultCode,
    };

    if (includeStack) {
      const stackSrc =
        originalError instanceof Error
          ? originalError.stack
          : isGraphQLErr
            ? err.stack
            : undefined;
      if (stackSrc && !extensions.stacktrace) {
        extensions.stacktrace = stackSrc.split("\n");
      }
    } else {
      delete extensions.stacktrace;
      delete extensions.stack;
    }

    let formatted: GraphQLFormattedError = {
      ...rawFormatted,
      extensions,
    };

    if (
      this.options.hideSchemaDetailsFromClientErrors &&
      (extensions.code === ApolloServerErrorCode.GRAPHQL_VALIDATION_FAILED ||
        extensions.code === ApolloServerErrorCode.GRAPHQL_PARSE_FAILED)
    ) {
      formatted = {
        message: "GraphQL validation failed.",
        extensions: { code: extensions.code },
      };
    }

    if (this.options.formatError) {
      try {
        return this.options.formatError(
          formatted,
          isGraphQLErr ? err : formatted,
        );
      } catch {
        return {
          message: "Internal server error",
          extensions: { code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR },
        };
      }
    }

    return formatted;
  }

  private computeHttpStatusFromErrors(
    errors: readonly (GraphQLError | GraphQLFormattedError)[],
    fallbackStatus: number,
  ): number {
    for (const err of errors) {
      const ext = err.extensions as
        | { http?: { status?: unknown } }
        | undefined;
      const explicitStatus = ext?.http?.status;
      if (typeof explicitStatus === "number" && explicitStatus >= 100) {
        return explicitStatus;
      }
    }
    return fallbackStatus;
  }

  async executeOperation<
    TData = Record<string, unknown>,
    TVariables extends Record<string, unknown> = Record<string, unknown>,
  >(
    request: Omit<GraphQLRequest, "variables"> & { variables?: TVariables },
    options?: { contextValue?: TContext },
  ): Promise<GraphQLResponse<TData>> {
    if (!this._started) {
      await this.start();
    }

    const schema = this.schema;
    const response: GraphQLResponse<TData> = {
      http: {
        status: undefined,
        headers: new HeaderMap(),
      },
      body: {
        kind: "single",
        singleResult: {},
      },
    };

    const contextValue = (options?.contextValue ?? {}) as TContext;
    const reqCopy: GraphQLRequest = {
      ...request,
      http: request.http ?? { method: "POST", headers: new HeaderMap() },
    };

    const requestContext: GraphQLRequestContext<TContext> = {
      request: reqCopy,
      response: response as GraphQLResponse,
      schema: schema as GraphQLSchema,
      contextValue,
      cache: this.cache,
      logger: this.logger,
      source: reqCopy.query,
      operationName: reqCopy.operationName ?? null,
    };

    const requestListeners: GraphQLRequestListener<TContext>[] = [];
    for (const plugin of this.plugins) {
      if (typeof plugin.requestDidStart === "function") {
        const listener = await plugin.requestDidStart(requestContext);
        if (listener) {
          requestListeners.push(listener);
        }
      }
    }

    const finalize = async (
      singleResult: FormattedExecutionResult<TData>,
      httpStatus: number,
      rawErrors?: readonly GraphQLError[],
    ): Promise<GraphQLResponse<TData>> => {
      response.body = {
        kind: "single",
        singleResult,
      };
      if (response.http.status === undefined) {
        response.http.status = httpStatus;
      }
      if (rawErrors && rawErrors.length > 0) {
        requestContext.errors = rawErrors;
        for (const listener of requestListeners) {
          await listener.didEncounterErrors?.(requestContext);
        }
      }
      for (const listener of requestListeners) {
        await listener.willSendResponse?.(requestContext);
      }
      return response;
    };

    if (!schema) {
      const err = new GraphQLError(
        "ApolloServer has no GraphQLSchema configured.",
        {
          extensions: { code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR },
        },
      );
      return finalize({ errors: [this.formatError(err)] }, 500, [err]);
    }

    // Automatic Persisted Queries (APQ) support
    let querySource = reqCopy.query;
    const apq = reqCopy.extensions?.persistedQuery as
      { version?: number; sha256Hash?: string } | undefined;

    if (apq) {
      if (
        this.options.persistedQueries === false ||
        !this.persistedQueryCache
      ) {
        const err = new GraphQLError("PersistedQueryNotSupported", {
          extensions: {
            code: ApolloServerErrorCode.PERSISTED_QUERY_NOT_SUPPORTED,
          },
        });
        return finalize(
          {
            errors: [
              this.formatError(
                err,
                ApolloServerErrorCode.PERSISTED_QUERY_NOT_SUPPORTED,
              ),
            ],
          },
          200,
          [err],
        );
      }
      const hash = apq.sha256Hash;
      if (hash) {
        const cacheKey = `apq:${hash}`;
        if (!querySource) {
          const cached = await this.persistedQueryCache.get(cacheKey);
          if (!cached) {
            const err = new GraphQLError("PersistedQueryNotFound", {
              extensions: {
                code: ApolloServerErrorCode.PERSISTED_QUERY_NOT_FOUND,
              },
            });
            return finalize(
              {
                errors: [
                  this.formatError(
                    err,
                    ApolloServerErrorCode.PERSISTED_QUERY_NOT_FOUND,
                  ),
                ],
              },
              200,
              [err],
            );
          }
          querySource = cached;
        } else {
          const computed = new Bun.CryptoHasher("sha256")
            .update(querySource)
            .digest("hex");
          if (computed !== hash) {
            const err = new GraphQLError("provided sha does not match query", {
              extensions: { code: ApolloServerErrorCode.BAD_REQUEST },
            });
            return finalize(
              {
                errors: [
                  this.formatError(err, ApolloServerErrorCode.BAD_REQUEST),
                ],
              },
              400,
              [err],
            );
          }
          await this.persistedQueryCache.set(cacheKey, querySource, {
            ttl:
              typeof this.options.persistedQueries === "object"
                ? this.options.persistedQueries.ttl
                : undefined,
          });
        }
      }
    }

    if (typeof querySource !== "string" || querySource.trim().length === 0) {
      const err = new GraphQLError(
        "GraphQL operations must contain a non-empty `query` or a `persistedQuery` extension.",
        { extensions: { code: ApolloServerErrorCode.BAD_REQUEST } },
      );
      return finalize(
        { errors: [this.formatError(err, ApolloServerErrorCode.BAD_REQUEST)] },
        400,
        [err],
      );
    }

    requestContext.source = querySource;
    requestContext.queryHash = new Bun.CryptoHasher("sha256")
      .update(querySource)
      .digest("hex");

    // 1. Parse
    const parseEndHooks: Array<(err?: Error) => Promise<void> | void> = [];
    for (const listener of requestListeners) {
      const hook = await listener.parsingDidStart?.(requestContext);
      if (typeof hook === "function") parseEndHooks.push(hook);
    }

    let document: DocumentNode;
    try {
      const cachedDoc = this.documentStore
        ? await this.documentStore.get(requestContext.queryHash)
        : undefined;
      if (cachedDoc) {
        document = cachedDoc;
      } else {
        document = parse(querySource, this.options.parseOptions);
        if (this.documentStore) {
          await this.documentStore.set(requestContext.queryHash, document);
        }
      }
      for (const hook of parseEndHooks) await hook();
    } catch (err) {
      const gqlErr =
        err instanceof GraphQLError
          ? err
          : new GraphQLError(err instanceof Error ? err.message : String(err));
      for (const hook of parseEndHooks) await hook(gqlErr);
      return finalize(
        {
          errors: [
            this.formatError(
              gqlErr,
              ApolloServerErrorCode.GRAPHQL_PARSE_FAILED,
            ),
          ],
        },
        400,
        [gqlErr],
      );
    }

    requestContext.document = document;

    // 2. Validate
    if (!this.options.dangerouslyDisableValidation) {
      const validateEndHooks: Array<
        (err?: readonly Error[]) => Promise<void> | void
      > = [];
      for (const listener of requestListeners) {
        const hook = await listener.validationDidStart?.(requestContext);
        if (typeof hook === "function") validateEndHooks.push(hook);
      }

      const rules: ValidationRule[] = [...specifiedRules];
      const introspectionEnabled = this.options.introspection ?? !this.isProd();
      if (!introspectionEnabled) {
        rules.push(NoSchemaIntrospectionCustomRule);
      }
      if (this.options.maxRecursiveSelections !== undefined) {
        rules.push(
          createMaxRecursiveSelectionsRule(this.options.maxRecursiveSelections),
        );
      }
      if (this.options.validationRules?.length) {
        rules.push(...this.options.validationRules);
      }

      const validationErrors = validate(
        schema,
        document,
        rules,
        this.options.validationOptions,
      );
      for (const hook of validateEndHooks) {
        await hook(validationErrors.length > 0 ? validationErrors : undefined);
      }

      if (validationErrors.length > 0) {
        return finalize(
          {
            errors: validationErrors.map((e) =>
              this.formatError(
                e,
                ApolloServerErrorCode.GRAPHQL_VALIDATION_FAILED,
              ),
            ),
          },
          400,
          validationErrors,
        );
      }
    }

    // 3. Resolve operation AST
    const operation = getOperationAST(
      document,
      reqCopy.operationName ?? undefined,
    );
    if (!operation) {
      const err = new GraphQLError(
        reqCopy.operationName
          ? `Unknown operation named "${reqCopy.operationName}".`
          : "Must provide operation name if query contains multiple operations.",
        {
          extensions: {
            code: ApolloServerErrorCode.OPERATION_RESOLUTION_FAILURE,
          },
        },
      );
      return finalize(
        {
          errors: [
            this.formatError(
              err,
              ApolloServerErrorCode.OPERATION_RESOLUTION_FAILURE,
            ),
          ],
        },
        400,
        [err],
      );
    }

    requestContext.operation = operation;
    requestContext.operationName =
      operation.name?.value ?? reqCopy.operationName ?? null;

    for (const listener of requestListeners) {
      await listener.didResolveOperation?.(requestContext);
    }

    // 4. Plugin short-circuit via responseForOperation
    for (const listener of requestListeners) {
      const customResponse =
        await listener.responseForOperation?.(requestContext);
      if (customResponse) {
        response.http = customResponse.http;
        response.body = customResponse.body as GraphQLResponse<TData>["body"];
        for (const endListener of requestListeners) {
          await endListener.willSendResponse?.(requestContext);
        }
        return response;
      }
    }

    // 5. Execution
    const execEndHooks: Array<(err?: Error) => Promise<void> | void> = [];
    for (const listener of requestListeners) {
      const execListener = await listener.executionDidStart?.(requestContext);
      if (execListener && typeof execListener.executionDidEnd === "function") {
        execEndHooks.push(execListener.executionDidEnd);
      }
    }

    let rawResult: {
      data?: Record<string, unknown> | null;
      errors?: readonly (GraphQLError | GraphQLFormattedError)[];
      extensions?: Record<string, unknown>;
    };

    try {
      if (this.gatewayExecutor) {
        rawResult = await this.gatewayExecutor(requestContext);
      } else {
        const rootValue =
          typeof this.options.rootValue === "function"
            ? (this.options.rootValue as (doc: DocumentNode) => unknown)(
                document,
              )
            : this.options.rootValue;

        const execRes: ExecutionResult = await execute({
          schema,
          document,
          rootValue,
          contextValue,
          variableValues: reqCopy.variables,
          operationName: reqCopy.operationName,
          fieldResolver: this.options.fieldResolver,
        });
        rawResult = execRes;
      }
      for (const hook of execEndHooks) await hook();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const hook of execEndHooks) await hook(error);
      const gqlErr =
        err instanceof GraphQLError
          ? err
          : new GraphQLError(error.message, { originalError: error });
      return finalize({ errors: [this.formatError(gqlErr)] }, 500, [gqlErr]);
    }

    const singleResult: FormattedExecutionResult<TData> = {};
    if (rawResult.data !== undefined) {
      singleResult.data = rawResult.data as TData | null;
    }

    const rawGqlErrors: GraphQLError[] = [];
    if (rawResult.errors && rawResult.errors.length > 0) {
      singleResult.errors = rawResult.errors.map((e) => {
        if (e instanceof GraphQLError) {
          rawGqlErrors.push(e);
        }
        return this.formatError(e);
      });
    }
    if (rawResult.extensions) {
      singleResult.extensions = rawResult.extensions;
    }

    const defaultStatus =
      rawResult.data === undefined &&
      rawResult.errors &&
      rawResult.errors.length > 0 &&
      this.options.status400ForVariableCoercionErrors !== false
        ? 400
        : 200;

    const httpStatus = rawResult.errors?.length
      ? this.computeHttpStatusFromErrors(rawResult.errors, defaultStatus)
      : 200;

    return finalize(
      singleResult,
      httpStatus,
      rawGqlErrors.length > 0 ? rawGqlErrors : undefined,
    );
  }

  private checkCsrfPrevention(req: Request): Response | null {
    const csrfOpt = this.options.csrfPrevention;
    if (csrfOpt === false) {
      return null;
    }
    if (csrfOpt === undefined) {
      // Disabled unless explicitly opted in or GET with query
      return null;
    }
    const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
    const isJsonPost =
      req.method.toUpperCase() === "POST" &&
      contentType.includes("application/json");
    if (isJsonPost) {
      return null;
    }
    const requiredHeaders =
      typeof csrfOpt === "object" && csrfOpt.requestHeaders?.length
        ? csrfOpt.requestHeaders
        : ["x-apollo-operation-name", "apollo-require-preflight"];
    const hasHeader = requiredHeaders.some(
      (h) => req.headers.get(h) !== null && req.headers.get(h) !== "",
    );
    if (!hasHeader) {
      return Response.json(
        {
          errors: [
            {
              message:
                "This operation has been blocked as a potential Cross-Site Request Forgery (CSRF).",
              extensions: { code: ApolloServerErrorCode.BAD_REQUEST },
            },
          ],
        },
        { status: 400 },
      );
    }
    return null;
  }

  private async serializePayload(
    payload: FormattedExecutionResult | FormattedExecutionResult[],
  ): Promise<string> {
    if (!Array.isArray(payload) && this.options.stringifyResult) {
      return await this.options.stringifyResult(payload);
    }
    return JSON.stringify(payload);
  }

  async handleHttpRequest(
    req: Request,
    res?: ResponseContext,
  ): Promise<Response> {
    if (!this._started) {
      await this.start();
    }

    const method = req.method.toUpperCase();
    const accept = req.headers.get("accept") ?? "";
    const url = new URL(req.url);

    // GET request: GraphiQL / landing page OR GET query
    if (method === "GET") {
      const query = url.searchParams.get("query");
      const extensionsRaw = url.searchParams.get("extensions");

      if (!query && !extensionsRaw) {
        if (accept.includes("text/html") && this.renderLandingPageFn) {
          const { html } = await this.renderLandingPageFn();
          return new Response(html, {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }
        return Response.json(
          {
            errors: [
              {
                message: "GraphQL query missing.",
                extensions: { code: ApolloServerErrorCode.BAD_REQUEST },
              },
            ],
          },
          { status: 400 },
        );
      }

      const csrfBlock = this.checkCsrfPrevention(req);
      if (csrfBlock) return csrfBlock;

      let variables: Record<string, unknown> | undefined;
      const rawVars = url.searchParams.get("variables");
      if (rawVars) {
        try {
          const parsed = JSON.parse(rawVars);
          if (parsed !== null && !isPlainRecord(parsed)) {
            return Response.json(
              {
                errors: [
                  {
                    message: "Variables must be a JSON object.",
                    extensions: { code: ApolloServerErrorCode.BAD_REQUEST },
                  },
                ],
              },
              { status: 400 },
            );
          }
          variables = parsed ?? undefined;
        } catch {
          return Response.json(
            {
              errors: [
                {
                  message: "Invalid JSON in variables parameter.",
                  extensions: { code: ApolloServerErrorCode.BAD_REQUEST },
                },
              ],
            },
            { status: 400 },
          );
        }
      }

      let extensions: Record<string, unknown> | undefined;
      if (extensionsRaw) {
        try {
          const parsedExt = JSON.parse(extensionsRaw);
          extensions = isPlainRecord(parsedExt) ? parsedExt : undefined;
        } catch {
          return Response.json(
            {
              errors: [
                {
                  message: "Invalid JSON in extensions parameter.",
                  extensions: { code: ApolloServerErrorCode.BAD_REQUEST },
                },
              ],
            },
            { status: 400 },
          );
        }
      }

      const operationName = url.searchParams.get("operationName") ?? undefined;
      const headers = new HeaderMap();
      req.headers.forEach((v, k) => headers.set(k, v));

      // Disallow mutations over GET
      if (query) {
        try {
          const doc = parse(query, this.options.parseOptions);
          const op = getOperationAST(doc, operationName);
          if (op?.operation === "mutation") {
            return Response.json(
              {
                errors: [
                  {
                    message:
                      "Can only perform a mutation operation from a POST request.",
                    extensions: { code: ApolloServerErrorCode.BAD_REQUEST },
                  },
                ],
              },
              { status: 405, headers: { Allow: "POST" } },
            );
          }
        } catch {
          // Parse error will be reported cleanly by executeOperation
        }
      }

      const contextValue = this.options.context
        ? await this.options.context({ req, res })
        : ({ req, res } as unknown as TContext);

      const execRes = await this.executeOperation(
        {
          query: query ?? undefined,
          variables,
          operationName,
          extensions,
          http: { method, headers, search: url.search },
        },
        { contextValue },
      );

      return this.toNativeResponse(execRes);
    }

    if (method === "POST") {
      const csrfBlock = this.checkCsrfPrevention(req);
      if (csrfBlock) return csrfBlock;

      let body: unknown;
      try {
        const text = await req.text();
        body = text ? JSON.parse(text) : {};
      } catch {
        return Response.json(
          {
            errors: [
              {
                message: "Malformed JSON request body.",
                extensions: { code: ApolloServerErrorCode.BAD_REQUEST },
              },
            ],
          },
          { status: 400 },
        );
      }

      const headers = new HeaderMap();
      req.headers.forEach((v, k) => headers.set(k, v));

      // Batched HTTP requests
      if (Array.isArray(body)) {
        if (!this.options.allowBatchedHttpRequests) {
          return Response.json(
            {
              errors: [
                {
                  message: "Operation batching disabled.",
                  extensions: { code: ApolloServerErrorCode.BAD_REQUEST },
                },
              ],
            },
            { status: 400 },
          );
        }

        const results = await Promise.all(
          body.map(async (item) => {
            const contextValue = this.options.context
              ? await this.options.context({ req, res })
              : ({ req, res } as unknown as TContext);
            const rec = isPlainRecord(item) ? item : {};
            const opRes = await this.executeOperation(
              {
                query: typeof rec.query === "string" ? rec.query : undefined,
                variables: isPlainRecord(rec.variables)
                  ? rec.variables
                  : undefined,
                operationName:
                  typeof rec.operationName === "string"
                    ? rec.operationName
                    : undefined,
                extensions: isPlainRecord(rec.extensions)
                  ? rec.extensions
                  : undefined,
                http: { method, headers, search: url.search },
              },
              { contextValue },
            );
            return opRes.body.kind === "single"
              ? opRes.body.singleResult
              : opRes.body.initialResult;
          }),
        );

        return new Response(await this.serializePayload(results), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }

      if (!isPlainRecord(body)) {
        return Response.json(
          {
            errors: [
              {
                message: "GraphQL request body must be a JSON object.",
                extensions: { code: ApolloServerErrorCode.BAD_REQUEST },
              },
            ],
          },
          { status: 400 },
        );
      }

      const contextValue = this.options.context
        ? await this.options.context({ req, res })
        : ({ req, res } as unknown as TContext);

      const execRes = await this.executeOperation(
        {
          query: typeof body.query === "string" ? body.query : undefined,
          variables: isPlainRecord(body.variables) ? body.variables : undefined,
          operationName:
            typeof body.operationName === "string"
              ? body.operationName
              : undefined,
          extensions: isPlainRecord(body.extensions)
            ? body.extensions
            : undefined,
          http: { method, headers, search: url.search },
        },
        { contextValue },
      );

      return this.toNativeResponse(execRes);
    }

    return Response.json(
      {
        errors: [
          {
            message: `Method ${method} not allowed.`,
            extensions: { code: ApolloServerErrorCode.BAD_REQUEST },
          },
        ],
      },
      { status: 405, headers: { Allow: "GET, POST" } },
    );
  }

  private async toNativeResponse<TData>(
    execRes: GraphQLResponse<TData>,
  ): Promise<Response> {
    const outHeaders = new Headers({
      "Content-Type": "application/json; charset=utf-8",
    });
    for (const [k, v] of execRes.http.headers.entries()) {
      outHeaders.set(k, v);
    }
    const payload =
      execRes.body.kind === "single"
        ? execRes.body.singleResult
        : execRes.body.initialResult;
    const serialized = await this.serializePayload(
      payload as FormattedExecutionResult,
    );
    return new Response(serialized, {
      status: execRes.http.status ?? 200,
      headers: outHeaders,
    });
  }
}

export type ApolloServer<TContext extends BaseContext = BaseContext> =
  BunestApolloServer<TContext>;
