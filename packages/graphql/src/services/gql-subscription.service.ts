import type { BunHttpAdapter } from "@bunest/core/http";
import {
  execute as defaultExecute,
  type ExecutionResult,
  parse,
  subscribe as defaultSubscribe,
  validate,
} from "../engine";
import type {
  GqlSubscriptionServiceOptions,
  GraphQLWsOptions,
} from "../interfaces/graphql.interface";
import {
  type GraphQLWsExecutionOutput,
  type GraphQLWsExecutor,
  GraphQLWsHandler,
} from "../subscriptions/graphql-ws.handler";

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

/**
 * Bun-native `graphql-transport-ws` subscription service matching
 * `@nestjs/graphql` `GqlSubscriptionService` (backed by `GraphQLWsHandler`).
 */
export class GqlSubscriptionService {
  private readonly wsHandler: GraphQLWsHandler;
  private readonly resolvedPath: string | undefined;

  constructor(
    private readonly options: GqlSubscriptionServiceOptions,
    private readonly httpServer?: unknown,
  ) {
    const schema = options.schema;
    const executeFn = options.execute ?? defaultExecute;
    const subscribeFn = options.subscribe ?? defaultSubscribe;
    const wsConfig: GraphQLWsOptions =
      typeof options["graphql-ws"] === "object" &&
      options["graphql-ws"] !== null
        ? options["graphql-ws"]
        : {};

    const customServer = wsConfig.server as
      | { options?: { noServer?: boolean; path?: string } }
      | undefined;
    if (
      customServer &&
      typeof customServer === "object" &&
      customServer.options?.noServer !== true
    ) {
      throw new Error(
        'Custom WebSocketServer passed to "graphql-ws" must be instantiated with "noServer: true".',
      );
    }

    const resolvedPath =
      wsConfig.path ?? customServer?.options?.path ?? options.path;
    this.resolvedPath = resolvedPath;
    const path = resolvedPath ?? "/graphql";

    const executor: GraphQLWsExecutor = {
      getPath: () => path,
      async executeQuery(params) {
        const document = parse(params.query);
        const errors = validate(schema, document);
        if (errors.length > 0) {
          return {
            status: 400,
            result: { errors: errors.map((e) => e.toJSON()) },
          };
        }
        const res = await executeFn({
          schema,
          document,
          variableValues: params.variables ?? undefined,
          operationName: params.operationName ?? undefined,
          contextValue: params.contextValue ?? {},
        });
        return {
          status: 200,
          result: {
            ...(res.data !== undefined
              ? { data: res.data as Record<string, unknown> | null }
              : {}),
            ...(res.errors
              ? { errors: res.errors.map((e) => e.toJSON()) }
              : {}),
          },
        };
      },
      async subscribeQuery(params) {
        const document = parse(params.query);
        const errors = validate(schema, document);
        if (errors.length > 0) {
          return { errors: errors.map((e) => e.toJSON()) };
        }
        const subResult = await subscribeFn({
          schema,
          document,
          variableValues: params.variables ?? undefined,
          operationName: params.operationName ?? undefined,
          contextValue: params.contextValue ?? {},
        });
        if (!isAsyncIterable(subResult)) {
          return {
            ...(subResult.data !== undefined
              ? { data: subResult.data as Record<string, unknown> | null }
              : {}),
            ...(subResult.errors
              ? { errors: subResult.errors.map((e) => e.toJSON()) }
              : {}),
          };
        }
        const iter = subResult[Symbol.asyncIterator]();
        const wrapped: AsyncIterableIterator<GraphQLWsExecutionOutput> = {
          [Symbol.asyncIterator]() {
            return wrapped;
          },
          async next() {
            const step = await iter.next();
            if (step.done) return { value: undefined, done: true };
            const r = step.value;
            return {
              done: false,
              value: {
                ...(r.data !== undefined
                  ? { data: r.data as Record<string, unknown> | null }
                  : {}),
                ...(r.errors
                  ? { errors: r.errors.map((e) => e.toJSON()) }
                  : {}),
              },
            };
          },
          async return() {
            if (typeof iter.return === "function") {
              await iter.return();
            }
            return { value: undefined, done: true };
          },
          async throw(err?: unknown) {
            if (typeof iter.throw === "function") {
              await iter.throw(err);
            }
            return Promise.reject(err);
          },
        };
        return wrapped;
      },
    };

    let fallbackContext: GraphQLWsOptions["context"];
    if (typeof options.context === "function") {
      fallbackContext = options.context as GraphQLWsOptions["context"];
    } else if (options.context) {
      fallbackContext = () => options.context as Record<string, unknown>;
    }

    this.wsHandler = new GraphQLWsHandler(executor, {
      ...wsConfig,
      path,
      context: wsConfig.context ?? fallbackContext,
      connectionInitWaitTimeoutMs:
        wsConfig.connectionInitWaitTimeoutMs ??
        wsConfig.connectionInitWaitTimeout,
    });

    this.initialize();
  }

  private initialize(): void {
    if (!this.options["graphql-ws"]) return;
    if (!this.resolvedPath) return;
    if (!this.httpServer || typeof this.httpServer !== "object") return;
    const srv = this.httpServer as {
      registerWebsocketHandler?: unknown;
      getHttpAdapter?: () => BunHttpAdapter;
    };
    let adapter: BunHttpAdapter | undefined;
    if (typeof srv.registerWebsocketHandler === "function") {
      adapter = this.httpServer as BunHttpAdapter;
    } else if (typeof srv.getHttpAdapter === "function") {
      adapter = srv.getHttpAdapter();
    }
    if (adapter && typeof adapter.registerWebsocketHandler === "function") {
      this.wsHandler.attachToHttpAdapter(adapter, this.wsHandler.getPath());
    }
  }

  getHandler(): GraphQLWsHandler {
    return this.wsHandler;
  }

  async stop(): Promise<void> {
    await this.wsHandler.closeAll();
  }
}
