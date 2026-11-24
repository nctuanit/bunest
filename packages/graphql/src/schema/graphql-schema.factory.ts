import {
  type ArgumentMetadata,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  type ExceptionFilter,
  type ExceptionFilterLike,
  ForbiddenException,
  type GuardLike,
  Injectable,
  type InterceptorLike,
  METADATA_KEYS,
  MetadataRegistry,
  Optional,
  type PipeLike,
  type PipeTransform,
  type Type,
} from "@bunest/core";
import {
  buildASTSchema,
  defaultFieldResolver,
  type GraphQLArgumentConfig,
  GraphQLBoolean,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigMap,
  type GraphQLFieldResolver,
  GraphQLFloat,
  type GraphQLInputFieldConfig,
  type GraphQLInputFieldConfigMap,
  GraphQLInputObjectType,
  type GraphQLInputType,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLList,
  type GraphQLNamedType,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLResolveInfo,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  GraphQLUnionType,
  isInputType,
  isObjectType,
  isOutputType,
  lexicographicSortSchema,
  parse,
  printSchema,
} from "../engine";
import { GRAPHQL_METADATA_KEYS, GRAPHQL_SDL_FILE_END } from "../constants";
import { GraphQLExecutionContextHost } from "../context/gql-execution-context";
import {
  getResolverFields,
  getResolverMethodParams,
  getResolverOperations,
} from "../decorators/resolver.decorators";
import {
  getGraphQLDirectives,
  getGraphQLExtensions,
  getGraphQLFields,
  getInterfaceImplementors,
  getRegisteredEnumType,
  getUseFieldMiddleware,
  isUnionTypeRef,
  resolveImplementedInterfaces,
} from "../decorators/type.decorators";
import type {
  BuildSchemaOptions,
  CustomScalar,
  Enhancer,
  FieldMiddleware,
  GqlParamMetadata,
  GraphQLModuleOptions,
  InputTypeMetadata,
  InterfaceTypeMetadata,
  NullableListOption,
  ObjectTypeMetadata,
  ResolveFieldMetadata,
  ResolverMetadata,
  ResolverOperationMetadata,
  ReturnTypeFuncValue,
  ScalarMetadata,
  SchemaFileConfig,
  SchemaFirstResolversMap,
  UnionTypeRef,
} from "../interfaces/graphql.interface";
import { GraphQLISODateTime, GraphQLTimestamp } from "../scalars";
import { GraphQLTypesLoader } from "./graphql-types.loader";

export type GqlEnhancerResolverFn = <T = unknown>(
  enhancer: Type<T> | T,
) => T | Promise<T>;

function defaultEnhancerResolver<T = unknown>(enhancer: Type<T> | T): T {
  if (typeof enhancer === "function") {
    return new (enhancer as Type<T>)();
  }
  return enhancer;
}

interface CompiledGqlFilter {
  readonly filter: ExceptionFilter;
  readonly catchTypes: readonly Type<any>[];
}

function extractGqlFilterCatchTypes(
  filterLike: ExceptionFilterLike,
  resolved: ExceptionFilter,
): readonly Type<any>[] {
  const ctors: Function[] = [];
  if (typeof filterLike === "function") {
    ctors.push(filterLike);
  } else if (filterLike && typeof filterLike === "object") {
    const c = (filterLike as { constructor?: Function }).constructor;
    if (c) ctors.push(c);
  }
  const resolvedCtor = (resolved as { constructor?: Function })?.constructor;
  if (resolvedCtor && !ctors.includes(resolvedCtor)) {
    ctors.push(resolvedCtor);
  }
  for (const ctor of ctors) {
    const caught = MetadataRegistry.get<readonly Type<any>[]>(
      METADATA_KEYS.CATCH_EXCEPTIONS,
      ctor,
    );
    if (caught && caught.length > 0) {
      return caught;
    }
  }
  return [];
}

function matchesGqlFilter(
  error: unknown,
  catchTypes: readonly Type<any>[],
): boolean {
  if (catchTypes.length === 0) {
    return true;
  }
  return catchTypes.some(
    (ctor) => typeof ctor === "function" && error instanceof ctor,
  );
}

interface CompiledGqlMethod {
  readonly resolverClass: Type<unknown>;
  readonly instance: object;
  readonly handlerKey: string | symbol;
  readonly handlerFn: Function;
  readonly params: readonly GqlParamMetadata[];
  readonly argCount: number;
  readonly guards: readonly CanActivate[];
  readonly interceptors: readonly BunestInterceptor[];
  readonly sharedPipes: readonly PipeTransform[];
  readonly paramPipes: readonly (readonly PipeTransform[])[];
  readonly filters: readonly CompiledGqlFilter[];
}

function wrapOutputNullability(
  inner: GraphQLOutputType,
  isListDepth: number,
  nullable: NullableListOption | undefined,
): GraphQLOutputType {
  if (isListDepth === 0) {
    return nullable === true ? inner : new GraphQLNonNull(inner);
  }

  const nullableItems = nullable === "items" || nullable === "itemsAndList";
  const nullableList = nullable === true || nullable === "itemsAndList";

  let wrapped: GraphQLOutputType = nullableItems
    ? inner
    : new GraphQLNonNull(inner);

  for (let d = 0; d < isListDepth; d++) {
    wrapped = new GraphQLList(wrapped);
    if (d < isListDepth - 1 && !nullableItems) {
      wrapped = new GraphQLNonNull(wrapped);
    }
  }

  if (!nullableList) {
    wrapped = new GraphQLNonNull(wrapped);
  }

  return wrapped;
}

function wrapInputNullability(
  inner: GraphQLInputType,
  isListDepth: number,
  nullable: NullableListOption | undefined,
): GraphQLInputType {
  if (isListDepth === 0) {
    return nullable === true ? inner : new GraphQLNonNull(inner);
  }

  const nullableItems = nullable === "items" || nullable === "itemsAndList";
  const nullableList = nullable === true || nullable === "itemsAndList";

  let wrapped: GraphQLInputType = nullableItems
    ? inner
    : new GraphQLNonNull(inner);

  for (let d = 0; d < isListDepth; d++) {
    wrapped = new GraphQLList(wrapped);
    if (d < isListDepth - 1 && !nullableItems) {
      wrapped = new GraphQLNonNull(wrapped);
    }
  }

  if (!nullableList) {
    wrapped = new GraphQLNonNull(wrapped);
  }

  return wrapped;
}

function unwrapListMeta(value: ReturnTypeFuncValue): {
  base: unknown;
  listDepth: number;
} {
  let current: unknown = value;
  let listDepth = 0;
  while (Array.isArray(current)) {
    listDepth++;
    current = current[0];
  }
  return { base: current, listDepth };
}

function isPlainThunk(value: unknown): value is () => Function {
  if (typeof value !== "function") return false;
  if (value.prototype === undefined) return true;
  const src = Function.prototype.toString.call(value).trimStart();
  if (src.startsWith("class ") || src.startsWith("class{")) return false;
  return (
    !MetadataRegistry.has(GRAPHQL_METADATA_KEYS.OBJECT_TYPE, value) &&
    !MetadataRegistry.has(GRAPHQL_METADATA_KEYS.INTERFACE_TYPE, value) &&
    !MetadataRegistry.has(GRAPHQL_METADATA_KEYS.INPUT_TYPE, value) &&
    value.length === 0
  );
}

