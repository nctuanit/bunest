import type {
  ContextType,
  ExecutionContext,
  HttpArgumentsHost,
  NextFunction,
  ResponseContext,
  RpcArgumentsHost,
  Type,
  WsArgumentsHost,
} from "@bunest/common";
import type { RequestContext } from "./request-context";

const NOOP_NEXT: NextFunction = () => undefined;

/**
 * HTTP implementation of `ExecutionContext` and `ArgumentsHost` (ADR-008).
 */
export class HttpExecutionContext implements ExecutionContext {
  private readonly args: [Request, ResponseContext, NextFunction];
  private readonly controllerClass: Type<unknown>;
  private readonly handlerFn: Function;
  private readonly handlerKey: string | symbol;
  public readonly requestContext: RequestContext;

  constructor(
    requestContext: RequestContext,
    controllerClass: Type<unknown>,
    handlerFn: Function,
    handlerKey: string | symbol,
    next: NextFunction = NOOP_NEXT,
  ) {
    this.requestContext = requestContext;
    this.controllerClass = controllerClass;
    this.handlerFn = handlerFn;
    this.handlerKey = handlerKey;
    this.args = [requestContext.request, requestContext.responseContext, next];
  }

  getType<TContext extends string = ContextType>(): TContext {
    return "http" as TContext;
  }

  getClass<T = any>(): Type<T> {
    return this.controllerClass as Type<T>;
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
    return {
      getRequest: <T = Request>(): T => this.args[0] as unknown as T,
      getResponse: <T = ResponseContext>(): T => this.args[1] as unknown as T,
      getNext: <T = NextFunction>(): T => this.args[2] as unknown as T,
    };
  }

  switchToWs(): WsArgumentsHost {
    return {
      getClient: <T = any>(): T => this.args[0] as unknown as T,
      getData: <T = any>(): T => this.args[1] as unknown as T,
      getPattern: (): string => "",
    };
  }

  switchToRpc(): RpcArgumentsHost {
    return {
      getData: <T = any>(): T => this.args[0] as unknown as T,
      getContext: <T = any>(): T => this.args[1] as unknown as T,
    };
  }
}
