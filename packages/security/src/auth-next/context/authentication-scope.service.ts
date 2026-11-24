import {
  ContextStorage,
  Injectable,
  type ExecutionContext,
  type HttpIncomingHeaders,
} from "@bunest/core";
import type { AuthenticationResult } from "../interfaces/authentication-result.interface";
import { graphqlContextOf } from "../utils/graphql-context.util";

export type IncomingHeadersLike = HttpIncomingHeaders;

export interface Scope {
  result: AuthenticationResult<any, any> | null;
  /** The call being handled; absent inside `AuthenticationContext.run()`. */
  context?: ExecutionContext;
}

/** The request and response of an HTTP call. */
export interface HttpExchange {
  request: {
    headers: HttpIncomingHeaders | Headers;
    method?: string;
    ip?: string;
    url?: string;
  };
  response?: unknown;
}

const calls = new ContextStorage<Scope>();

/** @internal Runs `fn` as the handling of this call (the interceptor, around `next.handle()`). */
export function runCall<R>(scope: Scope, fn: () => R): R {
  return calls.run(scope, fn);
}

/**
 * @internal What the handler of this call sees: the result the guard recorded for it, when the
 * interceptor is handling this handler.
 */
export function scopedResult(
  context: ExecutionContext,
): Scope["result"] | undefined {
  const call = calls.getStore();
  return call?.context && call.context.getHandler() === context.getHandler()
    ? call.result
    : undefined;
}

/**
 * @internal The per-call scope behind `AuthenticationContext` and `SignInService`.
 */
@Injectable()
export class AuthenticationScope {
  private readonly storage = new ContextStorage<Scope>();

  get current(): Scope | undefined {
    return this.storage.getStore();
  }

  run<R>(scope: Scope, fn: () => R): R {
    return this.storage.run(scope, fn);
  }

  /**
   * The HTTP request and response of the current call: an HTTP handler, a
   * GraphQL resolver whose context carries `req` (and `res`), or an MCP/AI call.
   */
  exchange(): HttpExchange | undefined {
    const context = this.current?.context;
    switch (context?.getType<string>()) {
      case "http": {
        const http = context.switchToHttp();
        return {
          request: http.getRequest() as HttpExchange["request"],
          response: http.getResponse(),
        };
      }
      case "graphql": {
        const gql = graphqlContextOf(context);
        return gql?.req
          ? {
              request: gql.req as HttpExchange["request"],
              response: gql.res,
            }
          : undefined;
      }
      case "mcp":
      case "ai": {
        const call = context.getArgByIndex(1) as
          { request?: HttpExchange["request"] } | undefined;
        const request = call?.request;
        return request?.headers ? { request } : undefined;
      }
      default:
        return undefined;
    }
  }
}
