import type { ExecutionContext } from "@bunest/core";
import { scopedResult } from "../context/authentication-scope.service";
import type { AuthenticationResult } from "../interfaces/authentication-result.interface";
import { graphqlContextOf } from "./graphql-context.util";
import {
  readFirstHeader,
  toHeaderMap,
  type HeaderMap,
  type HeadersInput,
} from "./headers.util";

type State = AuthenticationResult<unknown, unknown> | null;

const AUTH_STATE = Symbol.for("nestjs.authentication.state");
const MIRRORED_SESSION = Symbol.for("nestjs.authentication.mirrored-session");
const USER_OF = Symbol.for("nestjs.authentication.userOf");
const RAW = Symbol.for("nestjs.authentication.raw");

const perCall = new WeakMap<object, State>();
const rawPerCall = new WeakMap<object, State>();

function callKeys(context: ExecutionContext): object[] {
  if (context.getType<string>() !== "ws") {
    return [];
  }
  const data = context.switchToWs().getData();
  const keys: object[] = [context.getArgs()];
  if (typeof data === "object" && data !== null) {
    keys.push(data as object);
  }
  return keys;
}

function callContextOf(
  context: ExecutionContext,
): Record<PropertyKey, unknown> | undefined {
  const call = context.getArgByIndex(1);
  return typeof call === "object" && call !== null
    ? (call as Record<PropertyKey, unknown>)
    : undefined;
}

function carrierOf(
  context: ExecutionContext,
): Record<PropertyKey, unknown> | undefined {
  switch (context.getType<string>()) {
    case "http":
      return context.switchToHttp().getRequest() as
        | Record<PropertyKey, unknown>
        | undefined;
    case "ws":
      return context.switchToWs().getClient() as
        | Record<PropertyKey, unknown>
        | undefined;
    case "rpc": {
      const ctx = context.switchToRpc().getContext();
      return typeof ctx === "object" && ctx !== null
        ? (ctx as Record<PropertyKey, unknown>)
        : undefined;
    }
    case "graphql":
      return graphqlContextOf(context)?.req as
        | Record<PropertyKey, unknown>
        | undefined;
    case "mcp":
    case "ai": {
      const call = callContextOf(context);
      return (call?.request ?? call) as
        | Record<PropertyKey, unknown>
        | undefined;
    }
    default:
      return undefined;
  }
}

function stateCarrierOf(
  context: ExecutionContext,
): Record<PropertyKey, unknown> | undefined {
  if (context.getType<string>() === "graphql") {
    return graphqlContextOf(context) as
      | Record<PropertyKey, unknown>
      | undefined;
  }
  return carrierOf(context);
}

/**
 * Records what the handler sees (`@CurrentUser()`, `AuthenticationContext`, `request.user`).
 */
export function setAuthState(
  context: ExecutionContext,
  result: State,
  { perCallOnly = false }: { perCallOnly?: boolean | undefined } = {},
): void {
  for (const key of callKeys(context)) {
    perCall.set(key, result);
  }
  const carrier = carrierOf(context);
  const type = context.getType<string>();
  if (carrier && (type === "ws" || type === "graphql")) {
    carrier[USER_OF] = userOf;
  }
  if (perCallOnly) {
    return;
  }
  const own = stateCarrierOf(context);
  if (own) {
    own[AUTH_STATE] = result;
  }
  if (!carrier) {
    return;
  }
  carrier.user = result?.user ?? null;
  if (
    !("session" in carrier) ||
    carrier.session === carrier[MIRRORED_SESSION]
  ) {
    carrier.session = result?.session ?? null;
    carrier[MIRRORED_SESSION] = carrier.session;
  }
}

/**
 * `undefined` when authentication has not run for this call, `null` when it
 * ran and the caller is anonymous.
 */
