export interface Type<T = any> extends Function {
  new (...args: any[]): T;
}

export type Abstract<T = any> = abstract new (...args: any[]) => T;

/**
 * Phantom-typed symbol token carrying compile-time value type `T` for
 * type-safe DI registration and retrieval (`app.get(token)` / `moduleRef.get(token)`).
 */
export type TypedToken<T> = symbol & { readonly __bunestTokenType?: T };

/**
 * Creates a type-safe DI injection token whose runtime value is a unique `Symbol`
 * and whose compile-time type is `TypedToken<T>`.
 *
 * @example
 * ```ts
 * export const CACHE_CLIENT = createToken<CacheClient>("CACHE_CLIENT");
 * // app.get(CACHE_CLIENT) -> CacheClient (no explicit generic needed!)
 * ```
 */
export function createToken<T>(description: string): TypedToken<T> {
  return Symbol(description) as TypedToken<T>;
}

export type InjectionToken<T = any> =
  Type<T> | Abstract<T> | TypedToken<T> | string | symbol;

export interface ForwardReference<T = any> {
  readonly forwardRef: () => T;
}

/**
 * Allows referencing a class or module that has not yet been defined,
 * breaking circular reference issues in decorator metadata.
 */
export function forwardRef<T = any>(fn: () => T): ForwardReference<T> {
  return { forwardRef: fn };
}

export function isForwardReference<T = any>(
  value: unknown,
): value is ForwardReference<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "forwardRef" in value &&
    typeof (value as ForwardReference).forwardRef === "function"
  );
}
