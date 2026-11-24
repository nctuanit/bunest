import type {
  DocumentNode,
  GraphQLError,
  GraphQLFieldResolver,
  GraphQLFormattedError,
  GraphQLResolveInfo,
  GraphQLSchema,
  OperationDefinitionNode,
  ParseOptions,
  ValidationRule,
} from "../../engine";
import type { HeaderMap } from "./header-map";

export interface BaseContext {
  [key: string]: unknown;
}

export interface KeyValueCache<V = string> {
  get(key: string): Promise<V | undefined>;
  set(key: string, value: V, options?: { ttl?: number | null }): Promise<void>;
  delete(key: string): Promise<boolean | void>;
}

export interface ApolloLogger {
  debug?(message?: unknown): void;
  info?(message?: unknown): void;
  warn?(message?: unknown): void;
  error?(message?: unknown): void;
}

export interface GraphQLRequest {
  query?: string;
  operationName?: string;
  variables?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  http?: {
    method: string;
    headers: HeaderMap;
    search?: string;
  };
}

export interface FormattedExecutionResult<
  TData = Record<string, unknown>,
  TExtensions = Record<string, unknown>,
> {
  errors?: readonly GraphQLFormattedError[];
  data?: TData | null;
  extensions?: TExtensions;
}

export interface GraphQLResponse<
  TData = Record<string, unknown>,
  TExtensions = Record<string, unknown>,
> {
  http: {
    status?: number;
    headers: HeaderMap;
  };
  body:
    | {
        kind: "single";
        singleResult: FormattedExecutionResult<TData, TExtensions>;
      }
    | {
        kind: "incremental";
        initialResult: FormattedExecutionResult<TData, TExtensions> & {
          hasNext: boolean;
        };
        subsequentResults: AsyncIterable<Record<string, unknown>>;
      };
}

export interface GraphQLRequestContext<
  TContext extends BaseContext = BaseContext,
> {
  readonly request: GraphQLRequest;
  readonly response: GraphQLResponse;
  readonly schema: GraphQLSchema;
  readonly contextValue: TContext;
  readonly cache: KeyValueCache;
  readonly logger: ApolloLogger;
  document?: DocumentNode;
  source?: string;
  queryHash?: string;
  operationName?: string | null;
  operation?: OperationDefinitionNode;
  errors?: readonly GraphQLError[];
  overallCachePolicy?: {
    maxAge?: number;
    scope?: "PUBLIC" | "PRIVATE";
  };
}

export interface GraphQLRequestListener<
  TContext extends BaseContext = BaseContext,
> {
  parsingDidStart?(
    requestContext: GraphQLRequestContext<TContext>,
  ):
    | Promise<((err?: Error) => Promise<void> | void) | void>
    | ((err?: Error) => Promise<void> | void)
    | void;
  validationDidStart?(
    requestContext: GraphQLRequestContext<TContext>,
  ):
    | Promise<((err?: readonly Error[]) => Promise<void> | void) | void>
    | ((err?: readonly Error[]) => Promise<void> | void)
    | void;
  didResolveOperation?(
    requestContext: GraphQLRequestContext<TContext>,
  ): Promise<void> | void;
  responseForOperation?(
    requestContext: GraphQLRequestContext<TContext>,
  ):
    | Promise<GraphQLResponse | null | undefined>
    | GraphQLResponse
    | null
    | undefined;
  executionDidStart?(requestContext: GraphQLRequestContext<TContext>): Promise<{
    willResolveField?: (args: {
      source: unknown;
      args: Record<string, unknown>;
      contextValue: TContext;
      info: GraphQLResolveInfo;
    }) => ((error: Error | null, result?: unknown) => void) | void;
    executionDidEnd?: (err?: Error) => Promise<void> | void;
  } | void> | void;
  didEncounterErrors?(
    requestContext: GraphQLRequestContext<TContext>,
  ): Promise<void> | void;
  willSendResponse?(
    requestContext: GraphQLRequestContext<TContext>,
  ): Promise<void> | void;
}

export interface GraphQLServerContext {
  logger: ApolloLogger;
  cache: KeyValueCache;
  schema: GraphQLSchema;
  apollo: {
    key?: string;
    keyHash?: string;
    graphRef?: string;
  };
  startedInBackground: boolean;
}