function applyFieldMiddleware(
  middlewares: readonly FieldMiddleware[],
  baseResolver: GraphQLFieldResolver<any, any>,
): GraphQLFieldResolver<any, any> {
  if (middlewares.length === 0) {
    return baseResolver;
  }
  return (source, args, context, info) => {
    const ctx = {
      source,
      args: args ?? {},
      context: context ?? {},
      info,
    };
    const dispatch = (index: number): Promise<unknown> => {
      if (index >= middlewares.length) {
        return Promise.resolve(baseResolver(source, args, context, info));
      }
      const mw = middlewares[index]!;
      return Promise.resolve(mw(ctx, () => dispatch(index + 1)));
    };
    return dispatch(0);
  };
}

function resolveAutoSchemaFilePath(
  autoSchemaFile: GraphQLModuleOptions["autoSchemaFile"],
): string | undefined {
  if (typeof autoSchemaFile === "string") {
    return autoSchemaFile;
  }
  if (
    autoSchemaFile &&
    typeof autoSchemaFile === "object" &&
    typeof (autoSchemaFile as SchemaFileConfig).path === "string"
  ) {
    return (autoSchemaFile as SchemaFileConfig).path;
  }
  return undefined;
}

function remapInputValue(
  value: unknown,
  rawType: unknown,
  keepOriginalKeys = false,
): unknown {
  if (value === null || value === undefined || rawType === undefined) {
    return value;
  }

  if (Array.isArray(rawType)) {
    if (!Array.isArray(value)) {
      return value;
    }
    const innerType = rawType[0];
    return value.map((item) =>
      remapInputValue(item, innerType, keepOriginalKeys),
    );
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  if (typeof rawType !== "function") {
    return value;
  }

  const fields = getGraphQLFields(rawType);
  if (fields.length === 0) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const schemaNameToField = new Map<string, (typeof fields)[number]>();
  for (const f of fields) {
    schemaNameToField.set(f.name ?? f.propertyKey, f);
  }

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (keepOriginalKeys || !schemaNameToField.has(key)) {
      result[key] = record[key];
    }
  }
  for (const [schemaName, field] of schemaNameToField) {
    if (Object.prototype.hasOwnProperty.call(record, schemaName)) {
      const fieldRawType = field.typeFn ? field.typeFn() : field.designType;
      result[field.propertyKey] = remapInputValue(
        record[schemaName],
        fieldRawType,
        keepOriginalKeys,
      );
    }
  }

  return result;
}

function remapSubscriptionArgs(
  args: Record<string, unknown>,
  params: readonly GqlParamMetadata[],
): Record<string, unknown> {
  if (!args || params.length === 0) return args;
  let mapped: Record<string, unknown> = { ...args };
  for (const param of params) {
    if (param.source !== "args") continue;
    const rawType = param.typeFn ? param.typeFn() : param.metatype;
    if (param.key !== undefined) {
      if (Object.prototype.hasOwnProperty.call(mapped, param.key)) {
        mapped[param.key] = remapInputValue(mapped[param.key], rawType, true);
      }
    } else {
      mapped = remapInputValue(mapped, rawType, true) as Record<
        string,
        unknown
      >;
    }
  }
  return mapped;
}

export interface GqlGlobalEnhancers {
  readonly pipes?: readonly PipeLike[];
  readonly guards?: readonly GuardLike[];
  readonly interceptors?: readonly InterceptorLike[];
  readonly filters?: readonly ExceptionFilterLike[];
}

/**
 * Compiles code-first (`@ObjectType`, `@InterfaceType`, `createUnionType`,
 * `@InputType`, `@ArgsType`, `@Resolver`, `@Query`, `@Mutation`, `@Subscription`,
 * `@ResolveField`) AND/OR schema-first (`typeDefs` / `typePaths`) metadata into
 * an executable `GraphQLSchema` with full Bunest Guards/Pipes/Interceptors/Filters
 * and `FieldMiddleware` support.
 */
@Injectable()
export class GraphQLSchemaFactory {
  private readonly objectTypes = new Map<Function, GraphQLObjectType>();
  private readonly interfaceTypes = new Map<Function, GraphQLInterfaceType>();
  private readonly unionTypes = new Map<UnionTypeRef<any>, GraphQLUnionType>();
  private readonly inputTypes = new Map<Function, GraphQLInputObjectType>();
  private readonly customScalarsByType = new Map<unknown, GraphQLScalarType>();
  private readonly discoveredConcreteTypes = new Set<GraphQLNamedType>();
  private readonly resolveFieldRegistry = new Map<
    string,
    Array<{
      readonly meta: ResolveFieldMetadata;
      readonly compiled: CompiledGqlMethod;
    }>
  >();
  private activeGlobalFilters: readonly ExceptionFilterLike[] = [];
  private activeGlobalPipes: readonly PipeLike[] = [];
  private activeGlobalGuards: readonly GuardLike[] = [];
  private activeGlobalInterceptors: readonly InterceptorLike[] = [];
  private activeBuildSchemaOptions: BuildSchemaOptions = {};
  private activeFieldResolverEnhancers?: readonly Enhancer[];
  private readonly typesLoader = new GraphQLTypesLoader();

  constructor(
    @Optional()
    private readonly resolveEnhancer: GqlEnhancerResolverFn = defaultEnhancerResolver,
    @Optional()
    private readonly defaultGlobalFilters: readonly ExceptionFilterLike[] = [],
    @Optional()
    private readonly defaultGlobalEnhancers: GqlGlobalEnhancers = {},
  ) {}

  async create(
    resolverInstances: readonly object[],
    options: GraphQLModuleOptions = {},
    globalFilters: readonly ExceptionFilterLike[] = [],
  ): Promise<GraphQLSchema> {
    this.objectTypes.clear();
    this.interfaceTypes.clear();
    this.unionTypes.clear();
    this.inputTypes.clear();
    this.customScalarsByType.clear();
    this.discoveredConcreteTypes.clear();
    this.resolveFieldRegistry.clear();

    this.activeGlobalFilters = [
      ...(options.filters ?? []),
      ...this.defaultGlobalFilters,
      ...(this.defaultGlobalEnhancers.filters ?? []),
      ...globalFilters,
    ];
    this.activeGlobalPipes = [...(this.defaultGlobalEnhancers.pipes ?? [])];
    this.activeGlobalGuards = [...(this.defaultGlobalEnhancers.guards ?? [])];
    this.activeGlobalInterceptors = [
      ...(this.defaultGlobalEnhancers.interceptors ?? []),
    ];
    this.activeBuildSchemaOptions = options.buildSchemaOptions ?? {};
    this.activeFieldResolverEnhancers = options.fieldResolverEnhancers;

    if (this.activeBuildSchemaOptions.scalarsMap) {
      for (const entry of this.activeBuildSchemaOptions.scalarsMap) {
        if (entry?.type && entry.scalar) {
          this.customScalarsByType.set(entry.type, entry.scalar);
        }
      }
    }

    if (options.schema) {
      return options.transformSchema
        ? await options.transformSchema(options.schema)
        : options.schema;
    }

    if (
      options.typeDefs ||
      (options.typePaths && options.typePaths.length > 0)
    ) {
      return this.buildSchemaFirst(resolverInstances, options);
    }

    return this.buildCodeFirst(resolverInstances, options);
  }

