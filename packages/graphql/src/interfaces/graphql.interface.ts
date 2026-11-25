import type {
  ArgumentsHost,
  ExceptionFilterLike,
  InjectionToken,
  ModuleImport,
  PipeLike,
  ResponseContext,
  Type,
} from "@bunest/core";
import type { BunHttpAdapter } from "@bunest/core/http";
import type {
  DocumentNode,
  execute as graphqlExecute,
  GraphQLCompositeType,
  GraphQLDirective,
  GraphQLField,
  GraphQLFormattedError,
  GraphQLResolveInfo,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLTypeResolver,
  subscribe as graphqlSubscribe,
  ValidationRule,
  ValueNode,
} from "../engine";

// ---------------------------------------------------------------------------
// Utility & Helper Types
// ---------------------------------------------------------------------------

export type ArrayElement<ArrayType extends readonly unknown[]> =
  ArrayType[number];

export type Union<T extends readonly any[]> = InstanceType<ArrayElement<T>>;

export type FieldType<T> = T;

export type GqlTypeReference<T = unknown> =
  Type<T> | GraphQLScalarType | Function | object | symbol | string;

export type ResolverTypeFn = (of?: void) => Function;

export type ResolveTypeFn<TSource = unknown, TContext = unknown> = (
  ...args: Parameters<GraphQLTypeResolver<TSource, TContext>>
) =>
  | ReturnType<GraphQLTypeResolver<TSource, TContext>>
  | Function
  | Promise<Function>;

export type RegisterInOption =
  Function | (() => Function) | Array<Function | (() => Function)>;

export type NullableList = "items" | "itemsAndList";

export type NullableListOption = boolean | NullableList;

type NonNullableBaseType<T = any> = {
  nullable?: false | NullableList;
  defaultValue?: T;
};

type NullableBaseType<T = any> = {
  nullable: true;
  defaultValue?: T | null;
};

export type BaseTypeOptions<T = any> =
  NonNullableBaseType<T> | NullableBaseType<T>;

export type Enhancer = "guards" | "interceptors" | "filters";

export type DateScalarMode = "isoDate" | "timestamp";

export type NumberScalarMode = "float" | "integer";

export interface ScalarsTypeMap {
  type: Function;
  scalar: GraphQLScalarType;
}

// ---------------------------------------------------------------------------
// Field Middleware & Complexity
// ---------------------------------------------------------------------------

export interface MiddlewareContext<
  TSource = any,
  TContext = any,
  TArgs = { [argName: string]: any },
> {
  source: TSource;
  args: TArgs;
  context: TContext;
  info?: GraphQLResolveInfo | null;
}

export type NextFn<T = any> = () => Promise<T>;

export interface FieldMiddleware<
  TSource = any,
  TContext = any,
  TArgs = { [argName: string]: any },
  TOutput = any,
> {
  (
    ctx: MiddlewareContext<TSource, TContext, TArgs>,
    next: NextFn,
  ): Promise<TOutput> | TOutput;
}

export type ComplexityEstimatorArgs = {
  type: GraphQLCompositeType;
  field: GraphQLField<any, any>;
  args: { [key: string]: any };
  childComplexity: number;
};

export type ComplexityEstimator = (
  options: ComplexityEstimatorArgs,
) => number | void;

export type Complexity = ComplexityEstimator | number;

// ---------------------------------------------------------------------------
// Exception Filter & Driver Interfaces
// ---------------------------------------------------------------------------

export interface GqlExceptionFilter<TInput = any, TOutput = any> {
  catch(exception: TInput, host: ArgumentsHost): TOutput;
}

