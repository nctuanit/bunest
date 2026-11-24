import {
  UseGuards,
  applyDecorators,
  type ComposedDecorator,
  type GuardLike,
} from "@bunest/core";
import { CheckPolicies, Roles, type PolicyHandler } from "./auth.decorators";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { PoliciesGuard } from "./policies.guard";
import { RolesGuard } from "./roles.guard";

export interface ProtectedOptions {
  /**
   * Required roles checked by `RolesGuard`.
   */
  roles?: readonly string[];
  /**
   * Custom guards to apply. When omitted, defaults to `[JwtAuthGuard, RolesGuard]`.
   * When provided alongside `roles`, `RolesGuard` is appended automatically if not already present.
   */
  guards?: readonly GuardLike[];
  /**
   * Optional ABAC policy handlers checked by `PoliciesGuard`.
   */
  policies?: readonly PolicyHandler[];
}

/**
 * Composite authentication & RBAC decorator composing `UseGuards(JwtAuthGuard, RolesGuard)`
 * and optional `@Roles(...roles)` in a single declaration.
 */
export function Auth(...roles: string[]): ComposedDecorator {
  return applyDecorators(
    UseGuards(JwtAuthGuard, RolesGuard),
    ...(roles.length > 0 ? [Roles(...roles)] : []),
  );
}

/**
 * Declarative protection decorator composing guards, optional RBAC roles,
 * and optional ABAC policies on controllers or route handlers.
 */
export function Protected(options: ProtectedOptions = {}): ComposedDecorator {
  const hasRoles = Boolean(options.roles && options.roles.length > 0);
  const hasPolicies = Boolean(options.policies && options.policies.length > 0);

  const guards: GuardLike[] =
    options.guards && options.guards.length > 0
      ? [...options.guards]
      : [JwtAuthGuard, RolesGuard];

  if (hasRoles && !guards.includes(RolesGuard)) {
    guards.push(RolesGuard);
  }
  if (hasPolicies && !guards.includes(PoliciesGuard)) {
    guards.push(PoliciesGuard);
  }

  return applyDecorators(
    UseGuards(...guards),
    ...(hasRoles ? [Roles(...options.roles!)] : []),
    ...(hasPolicies ? [CheckPolicies(...options.policies!)] : []),
  );
}
