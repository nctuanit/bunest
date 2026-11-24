import type { ExecutionContext } from "@bunest/core";
import { AUTHENTICATION_USER_OF } from "../authorization.constants";

/**
 * @internal The user a policy sees: `null` for a guest. `undefined` (no user
 * set) and `false` (what Passport's optional authentication leaves on
 * `request.user` when there are no credentials) mean a guest too.
 */
export const toPolicyUser = (user: unknown): unknown =>
  user === undefined || user === false ? null : user;

/**
 * The default `getUser`: where `@bunest/security/auth`, Passport and most
 * auth guards leave the user across `http`, `ws`, `rpc`, `graphql`, `mcp`,
 * and `ai` execution contexts.
 */
export function defaultGetUser(context: ExecutionContext): unknown {
  switch (context.getType<string>()) {
    case "http":
      return (
        context.switchToHttp().getRequest() as
          Record<PropertyKey, unknown> | undefined
      )?.user;
    case "ws": {
      const client = context.switchToWs().getClient() as
        | Record<PropertyKey, unknown>
        | undefined;
      const own = recordedUser(client, context);
      if (own !== undefined) {
        return own;
      }
      if (client?.user !== undefined) {
        return client.user;
      }
      const data = client?.data;
      return data && typeof data === "object"
        ? (data as Record<PropertyKey, unknown>).user
        : undefined;
    }
    case "rpc":
      return (
        context.switchToRpc().getContext() as
          | Record<PropertyKey, unknown>
          | undefined
      )?.user;
    case "graphql": {
      const gqlCtx = context.getArgByIndex(
        context.getArgs().length === 3 ? 1 : 2,
      ) as Record<PropertyKey, unknown> | undefined;
      const req = gqlCtx?.req as Record<PropertyKey, unknown> | undefined;
      const own = recordedUser(req, context);
      return own !== undefined ? own : req?.user;
    }
    case "mcp":
    case "ai": {
      const call = context.getArgByIndex(1) as
        | Record<PropertyKey, unknown>
        | undefined;
      const carrier = (call?.request ?? call) as
        | Record<PropertyKey, unknown>
        | undefined;
      return carrier?.user;
    }
    default:
      return undefined;
  }
}

/** What authentication answers for this call, through the function it left on `carrier`, if any. */
function recordedUser(
  carrier: Record<PropertyKey, unknown> | undefined,
  context: ExecutionContext,
): unknown {
  const userOf = carrier?.[AUTHENTICATION_USER_OF];
  return typeof userOf === "function"
    ? (userOf as (this: unknown, ctx: ExecutionContext) => unknown).call(
        carrier,
        context,
      )
    : undefined;
}
