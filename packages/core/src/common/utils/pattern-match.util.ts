import { describeValue } from "./error.util";
import { deepEqual } from "./object.util";
import { include, not } from "./predicate.util";
import {
  type Constructor,
  isArray,
  isBigInt,
  isBoolean,
  isDate,
  isFunction,
  isInstanceof,
  isMap,
  isNotNull,
  isNull,
  isNullish,
  isNumber,
  isPlainObject,
  isRegExp,
  isSet,
  isString,
  isSymbol,
  isTypeof,
  isUndefined,
  type Primitive,
} from "./type-guards.util";

// ─── Symbols & Error Types ───────────────────────────────────────────────────

export const MATCHER_SYMBOL = Symbol.for("@bunest/common/pattern-matcher");

declare const MATCHER_OUT: unique symbol;
declare const MATCHER_KIND: unique symbol;
declare const MATCHER_REFINED: unique symbol;
declare const MATCHER_SELECT: unique symbol;
declare const NO_SELECTION: unique symbol;

type NoSelection = typeof NO_SELECTION;

export type MatcherKind =
  | "any"
  | "default"
  | "nonNullable"
  | "not"
  | "optional"
  | "union"
  | "intersection"
  | "array"
  | "set"
  | "map"
  | "record"
  | "shape"
  | "select";

/**
 * Error thrown by `.exhaustive()` or `.run()` when no pattern matches the input value.
 */
export class NonExhaustiveError extends Error {
  public readonly input: unknown;

  constructor(input: unknown) {
    super(
      `Pattern matching error: no pattern matched ${describeValue(input)}.`,
    );
    this.name = "NonExhaustiveError";
    this.input = input;
  }
}

/**
 * Compile-time diagnostic marker surfaced when `.exhaustive()` is called
 * before every member of the input union has been handled.
 */
export interface NonExhaustivePatternError<Unhandled> {
  readonly __nonExhaustivePatternError: "Pattern matching is not exhaustive. Unhandled input type:";
  readonly __unhandled: Unhandled;
}

// ─── Internal Runtime Match Context ──────────────────────────────────────────

interface SelectionContext {
  anonymous?: { set: boolean; value: unknown };
  named: Record<string, unknown>;
}

function createSelectionContext(): SelectionContext {
  return { named: {} };
}

function cloneSelectionContext(ctx: SelectionContext): SelectionContext {
  return {
    anonymous: ctx.anonymous ? { ...ctx.anonymous } : undefined,
    named: { ...ctx.named },
  };
}

function mergeSelectionContext(
  target: SelectionContext,
  source: SelectionContext,
): void {
  if (source.anonymous?.set) {
    target.anonymous = { ...source.anonymous };
  }
  for (const [k, v] of Object.entries(source.named)) {
    target.named[k] = v;
  }
}

interface InternalMatcher {
  readonly [MATCHER_SYMBOL]: true;
  readonly kind: MatcherKind;
  readonly match: (value: unknown, ctx: SelectionContext) => boolean;
  readonly selectionName?: string;
  readonly subPattern?: unknown;
}

function isInternalMatcher(value: unknown): value is InternalMatcher {
  return (
    isTypeof(value, "object") &&
    isNotNull(value) &&
    MATCHER_SYMBOL in value &&
    (value as { [MATCHER_SYMBOL]?: unknown })[MATCHER_SYMBOL] === true
  );
}

interface StaticSelectionKeys {
  hasAnonymous: boolean;
  namedKeys: string[];
}

function collectSelectionKeys(
  pattern: unknown,
  out: StaticSelectionKeys = { hasAnonymous: false, namedKeys: [] },
): StaticSelectionKeys {
  if (isInternalMatcher(pattern)) {
    if (pattern.kind === "select") {
      if (isUndefined(pattern.selectionName)) {
        out.hasAnonymous = true;
      } else if (not(include(out.namedKeys, pattern.selectionName))) {
        out.namedKeys.push(pattern.selectionName);
      }
    }
    if (not(isUndefined(pattern.subPattern))) {
      collectSelectionKeys(pattern.subPattern, out);
    }
    return out;
  }
  if (isArray(pattern)) {
    for (const item of pattern) {
      collectSelectionKeys(item, out);
    }
    return out;
  }
  if (isPlainObject(pattern)) {
    for (const sub of Object.values(pattern)) {
      collectSelectionKeys(sub, out);
    }
  }
  return out;
}

// ─── Pattern Matcher Interfaces ──────────────────────────────────────────────

export interface PatternMatcher<
  Output = unknown,
  Kind extends MatcherKind = MatcherKind,
  Refined extends boolean = boolean,
  Selections = NoSelection,
> {
  readonly [MATCHER_SYMBOL]: true;
  readonly kind: Kind;
  readonly match: (value: unknown, ctx: SelectionContext) => boolean;
  readonly [MATCHER_OUT]?: () => Output;
  readonly [MATCHER_KIND]?: () => Kind;
  readonly [MATCHER_REFINED]?: () => Refined;
  readonly [MATCHER_SELECT]?: () => Selections;
}

export interface ChainableMatcher<
  Output,
  Kind extends MatcherKind = "default",
  Refined extends boolean = false,
  Selections = NoSelection,
> extends PatternMatcher<Output, Kind, Refined, Selections> {
  /** Matches `undefined` or this matcher. */
  optional(): ChainableMatcher<
    PatternMatcher<Output, Kind, Refined, Selections>,
    "optional",
    Refined,
    Selections
  >;
  /** Captures the matched value as an anonymous selection argument. */
  select(): ChainableMatcher<
    PatternMatcher<Output, Kind, Refined, Selections>,
    "select",
    Refined,
    { readonly kind: "anon"; readonly value: Output }
  >;
  /** Captures the matched value under `name` in the selections object. */
  select<const Name extends string>(
    name: Name,
  ): ChainableMatcher<
    PatternMatcher<Output, Kind, Refined, Selections>,
    "select",
    Refined,
    { readonly kind: "named"; readonly map: { readonly [K in Name]: Output } }
  >;
  /** Combines this matcher with another pattern (logical AND). */
  and<const Other>(
    pattern: Other,
  ): ChainableMatcher<
    readonly [PatternMatcher<Output, Kind, Refined, Selections>, Other],
    "intersection",
    true,
    NoSelection
  >;
  /** Combines this matcher with another pattern (logical OR). */
  or<const Other>(
    pattern: Other,
  ): ChainableMatcher<
    readonly [PatternMatcher<Output, Kind, Refined, Selections>, Other],
    "union",
    Refined,
    NoSelection
  >;
}

export interface StringMatcher<
  Refined extends boolean = false,
  Selections = NoSelection,
> extends ChainableMatcher<string, "default", Refined, Selections> {
  startsWith<const Prefix extends string>(
    prefix: Prefix,
  ): StringMatcher<true, Selections>;
  endsWith<const Suffix extends string>(
    suffix: Suffix,
  ): StringMatcher<true, Selections>;
  includes(substring: string): StringMatcher<true, Selections>;
  regex(pattern: RegExp): StringMatcher<true, Selections>;
  minLength(min: number): StringMatcher<true, Selections>;
  maxLength(max: number): StringMatcher<true, Selections>;
  length(exact: number): StringMatcher<true, Selections>;
  nonEmpty(): StringMatcher<true, Selections>;
}