  private async compileMethod(
    instance: object,
    handlerKey: string | symbol,
    isFieldResolver = false,
  ): Promise<CompiledGqlMethod> {
    const resolverClass = instance.constructor as Type<unknown>;
    const handlerFn = (
      resolverClass.prototype as Record<string | symbol, unknown>
    )[handlerKey] as Function;

    const params = getResolverMethodParams(resolverClass, handlerKey);
    const argCount =
      params.length > 0 ? Math.max(...params.map((p) => p.index)) + 1 : 0;

    const enhancers = this.activeFieldResolverEnhancers;
    const enableGuards =
      !isFieldResolver || !enhancers || enhancers.includes("guards");
    const enableInterceptors =
      !isFieldResolver || !enhancers || enhancers.includes("interceptors");
    const enableFilters =
      !isFieldResolver || !enhancers || enhancers.includes("filters");

    const classGuards = enableGuards
      ? MetadataRegistry.getMergedClassArray<GuardLike>(
          METADATA_KEYS.GUARDS,
          resolverClass,
        )
      : [];
    const methodGuards = enableGuards
      ? (MetadataRegistry.get<readonly GuardLike[]>(
          METADATA_KEYS.GUARDS,
          handlerFn,
        ) ?? [])
      : [];

    const classInterceptors = enableInterceptors
      ? MetadataRegistry.getMergedClassArray<InterceptorLike>(
          METADATA_KEYS.INTERCEPTORS,
          resolverClass,
        )
      : [];
    const methodInterceptors = enableInterceptors
      ? (MetadataRegistry.get<readonly InterceptorLike[]>(
          METADATA_KEYS.INTERCEPTORS,
          handlerFn,
        ) ?? [])
      : [];

    const classPipes = MetadataRegistry.getMergedClassArray<PipeLike>(
      METADATA_KEYS.PIPES,
      resolverClass,
    );
    const methodPipes =
      MetadataRegistry.get<readonly PipeLike[]>(
        METADATA_KEYS.PIPES,
        handlerFn,
      ) ?? [];

    const classFilters = enableFilters
      ? MetadataRegistry.getMergedClassArray<ExceptionFilterLike>(
          METADATA_KEYS.EXCEPTION_FILTERS,
          resolverClass,
        )
      : [];
    const methodFilters = enableFilters
      ? (MetadataRegistry.get<readonly ExceptionFilterLike[]>(
          METADATA_KEYS.EXCEPTION_FILTERS,
          handlerFn,
        ) ?? [])
      : [];

    const guards: CanActivate[] = [];
    if (enableGuards) {
      for (const g of [
        ...this.activeGlobalGuards,
        ...classGuards,
        ...methodGuards,
      ]) {
        guards.push(await this.resolveEnhancer<CanActivate>(g));
      }
    }

    const interceptors: BunestInterceptor[] = [];
    if (enableInterceptors) {
      for (const ic of [
        ...this.activeGlobalInterceptors,
        ...classInterceptors,
        ...methodInterceptors,
      ]) {
        interceptors.push(await this.resolveEnhancer<BunestInterceptor>(ic));
      }
    }

    const sharedPipes: PipeTransform[] = [];
    for (const p of [
      ...this.activeGlobalPipes,
      ...classPipes,
      ...methodPipes,
    ]) {
      sharedPipes.push(await this.resolveEnhancer<PipeTransform>(p));
    }

    const paramPipes: PipeTransform[][] = [];
    for (const param of params) {
      const list: PipeTransform[] = [];
      for (const p of param.pipes ?? []) {
        list.push(await this.resolveEnhancer<PipeTransform>(p));
      }
      paramPipes.push(list);
    }

    // Precedence: method filters -> class filters -> global filters
    const filters: CompiledGqlFilter[] = [];
    if (enableFilters) {
      for (const f of [
        ...methodFilters,
        ...classFilters,
        ...this.activeGlobalFilters,
      ]) {
        const resolved = await this.resolveEnhancer<ExceptionFilter>(f);
        filters.push({
          filter: resolved,
          catchTypes: extractGqlFilterCatchTypes(f, resolved),
        });
      }
    }

    return {
      resolverClass,
      instance,
      handlerKey,
      handlerFn,
      params,
      argCount,
      guards,
      interceptors,
      sharedPipes,
      paramPipes,
      filters,
    };
  }

  private createResolverFn(compiled: CompiledGqlMethod) {
    return async (
      parent: unknown,
      rawArgs: Record<string, unknown>,
      contextValue: Record<string, unknown>,
      info: GraphQLResolveInfo,
    ): Promise<unknown> => {
      const ctxObj = contextValue ?? {};
      const argsObj = rawArgs ?? {};

      const executionContext = new GraphQLExecutionContextHost(
        parent,
        argsObj,
        ctxObj,
        info,
        compiled.resolverClass,
        compiled.handlerFn,
        compiled.handlerKey,
      );

      try {
        // 1. Guards (Resolver -> Method)
        for (let i = 0; i < compiled.guards.length; i++) {
          const guard = compiled.guards[i];
          if (!guard) continue;
          const allowed = await guard.canActivate(executionContext);
          if (!allowed) {
            throw new ForbiddenException("Forbidden resource");
          }
        }

        // 2. Interceptors wrapping Parameter Extraction -> Pipes -> Resolver Method
        const invokeInner = async (): Promise<unknown> => {
          let callArgs: unknown[];

          if (compiled.params.length === 0) {
            callArgs = [];
          } else {
            callArgs = new Array<unknown>(compiled.argCount);
            for (let i = 0; i < compiled.params.length; i++) {
              const param = compiled.params[i];
              if (!param) continue;

              if (param.source === "parent") {
                callArgs[param.index] = parent;
                continue;
              }
              if (param.source === "info") {
                callArgs[param.index] = info;
                continue;
              }
              if (param.source === "context") {
                callArgs[param.index] =
                  param.key !== undefined ? ctxObj[param.key] : ctxObj;
                continue;
              }

              // `args` source
              const rawArgType = param.typeFn ? param.typeFn() : param.metatype;
              let value =
                param.key !== undefined
                  ? remapInputValue(argsObj[param.key], rawArgType)
                  : remapInputValue({ ...argsObj }, rawArgType);

              const argMeta: ArgumentMetadata = {
                type: "body",
                metatype: param.metatype,
                data: param.key,
              };

              for (let p = 0; p < compiled.sharedPipes.length; p++) {
                const pipe = compiled.sharedPipes[p];
                if (pipe) {
                  value = await pipe.transform(value, argMeta);
                }
              }

              const pPipes = compiled.paramPipes[i];
              if (pPipes) {
                for (let p = 0; p < pPipes.length; p++) {
                  const pipe = pPipes[p];
                  if (pipe) {
                    value = await pipe.transform(value, argMeta);
                  }
                }
              }

              callArgs[param.index] = value;
            }
          }

          return await (
            compiled.handlerFn as (...a: unknown[]) => unknown
          ).apply(compiled.instance, callArgs);
        };

        if (compiled.interceptors.length === 0) {
          return await invokeInner();
        }

        let nextHandler: CallHandler = { handle: invokeInner };
        for (let i = compiled.interceptors.length - 1; i >= 0; i--) {
          const interceptor = compiled.interceptors[i];
          if (!interceptor) continue;
          const currentNext = nextHandler;
          nextHandler = {
            handle: () =>
              Promise.resolve(
                interceptor.intercept(executionContext, currentNext),
              ),
          };
        }
        return await nextHandler.handle();
      } catch (err) {
        for (let i = 0; i < compiled.filters.length; i++) {
          const entry = compiled.filters[i];
          if (!entry) continue;
          if (!matchesGqlFilter(err, entry.catchTypes)) {
            continue;
          }
          return await entry.filter.catch(err, executionContext);
        }
        throw err;
      }
    };
  }

