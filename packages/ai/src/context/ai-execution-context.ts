import type {
  ContextType,
  ExecutionContext,
  HttpArgumentsHost,
  RpcArgumentsHost,
  Type,
  WsArgumentsHost,
} from '@bunest/common';
import type { AgentFunctionContext } from '../interfaces/agent-function.interface';

/** `context.getType<AiContextType>() === 'ai'` in an enhancer tells an agent function call from an HTTP request. */
export type AiContextType = 'ai';

/**
 * The execution context of an agent function call, for guards, interceptors and exception filters.
 *
 * The arguments of an agent function call are `[input, context]`: `getInput()` (also `switchToRpc().getData()`) and
 * `getContext()`.
 */
export class AiExecutionContext implements ExecutionContext {
  private readonly args: any[];
  private readonly constructorRef: Type<any> | null;
  private readonly handler: Function | null;
  private contextType: string = 'ai';

  constructor(
    args: any[],
    constructorRef: Type<any> | null = null,
    handler: Function | null = null,
  ) {
    this.args = args;
    this.constructorRef = constructorRef;
    this.handler = handler;
  }

  static create(context: ExecutionContext): AiExecutionContext {
    const host = context as ExecutionContext & {
      getClass?: () => Type<any>;
      getHandler?: () => Function;
    };
    const ai = new AiExecutionContext(
      context.getArgs(),
      host.getClass?.() ?? null,
      host.getHandler?.() ?? null,
    );
    ai.setType(context.getType());
    return ai;
  }

  /** The arguments, validated against the function's `inputSchema`. */
  getInput<T = any>(): T {
    return this.getArgByIndex<T>(0);
  }

  getContext<TRequest = any, TUser = any>(): AgentFunctionContext<TRequest, TUser> {
    return this.getArgByIndex<AgentFunctionContext<TRequest, TUser>>(1);
  }

  /** The agent function's name. */
  getName(): string | undefined {
    return this.getContext()?.name;
  }

  /** The HTTP platform's request the agent runs in (`caller.request`); `undefined` where there is none, as in a job. */
  getRequest<TRequest = any>(): TRequest | undefined {
    return this.getContext<TRequest>()?.request;
  }

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
    return this.args as T;
  }

  getArgByIndex<T = any>(index: number): T {
    return this.args[index] as T;
  }

  switchToRpc(): RpcArgumentsHost {
    return {
      getData: <T = any>() => this.getArgByIndex<T>(0),
      getContext: <T = any>() => this.getArgByIndex<T>(1),
    };
  }

  switchToHttp(): HttpArgumentsHost {
    return {
      getRequest: <T = any>() => this.getArgByIndex<T>(0),
      getResponse: <T = any>() => this.getArgByIndex<T>(1),
      getNext: <T = any>() => this.getArgByIndex<T>(2),
    };
  }

  switchToWs(): WsArgumentsHost {
    return {
      getClient: <T = any>() => this.getArgByIndex<T>(0),
      getData: <T = any>() => this.getArgByIndex<T>(1),
      getPattern: () => this.getArgByIndex<string>(2),
    };
  }
}
