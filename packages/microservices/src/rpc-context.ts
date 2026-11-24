import type {
  ContextType,
  ExecutionContext,
  HttpArgumentsHost,
  RpcArgumentsHost,
  Type,
  WsArgumentsHost,
} from "@bunest/core";
import type { RpcContext } from "./interfaces";

/**
 * `ExecutionContext` implementation for microservice RPC handlers so Bunest guards,
 * pipes, interceptors, and exception filters can call `context.switchToRpc()`.
 */
export class RpcExecutionContext implements ExecutionContext {
  constructor(
    private readonly targetClass: Type<unknown>,
    private readonly handler: Function,
    private readonly handlerKey: string | symbol,
    private readonly data: unknown,
    private readonly rpcContext: RpcContext,
  ) {}

  getClass<T = any>(): Type<T> {
    return this.targetClass as Type<T>;
  }

  getHandler(): Function {
    return this.handler;
  }

  getHandlerKey(): string | symbol {
    return this.handlerKey;
  }

  getType<TContext extends string = ContextType>(): TContext {
    return "rpc" as TContext;
  }

  getArgs<T extends Array<any> = any[]>(): T {
    return [this.data, this.rpcContext] as unknown as T;
  }

  getArgByIndex<T = any>(index: number): T {
    if (index === 0) return this.data as T;
    if (index === 1) return this.rpcContext as T;
    return undefined as T;
  }

  switchToRpc(): RpcArgumentsHost {
    return {
      getData: <T = any>() => this.data as T,
      getContext: <T = any>() => this.rpcContext as T,
    };
  }

  switchToHttp(): HttpArgumentsHost {
    throw new Error(
      "Cannot call switchToHttp() on an RPC ExecutionContext. Use switchToRpc() instead.",
    );
  }

  switchToWs(): WsArgumentsHost {
    throw new Error(
      "Cannot call switchToWs() on an RPC ExecutionContext. Use switchToRpc() instead.",
    );
  }
}