  private createSubscriptionField(
    op: ResolverOperationMetadata,
    compiled: CompiledGqlMethod,
    outputType: GraphQLOutputType,
    argsConfig: Record<string, GraphQLArgumentConfig>,
  ): GraphQLFieldConfig<any, any> {
    const baseSubscribe = this.createResolverFn(compiled);

    const subscribe = async (
      parent: unknown,
      args: Record<string, unknown>,
      contextValue: Record<string, unknown>,
      info: GraphQLResolveInfo,
    ): Promise<AsyncIterableIterator<unknown>> => {
      const iterable = (await baseSubscribe(
        parent,
        args,
        contextValue,
        info,
      )) as AsyncIterable<unknown>;

      if (!iterable || typeof iterable[Symbol.asyncIterator] !== "function") {
        throw new Error(
          `Subscription "${op.name}" must return an AsyncIterable / AsyncIterator.`,
        );
      }

      const sourceIter = iterable[Symbol.asyncIterator]();
      if (!op.filter) {
        // Return an AsyncIterableIterator wrapper guaranteeing return() propagation
        const passthrough: AsyncIterableIterator<unknown> = {
          [Symbol.asyncIterator]() {
            return passthrough;
          },
          next: () => sourceIter.next(),
          return: () =>
            typeof sourceIter.return === "function"
              ? sourceIter.return()
              : Promise.resolve({ value: undefined, done: true }),
          throw: (err) =>
            typeof sourceIter.throw === "function"
              ? sourceIter.throw(err)
              : Promise.reject(err),
        };
        return passthrough;
      }

      const filterFn = op.filter;
      let closed = false;
      const filtered: AsyncIterableIterator<unknown> = {
        [Symbol.asyncIterator]() {
          return filtered;
        },
        async next(): Promise<IteratorResult<unknown>> {
          while (!closed) {
            const step = await sourceIter.next();
            if (step.done) {
              return { value: undefined, done: true };
            }
            const ok = await filterFn(
              step.value,
              remapSubscriptionArgs(args, compiled.params),
              contextValue,
              info,
            );
            if (ok) {
              return { value: step.value, done: false };
            }
          }
          return { value: undefined, done: true };
        },
        async return(): Promise<IteratorResult<unknown>> {
          closed = true;
          if (typeof sourceIter.return === "function") {
            await sourceIter.return();
          }
          return { value: undefined, done: true };
        },
        async throw(err?: unknown): Promise<IteratorResult<unknown>> {
          closed = true;
          if (typeof sourceIter.return === "function") {
            await sourceIter.return();
          }
          return Promise.reject(err);
        },
      };

      return filtered;
    };

    const resolve = op.resolve
      ? (
          payload: unknown,
          args: Record<string, unknown>,
          contextValue: Record<string, unknown>,
          info: GraphQLResolveInfo,
        ) =>
          op.resolve!(
            payload,
            remapSubscriptionArgs(args, compiled.params),
            contextValue,
            info,
          )
      : (payload: unknown) => {
          if (
            payload !== null &&
            typeof payload === "object" &&
            op.name in (payload as Record<string, unknown>)
          ) {
            return (payload as Record<string, unknown>)[op.name];
          }
          return payload;
        };

    return {
      type: outputType,
      description: op.description,
      deprecationReason: op.deprecationReason,
      args: argsConfig,
      subscribe,
      resolve,
    };
  }

  private resolveTargetTypeName(meta: ResolverMetadata): string | undefined {
    if (!meta.of) return undefined;
    const resolved = isPlainThunk(meta.of) ? meta.of() : meta.of;
    if (typeof resolved !== "function") return undefined;
    const objMeta = MetadataRegistry.getOwn<ObjectTypeMetadata>(
      GRAPHQL_METADATA_KEYS.OBJECT_TYPE,
      resolved,
    );
    if (objMeta) return objMeta.name;
    const ifaceMeta = MetadataRegistry.getOwn<InterfaceTypeMetadata>(
      GRAPHQL_METADATA_KEYS.INTERFACE_TYPE,
      resolved,
    );
    if (ifaceMeta) return ifaceMeta.name;
    return resolved.name;
  }

  private resolveOutputType(
    raw: ReturnTypeFuncValue | undefined,
    nullable: NullableListOption | undefined,
  ): GraphQLOutputType {
    if (raw === undefined) {
      return wrapOutputNullability(GraphQLString, 0, nullable);
    }

    const { base, listDepth } = unwrapListMeta(raw);
    const leaf = this.resolveOutputLeaf(base);
    return wrapOutputNullability(leaf, listDepth, nullable);
  }

  private resolveOutputLeaf(base: unknown): GraphQLOutputType {
    if (base instanceof GraphQLScalarType || isOutputType(base)) {
      return base as GraphQLOutputType;
    }

    const mappedScalar = this.customScalarsByType.get(base);
    if (mappedScalar) {
      return mappedScalar;
    }

    if (isUnionTypeRef(base)) {
      return this.getOrCreateUnionType(base);
    }

    const enumType = getRegisteredEnumType(base);
    if (enumType) {
      return enumType;
    }

    if (base === String) return GraphQLString;
    if (base === Number) {
      return this.activeBuildSchemaOptions.numberScalarMode === "integer"
        ? GraphQLInt
        : GraphQLFloat;
    }
    if (base === Boolean) return GraphQLBoolean;
    if (base === Date) {
      return this.activeBuildSchemaOptions.dateScalarMode === "timestamp"
        ? GraphQLTimestamp
        : GraphQLISODateTime;
    }

    if (typeof base === "function") {
      if (
        MetadataRegistry.hasOwn(GRAPHQL_METADATA_KEYS.INTERFACE_TYPE, base) &&
        !MetadataRegistry.hasOwn(GRAPHQL_METADATA_KEYS.OBJECT_TYPE, base)
      ) {
        return this.getOrCreateInterfaceType(base);
      }
      return this.getOrCreateObjectType(base);
    }

    return GraphQLString;
  }

  private resolveTypeNameFromResult(
    resolved: string | Function | null | undefined,
  ): string | undefined {
    if (typeof resolved === "string") {
      return resolved;
    }
    if (typeof resolved === "function") {
      const objMeta = MetadataRegistry.getOwn<ObjectTypeMetadata>(
        GRAPHQL_METADATA_KEYS.OBJECT_TYPE,
        resolved,
      );
      return objMeta?.name ?? resolved.name;
    }
    return undefined;
  }

  private resolveDefaultConcreteTypeName(
    value: unknown,
    candidates: readonly Function[],
  ): string | undefined {
    if (value && typeof value === "object") {
      const typename = (value as { __typename?: unknown }).__typename;
      if (typeof typename === "string" && typename.length > 0) {
        return typename;
      }
      for (const candidate of candidates) {
        if (value instanceof candidate) {
          return this.resolveTypeNameFromResult(candidate);
        }
      }
      const ctor = (value as { constructor?: Function }).constructor;
      if (ctor && ctor !== Object) {
        const objMeta = MetadataRegistry.getOwn<ObjectTypeMetadata>(
          GRAPHQL_METADATA_KEYS.OBJECT_TYPE,
          ctor,
        );
        if (objMeta) {
          return objMeta.name;
        }
      }
    }
    return undefined;
  }

  private getOrCreateInterfaceType(cls: Function): GraphQLInterfaceType {
    const existing = this.interfaceTypes.get(cls);
    if (existing) {
      return existing;
    }

    const meta = MetadataRegistry.getOwn<InterfaceTypeMetadata>(
      GRAPHQL_METADATA_KEYS.INTERFACE_TYPE,
      cls,
    );
    const typeName = meta?.name ?? cls.name;

    // Ensure concrete implementing @ObjectType classes are included in schema `types`
    const implementors = getInterfaceImplementors(cls);

    const ifaceType = new GraphQLInterfaceType({
      name: typeName,
      description: meta?.description,
      interfaces: () =>
        resolveImplementedInterfaces(meta?.implements).map((parentIface) =>
          this.getOrCreateInterfaceType(parentIface),
        ),
      resolveType: async (value, context, info) => {
        if (meta?.resolveType) {
          const custom = await meta.resolveType(value, context, info);
          const name = this.resolveTypeNameFromResult(custom);
          if (name) return name;
        }
        return this.resolveDefaultConcreteTypeName(
          value,
          getInterfaceImplementors(cls),
        );
      },
      fields: () => {
        const fields: GraphQLFieldConfigMap<any, any> = {};
        for (const fieldMeta of getGraphQLFields(cls)) {
          const rawType = fieldMeta.typeFn
            ? fieldMeta.typeFn()
            : (fieldMeta.designType as ReturnTypeFuncValue | undefined);
          fields[fieldMeta.name ?? fieldMeta.propertyKey] = {
            type: this.resolveOutputType(rawType, fieldMeta.nullable),
            description: fieldMeta.description,
            deprecationReason: fieldMeta.deprecationReason,
          };
        }
        return fields;
      },
    });

    this.interfaceTypes.set(cls, ifaceType);
    for (const impl of implementors) {
      this.discoveredConcreteTypes.add(this.getOrCreateObjectType(impl));
    }
    return ifaceType;
  }

