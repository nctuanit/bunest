import {
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  Reflector,
  type CanActivate,
  type ExecutionContext,
} from "@bunest/core";
import { ROLES_KEY, getRequestUser } from "./auth.decorators";

export const ROLES_GUARD_OPTIONS = Symbol.for(
  "bunest:security:roles_guard_options",
);

export interface RolesGuardOptions {
  getUserRoles?: (
    user: unknown,
    context: ExecutionContext,
  ) => readonly string[] | undefined;
  requireAll?: boolean;
}

/**
 * RBAC guard matching `@Roles(...)` metadata against the authenticated user's roles.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional()
    @Inject(ROLES_GUARD_OPTIONS)
    private readonly options?: RolesGuardOptions,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();
    const user = getRequestUser<Record<string, unknown>>(req);
    if (!user) {
      throw new ForbiddenException("Insufficient role permissions");
    }

    let userRoles: readonly string[];
    if (this.options?.getUserRoles) {
      userRoles = this.options.getUserRoles(user, context) ?? [];
    } else if (Array.isArray(user.roles)) {
      userRoles = user.roles.filter((r): r is string => typeof r === "string");
    } else if (typeof user.role === "string") {
      userRoles = [user.role];
    } else {
      userRoles = [];
    }

    const allowed = this.options?.requireAll
      ? requiredRoles.every((role) => userRoles.includes(role))
      : requiredRoles.some((role) => userRoles.includes(role));

    if (!allowed) {
      throw new ForbiddenException("Insufficient role permissions");
    }

    return true;
  }
}