export interface GraphQLDriver<TOptions = any> {
  start(options: TOptions): Promise<unknown>;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Code-First Type & Decorator Options
// ---------------------------------------------------------------------------

export type InterfaceImplementsInput =
  Function | readonly Function[] | (() => Function | readonly Function[]);

export type TypeResolverFn = (
  value: any,
  context: any,
  info: GraphQLResolveInfo,
) =>
  | string
  | Function
  | null
  | undefined
  | Promise<string | Function | null | undefined>;

export interface UnionTypeRef<
  T extends readonly Type<unknown>[] = readonly Type<unknown>[],
> {
  readonly __bunestGraphQLUnion: true;
  readonly name: string;
  readonly description?: string;
  readonly types: () => T;
  readonly resolveType?: TypeResolverFn;
  readonly registerIn?: RegisterInOption;
  readonly directives?: readonly string[];
}

export interface CreateUnionTypeOptions<
  T extends readonly Type<unknown>[] = readonly Type<unknown>[],
> {
  readonly name: string;
  readonly types: () => T;
  readonly description?: string;
  readonly resolveType?: TypeResolverFn;
  readonly registerIn?: RegisterInOption;
  readonly directives?: readonly string[];
}

export interface UnionOptions<
  T extends readonly Type<unknown>[] = readonly Type<unknown>[],
> extends CreateUnionTypeOptions<T> {}

export type ReturnTypeFuncValue =
  | Type<unknown>
  | Function
  | GraphQLScalarType
  | UnionTypeRef
  | Record<string, string | number>
  | [ReturnTypeFuncValue]
  | readonly ReturnTypeFuncValue[];

export type ReturnTypeFunc<
  T extends ReturnTypeFuncValue = ReturnTypeFuncValue,
> = () => T;

export interface ObjectTypeOptions {
  name?: string;
  description?: string;
  isAbstract?: boolean;
  implements?: InterfaceImplementsInput;
  inheritDescription?: boolean;
  registerIn?: RegisterInOption;
}

export interface ObjectTypeMetadata {
  readonly name: string;
  readonly description?: string;
  readonly isAbstract?: boolean;
  readonly implements?: InterfaceImplementsInput;
  readonly inheritDescription?: boolean;
  readonly registerIn?: RegisterInOption;
}

export interface InterfaceTypeOptions {
  name?: string;
  description?: string;
  isAbstract?: boolean;
  implements?: InterfaceImplementsInput;
  resolveType?: TypeResolverFn;
  registerIn?: RegisterInOption;
}

export interface InterfaceTypeMetadata {
  readonly name: string;
  readonly description?: string;
  readonly isAbstract?: boolean;
  readonly implements?: InterfaceImplementsInput;
  readonly resolveType?: TypeResolverFn;
  readonly registerIn?: RegisterInOption;
}

export interface InputTypeOptions {
  name?: string;
  description?: string;
  isAbstract?: boolean;
  isOneOf?: boolean;
  registerIn?: RegisterInOption;
}

export interface InputTypeMetadata {
  readonly name: string;
  readonly description?: string;
  readonly isAbstract?: boolean;
  readonly isOneOf?: boolean;
  readonly registerIn?: RegisterInOption;
}

export interface ArgsTypeOptions {
  registerIn?: RegisterInOption;
}

export type FieldOptions<T = any> = {
  name?: string;
  description?: string;
  nullable?: NullableListOption;
  defaultValue?: T;
  deprecationReason?: string;
  complexity?: Complexity;
  middleware?: FieldMiddleware[];
};

export interface FieldMetadata extends FieldOptions {
  readonly propertyKey: string;
  readonly typeFn?: ReturnTypeFunc;
  readonly designType?: Function;
}

export interface PropertyMetadata {
  schemaName: string;
  name: string;
  typeFn: () => GqlTypeReference;
  target: Function;
  options: {
    nullable?: NullableListOption;
    defaultValue?: unknown;
    isArray?: boolean;
    arrayDepth?: number;
  };
  description?: string;
  deprecationReason?: string;
  methodArgs?: readonly GqlParamMetadata[];
  directives?: readonly string[];
  extensions?: Record<string, unknown>;
  complexity?: Complexity;
  middleware?: FieldMiddleware[];
}

export interface ResolverOptions {
  isAbstract?: boolean;
}

export interface ResolverMetadata {
  readonly of?: Function | (() => Function);
  readonly isAbstract?: boolean;
}

export interface ExploredResolverMetadata {
  target?: Function;
  declaredOn?: Function;
  name: string;
  type: string;
  methodName: string;
  callback?: Function;
}

export type OperationOptions<T = any> = {
  name?: string;
  description?: string;
  nullable?: NullableListOption;
  defaultValue?: T;
  deprecationReason?: string;
  complexity?: Complexity;
};

export type QueryOptions<T = any> = OperationOptions<T>;

export type MutationOptions<T = any> = OperationOptions<T>;

export type ResolveFieldOptions<T = any> = OperationOptions<T> & {
  middleware?: FieldMiddleware[];
};

export type SubscriptionOptions<
  TPayload = any,
  TVariables = any,
> = OperationOptions & {
  filter?: (
    payload: TPayload,
    variables: TVariables,
    context: Record<string, unknown>,
    info: GraphQLResolveInfo,
  ) => boolean | Promise<boolean>;
  resolve?: (
    payload: TPayload,
    args: TVariables,
    context: Record<string, unknown>,
    info: GraphQLResolveInfo,
  ) => unknown | Promise<unknown>;
};

export interface ResolverOperationMetadata {
  readonly kind: "query" | "mutation" | "subscription";
  readonly handlerKey: string | symbol;
  readonly name: string;
  readonly returnTypeFn: ReturnTypeFunc;
  readonly description?: string;
  readonly nullable?: NullableListOption;
  readonly defaultValue?: unknown;
  readonly deprecationReason?: string;
  readonly complexity?: Complexity;
  readonly filter?: SubscriptionOptions["filter"];
  readonly resolve?: SubscriptionOptions["resolve"];
}

export interface ResolveFieldMetadata {
  readonly handlerKey: string | symbol;
  readonly name: string;
  readonly returnTypeFn?: ReturnTypeFunc;
  readonly description?: string;
  readonly nullable?: NullableListOption;
  readonly defaultValue?: unknown;
  readonly deprecationReason?: string;
  readonly complexity?: Complexity;
  readonly middleware?: FieldMiddleware[];
}

export type ArgsOptions = {
  name?: string;
  type?: ReturnTypeFunc;
  description?: string;
  nullable?: NullableListOption;
  defaultValue?: unknown;
  deprecationReason?: string;
};

export type GqlParamSource = "args" | "parent" | "context" | "info";

export interface GqlParamMetadata {
  readonly index: number;
  readonly source: GqlParamSource;
  readonly key?: string;
  readonly typeFn?: ReturnTypeFunc;
  readonly description?: string;
  readonly nullable?: NullableListOption;
  readonly defaultValue?: unknown;
  readonly deprecationReason?: string;
  readonly pipes?: readonly PipeLike[];
  readonly metatype?: Function;
}

export interface EnumValueConfigOptions {
  description?: string;
  deprecationReason?: string;
  directives?: readonly string[];
}

export interface EnumTypeOptions {
  name: string;
  description?: string;
  valuesMap?: Record<string, EnumValueConfigOptions>;
  registerIn?: RegisterInOption;
  directives?: readonly string[];
}

export interface EnumOptions extends EnumTypeOptions {}

// ---------------------------------------------------------------------------
// Subscriptions & WebSocket Types
// ---------------------------------------------------------------------------

export interface GraphQLWsConnectionContext {
  readonly request: Request;
  readonly connectionParams: Readonly<Record<string, unknown>>;
  readonly extra: Record<string, unknown>;
}

export interface GraphQLWsSubscribeMessage {
  readonly id: string;
  readonly type: "subscribe";
  readonly payload: {
    readonly query: string;
    readonly variables?: Record<string, unknown> | null;
    readonly operationName?: string | null;
    readonly extensions?: Record<string, unknown>;
  };
}

export interface GraphQLWsServer {
  options: {
    noServer?: boolean;
    path?: string;
  };
  handleUpgrade(
    request: unknown,
    socket: unknown,
    upgradeHead: unknown,
    callback: (client: unknown, request: unknown) => void,
  ): void;
  emit(event: "connection", ...args: unknown[]): boolean;
}

export interface GraphQLWsOptions {
  /**
   * WebSocket upgrade path (defaults to GraphQLModule HTTP `path`).
   */
  path?: string;
  /**
   * Authentication / authorization hook invoked on `connection_init`.
   */
  onConnect?: (
    ctx: GraphQLWsConnectionContext,
  ) =>
    | boolean
    | Record<string, unknown>
    | void
    | Promise<boolean | Record<string, unknown> | void>;
  /**
   * Lifecycle hook invoked when a client WebSocket disconnects.
   */
  onDisconnect?: (
    ctx: GraphQLWsConnectionContext,
    code: number,
    reason: string,
  ) => void | Promise<void>;
  onClose?: (
    ctx: GraphQLWsConnectionContext,
    code?: number,
    reason?: string,
  ) => void | Promise<void>;
  onSubscribe?: (...args: any[]) => unknown;
  onNext?: (...args: any[]) => unknown;
  onError?: (...args: any[]) => unknown;
  validate?: (...args: any[]) => unknown;
  /**
   * Optional per-operation GraphQL context factory for WS operations.
   */
  context?: (
    ctx: GraphQLWsConnectionContext,
    message: GraphQLWsSubscribeMessage,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * Maximum milliseconds to wait for `connection_init` after socket open.
   * @default 10000
   */
  connectionInitWaitTimeoutMs?: number;
  connectionInitWaitTimeout?: number;
  server?: GraphQLWsServer;
  unclaimedUpgradeTimeout?: number;
}

export type GraphQLWsSubscriptionsConfig = GraphQLWsOptions;

export type SubscriptionConfig = {
  "graphql-ws"?: GraphQLWsSubscriptionsConfig | boolean;
};

export interface GqlSubscriptionServiceOptions extends SubscriptionConfig {
  schema: GraphQLSchema;
  execute?: typeof graphqlExecute;
  subscribe?: typeof graphqlSubscribe;
  path?: string;
  context?:
    | GraphQLWsOptions["context"]
    | ((...args: any[]) => unknown)
    | Record<string, unknown>;
}

export type GraphQLSubscriptionsConfig =
  | boolean
  | {
      readonly sse?: boolean;
      readonly "graphql-ws"?: boolean | GraphQLWsOptions;
      readonly ws?: boolean | GraphQLWsOptions;
    };

export interface GraphQLContextFactoryArgs {
  readonly req: Request;
  readonly res?: ResponseContext;
}

export type GraphQLContextFactory = (
  args: GraphQLContextFactoryArgs,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export type SchemaFirstResolversMap = Record<
  string,
  Record<
    string,
    | ((
        parent: any,
        args: any,
        context: any,
        info: GraphQLResolveInfo,
      ) => unknown)
    | {
        subscribe?: (
          parent: any,
          args: any,
          context: any,
          info: GraphQLResolveInfo,
        ) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
        resolve?: (
          payload: any,
          args: any,
          context: any,
          info: GraphQLResolveInfo,
        ) => unknown;
      }
  >
>;

export interface CustomScalar<TExternal = any, TInternal = any> {
  description?: string;
  specifiedByURL?: string;
  extensions?: Record<string, unknown>;
  parseValue(value: unknown): TInternal;
  serialize(value: TInternal): TExternal;
  parseLiteral?(
    ast: ValueNode,
    variables?: Record<string, unknown> | null,
  ): TInternal;
}

export interface ScalarMetadata {
  readonly name: string;
  readonly typeFunc?: ReturnTypeFunc;
}

// ---------------------------------------------------------------------------
// Federation, Schema File, Definitions Generator & BuildSchemaOptions
// ---------------------------------------------------------------------------

export interface AliasDirectiveImport {
  name: string;
  as: string;
}

export type FederationVersion = 1 | 2;

export interface Federation2Config {
  version: 2;
  directives?: Array<string | AliasDirectiveImport>;
  importUrl?: string;
}

export type FederationConfig = Federation2Config;

export interface FederationOptions {
  version?: FederationVersion;
  directives?: Array<string | AliasDirectiveImport>;
  importUrl?: string;
}

export interface SchemaFileConfig {
  federation?: FederationVersion | FederationConfig;
  path?: string;
}

export type AutoSchemaFileValue = boolean | string | SchemaFileConfig;

export interface BuildFederatedSchemaOptions {
  typeDefs: string | readonly string[] | DocumentNode;
  resolvers?: SchemaFirstResolversMap | SchemaFirstResolversMap[];
}

export interface BuildSchemaOptions {
  dateScalarMode?: DateScalarMode;
  numberScalarMode?: NumberScalarMode;
  scalarsMap?: ScalarsTypeMap[];
  orphanedTypes?: Array<Function | object>;
  skipCheck?: boolean;
  directives?: GraphQLDirective[];
  fieldMiddleware?: FieldMiddleware[];
  noDuplicatedFields?: boolean;
  addNewlineAtEnd?: boolean;
}

export interface DefinitionsGeneratorOptions {
  emitTypenameField?: boolean;
  skipResolverArgs?: boolean;
  defaultScalarType?: string;
  customScalarTypeMapping?: Record<string, string | { name: string }>;
  defaultTypeMapping?: Partial<
    Record<"ID" | "Float" | "Int", "string" | "number"> &
      Record<"Boolean" | "String", "boolean" | "string" | "number">
  >;
  additionalHeader?: string;
  enumsAsTypes?: boolean;
  emitDescriptions?: boolean;
  typeName?: (name: string) => string;
}

export type GenerateOptions = DefinitionsGeneratorOptions & {
  typePaths: string[];
  path: string;
  outputAs?: "class" | "interface";
  watch?: boolean;
  debug?: boolean;
  typeDefs?: string | string[];
};

// ---------------------------------------------------------------------------
// GraphQL Module Options & Async Options
// ---------------------------------------------------------------------------

export interface GraphQLModuleOptions<TDriver extends GraphQLDriver = any> {
  /**
   * HTTP endpoint path for GraphQL queries, mutations, SSE subscriptions, and GraphiQL UI.
   * Defaults to `"/graphql"`.
   */
  path?: string;
  /**
   * Enable code-first schema generation (`true` for in-memory, a file path, or `SchemaFileConfig`).
   */
  autoSchemaFile?: AutoSchemaFileValue;
  /**
   * Sort generated GraphQL schema lexicographically (`lexicographicSortSchema`).
   */
  sortSchema?: boolean;
  /**
   * Code-first schema builder options (`dateScalarMode`, `numberScalarMode`, `scalarsMap`, `fieldMiddleware`, etc.).
   */
  buildSchemaOptions?: BuildSchemaOptions;
  /**
   * GraphQL server driver class (NestJS driver compatibility).
   */
  driver?: Type<TDriver>;
  /**
   * Restrict resolver discovery to the specified NestJS/Bunest module classes.
   */
  include?: Function[];
  /**
   * Deprecated directive resolvers option (kept for NestJS compatibility).
   */
  directiveResolvers?: Record<string, unknown>;
  /**
   * Enable Apollo Federation Subgraph (`_service { sdl }` + `_entities(representations)`).
   */
  federation?: boolean | FederationOptions;
  /**
   * Schema-first GraphQL SDL definition(s).
   */
  typeDefs?: string | readonly string[];
  /**
   * Glob patterns of `.graphql` / `.gql` SDL files loaded via native `Bun.Glob`.
   */
  typePaths?: string[];
  /**
   * Schema-first resolver map (can also be combined with `@Resolver()` classes).
   */
  resolvers?: SchemaFirstResolversMap | SchemaFirstResolversMap[];
  /**
   * TypeScript definitions generator options.
   */
  definitions?: {
    path?: string;
    outputAs?: "class" | "interface";
  } & DefinitionsGeneratorOptions;
  /**
   * Pre-built `GraphQLSchema` instance.
   */
  schema?: GraphQLSchema;
  /**
   * Per-request GraphQL context factory receiving `{ req, res }`.
   */
  context?: GraphQLContextFactory;
  /**
   * Prepend global application HTTP prefix to GraphQL route path.
   */
  useGlobalPrefix?: boolean;
  /**
   * Enable/disable enhancers (`guards`, `interceptors`, `filters`) for `@ResolveField()`.
   */
  fieldResolverEnhancers?: Enhancer[];
  /**
   * Resolver validation options.
   */
  resolverValidationOptions?: Record<string, unknown>;
  /**
   * Inherit missing resolvers from interface types defined in the resolvers object.
   */
  inheritResolversFromInterfaces?: boolean;
  /**
   * Transform the generated or provided `GraphQLSchema` before execution.
   */
  transformSchema?: (
    schema: GraphQLSchema,
  ) => GraphQLSchema | Promise<GraphQLSchema>;
  /**
   * Transform discovered/configured resolvers before binding.
   */
  transformResolvers?: (
    resolvers: SchemaFirstResolversMap | SchemaFirstResolversMap[],
  ) =>
    | SchemaFirstResolversMap
    | SchemaFirstResolversMap[]
    | Promise<SchemaFirstResolversMap | SchemaFirstResolversMap[]>;
  /**
   * Apply `transformSchema` before emitting the `autoSchemaFile`.
   */
  transformAutoSchemaFile?: boolean;
  /**
   * Extra static metadata loader hook.
   */
  metadata?: () => Promise<Record<string, unknown>>;
  /**
   * Enable verbose debug logging.
   */
  debug?: boolean;
  /**
   * Stop GraphQL server during `onApplicationShutdown` instead of `onModuleDestroy`.
   */
  stopOnApplicationShutdown?: boolean;
  /**
   * Enable interactive GraphiQL / Playground HTML on `GET <path>`.
   */
  playground?: boolean | Record<string, unknown>;
  /**
   * Alias for `playground`.
   */
  graphiql?: boolean | Record<string, unknown>;
  /**
   * Enable GraphQL introspection queries (`__schema`, `__type`).
   */
  introspection?: boolean;
  /**
   * Maximum allowed selection-set nesting depth (DoS protection).
   */
  maxDepth?: number;
  /**
   * Include stack traces / internal error messages in GraphQL error responses.
   */
  includeStacktraceInErrorResponses?: boolean;
  /**
   * Automatically transform NestJS `HttpException`s into Apollo-compatible GraphQL error extensions.
   * Defaults to `true`.
   */
  autoTransformHttpErrors?: boolean;
  /**
   * Keep HTTP 200 for GraphQL execution errors even when `extensions.http.status` is set.
   * Defaults to `true`.
   */
  preserveHttpStatusForExecutionErrors?: boolean;
  /**
   * Additional GraphQL validation rules appended to the standard validation rule set.
   */
  validationRules?: ValidationRule[];
  /**
   * Custom GraphQL error formatter hook.
   */
  formatError?: (
    formattedError: GraphQLFormattedError,
    error: unknown,
  ) => GraphQLFormattedError;
  /**
   * Enable SSE and/or `graphql-ws` (`graphql-transport-ws`) subscriptions. Defaults to `true`.
   */
  subscriptions?: GraphQLSubscriptionsConfig;
  /**
   * Optional `BunHttpAdapter` for auto-registering the `graphql-ws` WebSocket handler on bootstrap.
   */
  httpAdapter?: BunHttpAdapter;
  /**
   * Global GraphQL `ExceptionFilter`s executed on resolver errors.
   */
  filters?: readonly ExceptionFilterLike[];
  /**
   * Extra `@ObjectType()` / `@InputType()` / `@InterfaceType()` classes to include in generated schema.
   */
  orphanedTypes?: readonly Function[];
  /**
   * Register `GraphQLModule` globally. Defaults to `true`.
   */
  global?: boolean;
}

export interface GqlModuleOptions<
  TDriver extends GraphQLDriver = any,
> extends GraphQLModuleOptions<TDriver> {}

export interface GqlOptionsFactory<
  T extends object = GraphQLModuleOptions,
> {
  createGqlOptions(): Promise<Omit<T, "driver">> | Omit<T, "driver">;
}

export interface GraphQLModuleAsyncOptions<
  TOptions extends Record<string, any> = GraphQLModuleOptions,
  TFactory = GqlOptionsFactory<TOptions>,
> {
  /**
   * Endpoint path bound to the GraphQL controller (defaults to `"/graphql"`).
   */
  path?: string;
  driver?: TOptions["driver"];
  imports?: ModuleImport[];
  inject?: InjectionToken[];
  useExisting?: Type<TFactory>;
  useClass?: Type<TFactory>;
  useFactory?: (
    ...args: any[]
  ) => Omit<TOptions, "driver"> | Promise<Omit<TOptions, "driver">>;
  global?: boolean;
}

export interface GqlModuleAsyncOptions<
  TOptions extends Record<string, any> = GraphQLModuleOptions,
  TFactory = GqlOptionsFactory<TOptions>,
> extends GraphQLModuleAsyncOptions<TOptions, TFactory> {}

export interface GraphQLRequestPayload {
  readonly query: string;
  readonly variables?: Record<string, unknown> | null;
  readonly operationName?: string | null;
}
