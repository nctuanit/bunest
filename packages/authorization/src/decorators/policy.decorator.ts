import { Injectable } from "@bunest/common";
import { POLICY_METADATA } from "../authorization.constants";
import type { GuestSafeBefore } from "../interfaces/policy-before.interface";

/**
 * Marks a class as a policy and makes it injectable. Every method returning
 * `boolean | Promise<boolean>` whose first parameter is the user is an
 * ability. A `before()` hook must accept a `null` user.
 */
export function Policy(): <T extends Function>(
  target: T & GuestSafeBefore<T>,
) => void {
  return (target) => {
    Injectable()(target);
    Reflect.defineMetadata(POLICY_METADATA, true, target);
  };
}