  private getOrCreateUnionType(ref: UnionTypeRef<any>): GraphQLUnionType {
    const existing = this.unionTypes.get(ref);
    if (existing) {
      return existing;
    }

    const unionType = new GraphQLUnionType({
      name: ref.name,
      description: ref.description,
      types: () =>
        (ref.types() as readonly Function[]).map((t) =>
          this.getOrCreateObjectType(t),
        ),
      resolveType: async (value, context, info) => {
        if (ref.resolveType) {
          const custom = await ref.resolveType(value, context, info);
          const name = this.resolveTypeNameFromResult(custom);
          if (name) return name;
        }
        return this.resolveDefaultConcreteTypeName(value, ref.types());
      },
    });

    this.unionTypes.set(ref, unionType);
    return unionType;
  }

  private resolveInputType(
    raw: ReturnTypeFuncValue | undefined,
    nullable: NullableListOption | undefined,
  ): GraphQLInputType {
    if (raw === undefined) {
      return wrapInputNullability(GraphQLString, 0, nullable);
    }

    const { base, listDepth } = unwrapListMeta(raw);
    const leaf = this.resolveInputLeaf(base);
    return wrapInputNullability(leaf, listDepth, nullable);
  }

  private resolveInputLeaf(base: unknown): GraphQLInputType {
    if (base instanceof GraphQLScalarType || isInputType(base)) {
      return base as GraphQLInputType;
    }

    const mappedScalar = this.customScalarsByType.get(base);
    if (mappedScalar) {
      return mappedScalar;
    }

    const enumType = getRegisteredEnumType(base);
    if (enumType) {
      return enumType;
    }

    if (base === String) return GraphQLString;
    if (base === Number) {
      return this.activeBuildSchemaOptions.numberScalarMode === "integer"
        ? GraphQLInt
        : GraphQLFloat;
    }
    if (base === Boolean) return GraphQLBoolean;
    if (base === Date) {
      return this.activeBuildSchemaOptions.dateScalarMode === "timestamp"
        ? GraphQLTimestamp
        : GraphQLISODateTime;
    }

    if (typeof base === "function") {
      return this.getOrCreateInputType(base);
    }

    return GraphQLString;
  }

  private getOrCreateObjectType(cls: Function): GraphQLObjectType {
    const existing = this.objectTypes.get(cls);
    if (existing) {
      return existing;
    }

    const meta = MetadataRegistry.getOwn<ObjectTypeMetadata>(
      GRAPHQL_METADATA_KEYS.OBJECT_TYPE,
      cls,
    );
    const typeName = meta?.name ?? cls.name;

    // Support `inheritDescription` walking up prototype chain if own description is unset
    let resolvedDescription = meta?.description;
    if (resolvedDescription === undefined) {
      const chain = MetadataRegistry.getPrototypeChain(cls);
      for (let i = chain.length - 2; i >= 0; i--) {
        const parentMeta = MetadataRegistry.getOwn<ObjectTypeMetadata>(
          GRAPHQL_METADATA_KEYS.OBJECT_TYPE,
          chain[i]!,
        );
        if (parentMeta?.inheritDescription && parentMeta.description) {
          resolvedDescription = parentMeta.description;
          break;
        }
      }
    }

    const objExtensions = getGraphQLExtensions(cls);
    const objDirectives = getGraphQLDirectives(cls);
    const mergedObjExtensions =
      objExtensions || objDirectives.length > 0
        ? {
            ...(objExtensions ?? {}),
            ...(objDirectives.length > 0 ? { directives: objDirectives } : {}),
          }
        : undefined;

    const globalMiddleware =
      this.activeBuildSchemaOptions.fieldMiddleware ?? [];

    // Lazy `fields: () => ({ ... })` thunk breaks circular object type references natively!
    const objType = new GraphQLObjectType({
      name: typeName,
      description: resolvedDescription,
      ...(mergedObjExtensions ? { extensions: mergedObjExtensions } : {}),
      interfaces: () =>
        resolveImplementedInterfaces(meta?.implements).map((iface) =>
          this.getOrCreateInterfaceType(iface),
        ),
      fields: () => {
        const fields: GraphQLFieldConfigMap<any, any> = {};

        // Inherit fields from implemented @InterfaceType() classes first (overridable by own fields)
        for (const iface of resolveImplementedInterfaces(meta?.implements)) {
          for (const fieldMeta of getGraphQLFields(iface)) {
            const rawType = fieldMeta.typeFn
              ? fieldMeta.typeFn()
              : (fieldMeta.designType as ReturnTypeFuncValue | undefined);
            const ifaceUseMw = getUseFieldMiddleware(iface, fieldMeta.propertyKey);
            const clsUseMw = getUseFieldMiddleware(cls, fieldMeta.propertyKey);
            const combinedUseMw =
              cls.prototype instanceof iface
                ? clsUseMw
                : [...ifaceUseMw, ...clsUseMw];
            const fieldMw: FieldMiddleware[] = [
              ...globalMiddleware,
              ...(fieldMeta.middleware ?? []),
              ...combinedUseMw,
            ];
            const baseResolve: GraphQLFieldResolver<any, any> =
              fieldMeta.name && fieldMeta.name !== fieldMeta.propertyKey
                ? (parent: Record<string, unknown>) =>
                    parent?.[fieldMeta.propertyKey]
                : defaultFieldResolver;
            fields[fieldMeta.name ?? fieldMeta.propertyKey] = {
              type: this.resolveOutputType(rawType, fieldMeta.nullable),
              description: fieldMeta.description,
              deprecationReason: fieldMeta.deprecationReason,
              resolve:
                fieldMw.length > 0
                  ? applyFieldMiddleware(fieldMw, baseResolve)
                  : fieldMeta.name && fieldMeta.name !== fieldMeta.propertyKey
                    ? baseResolve
                    : undefined,
            };
          }
        }

        for (const fieldMeta of getGraphQLFields(cls)) {
          const rawType = fieldMeta.typeFn
            ? fieldMeta.typeFn()
            : (fieldMeta.designType as ReturnTypeFuncValue | undefined);
          const fieldExt = getGraphQLExtensions(cls, fieldMeta.propertyKey);
          const fieldDirs = getGraphQLDirectives(cls, fieldMeta.propertyKey);
          const mergedFieldExt =
            fieldExt ||
            fieldDirs.length > 0 ||
            fieldMeta.complexity !== undefined
              ? {
                  ...(fieldExt ?? {}),
                  ...(fieldDirs.length > 0 ? { directives: fieldDirs } : {}),
                  ...(fieldMeta.complexity !== undefined
                    ? { complexity: fieldMeta.complexity }
                    : {}),
                }
              : undefined;
          const fieldMw: FieldMiddleware[] = [
            ...globalMiddleware,
            ...(fieldMeta.middleware ?? []),
            ...getUseFieldMiddleware(cls, fieldMeta.propertyKey),
          ];
          const baseResolve: GraphQLFieldResolver<any, any> =
            fieldMeta.name && fieldMeta.name !== fieldMeta.propertyKey
              ? (parent: Record<string, unknown>) =>
                  parent?.[fieldMeta.propertyKey]
              : defaultFieldResolver;

          fields[fieldMeta.name ?? fieldMeta.propertyKey] = {
            type: this.resolveOutputType(rawType, fieldMeta.nullable),
            description: fieldMeta.description,
            deprecationReason: fieldMeta.deprecationReason,
            ...(mergedFieldExt ? { extensions: mergedFieldExt } : {}),
            resolve:
              fieldMw.length > 0
                ? applyFieldMiddleware(fieldMw, baseResolve)
                : fieldMeta.name && fieldMeta.name !== fieldMeta.propertyKey
                  ? baseResolve
                  : undefined,
          };
        }

        // Attach @ResolveField() methods targeting this @ObjectType
        const fieldResolvers = this.resolveFieldRegistry.get(typeName) ?? [];
        for (const { meta: rfMeta, compiled } of fieldResolvers) {
          const existingField = fields[rfMeta.name];
          let fieldType: GraphQLOutputType;
          if (rfMeta.returnTypeFn) {
            fieldType = this.resolveOutputType(
              rfMeta.returnTypeFn(),
              rfMeta.nullable,
            );
          } else if (existingField?.type) {
            fieldType = existingField.type;
          } else {
            const designReturn = MetadataRegistry.getReturnType(
              compiled.resolverClass.prototype,
              rfMeta.handlerKey,
            );
            fieldType =
              designReturn &&
              designReturn !== Object &&
              designReturn !== Promise
                ? this.resolveOutputType(
                    designReturn as ReturnTypeFuncValue,
                    rfMeta.nullable,
                  )
                : GraphQLString;
          }
          const argsConfig = this.buildArgsConfig(compiled.params);
          const rfMw: FieldMiddleware[] = [
            ...globalMiddleware,
            ...(rfMeta.middleware ?? []),
            ...getUseFieldMiddleware(compiled.resolverClass, rfMeta.handlerKey),
          ];
          const baseResolve = this.createResolverFn(compiled);

          fields[rfMeta.name] = {
            type: fieldType,
            description: rfMeta.description ?? existingField?.description,
            deprecationReason:
              rfMeta.deprecationReason ?? existingField?.deprecationReason,
            args: argsConfig,
            ...(rfMeta.complexity !== undefined
              ? {
                  extensions: {
                    ...(existingField?.extensions ?? {}),
                    complexity: rfMeta.complexity,
                  },
                }
              : {}),
            resolve:
              rfMw.length > 0
                ? applyFieldMiddleware(rfMw, baseResolve)
                : baseResolve,
          };
        }

        return fields;
      },
    });

    this.objectTypes.set(cls, objType);
    return objType;
  }

