import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@bunest/common";
import {
  AUTHORIZATION_GUARD,
  AUTHORIZATION_MODULE_OPTIONS,
} from "../authorization.constants";
import {
  AuthorizationError,
  type DenialReason,
} from "../errors/authorization.error";
import { AuthorizationEvents } from "../events/authorization-events.service";
import type { AuthorizationModuleOptions } from "../interfaces/authorization-module-options.interface";
import { PolicyEvaluator } from "../services/policy-evaluator.service";
import { defaultGetUser, toPolicyUser } from "../utils/get-user.util";
import { routeChecks } from "../utils/route-checks.util";
import { toTransportError } from "../utils/transport-error.util";

/**
 * Enforces `@Can()` requirements (class-level first, then method-level; all
 * must pass; a method's `@Can.Anyone()` or `@Public()` lifts the class's),
 * each with the arguments its resolver reads from the call. Denies by
 * default: a handler with no `@Can()` runs only when it, or its class, has
 * `@Can.Anyone()` or `@bunest/authentication`'s `@Public()`.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  static readonly [AUTHORIZATION_GUARD] = true;

  constructor(
    private readonly evaluator: PolicyEvaluator,
    private readonly events: AuthorizationEvents,
    @Inject(AUTHORIZATION_MODULE_OPTIONS)
    private readonly options: AuthorizationModuleOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { onClass, onMethod, open } = routeChecks(
      context.getClass(),
      context.getHandler(),
    );
    const requirements = [...onClass, ...onMethod];
    if (requirements.length === 0 && open) {
      return true;
    }

    const user = toPolicyUser(
      await (this.options?.getUser
        ? this.options.getUser(context)
        : defaultGetUser(context)),
    );

    if (requirements.length === 0) {
      return this.deny(
        context,
        user === null ? "unauthenticated" : "forbidden",
        user,
        null,
        null,
        [],
      );
    }

    for (const { policy, ability, args: resolve } of requirements) {
      const args = resolve ? await resolve(context) : [];
      if (!Array.isArray(args)) {
        throw new TypeError(
          `The args of @Can(${policy.name}, '${ability}') must return an array: ` +
            `the ability's arguments after the user.`,
        );
      }
      const decision = await this.evaluator.decide(
        policy,
        ability,
        user,
        [...args],
      );
      if (decision !== "allow") {
        return this.deny(context, decision, user, policy.name, ability, args);
      }
    }

    return true;
  }

  private async deny(
    context: ExecutionContext,
    reason: DenialReason,
    user: unknown,
    policy: string | null,
    ability: string | null,
    args: readonly unknown[],
  ): Promise<never> {
    const handler = `${context.getClass().name}.${context.getHandler().name}`;
    this.events.emit({
      type: "denied",
      policy,
      ability,
      reason,
      user,
      args,
      handler,
    });
    throw await toTransportError(
      context,
      new AuthorizationError(reason, policy, ability),
    );
  }
}
