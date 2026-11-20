/**
 * Optional hook on a policy. Return `true`/`false` to decide, `undefined` to
 * fall through to the ability. Receives `null` when there is no user, so its
 * user parameter must accept `null`: `before(user: User)` is a compile error.
 */
export interface PolicyBefore<
  TUser = unknown,
  TAbility extends string = string,
> {
  before: (
    user: TUser | null,
    ability: TAbility,
    ...args: any[]
  ) =>
    | boolean
    | undefined
    | void
    | Promise<boolean | undefined | void>;
}

/**
 * What `@Policy()` accepts: any class, but if it has a `before()` hook, the
 * hook's user parameter must accept `null` (guests reach it too).
 */
export type GuestSafeBefore<T> = T extends abstract new (...args: any[]) => {
  before: infer B;
}
  ? B extends (user: null, ...args: any[]) => unknown
    ? unknown
    : {
        "before() must accept a null user (guests reach it too): type it User | null": true;
      }
  : unknown;
