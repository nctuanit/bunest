import { DomainException } from "../exceptions/domain.exception";
import { HttpException } from "../exceptions/http.exception";
import type {
  CanActivate,
  ExecutionContext,
  GuardLike,
} from "../interfaces/pipeline.interface";
import type { Type } from "../interfaces/type.interface";

export const GUARD_COMPOSITE_METADATA = Symbol.for("bunest:guard:composite");

export type GuardCompositeOperator = "any" | "all" | "not";

export interface GuardCompositeMetadata {
  readonly operator: GuardCompositeOperator;
  readonly guards: readonly GuardLike[];
}

function isAuthDenialError(error: unknown): boolean {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return status === 401 || status === 403;
  }
  if (error instanceof DomainException) {
    return error.httpStatus === 401 || error.httpStatus === 403;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { getStatus?: unknown }).getStatus === "function"
  ) {
    const status = (error as { getStatus(): unknown }).getStatus();
    return status === 401 || status === 403;
  }
  return false;
}

function validateGuardItems(
  helperName: string,
  guards: readonly GuardLike[],
): void {
  if (guards.length === 0) {
    throw new Error(`${helperName}() requires at least one guard.`);
  }
  for (let i = 0; i < guards.length; i++) {
    const item = guards[i];
    const valid =
      typeof item === "function" ||
      (typeof item === "object" &&
        item !== null &&
        typeof (item as { canActivate?: unknown }).canActivate === "function");
    if (!valid) {
      throw new Error(
        `Invalid guard passed to ${helperName}() at index ${i} (expected a guard class or an object with a canActivate() method).`,
      );
    }
  }
}

function resolveStandaloneGuard(guard: GuardLike): CanActivate {
  if (typeof guard === "function") {
    return new (guard as Type<CanActivate>)();
  }
  return guard;
}

/**
 * Builds a runtime `CanActivate` instance from already DI-resolved child guards.
 * Used internally by `DIContainer.resolveEnhancer()` and by standalone composite guards.
 */
export function createCompositeGuardInstance(
  operator: GuardCompositeOperator,
  resolvedGuards: readonly CanActivate[],
): CanActivate {
  if (operator === "any") {
    return {
      async canActivate(context: ExecutionContext): Promise<boolean> {
        let lastAuthError: unknown;
        let hasAuthError = false;

        for (let i = 0; i < resolvedGuards.length; i++) {
          const guard = resolvedGuards[i]!;
          try {
            const allowed = await guard.canActivate(context);
            if (allowed) {
              return true;
            }
          } catch (err) {
            if (isAuthDenialError(err)) {
              lastAuthError = err;
              hasAuthError = true;
              continue;
            }
            // Non-auth errors (500, DB failures, etc.) must propagate immediately
            throw err;
          }
        }

        if (hasAuthError) {
          throw lastAuthError;
        }
        return false;
      },
    };
  }

  if (operator === "all") {
    return {
      async canActivate(context: ExecutionContext): Promise<boolean> {
        for (let i = 0; i < resolvedGuards.length; i++) {
          const allowed = await resolvedGuards[i]!.canActivate(context);
          if (!allowed) {
            return false;
          }
        }
        return true;
      },
    };
  }

  // operator === "not"
  return {
    async canActivate(context: ExecutionContext): Promise<boolean> {
      const inner = resolvedGuards[0]!;
      try {
        const allowed = await inner.canActivate(context);
        return !allowed;
      } catch (err) {
        if (isAuthDenialError(err)) {
          return true;
        }
        throw err;
      }
    },
  };
}

export function getGuardCompositeMetadata(
  target: unknown,
): GuardCompositeMetadata | undefined {
  if (typeof target !== "function") return undefined;
  return (target as unknown as Record<PropertyKey, unknown>)[
    GUARD_COMPOSITE_METADATA
  ] as GuardCompositeMetadata | undefined;
}

function createCompositeGuardClass(
  operator: GuardCompositeOperator,
  guards: readonly GuardLike[],
  className: string,
): Type<CanActivate> {
  const frozenGuards = Object.freeze([...guards]);

  class ComposedGuard implements CanActivate {
    private standalone?: CanActivate;

    canActivate(context: ExecutionContext): boolean | Promise<boolean> {
      if (!this.standalone) {
        this.standalone = createCompositeGuardInstance(
          operator,
          frozenGuards.map(resolveStandaloneGuard),
        );
      }
      return this.standalone.canActivate(context);
    }
  }

  Object.defineProperty(ComposedGuard, "name", {
    value: className,
    configurable: true,
  });
  Object.defineProperty(ComposedGuard, GUARD_COMPOSITE_METADATA, {
    value: Object.freeze<GuardCompositeMetadata>({
      operator,
      guards: frozenGuards,
    }),
    enumerable: false,
    configurable: false,
  });

  return ComposedGuard;
}

/**
 * Composes multiple guards with **OR** semantics for `@UseGuards(AnyGuard(JwtGuard, ApiKeyGuard))`.
 *
 * - Evaluates guards sequentially via DI (including `TestingModule.overrideGuard()`).
 * - Short-circuits and allows the request as soon as ANY guard returns `true`.
 * - Catches 401/403 `HttpException` denials and tries the next guard; rethrows the
 *   last auth denial if all guards fail (non-auth 5xx errors propagate immediately).
 */
export function AnyGuard(...guards: GuardLike[]): Type<CanActivate> {
  validateGuardItems("AnyGuard", guards);
  return createCompositeGuardClass("any", guards, "AnyGuardMixin");
}

/**
 * Composes multiple guards with **AND** semantics — useful when nesting inside
 * `AnyGuard(AllGuards(JwtGuard, AdminGuard), ApiKeyGuard)`.
 */
export function AllGuards(...guards: GuardLike[]): Type<CanActivate> {
  validateGuardItems("AllGuards", guards);
  return createCompositeGuardClass("all", guards, "AllGuardsMixin");
}

/**
 * Negates a single guard — allows the request if the inner guard returns `false`
 * or throws a 401/403 `HttpException`, and denies it if the inner guard returns `true`.
 */
export function NotGuard(guard: GuardLike): Type<CanActivate> {
  validateGuardItems("NotGuard", [guard]);
  return createCompositeGuardClass("not", [guard], "NotGuardMixin");
}
