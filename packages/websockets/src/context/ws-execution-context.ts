import type {
  ContextType,
  ExecutionContext,
  HttpArgumentsHost,
  RpcArgumentsHost,
  Type,
  WsArgumentsHost,
} from "@bunest/common";
import type { BunWsClient } from "../interfaces/ws.interface";

/**
 * WebSocket implementation of `ExecutionContext` and `ArgumentsHost`.
 */
export class WsExecutionContext implements ExecutionContext {
  private readonly args: [BunWsClient, unknown, string];
  private readonly gatewayClass: Type<unknown>;
  private readonly handlerFn: Function;
  private readonly handlerKey: string | symbol;

  constructor(
    client: BunWsClient,
    data: unknown,
    pattern: string,
    gatewayClass: Type<unknown>,
    handlerFn: Function,
    handlerKey: string | symbol,
  ) {
    this.args = [client, data, pattern];
    this.gatewayClass = gatewayClass;
    this.handlerFn = handlerFn;
    this.handlerKey = handlerKey;
  }

  getType<TContext extends string = ContextType>(): TContext {
    return "ws" as TContext;
  }

  getClass<T = any>(): Type<T> {
    return this.gatewayClass as Type<T>;
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

  switchToWs(): WsArgumentsHost {
    return {
      getClient: <T = BunWsClient>(): T => this.args[0] as unknown as T,
      getData: <T = any>(): T => this.args[1] as T,
      getPattern: (): string => this.args[2],
    };
  }

  switchToHttp(): HttpArgumentsHost {
    return {
      getRequest: <T = Request>(): T =>
        this.args[0].request as unknown as T,
      getResponse: <T = any>(): T => undefined as T,
      getNext: <T = any>(): T => undefined as T,
    };
  }

  switchToRpc(): RpcArgumentsHost {
    return {
      getData: <T = any>(): T => this.args[1] as T,
      getContext: <T = any>(): T => this.args[0] as unknown as T,
    };
  }
}
