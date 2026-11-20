import { Injectable, Logger, type Type } from "@bunest/common";
import type { DenialReason } from "../errors/authorization.error";
import { toPolicyUser } from "../utils/get-user.util";
import { findAbility, PolicyRegistry } from "./policy-registry.service";

export type Decision = "allow" | DenialReason;

const isNullDereference = (error: unknown): boolean =>
  error instanceof TypeError && /\bnull\b/.test(error.message);

/**
 * Runs one check: `before()`, then the ability. Shared by the guard and
 * `AuthorizationService`; never throws on a denial.
 */
@Injectable()
export class PolicyEvaluator {
  private readonly logger = new Logger("Authorization");
  private readonly warnedGuestErrors = new Set<string>();

  constructor(private readonly registry: PolicyRegistry) {}

  async decide(
    policy: Type<unknown>,
    ability: string,
    user: unknown,
    args: unknown[],
  ): Promise<Decision> {
    const instance = this.registry.get(policy) as Record<string, unknown>;
    const method = findAbility(instance, ability);
    if (!method) {
      throw new Error(`${policy.name} has no ability '${ability}'.`);
    }
    const current = toPolicyUser(user);
    let verdict: boolean;
    try {
      verdict = await this.evaluate(instance, method, ability, current, args);
    } catch (error) {
      if (current !== null || !isNullDereference(error)) {
        throw error;
      }
      this.warnGuestError(policy, ability, error as Error);
      return "unauthenticated";
    }
    if (verdict) {
      return "allow";
    }
    return current === null ? "unauthenticated" : "forbidden";
  }

  private warnGuestError(
    policy: Type<unknown>,
    ability: string,
    error: Error,
  ): void {
    const key = `${policy.name}.${ability}`;
    if (this.warnedGuestErrors.has(key)) {
      return;
    }
    this.warnedGuestErrors.add(key);
    this.logger.warn(
      `${key} threw for a guest (${error.message}); treated as a denial. ` +
        `Type the user parameter of before() and of this ability as User | null.`,
    );
  }

  private async evaluate(
    instance: Record<string, unknown>,
    method: Function,
    ability: string,
    user: unknown,
    args: unknown[],
  ): Promise<boolean> {
    if (typeof instance.before === "function") {
      const early = await (
        instance.before as (
          u: unknown,
          a: string,
          ...rest: unknown[]
        ) => unknown
      )(user, ability, ...args);
      if (early === true || early === false) {
        return early;
      }
    }
    // Only a literal `true` allows; truthy values do not.
    return (await method.call(instance, user, ...args)) === true;
  }
}