  private getOrCreateInputType(cls: Function): GraphQLInputObjectType {
    const existing = this.inputTypes.get(cls);
    if (existing) {
      return existing;
    }

    const meta = MetadataRegistry.get<InputTypeMetadata>(
      GRAPHQL_METADATA_KEYS.INPUT_TYPE,
      cls,
    );
    const typeName = meta?.name ?? cls.name;

    const inputType = new GraphQLInputObjectType({
      name: typeName,
      description: meta?.description,
      ...(meta?.isOneOf ? { isOneOf: true } : {}),
      fields: () => {
        const fields: GraphQLInputFieldConfigMap = {};
        for (const fieldMeta of getGraphQLFields(cls)) {
          const rawType = fieldMeta.typeFn
            ? fieldMeta.typeFn()
            : (fieldMeta.designType as ReturnTypeFuncValue | undefined);
          const config: GraphQLInputFieldConfig = {
            type: this.resolveInputType(rawType, fieldMeta.nullable),
            description: fieldMeta.description,
            defaultValue: fieldMeta.defaultValue,
            deprecationReason: fieldMeta.deprecationReason,
          };
          fields[fieldMeta.name ?? fieldMeta.propertyKey] = config;
        }
        return fields;
      },
    });

    this.inputTypes.set(cls, inputType);
    return inputType;
  }

  private buildArgsConfig(
    params: readonly GqlParamMetadata[],
  ): Record<string, GraphQLArgumentConfig> {
    const argsConfig: Record<string, GraphQLArgumentConfig> = {};

    for (let i = 0; i < params.length; i++) {
      const param = params[i];
      if (!param || param.source !== "args") continue;

      // Expand `@ArgsType()` class properties directly into GraphQL field arguments
      if (
        param.key === undefined &&
        param.metatype &&
        MetadataRegistry.get<boolean>(
          GRAPHQL_METADATA_KEYS.ARGS_TYPE,
          param.metatype,
        ) === true
      ) {
        for (const fieldMeta of getGraphQLFields(param.metatype)) {
          const rawType = fieldMeta.typeFn
            ? fieldMeta.typeFn()
            : (fieldMeta.designType as ReturnTypeFuncValue | undefined);
          argsConfig[fieldMeta.name ?? fieldMeta.propertyKey] = {
            type: this.resolveInputType(rawType, fieldMeta.nullable),
            description: fieldMeta.description,
            defaultValue: fieldMeta.defaultValue,
          };
        }
        continue;
      }

      if (param.key !== undefined) {
        const rawType = param.typeFn
          ? param.typeFn()
          : (param.metatype as ReturnTypeFuncValue | undefined);
        argsConfig[param.key] = {
          type: this.resolveInputType(rawType, param.nullable),
          description: param.description,
          defaultValue: param.defaultValue,
          ...(param.deprecationReason !== undefined
            ? { deprecationReason: param.deprecationReason }
            : {}),
        };
      }
    }

    return argsConfig;
  }

