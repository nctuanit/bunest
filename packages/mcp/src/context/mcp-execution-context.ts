import type {
  ArgumentsHost,
  ContextType,
  ExecutionContext,
  HttpArgumentsHost,
  RpcArgumentsHost,
  Type,
  WsArgumentsHost,
} from "@bunest/common";
import type {
  McpAuthInfo,
  McpCallKind,
  McpContext,
  McpContextType,
} from "../interfaces/mcp-types";
import { MCP_CONTEXT_TYPE } from "../mcp.constants";

/**
 * The execution context of an MCP call, for guards, interceptors and exception filters.
 * Arguments are `[input, context]`: `getInput()` and `getContext()`.
 */
export class McpExecutionContext implements ExecutionContext {
  private contextType: string = MCP_CONTEXT_TYPE;

  constructor(
    private readonly args: unknown[],
    private readonly constructorRef: Type<any> | null = null,
    private readonly handler: Function | null = null,
  ) {}

  static create(
    context: ExecutionContext | ArgumentsHost,
  ): McpExecutionContext {
    if (context instanceof McpExecutionContext) {
      return context;
    }
    const exec = context as Partial<ExecutionContext>;
    const ctor = typeof exec.getClass === "function" ? exec.getClass() : null;
    const handler =
      typeof exec.getHandler === "function" ? exec.getHandler() : null;
    const mcp = new McpExecutionContext(context.getArgs(), ctor, handler);
    mcp.setType(context.getType<McpContextType>() || MCP_CONTEXT_TYPE);
    return mcp;
  }

  setType(type: string): void {
    this.contextType = type;
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
      getData: <T = any>() => this.args[0] as T,
      getContext: <T = any>() => this.args[1] as T,
    };
  }

  switchToHttp(): HttpArgumentsHost {
    return {
      getRequest: <T = any>() => this.getRequest<T>() as T,
      getResponse: <T = any>() => undefined as T,
      getNext: <T = any>() => undefined as T,
    };
  }

  switchToWs(): WsArgumentsHost {
    return {
      getClient: <T = any>() => undefined as T,
      getData: <T = any>() => this.args[0] as T,
      getPattern: () => this.getName() ?? "",
    };
  }

  /** The validated arguments (tools, prompts) or URI template variables (resource templates). */
  getInput<T = any>(): T {
    return this.args[0] as T;
  }

  getContext<TRequest = any>(): McpContext<TRequest> {
    return this.args[1] as McpContext<TRequest>;
  }

  getKind(): McpCallKind | undefined {
    return this.getContext()?.kind;
  }

  getName(): string | undefined {
    return this.getContext()?.name;
  }

  getRequest<TRequest = any>(): TRequest | undefined {
    return this.getContext<TRequest>()?.request;
  }

  getAuthInfo(): McpAuthInfo | undefined {
    return this.getContext()?.authInfo;
  }

  getSessionId(): string | undefined {
    return this.getContext()?.sessionId;
  }
}