export function getAuthState(context: ExecutionContext): State | undefined {
  for (const key of callKeys(context)) {
    if (perCall.has(key)) {
      return perCall.get(key);
    }
  }
  const own = stateCarrierOf(context);
  return own && AUTH_STATE in own ? (own[AUTH_STATE] as State) : undefined;
}

/**
 * @internal This call's result: the scope the interceptor opened for it, else
 * what the guard recorded on the carrier.
 */
export function resultOf(context: ExecutionContext): State | undefined {
  const scoped = scopedResult(context);
  return scoped !== undefined ? scoped : getAuthState(context);
}

function userOf(context: ExecutionContext): unknown {
  const result = resultOf(context);
  if (result === undefined) {
    return context.getType<string>() === "graphql" ? null : undefined;
  }
  return result?.user ?? null;
}

export function setRawResult(context: ExecutionContext, result: State): void {
  if (context.getType<string>() === "ws") {
    for (const key of callKeys(context)) {
      rawPerCall.set(key, result);
    }
    return;
  }
  const own = stateCarrierOf(context);
  if (own) {
    own[RAW] = result;
  }
}

export function getRawResult(context: ExecutionContext): State | undefined {
  if (context.getType<string>() === "ws") {
    for (const key of callKeys(context)) {
      if (rawPerCall.has(key)) {
        return rawPerCall.get(key);
      }
    }
    return undefined;
  }
  const own = stateCarrierOf(context);
  return own && RAW in own ? (own[RAW] as State) : undefined;
}

export function getRequestHeaders(
  context: ExecutionContext,
): HeaderMap | undefined {
  return toHeaderMap(requestOf(context)?.headers);
}

export function requestOf(context: ExecutionContext):
  | {
      headers: HeaderMap;
      method?: string;
      url?: string;
      ip?: string;
    }
  | undefined {
  switch (context.getType<string>()) {
    case "http": {
      const req = context.switchToHttp().getRequest() as
        | { headers?: HeadersInput; method?: string; url?: string; ip?: string }
        | undefined;
      if (!req?.headers) {
        return undefined;
      }
      const headers = toHeaderMap(req.headers);
      if (!headers) return undefined;
      if (headers === (req.headers as unknown)) {
        return req as {
          headers: HeaderMap;
          method?: string;
          url?: string;
          ip?: string;
        };
      }
      return {
        headers,
        method: req.method,
        url: req.url,
        ip: req.ip,
      };
    }
    case "ws": {
      const client = context.switchToWs().getClient() as
        | {
            handshake?: { headers?: HeadersInput };
            request?: { headers?: HeadersInput };
          }
        | undefined;
      const raw = client?.handshake?.headers ?? client?.request?.headers;
      const headers = toHeaderMap(raw);
      return headers ? { headers } : undefined;
    }
    case "graphql": {
      const req = graphqlContextOf(context)?.req as
        | { headers?: HeadersInput; method?: string; url?: string; ip?: string }
        | undefined;
      if (!req?.headers) return undefined;
      const headers = toHeaderMap(req.headers);
      if (!headers) return undefined;
      return headers === (req.headers as unknown)
        ? (req as {
            headers: HeaderMap;
            method?: string;
            url?: string;
            ip?: string;
          })
        : { headers, method: req.method, url: req.url, ip: req.ip };
    }
    case "mcp":
    case "ai": {
      const request = callContextOf(context)?.request as
        | { headers?: HeadersInput; method?: string; url?: string; ip?: string }
        | undefined;
      if (!request?.headers) return undefined;
      const headers = toHeaderMap(request.headers);
      if (!headers) return undefined;
      return headers === (request.headers as unknown)
        ? (request as {
            headers: HeaderMap;
            method?: string;
            url?: string;
            ip?: string;
          })
        : {
            headers,
            method: request.method,
            url: request.url,
            ip: request.ip,
          };
    }
    default:
      return undefined;
  }
}

export function firstHeader(
  headers: HeadersInput,
  name: string,
): string | undefined {
  return readFirstHeader(headers, name);
}
