import {
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
  type HttpExceptionOptions,
} from "@bunest/core";
import type { HttpAdapterHost } from "@bunest/core";
import type { AuthenticationError } from "../errors/authentication.error";
import { setResponseHeader } from "./headers.util";

export interface Refusal {
  status?: 401 | 403 | 409;
  message?: string;
  code?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

const loaded = new Map<
  string,
  Promise<(new (arg: any) => Error) | undefined>
>();

function load(
  pkg: string,
  name: string,
): Promise<(new (arg: any) => Error) | undefined> {
  let pending = loaded.get(pkg);
  if (!pending) {
    pending = import(pkg).then(
      (mod: Record<string, unknown>) =>
        mod[name] as (new (arg: any) => Error) | undefined,
      () => undefined,
    );
    loaded.set(pkg, pending);
  }
  return pending;
}

const DEFAULT_MESSAGE = "Unauthorized";
const PHRASES: Record<401 | 403 | 409, string> = {
  401: "Unauthorized",
  403: "Forbidden",
  409: "Conflict",
};

/** The refusal for an `AuthenticationError` a provider or a handler threw. */
export function refusalOf(error: AuthenticationError): Refusal {
  const { status, message, code, details } = error;
  return { status, message, code, details, cause: error };
}

/**
 * Converts a refusal into the active transport's exception and sets
 * `WWW-Authenticate` on HTTP 401 responses when `challenge` is provided.
 */
export async function refusal(
  context: ExecutionContext,
  { status = 401, message, code, details, cause }: Refusal = {},
  {
    challenge,
    adapterHost,
  }: {
    challenge?: string;
    adapterHost?: HttpAdapterHost;
  } = {},
): Promise<Error> {
  const bare =
    message === undefined ||
    (status === 401 && message === DEFAULT_MESSAGE && !code);
  const payload: Record<string, unknown> = {
    statusCode: status,
    ...(!bare && code ? { error: code } : {}),
    message: message ?? PHRASES[status],
    ...(code ? { errorCode: code } : {}),
    ...(details !== undefined ? { details } : {}),
  };

  switch (context.getType<string>()) {
    case "ws": {
      const WsException = await load("@bunest/core/ws", "WsException");
      if (WsException) {
        return withCause(
          new WsException({ status: "error", ...payload }),
          cause,
        );
      }
      break;
    }
    case "rpc": {
      const RpcException = await load("@bunest/microservices", "RpcException");
      if (RpcException) {
        return withCause(new RpcException(payload), cause);
      }
      break;
    }
    case "http":
      if (challenge && status === 401) {
        setResponseHeader(
          adapterHost,
          context.switchToHttp().getResponse(),
          "WWW-Authenticate",
          challenge,
        );
      }
      break;
    case "mcp":
    case "ai":
      break;
  }

  const Exception =
    status === 409
      ? ConflictException
      : status === 403
        ? ForbiddenException
        : UnauthorizedException;
  const options: HttpExceptionOptions = {
    cause,
    ...(code
      ? { errorCode: code, ...(!bare ? { description: code } : {}) }
      : {}),
    ...(challenge && status === 401
      ? { headers: { "WWW-Authenticate": challenge } }
      : {}),
  };
  const exception = new Exception(bare ? undefined : message, options);
  if (details === undefined) {
    return exception;
  }
  const existingBody = exception.getResponse();
  const baseBody =
    typeof existingBody === "object" && existingBody !== null
      ? existingBody
      : { message: String(existingBody), statusCode: status };
  return new Exception({ ...baseBody, details }, options);
}

function withCause(error: Error, cause: unknown): Error {
  if (cause !== undefined) {
    (error as { cause?: unknown }).cause = cause;
  }
  return error;
}
