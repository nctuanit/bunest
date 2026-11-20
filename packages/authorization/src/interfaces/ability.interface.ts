import type { ExecutionContext } from "@bunest/common";

type AbilityFn = (user: any, ...args: any[]) => boolean | Promise<boolean>;

/** The abilities of policy `P`, keyed by name. */
type AbilityMap<P> = {
  [K in keyof P as K extends "before"
    ? never
    : P[K] extends AbilityFn
      ? K
      : never]: P[K];
};

/**
 * Names of the ability methods on policy `P`: every method whose first
 * parameter is the user and which returns `boolean | Promise<boolean>`.
 * `before` and helpers returning anything else are excluded.
 */
export type Ability<P> =
  AbilityMap<P> extends infer M ? keyof M & string : never;

/** The user parameter type of ability `A` on policy `P`. */
export type AbilityUser<P, A extends keyof P> = P[A] extends (
  user: infer U,
  ...args: any[]
) => any
  ? U
  : never;

/** Parameters after the user, for ability `A` on policy `P`. */
export type AbilityArgs<P, A extends keyof P> = P[A] extends (
  user: any,
  ...args: infer R
) => any
  ? R
  : never;

/**
 * What a caller may pass as the user for ability `A`. An ability typed
 * `(user: User | null, ...)` accepts `null` and `undefined` (normalized to
 * `null`); one typed `(user: User, ...)` requires a `User`, so the caller
 * narrows first.
 */
export type UserArg<P, A extends keyof P> =
  null extends AbilityUser<P, A>
    ? AbilityUser<P, A> | undefined
    : AbilityUser<P, A>;

/**
 * Abilities usable in `@Can()`: those accepting `null` as the user, because
 * the guard cannot know statically whether a route has a user.
 */
export type RouteAbility<P> = {
  [K in Ability<P>]: null extends AbilityUser<P, K> ? K : never;
}[Ability<P>];

/**
 * What `@Can()` accepts as the ability: the route-usable ability names,
 * spelled out so compile errors list them. A policy without any gets a
 * message saying why instead of `never`.
 */
export type CanAbility<P> = [RouteAbility<P>] extends [never]
  ? "no ability of this policy works in @Can(): its user parameter must be typed User | null"
  : `${RouteAbility<P> & string}`;

/**
 * Reads the arguments after the user for ability `A` from the call.
 */
export type CanArgsResolver<P, A extends keyof P> = (
  context: ExecutionContext,
) => Readonly<AbilityArgs<P, A>> | Promise<Readonly<AbilityArgs<P, A>>>;

/**
 * The rest of `@Can()`'s parameters for ability `A`.
 */
export type CanArgs<P, A> = [A] extends [never]
  ? [args?: (context: ExecutionContext) => readonly unknown[]]
  : [A] extends [CanAbility<P> & keyof P]
    ? [] extends AbilityArgs<P, A & keyof P>
      ? [args?: CanArgsResolver<P, A & keyof P>]
      : [args: CanArgsResolver<P, A & keyof P>]
    : [args?: (context: ExecutionContext) => readonly unknown[]];