export interface GraphQLServerListener {
  serverWillStop?(): Promise<void> | void;
  drainServer?(): Promise<void> | void;
  renderLandingPage?(): Promise<{ html: string }> | { html: string };
  schemaDidLoadOrUpdate?(schemaContext: {
    apiSchema: GraphQLSchema;
    coreSupergraphSdl?: string;
  }): Promise<void> | void;
}

export interface ApolloServerPlugin<
  TContext extends BaseContext = BaseContext,
> {
  serverWillStart?(
    service: GraphQLServerContext,
  ): Promise<GraphQLServerListener | void> | GraphQLServerListener | void;
  requestDidStart?(
    requestContext: GraphQLRequestContext<TContext>,
  ):
    | Promise<GraphQLRequestListener<TContext> | void>
    | GraphQLRequestListener<TContext>
    | void;
  unexpectedErrorProcessingRequest?(requestContext: {
    requestContext: GraphQLRequestContext<TContext>;
    error: Error;
  }): Promise<void> | void;
  contextCreationDidFail?(ctx: { error: Error }): Promise<void> | void;
  invalidRequestWasReceived?(ctx: { error: Error }): Promise<void> | void;
  startupDidFail?(ctx: { error: Error }): Promise<void> | void;
}

export interface PersistedQueryOptions {
  cache?: KeyValueCache;
  ttl?: number | null;
}

export interface CSRFPreventionOptions {
  requestHeaders?: string[];
}

export interface ApolloConfigInput {
  key?: string;
  graphRef?: string;
  graphId?: string;
  graphVariant?: string;
}

export interface GatewaySchemaLoadContext {
  apiSchema: GraphQLSchema;
  coreSupergraphSdl?: string;
}

export type GatewaySchemaLoadOrUpdateCallback = (
  schemaContext: GatewaySchemaLoadContext,
) => void;

export type GatewayExecutor = (
  requestContext: GraphQLRequestContext<BaseContext>,
) => Promise<{
  data?: Record<string, unknown> | null;
  errors?: readonly (GraphQLError | GraphQLFormattedError)[];
  extensions?: Record<string, unknown>;
}>;

export interface GatewayLoadResult {
  executor?: GatewayExecutor;
  schema?: GraphQLSchema;
}

export interface GatewayInterface {
  load(options?: {
    apollo?: ApolloConfigInput;
    engine?: unknown;
  }): Promise<GatewayLoadResult>;
  onSchemaLoadOrUpdate(callback: GatewaySchemaLoadOrUpdateCallback): () => void;
  stop(): Promise<void>;
}

/**
 * Full Apollo Server v4 options surface (zero external `@apollo/server` runtime dependency).
 */
export interface ApolloServerOptionsBase<
  TContext extends BaseContext = BaseContext,
> {
  logger?: ApolloLogger;
  cache?: KeyValueCache | "bounded";
  formatError?: (
    formattedError: GraphQLFormattedError,
    error: unknown,
  ) => GraphQLFormattedError;
  rootValue?: ((parsedQuery: DocumentNode) => unknown) | unknown;
  validationRules?: ValidationRule[];
  fieldResolver?: GraphQLFieldResolver<any, TContext>;
  includeStacktraceInErrorResponses?: boolean;
  allowBatchedHttpRequests?: boolean;
  stringifyResult?: (
    value: FormattedExecutionResult,
  ) => string | Promise<string>;
  introspection?: boolean;
  maxRecursiveSelections?: number;
  hideSchemaDetailsFromClientErrors?: boolean;
  plugins?: ApolloServerPlugin<TContext>[];
  persistedQueries?: PersistedQueryOptions | false;
  stopOnTerminationSignals?: boolean;
  apollo?: ApolloConfigInput;
  nodeEnv?: string;
  documentStore?: KeyValueCache<DocumentNode> | null;
  dangerouslyDisableValidation?: boolean;
  validationOptions?: {
    maxErrors?: number;
  };
  csrfPrevention?: CSRFPreventionOptions | boolean;
  parseOptions?: ParseOptions;
  executionOptions?: Record<string, unknown>;
  status400ForVariableCoercionErrors?: boolean;
  legacyExperimentalExecuteIncrementally?: boolean;
}
