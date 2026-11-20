import type { ExecutionContext } from "@bunest/common";

/**
 * The token a bearer provider reads: the `Authorization: Bearer` header's,
 * else, over socket.io, `handshake.auth.token`. `undefined` when there is
 * none, or the header names another scheme. `null` for a malformed Bearer header.
 */
export function bearerToken(
  context: ExecutionContext,
  authorization: string | undefined,
): string | null | undefined {
  if (authorization) {
    const [scheme, token, ...rest] = authorization.trim().split(/\s+/);
    if (!scheme || scheme.toLowerCase() !== "bearer") {
      return undefined;
    }
    return token && !rest.length ? token : null;
  }
  if (context.getType<string>() === "ws") {
    const client = context.switchToWs().getClient() as
      | { handshake?: { auth?: { token?: unknown } } }
      | undefined;
    const token = client?.handshake?.auth?.token;
    return typeof token === "string" ? token : undefined;
  }
  return undefined;
}