export interface NumberMatcher<
  Refined extends boolean = false,
  Selections = NoSelection,
> extends ChainableMatcher<number, "default", Refined, Selections> {
  gt(min: number): NumberMatcher<true, Selections>;
  gte(min: number): NumberMatcher<true, Selections>;
  lt(max: number): NumberMatcher<true, Selections>;
  lte(max: number): NumberMatcher<true, Selections>;
  between(min: number, max: number): NumberMatcher<true, Selections>;
  int(): NumberMatcher<true, Selections>;
  finite(): NumberMatcher<true, Selections>;
  positive(): NumberMatcher<true, Selections>;
  negative(): NumberMatcher<true, Selections>;
}

export interface BigIntMatcher<
  Refined extends boolean = false,
  Selections = NoSelection,
> extends ChainableMatcher<bigint, "default", Refined, Selections> {
  gt(min: bigint): BigIntMatcher<true, Selections>;
  gte(min: bigint): BigIntMatcher<true, Selections>;
  lt(max: bigint): BigIntMatcher<true, Selections>;
  lte(max: bigint): BigIntMatcher<true, Selections>;
  between(min: bigint, max: bigint): BigIntMatcher<true, Selections>;
  positive(): BigIntMatcher<true, Selections>;
  negative(): BigIntMatcher<true, Selections>;
}

export interface ArrayMatcher<
  ItemPattern,
  Refined extends boolean = false,
  Selections = NoSelection,
> extends ChainableMatcher<ItemPattern, "array", Refined, Selections> {
  minLength(min: number): ArrayMatcher<ItemPattern, true, Selections>;
  maxLength(max: number): ArrayMatcher<ItemPattern, true, Selections>;
  length(exact: number): ArrayMatcher<ItemPattern, true, Selections>;
  nonEmpty(): ArrayMatcher<ItemPattern, true, Selections>;
}

// ─── Type-Level Pattern Matching Engine (Zero `any`) ─────────────────────────

interface UnwrapByKind<Out> {
  any: unknown;
  default: Out;
  nonNullable: NonNullable<Out>;
  not: unknown;
  optional: UnwrapMatcherOutput<Out> | undefined;
  select: UnwrapMatcherOutput<Out>;
  union: Out extends readonly unknown[] ? UnwrapUnion<Out> : unknown;
  intersection: Out extends readonly unknown[]
    ? UnwrapIntersection<Out>
    : unknown;
  array: UnwrapMatcherOutput<Out>[];
  set: Set<UnwrapMatcherOutput<Out>>;
  map: Out extends readonly [infer KP, infer VP]
    ? Map<UnwrapMatcherOutput<KP>, UnwrapMatcherOutput<VP>>
    : Map<unknown, unknown>;
  record: Record<string, UnwrapMatcherOutput<Out>>;
  shape: UnwrapMatcherOutput<Out>;
}

type UnwrapMatcherOutput<P> =
  P extends PatternMatcher<infer Out, infer Kind, boolean, unknown>
    ? UnwrapByKind<Out>[Kind]
    : P extends readonly unknown[]
      ? { [K in keyof P]: UnwrapMatcherOutput<P[K]> }
      : P extends Readonly<Record<PropertyKey, unknown>>
        ? { [K in keyof P]: UnwrapMatcherOutput<P[K]> }
        : P;

type UnwrapUnion<T extends readonly unknown[]> = T extends readonly [
  infer Head,
  ...infer Tail,
]
  ? UnwrapMatcherOutput<Head> | UnwrapUnion<Tail>
  : never;

type UnwrapIntersection<T extends readonly unknown[]> = T extends readonly [
  infer Head,
  ...infer Tail,
]
  ? UnwrapMatcherOutput<Head> & UnwrapIntersection<Tail>
  : unknown;

type ConsTupleMatch<Head, Tail> = [Head] extends [never]
  ? never
  : [Tail] extends [never]
    ? never
    : Tail extends readonly unknown[]
      ? [Head, ...Tail]
      : never;

type MatchEmptyTuple<Input extends readonly unknown[]> =
  Input extends readonly [] ? [] : number extends Input["length"] ? [] : never;

type MatchTupleStep<
  Input extends readonly unknown[],
  PHead,
  PTail extends readonly unknown[],
> = Input extends readonly [infer IHead, ...infer ITail]
  ? ConsTupleMatch<ExtractMatched<IHead, PHead>, MatchTuple<ITail, PTail>>
  : Input extends readonly (infer El)[]
    ? number extends Input["length"]
      ? ConsTupleMatch<
          ExtractMatched<El, PHead>,
          MatchTuple<readonly El[], PTail>
        >
      : never
    : never;

type MatchTuple<
  Input extends readonly unknown[],
  Pat extends readonly unknown[],
> = Pat extends readonly []
  ? MatchEmptyTuple<Input>
  : Pat extends readonly [infer PHead, ...infer PTail]
    ? MatchTupleStep<Input, PHead, PTail>
    : never;

type IsOptionalPattern<P> =
  P extends PatternMatcher<unknown, "optional", boolean, unknown>
    ? true
    : false;

type ObjectKeyCanMatch<
  Input extends object,
  Pat extends Readonly<Record<PropertyKey, unknown>>,
  K extends keyof Pat,
> = K extends keyof Input
  ? [ExtractMatched<Input[K], Pat[K]>] extends [never]
    ? false
    : true
  : IsOptionalPattern<Pat[K]> extends true
    ? true
    : string extends keyof Input
      ? true
      : false;

type ObjectKeysCanMatch<
  Input extends object,
  Pat extends Readonly<Record<PropertyKey, unknown>>,
> = {
  [K in keyof Pat]: ObjectKeyCanMatch<Input, Pat, K>;
}[keyof Pat] extends true
  ? true
  : false;

type NarrowObject<
  Input extends object,
  Pat extends Readonly<Record<PropertyKey, unknown>>,
> =
  ObjectKeysCanMatch<Input, Pat> extends true
    ? {
        [K in keyof Input]: K extends keyof Pat
          ? ExtractMatched<Input[K], Pat[K]>
          : Input[K];
      } & {
        [
          K in Exclude<keyof Pat, keyof Input> as IsOptionalPattern<
            Pat[K]
          > extends true
            ? never
            : K
        ]: ExtractMatched<unknown, Pat[K]>;
      }
    : never;

type ExtractUnionMatched<
  Input,
  Pats extends readonly unknown[],
> = Pats extends readonly [infer Head, ...infer Tail]
  ? ExtractMatched<Input, Head> | ExtractUnionMatched<Input, Tail>
  : never;

type ExtractIntersectionMatched<
  Input,
  Pats extends readonly unknown[],
> = Pats extends readonly [infer Head, ...infer Tail]
  ? ExtractIntersectionMatched<ExtractMatched<Input, Head>, Tail>
  : Input;

type ExtractOptional<Input, Target> = Input extends undefined
  ? undefined
  : unknown extends Input
    ? ExtractMatched<unknown, Target> | undefined
    : ExtractMatched<Exclude<Input, undefined>, Target>;