  private async buildCodeFirst(
    resolverInstances: readonly object[],
    options: GraphQLModuleOptions,
  ): Promise<GraphQLSchema> {
    const queryFields: GraphQLFieldConfigMap<any, any> = {};
    const mutationFields: GraphQLFieldConfigMap<any, any> = {};
    const subscriptionFields: GraphQLFieldConfigMap<any, any> = {};

    // Pre-pass: register custom @Scalar() providers before resolving any field types
    const customScalars: GraphQLScalarType[] = [];
    for (const instance of resolverInstances) {
      const ctor = instance.constructor as Type<unknown>;
      const scalarMeta = MetadataRegistry.get<ScalarMetadata>(
        GRAPHQL_METADATA_KEYS.SCALAR,
        ctor,
      );
      if (scalarMeta) {
        const impl = instance as CustomScalar;
        const scalar = new GraphQLScalarType({
          name: scalarMeta.name,
          description: impl.description,
          ...(impl.specifiedByURL !== undefined
            ? { specifiedByURL: impl.specifiedByURL }
            : {}),
          ...(impl.extensions !== undefined
            ? { extensions: impl.extensions }
            : {}),
          parseValue: (v) => impl.parseValue(v),
          serialize: (v) => impl.serialize(v),
          ...(typeof impl.parseLiteral === "function"
            ? { parseLiteral: (ast, vars) => impl.parseLiteral!(ast, vars) }
            : {}),
        });
        customScalars.push(scalar);
        if (scalarMeta.typeFunc) {
          const targetType = scalarMeta.typeFunc();
          if (targetType !== undefined) {
            this.customScalarsByType.set(targetType, scalar);
          }
        }
      }
    }

    // First pass: collect @ResolveField() handlers so @ObjectType() thunks see them
    for (const instance of resolverInstances) {
      const resolverClass = instance.constructor as Type<unknown>;
      const resolverMeta = MetadataRegistry.get<ResolverMetadata>(
        GRAPHQL_METADATA_KEYS.RESOLVER,
        resolverClass,
      );
      if (!resolverMeta || resolverMeta.isAbstract) continue;

      const targetTypeName = this.resolveTargetTypeName(resolverMeta);
      const resolveFields = getResolverFields(resolverClass);
      if (targetTypeName && resolveFields.length > 0) {
        let list = this.resolveFieldRegistry.get(targetTypeName);
        if (!list) {
          list = [];
          this.resolveFieldRegistry.set(targetTypeName, list);
        }
        for (const rf of resolveFields) {
          const compiled = await this.compileMethod(
            instance,
            rf.handlerKey,
            true,
          );
          list.push({ meta: rf, compiled });
        }
      }
    }

    // Second pass: collect @Query(), @Mutation(), @Subscription()
    const noDuplicatedFields =
      this.activeBuildSchemaOptions.noDuplicatedFields === true;
    for (const instance of resolverInstances) {
      const resolverClass = instance.constructor as Type<unknown>;
      const resolverMeta = MetadataRegistry.get<ResolverMetadata>(
        GRAPHQL_METADATA_KEYS.RESOLVER,
        resolverClass,
      );
      if (resolverMeta?.isAbstract) {
        continue;
      }
      const queries = getResolverOperations(
        resolverClass,
        GRAPHQL_METADATA_KEYS.QUERIES,
      );
      const mutations = getResolverOperations(
        resolverClass,
        GRAPHQL_METADATA_KEYS.MUTATIONS,
      );
      const subscriptions = getResolverOperations(
        resolverClass,
        GRAPHQL_METADATA_KEYS.SUBSCRIPTIONS,
      );
      if (
        !resolverMeta &&
        queries.length === 0 &&
        mutations.length === 0 &&
        subscriptions.length === 0
      ) {
        continue;
      }

      for (const op of queries) {
        if (noDuplicatedFields && op.name in queryFields) {
          throw new Error(
            `Duplicate Query field "${op.name}" detected in ${resolverClass.name}.`,
          );
        }
        const compiled = await this.compileMethod(instance, op.handlerKey);
        queryFields[op.name] = {
          type: this.resolveOutputType(op.returnTypeFn(), op.nullable),
          description: op.description,
          deprecationReason: op.deprecationReason,
          args: this.buildArgsConfig(compiled.params),
          ...(op.complexity !== undefined
            ? { extensions: { complexity: op.complexity } }
            : {}),
          resolve: this.createResolverFn(compiled),
        };
      }

      for (const op of mutations) {
        if (noDuplicatedFields && op.name in mutationFields) {
          throw new Error(
            `Duplicate Mutation field "${op.name}" detected in ${resolverClass.name}.`,
          );
        }
        const compiled = await this.compileMethod(instance, op.handlerKey);
        mutationFields[op.name] = {
          type: this.resolveOutputType(op.returnTypeFn(), op.nullable),
          description: op.description,
          deprecationReason: op.deprecationReason,
          args: this.buildArgsConfig(compiled.params),
          ...(op.complexity !== undefined
            ? { extensions: { complexity: op.complexity } }
            : {}),
          resolve: this.createResolverFn(compiled),
        };
      }

      for (const op of subscriptions) {
        const compiled = await this.compileMethod(instance, op.handlerKey);
        subscriptionFields[op.name] = this.createSubscriptionField(
          op,
          compiled,
          this.resolveOutputType(op.returnTypeFn(), op.nullable),
          this.buildArgsConfig(compiled.params),
        );
      }
    }

    // Apollo Federation Subgraph support (`_service { sdl }` & `_entities(representations)`)
    const federationEnabled = Boolean(options.federation);
    const entityTypes: GraphQLObjectType[] = [];
    const referenceResolvers = new Map<
      string,
      (
        reference: Record<string, unknown>,
        context: any,
        info: GraphQLResolveInfo,
      ) => unknown
    >();

    if (federationEnabled) {
      for (const instance of resolverInstances) {
        const ctor = instance.constructor as Type<unknown>;
        const refKey = MetadataRegistry.get<string | symbol>(
          GRAPHQL_METADATA_KEYS.RESOLVE_REFERENCE,
          ctor,
        );
        const resMeta = MetadataRegistry.get<ResolverMetadata>(
          GRAPHQL_METADATA_KEYS.RESOLVER,
          ctor,
        );
        if (refKey !== undefined && resMeta) {
          const typeName = this.resolveTargetTypeName(resMeta);
          const fn = (instance as Record<string | symbol, unknown>)[refKey];
          if (typeName && typeof fn === "function") {
            referenceResolvers.set(typeName, (reference, context, info) =>
              (fn as Function).call(instance, reference, context, info),
            );
          }
        }
      }
    }

    const extraTypes: GraphQLNamedType[] = [
      ...this.discoveredConcreteTypes,
      ...customScalars,
    ];
    const allOrphaned = [
      ...(options.orphanedTypes ?? []),
      ...(this.activeBuildSchemaOptions.orphanedTypes ?? []),
    ];
    for (const orphan of allOrphaned) {
      if (typeof orphan === "function") {
        if (MetadataRegistry.hasOwn(GRAPHQL_METADATA_KEYS.INPUT_TYPE, orphan)) {
          extraTypes.push(this.getOrCreateInputType(orphan));
        } else if (
          MetadataRegistry.hasOwn(GRAPHQL_METADATA_KEYS.INTERFACE_TYPE, orphan) &&
          !MetadataRegistry.hasOwn(GRAPHQL_METADATA_KEYS.OBJECT_TYPE, orphan)
        ) {
          extraTypes.push(this.getOrCreateInterfaceType(orphan));
        } else {
          extraTypes.push(this.getOrCreateObjectType(orphan));
        }
      } else if (orphan && typeof orphan === "object") {
        const enumType = getRegisteredEnumType(orphan);
        if (enumType) {
          extraTypes.push(enumType);
        }
      }
    }

    let federationSdl = "";
    if (federationEnabled) {
      for (const named of extraTypes) {
        if (isObjectType(named) && referenceResolvers.has(named.name)) {
          entityTypes.push(named);
        }
      }
      // Also inspect any object types registered via this.objectTypes
      for (const objType of this.objectTypes.values()) {
        if (
          referenceResolvers.has(objType.name) &&
          !entityTypes.includes(objType)
        ) {
          entityTypes.push(objType);
        }
      }

      const AnyScalar = new GraphQLScalarType({
        name: "_Any",
        serialize: (v) => v,
        parseValue: (v) => v,
      });
      const ServiceType = new GraphQLObjectType({
        name: "_Service",
        fields: {
          sdl: { type: GraphQLString },
        },
      });
      queryFields._service = {
        type: new GraphQLNonNull(ServiceType),
        resolve: () => ({ sdl: federationSdl }),
      };
      if (entityTypes.length > 0) {
        const EntityUnion = new GraphQLUnionType({
          name: "_Entity",
          types: entityTypes,
          resolveType: (val: unknown) =>
            (val as { __typename?: string } | null | undefined)?.__typename,
        });
        queryFields._entities = {
          type: new GraphQLNonNull(new GraphQLList(EntityUnion)),
          args: {
            representations: {
              type: new GraphQLNonNull(
                new GraphQLList(new GraphQLNonNull(AnyScalar)),
              ),
            },
          },
          resolve: async (
            _parent,
            args: { representations?: unknown[] } | undefined,
            context,
            info,
          ) => {
            const reps = Array.isArray(args?.representations)
              ? args.representations
              : [];
            const results = [];
            for (const rep of reps) {
              const typename = (
                rep as { __typename?: unknown } | null | undefined
              )?.__typename;
              const resolver =
                typeof typename === "string"
                  ? referenceResolvers.get(typename)
                  : undefined;
              if (!resolver) {
                results.push(null);
              } else {
                const resolved = await resolver(
                  rep as Record<string, unknown>,
                  context,
                  info,
                );
                results.push(
                  resolved && typeof resolved === "object"
                    ? { __typename: typename, ...(resolved as object) }
                    : resolved,
                );
              }
            }
            return results;
          },
        };
      }
    }

    // GraphQL spec requires a non-empty root Query type
    if (Object.keys(queryFields).length === 0) {
      queryFields._empty = {
        type: GraphQLBoolean,
        resolve: () => true,
      };
    }

    const queryType = new GraphQLObjectType({
      name: "Query",
      fields: () => queryFields,
    });

    const mutationType =
      Object.keys(mutationFields).length > 0
        ? new GraphQLObjectType({
            name: "Mutation",
            fields: () => mutationFields,
          })
        : undefined;

    const subscriptionType =
      Object.keys(subscriptionFields).length > 0
        ? new GraphQLObjectType({
            name: "Subscription",
            fields: () => subscriptionFields,
          })
        : undefined;

    let schema = new GraphQLSchema({
      query: queryType,
      mutation: mutationType,
      subscription: subscriptionType,
      types: extraTypes.length > 0 ? extraTypes : undefined,
      ...(this.activeBuildSchemaOptions.directives
        ? { directives: this.activeBuildSchemaOptions.directives }
        : {}),
    });

    if (options.sortSchema) {
      schema = lexicographicSortSchema(schema);
    }

    if (federationEnabled) {
      federationSdl = printSchema(schema);
    }

    const autoSchemaPath = resolveAutoSchemaFilePath(options.autoSchemaFile);
    if (autoSchemaPath && !options.transformAutoSchemaFile) {
      const printed =
        printSchema(schema) +
        (this.activeBuildSchemaOptions.addNewlineAtEnd
          ? GRAPHQL_SDL_FILE_END
          : "");
      await Bun.write(autoSchemaPath, printed);
    }

    if (options.transformSchema) {
      schema = await options.transformSchema(schema);
    }

    if (autoSchemaPath && options.transformAutoSchemaFile) {
      const printed =
        printSchema(schema) +
        (this.activeBuildSchemaOptions.addNewlineAtEnd
          ? GRAPHQL_SDL_FILE_END
          : "");
      await Bun.write(autoSchemaPath, printed);
    }

    // Keep helper references reachable (avoid unused import warnings)
    void getGraphQLDirectives;
    void getGraphQLExtensions;

    return schema;
  }

