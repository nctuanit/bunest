import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from "@bunest/common";
import type { AuthorizationError } from "../errors/authorization.error";

const loaded = new Map<string, Promise<(new (arg: any) => Error) | undefined>>();

/** Lazily loads an optional peer's exception class, once. */
function load(
  pkg: string,
  name: string,
): Promise<(new (arg: any) => Error) | undefined> {
  const key = `${pkg}#${name}`;
  let pending = loaded.get(key);
  if (!pending) {
    pending = import(pkg).then(
      (mod: Record<string, unknown>) =>
        mod[name] as (new (arg: any) => Error) | undefined,
      () => undefined,
    );
    loaded.set(key, pending);
  }
  return pending;
}

/**
 * Converts a transport-agnostic `AuthorizationError` into the active transport's
 * exception (`UnauthorizedException`/`ForbiddenException` for HTTP/GraphQL/MCP/AI,
 * `WsException` for WS, `RpcException` for RPC).
 */
export async function toTransportError(
  context: ExecutionContext,
  denial: AuthorizationError,
): Promise<Error> {
  const exception =
    denial.reason === "unauthenticated"
      ? new UnauthorizedException(undefined, { cause: denial })
      : new ForbiddenException(undefined, { cause: denial });
  const rawBody = exception.getResponse();
  const body =
    typeof rawBody === "object" && rawBody !== null
      ? rawBody
      : { message: String(rawBody), statusCode: exception.getStatus() };

  switch (context.getType<string>()) {
    case "ws": {
      const WsException = await load("@bunest/websockets", "WsException");
      if (WsException) {
        return withCause(
          new WsException({ status: "error", ...body }),
          denial,
        );
      }
      break;
    }
    case "rpc": {
      const RpcException = await load("@bunest/microservices", "RpcException");
      if (RpcException) {
        return withCause(new RpcException(body), denial);
      }
      break;
    }
    case "mcp":
    case "ai":
      break;
  }

  return exception;
}

function withCause(error: Error, cause: unknown): Error {
  (error as { cause?: unknown }).cause = cause;
  return error;
}