type ExtractArray<Input, Target> = Input extends readonly (infer El)[]
  ? ExtractMatched<El, Target> extends never
    ? never
    : ExtractMatched<El, Target>[]
  : unknown extends Input
    ? ExtractMatched<unknown, Target>[]
    : never;

type ExtractRecord<Input, Target> =
  Input extends Record<string, infer Val>
    ? Record<string, ExtractMatched<Val, Target>>
    : unknown extends Input
      ? Record<string, ExtractMatched<unknown, Target>>
      : never;

type ExtractShape<Input, Target> =
  Target extends Readonly<Record<PropertyKey, unknown>>
    ? Input extends object
      ? NarrowObject<Input, Target>
      : unknown extends Input
        ? UnwrapMatcherOutput<Target>
        : never
    : Input;

type ExtractSet<Input, Target> =
  Input extends Set<infer El>
    ? Set<ExtractMatched<El, Target>>
    : unknown extends Input
      ? Set<ExtractMatched<unknown, Target>>
      : never;

type ExtractMap<Input, Target> = Target extends readonly [infer KP, infer VP]
  ? Input extends Map<infer K, infer V>
    ? Map<ExtractMatched<K, KP>, ExtractMatched<V, VP>>
    : unknown extends Input
      ? Map<ExtractMatched<unknown, KP>, ExtractMatched<unknown, VP>>
      : never
  : never;

type ExtractDefault<Input, Target> = unknown extends Target
  ? Input
  : Input extends Target
    ? Input
    : Target extends Input
      ? Target
      : Extract<Input, Target>;

interface ExtractByKind<Input, Target> {
  any: Input;
  default: ExtractDefault<Input, Target>;
  nonNullable: NonNullable<Input>;
  optional: ExtractOptional<Input, Target>;
  select: ExtractMatched<Input, Target>;
  not: ExcludeMatched<Input, Target>;
  union: Target extends readonly unknown[]
    ? ExtractUnionMatched<Input, Target>
    : Input;
  intersection: Target extends readonly unknown[]
    ? ExtractIntersectionMatched<Input, Target>
    : Input;
  array: ExtractArray<Input, Target>;
  record: ExtractRecord<Input, Target>;
  shape: ExtractShape<Input, Target>;
  set: ExtractSet<Input, Target>;
  map: ExtractMap<Input, Target>;
}

type ExtractLiteral<Input, Pat> = Input extends Pat
  ? Input
  : Pat extends Input
    ? Pat
    : never;

type ExtractTuplePattern<
  Input,
  Pat extends readonly unknown[],
> = Input extends readonly unknown[]
  ? MatchTuple<Input, Pat>
  : unknown extends Input
    ? UnwrapMatcherOutput<Pat>
    : never;

type ExtractObjectPattern<
  Input,
  Pat extends Readonly<Record<PropertyKey, unknown>>,
> = Input extends object
  ? Input extends readonly unknown[]
    ? never
    : NarrowObject<Input, Pat>
  : unknown extends Input
    ? UnwrapMatcherOutput<Pat>
    : never;

type ExtractNonMatcher<Input, Pat> = Pat extends Primitive | Date | RegExp
  ? ExtractLiteral<Input, Pat>
  : Pat extends readonly unknown[]
    ? ExtractTuplePattern<Input, Pat>
    : Pat extends Readonly<Record<PropertyKey, unknown>>
      ? ExtractObjectPattern<Input, Pat>
      : never;

/**
 * Narrows `Input` to the subset of values that match `Pat`.
 */
export type ExtractMatched<Input, Pat> = Input extends unknown
  ? Pat extends PatternMatcher<infer Target, infer Kind, boolean, unknown>
    ? ExtractByKind<Input, Target>[Kind]
    : ExtractNonMatcher<Input, Pat>
  : never;

// ─── Exhaustiveness Subtraction Engine ───────────────────────────────────────

type TupleCoversStep<
  Input extends readonly unknown[],
  PHead,
  PTail extends readonly unknown[],
> = Input extends readonly [infer IHead, ...infer ITail]
  ? Covers<IHead, PHead> extends true
    ? TupleCovers<ITail, PTail>
    : false
  : false;

type TupleCovers<
  Input extends readonly unknown[],
  Pat extends readonly unknown[],
> = Pat extends readonly []
  ? Input extends readonly []
    ? true
    : false
  : Pat extends readonly [infer PHead, ...infer PTail]
    ? TupleCoversStep<Input, PHead, PTail>
    : false;

type ObjectCovers<
  Input extends object,
  Pat extends Readonly<Record<PropertyKey, unknown>>,
> = {
  [K in keyof Pat]: K extends keyof Input ? Covers<Input[K], Pat[K]> : false;
}[keyof Pat] extends true
  ? true
  : false;

type AnyCovers<Input, Pats extends readonly unknown[]> = Pats extends readonly [
  infer Head,
  ...infer Tail,
]
  ? Covers<Input, Head> extends true
    ? true
    : AnyCovers<Input, Tail>
  : false;

type AllCover<Input, Pats extends readonly unknown[]> = Pats extends readonly [
  infer Head,
  ...infer Tail,
]
  ? Covers<Input, Head> extends true
    ? AllCover<Input, Tail>
    : false
  : true;

type CoversShape<Input, Target> =
  Target extends Readonly<Record<PropertyKey, unknown>>
    ? Input extends object
      ? ObjectCovers<Input, Target>
      : false
    : false;

type CoversMap<Input, Target> = Target extends readonly [infer KP, infer VP]
  ? Input extends Map<infer K, infer V>
    ? Covers<K, KP> extends true
      ? Covers<V, VP>
      : false
    : false
  : false;

interface CoversByKind<Input, Target> {
  any: true;
  default: [Input] extends [Target] ? true : false;
  nonNullable: [Input] extends [null | undefined] ? false : true;
  optional: [Input] extends [undefined] ? true : Covers<Input, Target>;
  select: Covers<Input, Target>;
  not: [ExtractMatched<Input, Target>] extends [never] ? true : false;
  union: Target extends readonly unknown[] ? AnyCovers<Input, Target> : false;
  intersection: Target extends readonly unknown[]
    ? AllCover<Input, Target>
    : false;
  array: Input extends readonly (infer El)[] ? Covers<El, Target> : false;
  set: Input extends Set<infer El> ? Covers<El, Target> : false;
  map: CoversMap<Input, Target>;
  record: false;
  shape: CoversShape<Input, Target>;
}

type CoversObjectPattern<
  Input,
  Pat extends Readonly<Record<PropertyKey, unknown>>,
> = Input extends object
  ? Input extends readonly unknown[]
    ? false
    : ObjectCovers<Input, Pat>
  : false;

type CoversNonMatcher<Input, Pat> = Pat extends Primitive
  ? [Input] extends [Pat]
    ? true
    : false
  : Pat extends readonly unknown[]
    ? Input extends readonly unknown[]
      ? TupleCovers<Input, Pat>
      : false
    : Pat extends Readonly<Record<PropertyKey, unknown>>
      ? CoversObjectPattern<Input, Pat>
      : false;

