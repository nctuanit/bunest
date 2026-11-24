import type {
  ArgumentsHost,
  ContextType,
  ExecutionContext,
  HttpArgumentsHost,
  RpcArgumentsHost,
  Type,
  WsArgumentsHost,
} from "@bunest/core";
import type { GraphQLResolveInfo } from "../engine";

export type GqlContextType = "graphql" | ContextType;

/**
 * GraphQL arguments host interface matching `@nestjs/graphql` `GraphQLArgumentsHost`.
 */
export interface GraphQLArgumentsHost extends ArgumentsHost {
  getRoot<T = any>(): T;
  getInfo<T = any>(): T;
  getArgs<T = any>(): T;
  getContext<T = any>(): T;
}

/**
 * `ExecutionContext` implementation passed to Guards and Interceptors during
 * GraphQL resolver execution with `getType() === "graphql"`.
 */
export class GraphQLExecutionContextHost implements ExecutionContext {
  private readonly args: [
    unknown,
    Record<string, unknown>,
    Record<string, unknown>,
    GraphQLResolveInfo,
  ];
  private readonly resolverClass: Type<unknown>;
  private readonly handlerFn: Function;
  private readonly handlerKey: string | symbol;
  private contextType: string = "graphql";

  constructor(
    root: unknown,
    args: Record<string, unknown>,
    context: Record<string, unknown>,
    info: GraphQLResolveInfo,
    resolverClass: Type<unknown>,
    handlerFn: Function,
    handlerKey: string | symbol,
  ) {
    this.args = [root, args, context, info];
    this.resolverClass = resolverClass;
    this.handlerFn = handlerFn;
    this.handlerKey = handlerKey;
  }

  getType<TContext extends string = GqlContextType>(): TContext {
    return this.contextType as TContext;
  }

  setType(type: string): void {
    this.contextType = type;
  }

  getClass<T = any>(): Type<T> {
    return this.resolverClass as Type<T>;
  }

  getHandler(): Function {
    return this.handlerFn;
  }

  getHandlerKey(): string | symbol {
    return this.handlerKey;
  }

  getArgs<T extends Array<any> = any[]>(): T {
    return this.args as unknown as T;
  }

  getArgByIndex<T = any>(index: number): T {
    return this.args[index] as T;
  }

  switchToHttp(): HttpArgumentsHost {
    const ctx = this.args[2];
    return {
      getRequest: <T = Request>(): T => ctx?.req as T,
      getResponse: <T = any>(): T => ctx?.res as T,
      getNext: <T = any>(): T => undefined as T,
    };
  }

  switchToWs(): WsArgumentsHost {
    return {
      getClient: <T = any>(): T => this.args[2] as T,
      getData: <T = any>(): T => this.args[1] as T,
      getPattern: (): string => this.args[3]?.fieldName ?? "",
    };
  }

  switchToRpc(): RpcArgumentsHost {
    return {
      getData: <T = any>(): T => this.args[1] as T,
      getContext: <T = any>(): T => this.args[2] as T,
    };
  }
}

/**
 * NestJS-compatible GraphQL arguments host usable inside ExceptionFilters
 * (`GqlArgumentsHost.create(host)`).
 */
export class GqlArgumentsHost implements GraphQLArgumentsHost {
  private contextType: string = "graphql";
  protected readonly args: unknown[];
  protected readonly constructorRef?: Type<unknown> | null;
  protected readonly handler?: Function | null;

  constructor(
    args: unknown[],
    constructorRef: Type<unknown> | null = null,
    handler: Function | null = null,
  ) {
    this.args = args;
    this.constructorRef = constructorRef;
    this.handler = handler;
  }

  static create(context: ArgumentsHost): GqlArgumentsHost {
    const type = context.getType();
    const execCtx = context as Partial<ExecutionContext>;
    const gqlHost = new GqlArgumentsHost(
      context.getArgs(),
      typeof execCtx.getClass === "function" ? execCtx.getClass() : null,
      typeof execCtx.getHandler === "function" ? execCtx.getHandler() : null,
    );
    gqlHost.setType(type);
    return gqlHost;
  }

  getType<TContext extends string = GqlContextType>(): TContext {
    return this.contextType as TContext;
  }

  setType(type: string): void {
    this.contextType = type;
  }

  getClass<T = any>(): Type<T> {
    return this.constructorRef as Type<T>;
  }

  getHandler(): Function {
    return this.handler as Function;
  }

  getArgByIndex<T = any>(index: number): T {
    return this.args[index] as T;
  }

  getRoot<T = any>(): T {
    return this.getArgByIndex<T>(0);
  }

  getArgs<T = any>(): T {
    return this.getArgByIndex<T>(1);
  }

  getContext<T = any>(): T {
    return this.getArgByIndex<T>(2);
  }

  getInfo<T = GraphQLResolveInfo>(): T {
    return this.getArgByIndex<T>(3);
  }

  switchToHttp(): HttpArgumentsHost {
    const ctx = this.args[2] as Record<string, unknown> | undefined;
    return {
      getRequest: <T = Request>(): T => (ctx?.req ?? this.args[0]) as T,
      getResponse: <T = any>(): T => (ctx?.res ?? this.args[1]) as T,
      getNext: <T = any>(): T => this.args[2] as T,
    };
  }

  switchToWs(): WsArgumentsHost {
    return {
      getClient: <T = any>(): T => this.args[2] as T,
      getData: <T = any>(): T => this.args[1] as T,
      getPattern: (): string =>
        (this.args[3] as { fieldName?: string } | undefined)?.fieldName ?? "",
    };
  }

  switchToRpc(): RpcArgumentsHost {
    return {
      getData: <T = any>(): T => this.args[1] as T,
      getContext: <T = any>(): T => this.args[2] as T,
    };
  }
}

/**
 * NestJS-compatible GraphQL execution context wrapper exposing typed
 * `getRoot()`, `getArgs()`, `getContext()`, and `getInfo()` accessors
 * inside Guards, Interceptors, and Exception Filters.
 */
export class GqlExecutionContext implements GraphQLArgumentsHost {
  private readonly context: ExecutionContext;
  private customType?: string;

  private constructor(context: ExecutionContext) {
    this.context = context;
  }

  static create(context: ExecutionContext): GqlExecutionContext {
    return new GqlExecutionContext(context);
  }

  getType<TContext extends string = GqlContextType>(): TContext {
    return (this.customType ?? this.context.getType()) as TContext;
  }

  setType(type: string): void {
    this.customType = type;
  }

  getClass<T = any>(): Type<T> {
    return this.context.getClass<T>();
  }

  getHandler(): Function {
    return this.context.getHandler();
  }

  getArgByIndex<T = any>(index: number): T {
    return this.context.getArgByIndex<T>(index);
  }

  getRoot<T = any>(): T {
    return this.context.getArgByIndex<T>(0);
  }

  getArgs<T = any>(): T {
    return this.context.getArgByIndex<T>(1);
  }

  getContext<T = Record<string, unknown>>(): T {
    return this.context.getArgByIndex<T>(2);
  }

  getInfo<T = GraphQLResolveInfo>(): T {
    return this.context.getArgByIndex<T>(3);
  }

  switchToHttp(): HttpArgumentsHost {
    return this.context.switchToHttp();
  }

  switchToWs(): WsArgumentsHost {
    return this.context.switchToWs();
  }

  switchToRpc(): RpcArgumentsHost {
    return this.context.switchToRpc();
  }
}

export type GraphQLExecutionContext = GqlExecutionContext;
