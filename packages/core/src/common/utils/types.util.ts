import type { Primitive } from "./type-guards.util";

/**
 * Flattens complex intersected object types for cleaner IDE hover previews.
 */
export type Prettify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Recursively makes all properties optional.
 */
export type DeepPartial<T> = T extends Primitive | Date | RegExp | ((...args: never[]) => unknown)
  ? T
  : T extends readonly (infer U)[]
    ? DeepPartial<U>[]
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

/**
 * Recursively marks all properties and arrays as `readonly`.
 */
export type DeepReadonly<T> = T extends Primitive | Date | RegExp | ((...args: never[]) => unknown)
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/**
 * Recursively marks all properties as required (non-optional).
 */
export type DeepRequired<T> = T extends Primitive | Date | RegExp | ((...args: never[]) => unknown)
  ? T
  : T extends readonly (infer U)[]
    ? DeepRequired<U>[]
    : T extends object
      ? { [K in keyof T]-?: DeepRequired<T[K]> }
      : T;

/**
 * Strips top-level `readonly` modifiers from an object type.
 */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Recursively strips `readonly` modifiers from objects and arrays.
 */
export type DeepMutable<T> = T extends Primitive | Date | RegExp | ((...args: never[]) => unknown)
  ? T
  : T extends readonly (infer U)[]
    ? DeepMutable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
      : T;

declare const BRAND_SYMBOL: unique symbol;

/**
 * Creates a nominal/branded type preventing accidental mixing of structurally identical primitives
 * (e.g. `type UserId = Brand<string, "UserId">`).
 */
export type Brand<T, Tag extends PropertyKey> = T & {
  readonly [BRAND_SYMBOL]: Tag;
};

/**
 * Strips a `Brand<T, Tag>` back to its underlying base type `T`.
 */
export type Unbrand<T> = T extends Brand<infer Base, PropertyKey> ? Base : T;

/**
 * Stricter version of built-in `Omit<T, K>` that requires `K` to be a valid key of `T`.
 */
export type StrictOmit<T, K extends keyof T> = Omit<T, K>;

/**
 * Requires at least one of the keys `Keys` (default all keys of `T`) to be present.
 */
export type RequireAtLeastOne<T, Keys extends keyof T = keyof T> = Pick<
  T,
  Exclude<keyof T, Keys>
> &
  {
    [K in Keys]-?: Required<Pick<T, K>> &
      Partial<Pick<T, Exclude<Keys, K>>>;
  }[Keys];

/**
 * Requires exactly one of the keys `Keys` to be present (mutually exclusive).
 */
export type RequireOnlyOne<T, Keys extends keyof T = keyof T> = Pick<
  T,
  Exclude<keyof T, Keys>
> &
  {
    [K in Keys]-?: Required<Pick<T, K>> &
      Partial<Record<Exclude<Keys, K>, undefined>>;
  }[Keys];

/**
 * Union of all property value types in `T`.
 */
export type ValueOf<T> = T[keyof T];

/**
 * Non-empty tuple/array guaranteed to have at least one item.
 */
export type NonEmptyArray<T> = [T, ...T[]];

/**
 * Value that may be synchronous or wrapped in a `Promise`.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Value or `null`.
 */
export type Nullable<T> = T | null;

/**
 * Value, `null`, or `undefined`.
 */
export type Nullish<T> = T | null | undefined;

type PrevDepth = [never, 0, 1, 2, 3, 4, 5, 6];

/**
 * Generates union of dot-separated property paths for nested object `T` (bounded depth = 6).
 *
 * @example
 * type P = PathOf<{ user: { profile: { name: string }; age: number } }>;
 * // "user" | "user.profile" | "user.profile.name" | "user.age"
 */
export type PathOf<T, Depth extends number = 5> = [Depth] extends [never]
  ? never
  : T extends Primitive | Date | RegExp | readonly unknown[] | ((...args: never[]) => unknown)
    ? never
    : T extends object
      ? {
          [K in keyof T & string]: NonNullable<T[K]> extends
            | Primitive
            | Date
            | RegExp
            | readonly unknown[]
            | ((...args: never[]) => unknown)
            ? K
            : K | `${K}.${PathOf<NonNullable<T[K]>, PrevDepth[Depth]>}`;
        }[keyof T & string]
      : never;

/**
 * Resolves the property type at a dot-separated path `P` within object `T`.
 *
 * @example
 * type Name = PathValue<{ user: { profile: { name: string } } }, "user.profile.name">; // string
 */
export type PathValue<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? PathValue<NonNullable<T[Head]>, Rest>
    : unknown
  : P extends keyof T
    ? T[P]
    : unknown;