  private async buildSchemaFirst(
    resolverInstances: readonly object[],
    options: GraphQLModuleOptions,
  ): Promise<GraphQLSchema> {
    const inlineSdl =
      typeof options.typeDefs === "string"
        ? options.typeDefs
        : Array.isArray(options.typeDefs)
          ? options.typeDefs.join("\n")
          : "";
    const loadedSdl =
      options.typePaths && options.typePaths.length > 0
        ? await this.typesLoader.mergeTypesByPaths(options.typePaths)
        : "";
    const sdl = [loadedSdl, inlineSdl]
      .filter((s) => s.trim().length > 0)
      .join("\n");

    let schema = buildASTSchema(parse(sdl));

    // 1. Attach plain schema-first resolver map(s) (with optional transformResolvers)
    if (options.resolvers) {
      const effectiveResolvers = options.transformResolvers
        ? await options.transformResolvers(options.resolvers)
        : options.resolvers;
      const resolverMaps = Array.isArray(effectiveResolvers)
        ? effectiveResolvers
        : [effectiveResolvers];
      for (const map of resolverMaps) {
        this.applyResolversMap(schema, map);
      }
    }

    // 2. Attach @Resolver() decorated class methods (with full DI, Guards, Pipes, Interceptors)
    for (const instance of resolverInstances) {
      const resolverClass = instance.constructor as Type<unknown>;
      const resolverMeta = MetadataRegistry.get<ResolverMetadata>(
        GRAPHQL_METADATA_KEYS.RESOLVER,
        resolverClass,
      );
      if (!resolverMeta || resolverMeta.isAbstract) continue;

      const queryType = schema.getQueryType();
      if (queryType) {
        const qFields = queryType.getFields();
        for (const op of getResolverOperations(
          resolverClass,
          GRAPHQL_METADATA_KEYS.QUERIES,
        )) {
          const field = qFields[op.name];
          if (field) {
            const compiled = await this.compileMethod(instance, op.handlerKey);
            field.resolve = this.createResolverFn(compiled);
          }
        }
      }

      const mutationType = schema.getMutationType();
      if (mutationType) {
        const mFields = mutationType.getFields();
        for (const op of getResolverOperations(
          resolverClass,
          GRAPHQL_METADATA_KEYS.MUTATIONS,
        )) {
          const field = mFields[op.name];
          if (field) {
            const compiled = await this.compileMethod(instance, op.handlerKey);
            field.resolve = this.createResolverFn(compiled);
          }
        }
      }

      const subType = schema.getSubscriptionType();
      if (subType) {
        const sFields = subType.getFields();
        for (const op of getResolverOperations(
          resolverClass,
          GRAPHQL_METADATA_KEYS.SUBSCRIPTIONS,
        )) {
          const field = sFields[op.name];
          if (field) {
            const compiled = await this.compileMethod(instance, op.handlerKey);
            const built = this.createSubscriptionField(
              op,
              compiled,
              field.type,
              {},
            );
            field.subscribe = built.subscribe;
            field.resolve = built.resolve;
          }
        }
      }

      const targetTypeName = this.resolveTargetTypeName(resolverMeta);
      if (targetTypeName) {
        const targetType = schema.getType(targetTypeName);
        if (isObjectType(targetType)) {
          const tFields = targetType.getFields();
          for (const rf of getResolverFields(resolverClass)) {
            const field = tFields[rf.name];
            if (field) {
              const compiled = await this.compileMethod(
                instance,
                rf.handlerKey,
                true,
              );
              const rfMw: FieldMiddleware[] = [
                ...(this.activeBuildSchemaOptions.fieldMiddleware ?? []),
                ...(rf.middleware ?? []),
                ...getUseFieldMiddleware(compiled.resolverClass, rf.handlerKey),
              ];
              const baseResolve = this.createResolverFn(compiled);
              field.resolve =
                rfMw.length > 0
                  ? applyFieldMiddleware(rfMw, baseResolve)
                  : baseResolve;
            }
          }
        }
      }
    }

    if (options.sortSchema) {
      schema = lexicographicSortSchema(schema);
    }

    if (options.transformSchema) {
      schema = await options.transformSchema(schema);
    }

    return schema;
  }

  private applyResolversMap(
    schema: GraphQLSchema,
    resolvers: SchemaFirstResolversMap,
  ): void {
    for (const [typeName, fieldResolvers] of Object.entries(resolvers)) {
      const gqlType = schema.getType(typeName);
      if (!isObjectType(gqlType)) continue;
      const fields = gqlType.getFields();

      for (const [fieldName, resolverDef] of Object.entries(fieldResolvers)) {
        const field = fields[fieldName];
        if (!field) continue;

        if (typeof resolverDef === "function") {
          field.resolve = resolverDef;
        } else if (resolverDef && typeof resolverDef === "object") {
          if (typeof resolverDef.subscribe === "function") {
            field.subscribe = resolverDef.subscribe;
          }
          if (typeof resolverDef.resolve === "function") {
            field.resolve = resolverDef.resolve;
          }
        }
      }
    }
  }
}
