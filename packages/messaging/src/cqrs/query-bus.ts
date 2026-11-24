import {
  Inject,
  Injectable,
  MetadataRegistry,
  Optional,
  Scope,
} from "@bunest/core";
import { ModuleRef, type InstanceWrapper } from "@bunest/core";
import type { Query } from "./classes/query";
import type { RegisteredQueryResult } from "./cqrs-registry.interface";
import {
  DuplicateQueryHandlerException,
  InvalidQueryHandlerException,
  QueryHandlerNotFoundException,
} from "./exceptions";
import { DefaultQueryPubSub } from "./helpers/default-pubsubs";
import type {
  CqrsModuleOptions,
  IQuery,
  IQueryBus,
  IQueryHandler,
  IQueryPublisher,
  IQueryResult,
  QueryMetadata,
  QueryType,
} from "./interfaces";
import { AsyncContext } from "./scopes/async.context";
import {
  CQRS_MODULE_OPTIONS,
  QUERY_HANDLER_METADATA,
  QUERY_METADATA,
} from "./tokens";
import {
  SubscribableStream,
  type StreamListener,
  type Subscribable,
  type SubscriptionHandle,
} from "./utils/subscribable-stream";

type StoredQueryHandler<QueryBase extends IQuery> =
  | {
      readonly kind: "instance";
      readonly handler: IQueryHandler<QueryBase, unknown>;
    }
  | {
      readonly kind: "wrapper";
      readonly wrapper: InstanceWrapper<IQueryHandler<QueryBase, unknown>>;
    };

function isInstanceWrapperLike(
  value: unknown,
): value is InstanceWrapper<IQueryHandler<any, any>> {
  return (
    typeof value === "object" &&
    value !== null &&
    "token" in value &&
    "moduleRef" in value
  );
}

/**
 * Dispatches read queries to their single registered `@QueryHandler()`.
 * Supports strongly-typed `Query<TResult>`, `AsyncContext` request-scoped handlers,
 * pluggable `IQueryPublisher`, and zero-RxJS subscribable `subject$`.
 */
