import type {
  ContextType,
  ExecutionContext,
  HttpArgumentsHost,
  RpcArgumentsHost,
  Type,
  WsArgumentsHost,
} from "../common/index";

/**
 * Generic `ExecutionContext` / `ArgumentsHost` implementation matching NestJS `ExecutionContextHost`.
 */
export class ExecutionContextHost implements ExecutionContext {
  private contextType: string = "http";

  constructor(
    private readonly args: unknown[],
    private readonly constructorRef: Type<unknown> | null = null,
    private readonly handler: Function | null = null,
  ) {}

  setType<TContext extends string = ContextType>(type: TContext): void {
    if (type) {
      this.contextType = type;
    }
  }

  getType<TContext extends string = ContextType>(): TContext {
    return this.contextType as TContext;
  }

  getClass<T = any>(): Type<T> {
    return this.constructorRef as Type<T>;
  }

  getHandler(): Function {
    return this.handler as Function;
  }

  getArgs<T extends Array<any> = any[]>(): T {
    return this.args as unknown as T;
  }

  getArgByIndex<T = any>(index: number): T {
    return this.args[index] as T;
  }

  switchToRpc(): RpcArgumentsHost {
    return {
      getData: <T = any>(): T => this.getArgByIndex<T>(0),
      getContext: <T = any>(): T => this.getArgByIndex<T>(1),
    };
  }

  switchToHttp(): HttpArgumentsHost {
    return {
      getRequest: <T = any>(): T => this.getArgByIndex<T>(0),
      getResponse: <T = any>(): T => this.getArgByIndex<T>(1),
      getNext: <T = any>(): T => this.getArgByIndex<T>(2),
    };
  }

  switchToWs(): WsArgumentsHost {
    return {
      getClient: <T = any>(): T => this.getArgByIndex<T>(0),
      getData: <T = any>(): T => this.getArgByIndex<T>(1),
      getPattern: (): string =>
        this.getArgByIndex<string>(this.args.length - 1),
    };
  }
}