type Covers<Input, Pat> =
  Pat extends PatternMatcher<infer Target, infer Kind, infer Refined, unknown>
    ? Refined extends true
      ? false
      : CoversByKind<Input, Target>[Kind]
    : CoversNonMatcher<Input, Pat>;

/**
 * Removes from `Remaining` every union member unconditionally covered by `Pat`.
 */
export type ExcludeMatched<Remaining, Pat> = Remaining extends unknown
  ? Covers<Remaining, Pat> extends true
    ? never
    : Remaining
  : never;

type ExcludeMultiple<
  Remaining,
  Pats extends readonly unknown[],
> = Pats extends readonly [infer Head, ...infer Tail]
  ? ExcludeMultiple<ExcludeMatched<Remaining, Head>, Tail>
  : Remaining;

// ─── Selection Extraction Types ──────────────────────────────────────────────

type UnionToIntersection<U> = (
  U extends unknown ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never;

type Prettify<T> = { [K in keyof T]: T[K] } & {};

type ExtractSelectKind<Input, Target, Sel> = Sel extends {
  readonly kind: "anon";
}
  ? { readonly kind: "anon"; readonly value: ExtractMatched<Input, Target> }
  : Sel extends { readonly kind: "named"; readonly map: infer M }
    ? {
        readonly kind: "named";
        readonly map: {
          readonly [K in keyof M]: ExtractMatched<Input, Target>;
        };
      }
    : never;

type ExtractArraySelection<Input, Target> = Input extends readonly (infer El)[]
  ? WrapArraySelection<ExtractRawSelections<El, Target>>
  : WrapArraySelection<ExtractRawSelections<unknown, Target>>;

type ExtractShapeSelection<Input, Target> =
  Target extends Readonly<Record<PropertyKey, unknown>>
    ? ExtractObjectSelections<Input, Target>
    : never;

interface SelectByKind<Input, Target, Sel> {
  any: never;
  default: never;
  nonNullable: never;
  not: never;
  union: never;
  intersection: never;
  set: never;
  map: never;
  record: never;
  select: ExtractSelectKind<Input, Target, Sel>;
  array: ExtractArraySelection<Input, Target>;
  optional: WrapOptionalSelection<
    ExtractRawSelections<Exclude<Input, undefined>, Target>
  >;
  shape: ExtractShapeSelection<Input, Target>;
}

type ExtractRawSelections<Input, Pat> =
  Pat extends PatternMatcher<infer Target, infer Kind, boolean, infer Sel>
    ? SelectByKind<Input, Target, Sel>[Kind]
    : Pat extends readonly unknown[]
      ? Input extends readonly unknown[]
        ? ExtractTupleSelections<Input, Pat>
        : never
      : Pat extends Readonly<Record<PropertyKey, unknown>>
        ? ExtractObjectSelections<Input, Pat>
        : never;

type WrapArraySelection<S> = S extends {
  readonly kind: "anon";
  readonly value: infer V;
}
  ? { readonly kind: "anon"; readonly value: V[] }
  : S extends { readonly kind: "named"; readonly map: infer M }
    ? {
        readonly kind: "named";
        readonly map: { readonly [K in keyof M]: M[K][] };
      }
    : never;

type WrapOptionalSelection<S> = S extends {
  readonly kind: "anon";
  readonly value: infer V;
}
  ? { readonly kind: "anon"; readonly value: V | undefined }
  : S extends { readonly kind: "named"; readonly map: infer M }
    ? {
        readonly kind: "named";
        readonly map: { readonly [K in keyof M]: M[K] | undefined };
      }
    : never;

type ExtractObjectSelections<
  Input,
  Pat extends Readonly<Record<PropertyKey, unknown>>,
> = {
  [K in keyof Pat]: K extends keyof Input
    ? ExtractRawSelections<Input[K], Pat[K]>
    : ExtractRawSelections<unknown, Pat[K]>;
}[keyof Pat];

type ExtractTupleSelections<
  Input extends readonly unknown[],
  Pat extends readonly unknown[],
> = Pat extends readonly [infer PHead, ...infer PTail]
  ? Input extends readonly [infer IHead, ...infer ITail]
    ? ExtractRawSelections<IHead, PHead> | ExtractTupleSelections<ITail, PTail>
    : Input extends readonly (infer El)[]
      ? | ExtractRawSelections<El, PHead>
        | ExtractTupleSelections<readonly El[], PTail>
      : never
  : never;

type NamedSelectionsMap<Sel> = Sel extends {
  readonly kind: "named";
  readonly map: infer M;
}
  ? M
  : never;

type ResolveSelectionArg<Matched, Sel> = [Sel] extends [never]
  ? Matched
  : [Sel] extends [{ readonly kind: "anon"; readonly value: infer V }]
    ? V
    : Prettify<UnionToIntersection<NamedSelectionsMap<Sel>>>;

type ResolveHandlerArgFromMatched<Matched, Pat> = ResolveSelectionArg<
  Matched,
  ExtractRawSelections<Matched, Pat>
>;

type ResolveHandlerArg<Input, Pat> = ResolveHandlerArgFromMatched<
  ExtractMatched<Input, Pat>,
  Pat
>;

/**
 * Pattern type accepted by `match().with()` and `isMatching()`.
 */
export type Pattern<T = unknown> =
  | PatternMatcher<unknown, MatcherKind, boolean, unknown>
  | Primitive
  | Date
  | RegExp
  | (T extends readonly (infer El)[]
      ? readonly Pattern<El>[]
      : readonly Pattern<unknown>[])
  | (T extends object ? { readonly [K in keyof T]?: Pattern<T[K]> } : never)
  | Readonly<Record<PropertyKey, unknown>>;

// ─── Core Runtime Matching Algorithm ─────────────────────────────────────────

function matchPattern(
  value: unknown,
  pattern: unknown,
  ctx: SelectionContext,
): boolean {
  if (isInternalMatcher(pattern)) {
    return pattern.match(value, ctx);
  }

  if (isNull(pattern) || not(isTypeof(pattern, "object"))) {
    return (
      value === pattern ||
      (isTypeof(value, "number") &&
        isTypeof(pattern, "number") &&
        Number.isNaN(value) &&
        Number.isNaN(pattern))
    );
  }

  if (isDate(pattern)) {
    return isDate(value) && value.getTime() === pattern.getTime();
  }

  if (isRegExp(pattern)) {
    return (
      isRegExp(value) &&
      value.source === pattern.source &&
      value.flags === pattern.flags
    );
  }

  if (isArray(pattern)) {
    if (!isArray(value) || value.length !== pattern.length) {
      return false;
    }
    const branchCtx = cloneSelectionContext(ctx);
    for (let i = 0; i < pattern.length; i++) {
      if (not(matchPattern(value[i], pattern[i], branchCtx))) {
        return false;
      }
    }
    mergeSelectionContext(ctx, branchCtx);
    return true;
  }

  // Partial structural object matching
  if (isNull(value) || not(isTypeof(value, "object")) || isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const branchCtx = cloneSelectionContext(ctx);
  for (const [key, subPattern] of Object.entries(
    pattern as Record<string, unknown>,
  )) {
    const keyExists = key in record;
    const propVal = record[key];
    if (!keyExists) {
      if (isInternalMatcher(subPattern) && subPattern.kind === "optional") {
        // Optional matcher matches missing keys
        subPattern.match(undefined, branchCtx);
        continue;
      }
      if (subPattern === undefined) {
        continue;
      }
      return false;
    }
    if (!matchPattern(propVal, subPattern, branchCtx)) {
      return false;
    }
  }
  mergeSelectionContext(ctx, branchCtx);
  return true;
}

// ─── Matcher Factories & `P` Namespace ───────────────────────────────────────

function createChainable<
  Output,
  Kind extends MatcherKind = "default",
  Refined extends boolean = false,
  Selections = NoSelection,
>(
  kind: Kind,
  predicate: (value: unknown, ctx: SelectionContext) => boolean,
  meta?: { readonly selectionName?: string; readonly subPattern?: unknown },
): ChainableMatcher<Output, Kind, Refined, Selections> {
  const matcher = {
    [MATCHER_SYMBOL]: true as const,
    kind,
    match: predicate,
    ...(meta?.selectionName !== undefined
      ? { selectionName: meta.selectionName }
      : {}),
    ...(meta?.subPattern !== undefined ? { subPattern: meta.subPattern } : {}),
    optional() {
      return createOptionalMatcher<
        PatternMatcher<Output, Kind, Refined, Selections>,
        Refined,
        Selections
      >(matcher);
    },
    select<const Name extends string>(name?: Name) {
      if (name === undefined) {
        return createSelectMatcher<
          PatternMatcher<Output, Kind, Refined, Selections>,
          Refined,
          { readonly kind: "anon"; readonly value: Output }
        >(matcher, undefined);
      }
      return createSelectMatcher<
        PatternMatcher<Output, Kind, Refined, Selections>,
        Refined,
        {
          readonly kind: "named";
          readonly map: { readonly [K in Name]: Output };
        }
      >(matcher, name);
    },
    and<const Other>(other: Other) {
      return createIntersectionMatcher(
        matcher,
        other,
      ) as unknown as ChainableMatcher<
        readonly [PatternMatcher<Output, Kind, Refined, Selections>, Other],
        "intersection",
        true,
        NoSelection
      >;
    },
    or<const Other>(other: Other) {
      return createUnionMatcher(matcher, other) as unknown as ChainableMatcher<
        readonly [PatternMatcher<Output, Kind, Refined, Selections>, Other],
        "union",
        Refined,
        NoSelection
      >;
    },
  } as ChainableMatcher<Output, Kind, Refined, Selections>;
  return matcher;
}

function createOptionalMatcher<
  Sub,
  Refined extends boolean = false,
  Selections = NoSelection,
>(sub: Sub): ChainableMatcher<Sub, "optional", Refined, Selections> {
  return createChainable<Sub, "optional", Refined, Selections>(
    "optional",
    (value, ctx) => {
      if (value === undefined) {
        const keys = collectSelectionKeys(sub);
        if (keys.hasAnonymous) {
          ctx.anonymous = { set: true, value: undefined };
        }
        for (const k of keys.namedKeys) {
          ctx.named[k] = undefined;
        }
        return true;
      }
      return matchPattern(value, sub, ctx);
    },
    { subPattern: sub },
  );
}

function createSelectMatcher<
  Sub,
  Refined extends boolean = false,
  Selections = NoSelection,
>(
  sub: Sub,
  name?: string,
): ChainableMatcher<Sub, "select", Refined, Selections> {
  return createChainable<Sub, "select", Refined, Selections>(
    "select",
    (value, ctx) => {
      const subCtx = cloneSelectionContext(ctx);
      if (!matchPattern(value, sub, subCtx)) {
        return false;
      }
      mergeSelectionContext(ctx, subCtx);
      if (name === undefined) {
        ctx.anonymous = { set: true, value };
      } else {
        ctx.named[name] = value;
      }
      return true;
    },
    { selectionName: name, subPattern: sub },
  );
}

function createUnionMatcher<const Pats extends readonly unknown[]>(
  ...patterns: Pats
): ChainableMatcher<Pats, "union", false, NoSelection> {
  return createChainable<Pats, "union", false, NoSelection>(
    "union",
    (value, ctx) => {
      for (const pat of patterns) {
        const branchCtx = cloneSelectionContext(ctx);
        if (matchPattern(value, pat, branchCtx)) {
          mergeSelectionContext(ctx, branchCtx);
          return true;
        }
      }
      return false;
    },
  );
}

function createIntersectionMatcher<const Pats extends readonly unknown[]>(
  ...patterns: Pats
): ChainableMatcher<Pats, "intersection", false, NoSelection> {
  return createChainable<Pats, "intersection", false, NoSelection>(
    "intersection",
    (value, ctx) => {
      const branchCtx = cloneSelectionContext(ctx);
      for (const pat of patterns) {
        if (!matchPattern(value, pat, branchCtx)) {
          return false;
        }
      }
      mergeSelectionContext(ctx, branchCtx);
      return true;
    },
  );
}

function createStringMatcher<Refined extends boolean = false>(
  checks: readonly ((s: string) => boolean)[] = [],
): StringMatcher<Refined, NoSelection> {
  const base = createChainable<string, "default", Refined, NoSelection>(
    "default",
    (value) => isString(value) && checks.every((fn) => fn(value)),
  );
  const extend = (
    check: (s: string) => boolean,
  ): StringMatcher<true, NoSelection> =>
    createStringMatcher<true>([...checks, check]);

  return {
    ...base,
    startsWith: (prefix) => extend((s) => s.startsWith(prefix)),
    endsWith: (suffix) => extend((s) => s.endsWith(suffix)),
    includes: (sub) => extend((s) => include(s, sub)),
    regex: (pattern) => extend((s) => pattern.test(s)),
    minLength: (min) => extend((s) => s.length >= min),
    maxLength: (max) => extend((s) => s.length <= max),
    length: (exact) => extend((s) => s.length === exact),
    nonEmpty: () => extend((s) => s.length > 0),
  };
}

function createNumberMatcher<Refined extends boolean = false>(
  checks: readonly ((n: number) => boolean)[] = [],
): NumberMatcher<Refined, NoSelection> {
  const base = createChainable<number, "default", Refined, NoSelection>(
    "default",
    (value) => isNumber(value) && checks.every((fn) => fn(value)),
  );
  const extend = (
    check: (n: number) => boolean,
  ): NumberMatcher<true, NoSelection> =>
    createNumberMatcher<true>([...checks, check]);

  return {
    ...base,
    gt: (min) => extend((n) => n > min),
    gte: (min) => extend((n) => n >= min),
    lt: (max) => extend((n) => n < max),
    lte: (max) => extend((n) => n <= max),
    between: (min, max) => extend((n) => n >= min && n <= max),
    int: () => extend((n) => Number.isInteger(n)),
    finite: () => extend((n) => Number.isFinite(n)),
    positive: () => extend((n) => n > 0),
    negative: () => extend((n) => n < 0),
  };
}

function createBigIntMatcher<Refined extends boolean = false>(
  checks: readonly ((n: bigint) => boolean)[] = [],
): BigIntMatcher<Refined, NoSelection> {
  const base = createChainable<bigint, "default", Refined, NoSelection>(
    "default",
    (value) => isBigInt(value) && checks.every((fn) => fn(value)),
  );
  const extend = (
    check: (n: bigint) => boolean,
  ): BigIntMatcher<true, NoSelection> =>
    createBigIntMatcher<true>([...checks, check]);

  return {
    ...base,
    gt: (min) => extend((n) => n > min),
    gte: (min) => extend((n) => n >= min),
    lt: (max) => extend((n) => n < max),
    lte: (max) => extend((n) => n <= max),
    between: (min, max) => extend((n) => n >= min && n <= max),
    positive: () => extend((n) => n > 0n),
    negative: () => extend((n) => n < 0n),
  };
}

function createArrayMatcher<ItemPat, Refined extends boolean = false>(
  itemPattern?: ItemPat,
  checks: readonly ((arr: readonly unknown[]) => boolean)[] = [],
): ArrayMatcher<ItemPat, Refined, NoSelection> {
  const base = createChainable<ItemPat, "array", Refined, NoSelection>(
    "array",
    (value, ctx) => {
      if (!Array.isArray(value)) {
        return false;
      }
      if (!checks.every((fn) => fn(value))) {
        return false;
      }
      if (itemPattern === undefined) {
        return true;
      }
      const staticKeys = collectSelectionKeys(itemPattern);
      const anonItems: unknown[] = [];
      let hasAnon = staticKeys.hasAnonymous;
      const namedLists: Record<string, unknown[]> = {};
      const namedKeys = new Set<string>(staticKeys.namedKeys);
      for (const key of staticKeys.namedKeys) {
        namedLists[key] = [];
      }

      for (const item of value) {
        const itemCtx = createSelectionContext();
        if (!matchPattern(item, itemPattern, itemCtx)) {
          return false;
        }
        if (itemCtx.anonymous?.set) {
          hasAnon = true;
          anonItems.push(itemCtx.anonymous.value);
        }
        for (const [k, v] of Object.entries(itemCtx.named)) {
          namedKeys.add(k);
          const list = namedLists[k];
          if (list) {
            list.push(v);
          } else {
            namedLists[k] = [v];
          }
        }
      }

      if (hasAnon) {
        ctx.anonymous = { set: true, value: anonItems };
      }
      for (const key of namedKeys) {
        ctx.named[key] = namedLists[key];
      }
      return true;
    },
    { subPattern: itemPattern },
  );

  const extend = (
    check: (arr: readonly unknown[]) => boolean,
  ): ArrayMatcher<ItemPat, true, NoSelection> =>
    createArrayMatcher<ItemPat, true>(itemPattern, [...checks, check]);

  return {
    ...base,
    minLength: (min) => extend((arr) => arr.length >= min),
    maxLength: (max) => extend((arr) => arr.length <= max),
    length: (exact) => extend((arr) => arr.length === exact),
    nonEmpty: () => extend((arr) => arr.length > 0),
  };
}

const anyMatcher = createChainable<unknown, "any", false, NoSelection>(
  "any",
  () => true,
);

function pWhen<T, U extends T>(
  predicate: (value: T) => value is U,
): ChainableMatcher<U, "default", true, NoSelection>;
function pWhen<T = unknown>(
  predicate: (value: T) => boolean,
): ChainableMatcher<T, "default", true, NoSelection>;
function pWhen(
  predicate: (value: never) => boolean,
): ChainableMatcher<unknown, "default", true, NoSelection> {
  return createChainable<unknown, "default", true, NoSelection>(
    "default",
    (value) => predicate(value as never),
  );
}

function pSelect(): ChainableMatcher<
  typeof anyMatcher,
  "select",
  false,
  { readonly kind: "anon"; readonly value: unknown }
>;
function pSelect<const Name extends string>(
  name: Name,
): ChainableMatcher<
  typeof anyMatcher,
  "select",
  false,
  { readonly kind: "named"; readonly map: { readonly [K in Name]: unknown } }
>;
function pSelect<const Name extends string, const Sub>(
  name: Name,
  subPattern: Sub,
): ChainableMatcher<
  Sub,
  "select",
  false,
  { readonly kind: "named"; readonly map: { readonly [K in Name]: Sub } }
>;
function pSelect<const Sub>(
  subPattern: Sub,
): ChainableMatcher<
  Sub,
  "select",
  false,
  { readonly kind: "anon"; readonly value: Sub }
>;
function pSelect(
  first?: unknown,
  second?: unknown,
): ChainableMatcher<unknown, "select", false, unknown> {
  if (first === undefined) {
    return createSelectMatcher(anyMatcher, undefined);
  }
  if (typeof first === "string") {
    return createSelectMatcher(
      second === undefined ? anyMatcher : second,
      first,
    );
  }
  return createSelectMatcher(first, undefined);
}

/**
 * Pattern combinator namespace modeled after `ts-pattern`'s `P`.
 */
export const P = {
  /** Wildcard matching any value (including `null` and `undefined`). */
  _: anyMatcher,
  /** Wildcard matching any value (alias for `P._`). */
  any: anyMatcher,
  /** Wildcard matching any value (alias for `P._`). */
  unknown: anyMatcher,
  /** Matches `string` values (with chainable `.startsWith()`, `.regex()`, `.minLength()`, etc.). */
  string: createStringMatcher<false>(),
  /** Matches `number` values excluding `NaN` (with chainable `.gt()`, `.between()`, `.int()`, etc.). */
  number: createNumberMatcher<false>(),
  /** Matches `bigint` values (with chainable `.gt()`, `.between()`, `.positive()`, etc.). */
  bigint: createBigIntMatcher<false>(),
  /** Matches `boolean` values. */
  boolean: createChainable<boolean, "default", false, NoSelection>(
    "default",
    isBoolean,
  ),
  /** Matches `symbol` values. */
  symbol: createChainable<symbol, "default", false, NoSelection>(
    "default",
    isSymbol,
  ),
  /** Matches `null` or `undefined`. */
  nullish: createChainable<null | undefined, "default", false, NoSelection>(
    "default",
    isNullish,
  ),
  /** Matches any value that is neither `null` nor `undefined`. */
  nonNullable: createChainable<unknown, "nonNullable", false, NoSelection>(
    "nonNullable",
    not(isNullish),
  ),
  /** Matches `NaN`. */
  NaN: createChainable<number, "default", true, NoSelection>(
    "default",
    (v) => isTypeof(v, "number") && Number.isNaN(v),
  ),

  /** Matches instances of a class constructor (`value instanceof Ctor`). */
  instanceOf<C extends Constructor>(
    ctor: C,
  ): ChainableMatcher<InstanceType<C>, "default", false, NoSelection> {
    return createChainable<InstanceType<C>, "default", false, NoSelection>(
      "default",
      isInstanceof(ctor),
    );
  },

  /** Matches an array whose elements all match `itemPattern` (or any array if omitted). */
  array<const ItemPat = typeof anyMatcher>(
    itemPattern?: ItemPat,
  ): ArrayMatcher<ItemPat, false, NoSelection> {
    return createArrayMatcher<ItemPat, false>(itemPattern);
  },

  /** Matches a `Set` whose elements all match `itemPattern` (or any `Set` if omitted). */
  set<const ItemPat = typeof anyMatcher>(
    itemPattern?: ItemPat,
  ): ChainableMatcher<ItemPat, "set", false, NoSelection> {
    return createChainable<ItemPat, "set", false, NoSelection>(
      "set",
      (value, ctx) => {
        if (!isSet(value)) {
          return false;
        }
        if (isUndefined(itemPattern)) {
          return true;
        }
        for (const item of value) {
          if (not(matchPattern(item, itemPattern, ctx))) {
            return false;
          }
        }
        return true;
      },
    );
  },

  /** Matches a `Map` whose entries all match `[keyPattern, valuePattern]`. */
  map<const KeyPat = typeof anyMatcher, const ValPat = typeof anyMatcher>(
    keyPattern?: KeyPat,
    valuePattern?: ValPat,
  ): ChainableMatcher<readonly [KeyPat, ValPat], "map", false, NoSelection> {
    return createChainable<
      readonly [KeyPat, ValPat],
      "map",
      false,
      NoSelection
    >("map", (value, ctx) => {
      if (!isMap(value)) {
        return false;
      }
      for (const [k, v] of value.entries()) {
        if (
          not(isUndefined(keyPattern)) &&
          not(matchPattern(k, keyPattern, ctx))
        ) {
          return false;
        }
        if (
          not(isUndefined(valuePattern)) &&
          not(matchPattern(v, valuePattern, ctx))
        ) {
          return false;
        }
      }
      return true;
    });
  },

  /** Matches a plain object whose own property values all match `valuePattern`. */
  record<const ValPat>(
    valuePattern: ValPat,
  ): ChainableMatcher<ValPat, "record", false, NoSelection> {
    return createChainable<ValPat, "record", false, NoSelection>(
      "record",
      (value, ctx) => {
        if (!isPlainObject(value)) {
          return false;
        }
        for (const propVal of Object.values(value)) {
          if (!matchPattern(propVal, valuePattern, ctx)) {
            return false;
          }
        }
        return true;
      },
    );
  },

  /** Explicitly creates a partial structural object matcher. */
  shape<const Shape extends Readonly<Record<PropertyKey, unknown>>>(
    shape: Shape,
  ): ChainableMatcher<Shape, "shape", false, NoSelection> {
    return createChainable<Shape, "shape", false, NoSelection>(
      "shape",
      (value, ctx) => matchPattern(value, shape, ctx),
    );
  },

  /** Matches `undefined` or values matching `subPattern`. */
  optional<const Sub>(
    subPattern: Sub,
  ): ChainableMatcher<Sub, "optional", false, NoSelection> {
    return createOptionalMatcher(subPattern);
  },

  /** Matches when `subPattern` does NOT match. */
  not<const Sub>(
    subPattern: Sub,
  ): ChainableMatcher<Sub, "not", false, NoSelection> {
    return createChainable<Sub, "not", false, NoSelection>(
      "not",
      (value) => !matchPattern(value, subPattern, createSelectionContext()),
    );
  },

  /** Matches when ANY of the provided patterns matches (logical OR). */
  union<const Pats extends readonly [unknown, ...unknown[]]>(
    ...patterns: Pats
  ): ChainableMatcher<Pats, "union", false, NoSelection> {
    return createUnionMatcher(...patterns);
  },

  /** Matches when ALL of the provided patterns match (logical AND). */
  intersection<const Pats extends readonly [unknown, ...unknown[]]>(
    ...patterns: Pats
  ): ChainableMatcher<Pats, "intersection", false, NoSelection> {
    return createIntersectionMatcher(...patterns);
  },

  /** Matches using a custom predicate or TypeScript type guard. */
  when: pWhen,

  /** Matches using structural deep equality (`deepEqual`). */
  eq<const V>(expected: V): ChainableMatcher<V, "default", true, NoSelection> {
    return createChainable<V, "default", true, NoSelection>(
      "default",
      (value) => deepEqual(value, expected),
    );
  },

  /**
   * Captures a matched sub-value to pass directly to the `.with()` handler.
   * - `P.select()` — anonymous selection (passes extracted value directly)
   * - `P.select(subPattern)` — anonymous selection constrained by `subPattern`
   * - `P.select("key")` — named selection (`{ key: value }`)
   * - `P.select("key", subPattern)` — named selection constrained by `subPattern`
   */
  select: pSelect,
} as const;

// ─── Standalone `isMatching` Type Guard ──────────────────────────────────────

/**
 * Checks whether `value` matches `pattern` (usable both eagerly and as a curried
 * predicate for `Array.prototype.filter`).
 */
export function isMatching<const Pat>(
  pattern: Pat,
): <Input>(value: Input) => value is Input & ExtractMatched<Input, Pat>;
export function isMatching<const Pat, Input>(
  pattern: Pat,
  value: Input,
): value is Input & ExtractMatched<Input, Pat>;
export function isMatching(
  pattern: unknown,
  ...rest: unknown[]
): boolean | ((value: unknown) => boolean) {
  if (rest.length > 0) {
    return matchPattern(rest[0], pattern, createSelectionContext());
  }
  return (value: unknown): boolean =>
    matchPattern(value, pattern, createSelectionContext());
}

// ─── Fluent Match Builder (`match(value)`) ───────────────────────────────────

type HandlerResult<Pinned, Next> = [Pinned] extends [never] ? Next : Pinned;
type NextOutput<Current, Pinned, Next> = [Pinned] extends [never]
  ? Current | Next
  : Pinned;

export interface MatchBuilder<
  Input,
  Remaining,
  Output = never,
  PinnedReturn = never,
> {
  /**
   * Pins the return type of all branches in this match expression.
   */
  returnType<R>(): MatchBuilder<Input, Remaining, R, R>;

  /**
   * Matches a single pattern and invokes `handler`.
   */
  with<const P1, R = PinnedReturn>(
    pattern: P1,
    handler: (
      selected: ResolveHandlerArg<Remaining, P1>,
      value: ExtractMatched<Remaining, P1>,
    ) => HandlerResult<PinnedReturn, R>,
  ): MatchBuilder<
    Input,
    ExcludeMatched<Remaining, P1>,
    NextOutput<Output, PinnedReturn, R>,
    PinnedReturn
  >;

  /**
   * Matches a pattern AND a guard predicate before invoking `handler`.
   */
  with<const P1, R = PinnedReturn>(
    pattern: P1,
    guard: (value: ExtractMatched<Remaining, P1>) => boolean,
    handler: (
      selected: ResolveHandlerArg<Remaining, P1>,
      value: ExtractMatched<Remaining, P1>,
    ) => HandlerResult<PinnedReturn, R>,
  ): MatchBuilder<
    Input,
    Remaining,
    NextOutput<Output, PinnedReturn, R>,
    PinnedReturn
  >;

  /**
   * Matches any of 2 patterns (OR) and invokes `handler`.
   */
  with<const P1, const P2, R = PinnedReturn>(
    p1: P1,
    p2: P2,
    handler: (
      value: ExtractMatched<Remaining, P1> | ExtractMatched<Remaining, P2>,
    ) => HandlerResult<PinnedReturn, R>,
  ): MatchBuilder<
    Input,
    ExcludeMultiple<Remaining, readonly [P1, P2]>,
    NextOutput<Output, PinnedReturn, R>,
    PinnedReturn
  >;

  /**
   * Matches any of 3 patterns (OR) and invokes `handler`.
   */
  with<const P1, const P2, const P3, R = PinnedReturn>(
    p1: P1,
    p2: P2,
    p3: P3,
    handler: (
      value:
        | ExtractMatched<Remaining, P1>
        | ExtractMatched<Remaining, P2>
        | ExtractMatched<Remaining, P3>,
    ) => HandlerResult<PinnedReturn, R>,
  ): MatchBuilder<
    Input,
    ExcludeMultiple<Remaining, readonly [P1, P2, P3]>,
    NextOutput<Output, PinnedReturn, R>,
    PinnedReturn
  >;

  /**
   * Matches any of 4 patterns (OR) and invokes `handler`.
   */
  with<const P1, const P2, const P3, const P4, R = PinnedReturn>(
    p1: P1,
    p2: P2,
    p3: P3,
    p4: P4,
    handler: (
      value:
        | ExtractMatched<Remaining, P1>
        | ExtractMatched<Remaining, P2>
        | ExtractMatched<Remaining, P3>
        | ExtractMatched<Remaining, P4>,
    ) => HandlerResult<PinnedReturn, R>,
  ): MatchBuilder<
    Input,
    ExcludeMultiple<Remaining, readonly [P1, P2, P3, P4]>,
    NextOutput<Output, PinnedReturn, R>,
    PinnedReturn
  >;

  /**
   * Matches any of N patterns (OR) with an optional trailing guard predicate.
   */
  with<const Pats extends readonly [unknown, ...unknown[]], R = PinnedReturn>(
    ...args: [
      ...patterns: Pats,
      handler: (value: Remaining) => HandlerResult<PinnedReturn, R>,
    ]
  ): MatchBuilder<
    Input,
    ExcludeMultiple<Remaining, Pats>,
    NextOutput<Output, PinnedReturn, R>,
    PinnedReturn
  >;

  /**
   * Matches when a TypeScript type-guard predicate returns `true`, narrowing the branch input
   * and subtracting the narrowed type from `Remaining`.
   */
  when<Narrowed extends Remaining, R = PinnedReturn>(
    predicate: (value: Remaining) => value is Narrowed,
    handler: (value: Narrowed) => HandlerResult<PinnedReturn, R>,
  ): MatchBuilder<
    Input,
    Exclude<Remaining, Narrowed>,
    NextOutput<Output, PinnedReturn, R>,
    PinnedReturn
  >;

  /**
   * Matches when a boolean predicate returns `true`.
   */
  when<R = PinnedReturn>(
    predicate: (value: Remaining) => boolean,
    handler: (value: Remaining) => HandlerResult<PinnedReturn, R>,
  ): MatchBuilder<
    Input,
    Remaining,
    NextOutput<Output, PinnedReturn, R>,
    PinnedReturn
  >;

  /**
   * Fallback branch executed when no earlier pattern matched.
   */
  otherwise<R = PinnedReturn>(
    handler: (value: Remaining) => HandlerResult<PinnedReturn, R>,
  ): NextOutput<Output, PinnedReturn, R>;

  /**
   * Shorthand fallback returning a constant value when no earlier pattern matched.
   */
  default<R = PinnedReturn>(
    fallbackValue: HandlerResult<PinnedReturn, R>,
  ): NextOutput<Output, PinnedReturn, R>;

  /**
   * Verifies exhaustiveness at compile time and returns the matched result.
   * Throws `NonExhaustiveError` at runtime if no branch matched.
   */
  exhaustive(
    ...args: [Remaining] extends [never]
      ? []
      : [NonExhaustivePatternError<Remaining>]
  ): Output;

  /**
   * Returns the matched result or throws `NonExhaustiveError` if no branch matched.
   */
  run(): Output;
}

class MatchInstance {
  private readonly input: unknown;
  private readonly matched: boolean;
  private readonly result: unknown;

  constructor(input: unknown, matched: boolean, result: unknown) {
    this.input = input;
    this.matched = matched;
    this.result = result;
  }

  returnType(): MatchInstance {
    return this;
  }

  with(...args: unknown[]): MatchInstance {
    if (this.matched) {
      return this;
    }

    if (args.length < 2) {
      throw new TypeError(
        "match().with() requires at least a pattern and a handler.",
      );
    }

    const handler = args[args.length - 1];
    if (not(isFunction(handler))) {
      throw new TypeError(
        "match().with() last argument must be a handler function.",
      );
    }

    let guard: ((value: unknown) => boolean) | undefined;
    let patterns: unknown[];

    if (args.length >= 3 && isFunction(args[args.length - 2])) {
      guard = args[args.length - 2] as (value: unknown) => boolean;
      patterns = args.slice(0, -2);
    } else {
      patterns = args.slice(0, -1);
    }

    for (const pattern of patterns) {
      const ctx = createSelectionContext();
      if (matchPattern(this.input, pattern, ctx)) {
        if (guard && !guard(this.input)) {
          continue;
        }
        const value = invokeHandler(
          handler as (a: unknown, b?: unknown) => unknown,
          this.input,
          ctx,
        );
        return new MatchInstance(this.input, true, value);
      }
    }

    return this;
  }

  when(
    predicate: (value: unknown) => boolean,
    handler: (value: unknown) => unknown,
  ): MatchInstance {
    if (this.matched) {
      return this;
    }
    if (predicate(this.input)) {
      return new MatchInstance(this.input, true, handler(this.input));
    }
    return this;
  }

  otherwise(handler: (value: unknown) => unknown): unknown {
    if (this.matched) {
      return this.result;
    }
    return handler(this.input);
  }

  default(fallbackValue: unknown): unknown {
    if (this.matched) {
      return this.result;
    }
    return fallbackValue;
  }

  exhaustive(): unknown {
    return this.run();
  }

  run(): unknown {
    if (this.matched) {
      return this.result;
    }
    throw new NonExhaustiveError(this.input);
  }
}

function invokeHandler(
  handler: (a: unknown, b?: unknown) => unknown,
  input: unknown,
  ctx: SelectionContext,
): unknown {
  if (ctx.anonymous?.set) {
    return handler(ctx.anonymous.value, input);
  }
  if (Object.keys(ctx.named).length > 0) {
    return handler(ctx.named, input);
  }
  return handler(input, input);
}

/**
 * Starts a fluent, type-safe pattern matching expression modeled after `ts-pattern`.
 *
 * Replaces verbose `if / else if / else` and `switch` chains with exhaustive,
 * short-circuiting structural pattern matching.
 *
 * @example
 * ```ts
 * const label = match(event)
 *   .with({ type: "created", id: P.select("id", P.string) }, ({ id }) => `Created ${id}`)
 *   .with({ type: "deleted" }, () => "Deleted")
 *   .exhaustive();
 * ```
 */
export function match<const Input>(
  value: Input,
): MatchBuilder<Input, Input, never, never> {
  return new MatchInstance(value, false, undefined) as unknown as MatchBuilder<
    Input,
    Input,
    never,
    never
  >;
}