@Injectable()
export class QueryBus<QueryBase extends IQuery = IQuery>
  implements IQueryBus<QueryBase>, Subscribable<QueryBase>
{
  readonly subject$ = new SubscribableStream<QueryBase>();

  private readonly handlers = new Map<
    Function,
    StoredQueryHandler<QueryBase>
  >();
  private readonly handlersById = new Map<
    string,
    StoredQueryHandler<QueryBase>
  >();
  private _publisher!: IQueryPublisher<QueryBase>;

  constructor(
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional()
    @Inject(CQRS_MODULE_OPTIONS)
    private readonly options?: CqrsModuleOptions,
  ) {
    if (this.options?.queryPublisher) {
      this._publisher = this.options
        .queryPublisher as IQueryPublisher<QueryBase>;
    } else {
      this.useDefaultPublisher();
    }
  }

  get publisher(): IQueryPublisher<QueryBase> {
    return this._publisher;
  }

  set publisher(publisher: IQueryPublisher<QueryBase>) {
    this._publisher = publisher;
  }

  subscribe(listenerOrObserver: StreamListener<QueryBase>): SubscriptionHandle {
    return this.subject$.subscribe(listenerOrObserver);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<QueryBase> {
    return this.subject$[Symbol.asyncIterator]();
  }

  bind<T extends QueryBase, TResult extends IQueryResult = any>(
    handler:
      InstanceWrapper<IQueryHandler<T, TResult>> | IQueryHandler<T, TResult>,
    queryId: string,
  ): void {
    const entry: StoredQueryHandler<QueryBase> = isInstanceWrapperLike(handler)
      ? {
          kind: "wrapper",
          wrapper: handler as InstanceWrapper<
            IQueryHandler<QueryBase, unknown>
          >,
        }
      : {
          kind: "instance",
          handler: handler as IQueryHandler<QueryBase, unknown>,
        };
    this.handlersById.set(queryId, entry);
  }

  register<TQuery extends QueryBase, TResult = unknown>(
    queryType: QueryType<TQuery>,
    handler: IQueryHandler<TQuery, TResult>,
  ): void;
  register(handlers?: InstanceWrapper<IQueryHandler<QueryBase, any>>[]): void;
  register(
    queryTypeOrHandlers?:
      QueryType<any> | InstanceWrapper<IQueryHandler<QueryBase, any>>[],
    maybeHandler?: IQueryHandler<any, any>,
  ): void {
    if (Array.isArray(queryTypeOrHandlers)) {
      for (const wrapper of queryTypeOrHandlers) {
        this.registerHandler(wrapper);
      }
      return;
    }

    if (!queryTypeOrHandlers) {
      return;
    }

    if (typeof queryTypeOrHandlers !== "function" || !maybeHandler) {
      throw new InvalidQueryHandlerException();
    }

    if (typeof maybeHandler.execute !== "function") {
      throw new InvalidQueryHandlerException();
    }

    if (this.handlers.has(queryTypeOrHandlers)) {
      throw new DuplicateQueryHandlerException(
        queryTypeOrHandlers.name || "<anonymous>",
      );
    }

    const entry: StoredQueryHandler<QueryBase> = {
      kind: "instance",
      handler: maybeHandler as IQueryHandler<QueryBase, unknown>,
    };
    this.handlers.set(queryTypeOrHandlers, entry);

    const meta = MetadataRegistry.get<QueryMetadata>(
      QUERY_METADATA,
      queryTypeOrHandlers,
    );
    if (meta?.id) {
      this.handlersById.set(meta.id, entry);
    }
  }

  protected registerHandler(
    wrapper: InstanceWrapper<IQueryHandler<QueryBase, any>>,
  ): void {
    const metatype =
      wrapper.metatype ??
      (wrapper.instance && typeof wrapper.instance === "object"
        ? wrapper.instance.constructor
        : undefined);
    if (typeof metatype !== "function") {
      throw new InvalidQueryHandlerException();
    }

    const queryType = MetadataRegistry.get<QueryType>(
      QUERY_HANDLER_METADATA,
      metatype,
    );
    if (!queryType || typeof queryType !== "function") {
      throw new InvalidQueryHandlerException();
    }

    const proto = metatype.prototype as Record<string, unknown> | undefined;
    const hasExecute =
      typeof (wrapper.instance as Record<string, unknown> | undefined)
        ?.execute === "function" || typeof proto?.execute === "function";
    if (!hasExecute) {
      throw new InvalidQueryHandlerException();
    }

    if (this.handlers.has(queryType)) {
      throw new DuplicateQueryHandlerException(queryType.name || "<anonymous>");
    }

    const entry: StoredQueryHandler<QueryBase> =
      wrapper.isDependencyTreeStatic &&
      wrapper.scope === Scope.SINGLETON &&
      wrapper.instance
        ? {
            kind: "instance",
            handler: wrapper.instance as IQueryHandler<QueryBase, unknown>,
          }
        : {
            kind: "wrapper",
            wrapper: wrapper as InstanceWrapper<
              IQueryHandler<QueryBase, unknown>
            >,
          };

    this.handlers.set(queryType, entry);

    const qMeta = MetadataRegistry.get<QueryMetadata>(
      QUERY_METADATA,
      queryType,
    );
    if (qMeta?.id) {
      this.handlersById.set(qMeta.id, entry);
    }
  }

  unregister(queryType: QueryType): void {
    this.handlers.delete(queryType);
    const meta = MetadataRegistry.get<QueryMetadata>(QUERY_METADATA, queryType);
    if (meta?.id) {
      this.handlersById.delete(meta.id);
    }
  }

  hasHandler(queryType: QueryType): boolean {
    if (this.handlers.has(queryType)) {
      return true;
    }
    const meta = MetadataRegistry.get<QueryMetadata>(QUERY_METADATA, queryType);
    return meta?.id ? this.handlersById.has(meta.id) : false;
  }

  execute<TResult>(query: Query<TResult>): Promise<TResult>;
  execute<TResult>(
    query: Query<TResult>,
    asyncContext: AsyncContext,
  ): Promise<TResult>;
  execute<TQuery extends QueryBase>(
    query: [RegisteredQueryResult<TQuery>] extends [never] ? never : TQuery,
    asyncContext?: AsyncContext,
  ): Promise<RegisteredQueryResult<TQuery>>;
  execute<TResult = any, TQuery extends QueryBase = QueryBase>(
    query: TQuery,
    asyncContext?: AsyncContext,
  ): Promise<TResult>;
  execute<TQuery extends QueryBase, TResult = any>(
    query: TQuery,
    asyncContext?: AsyncContext,
  ): Promise<TResult>;
  async execute(
    query: QueryBase | Query<unknown>,
    asyncContext?: AsyncContext,
  ): Promise<unknown> {
    if (!query || typeof query !== "object") {
      throw new QueryHandlerNotFoundException(String(query));
    }

    const ctor = query.constructor;
    let stored = this.handlers.get(ctor);
    if (!stored) {
      const meta = MetadataRegistry.get<QueryMetadata>(QUERY_METADATA, ctor);
      if (meta?.id) {
        stored = this.handlersById.get(meta.id);
      }
    }

    if (!stored) {
      throw new QueryHandlerNotFoundException(ctor?.name || "<anonymous>");
    }

    const ctx = asyncContext ?? AsyncContext.of(query);
    if (ctx) {
      ctx.attachTo(query);
    }

    let handler: { execute(query: IQuery): Promise<unknown> | unknown };
    if (stored.kind === "instance") {
      handler = stored.handler as {
        execute(query: IQuery): Promise<unknown> | unknown;
      };
    } else {
      const resolvedCtx = ctx ?? new AsyncContext();
      resolvedCtx.attachTo(query);
      const ref = stored.wrapper.moduleRef ?? this.moduleRef;
      if (!ref) {
        throw new InvalidQueryHandlerException();
      }
      handler = (await ref.resolve(stored.wrapper.token, resolvedCtx.id, {
        strict: false,
      })) as { execute(query: IQuery): Promise<unknown> | unknown };
    }

    this._publisher.publish(query as QueryBase);
    return await handler.execute(query);
  }

  clear(): void {
    this.handlers.clear();
    this.handlersById.clear();
    this.subject$.clear();
  }

  private useDefaultPublisher(): void {
    this._publisher = new DefaultQueryPubSub<QueryBase>(this.subject$);
  }
}
