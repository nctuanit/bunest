import {
  SetMetadata,
  createParamDecorator,
  type ExecutionContext,
  type Type,
} from "@bunest/common";

export const IS_PUBLIC_KEY = Symbol.for("bunest:security:is_public");
export const ROLES_KEY = Symbol.for("bunest:security:roles");
export const POLICIES_KEY = Symbol.for("bunest:security:policies");

export interface IPolicyHandler<TUser = any> {
  handle(user: TUser, context: ExecutionContext): boolean | Promise<boolean>;
}

export type PolicyHandlerCallback<TUser = any> = (
  user: TUser,
  context: ExecutionContext,
) => boolean | Promise<boolean>;

export type PolicyHandler<TUser = any> =
  | IPolicyHandler<TUser>
  | Type<IPolicyHandler<TUser>>
  | PolicyHandlerCallback<TUser>;

// Request-bound WeakMap storing authenticated user objects cleanly without
// mutating native Web Request instances or leaking memory across requests.
const requestUserStore = new WeakMap<object, unknown>();

export function setRequestUser(req: object, user: unknown): void {
  requestUserStore.set(req, user);
}

export function getRequestUser<T = any>(req: object): T | undefined {
  return requestUserStore.get(req) as T | undefined;
}

/**
 * Marks a controller or route handler as publicly accessible, bypassing `JwtAuthGuard`.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Declares required roles checked by `RolesGuard`.
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Declares fine-grained ABAC policy handlers checked by `PoliciesGuard`.
 */
export const CheckPolicies = (...handlers: PolicyHandler[]) =>
  SetMetadata(POLICIES_KEY, handlers);

/**
 * Extracts the authenticated user (or a specific property on the user object)
 * attached by `JwtAuthGuard` or custom authentication guards.
 */
export const CurrentUser = createParamDecorator(
  (property: string | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<Request>();
    const user = getRequestUser<Record<string, unknown>>(req);
    if (!property) {
      return user;
    }
    return user && typeof user === "object" ? user[property] : undefined;
  },
);
