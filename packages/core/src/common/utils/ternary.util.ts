import { not } from "./predicate.util";
import {
  isFunction,
  isNotNull,
  isTypeof,
  isUndefined,
} from "./type-guards.util";

// ─── Symbols & Recursive Ternary Struct Types ────────────────────────────────

export const TERNARY_NODE_SYMBOL = Symbol.for("@bunest/common/ternary-node");
export const TERNARY_LEAF_SYMBOL = Symbol.for("@bunest/common/ternary-leaf");
export const TERNARY_INSTANCE_SYMBOL = Symbol.for(
  "@bunest/common/ternary-instance",
);
export const TERNARY_RULE_SYMBOL = Symbol.for("@bunest/common/ternary-rule");

const DEFAULT_MAX_DEPTH = 10_000;

/**
 * Synchronous condition accepted by a ternary node (eager boolean or lazy predicate).
 */
export type TernaryCondition = boolean | (() => boolean);

/**
 * Asynchronous condition accepted by an async ternary node.
 */
export type AsyncTernaryCondition =
  boolean | Promise<boolean> | (() => boolean | Promise<boolean>);

/**
 * Explicit leaf wrapper that returns its contained `value` verbatim without invoking it.
 * Use `literal(fn)` when the desired outcome of a branch is itself a function.
 */
export interface TernaryLeaf<T> {
  readonly [TERNARY_LEAF_SYMBOL]: true;
  readonly value: T;
}

/**
 * Recursive binary decision tree struct representing `condition ? consequent : alternate`.
 * Both `consequent` and `alternate` may themselves be nested `TernaryNode` / `Ternary`
 * instances, lazy thunks, `TernaryLeaf` wrappers, or direct values.
 */
export interface TernaryNode<T> {
  readonly [TERNARY_NODE_SYMBOL]: true;
  readonly label?: string;
  readonly condition: TernaryCondition;
  readonly consequent: TernaryBranch<T>;
  readonly alternate: TernaryBranch<T>;
}

/**
 * Any valid branch of a synchronous ternary tree (supports arbitrary recursion).
 */
export type TernaryBranch<T> =
  T | TernaryLeaf<T> | (() => TernaryBranch<T>) | TernaryNode<T> | Ternary<T>;

/**
 * Asynchronous recursive binary decision tree struct.
 */
export interface AsyncTernaryNode<T> {
  readonly [TERNARY_NODE_SYMBOL]: true;
  readonly label?: string;
  readonly condition: AsyncTernaryCondition;
  readonly consequent: AsyncTernaryBranch<T>;
  readonly alternate: AsyncTernaryBranch<T>;
}

/**
 * Any valid branch of an asynchronous ternary tree.
 */
export type AsyncTernaryBranch<T> =
  | T
  | Promise<T>
  | TernaryLeaf<T>
  | (() => AsyncTernaryBranch<T> | Promise<AsyncTernaryBranch<T>>)
  | TernaryNode<T>
  | AsyncTernaryNode<T>
  | Ternary<T>;

type SyncTernaryWrapper<V> = Ternary<V> | TernaryNode<V> | (() => V);

/**
 * Recursively unwraps a branch type (`Ternary`, `TernaryNode`, `TernaryLeaf`, or thunk)
 * down to its final resolved result type.
 */
export type UnwrapTernary<B> =
  B extends TernaryLeaf<infer V>
    ? V
    : B extends SyncTernaryWrapper<infer V>
      ? UnwrapTernary<V>
      : B;

type AsyncTernaryWrapper<V> =
  | PromiseLike<V>
  | Ternary<V>
  | AsyncTernaryNode<V>
  | TernaryNode<V>
  | (() => V);

/**
 * Recursively unwraps an async branch type down to its resolved value type.
 */
export type UnwrapAsyncTernary<B> =
  B extends TernaryLeaf<infer V>
    ? V
    : B extends AsyncTernaryWrapper<infer V>
      ? UnwrapAsyncTernary<V>
      : B;

export interface EvalTernaryOptions {
  /** Guard against cyclic graphs / runaway recursion (default `10_000`). */
  readonly maxDepth?: number;
}

export interface TernaryTraceStep {
  readonly depth: number;
  readonly label?: string;
  readonly conditionResult: boolean;
  readonly direction: "then" | "else";
}

export interface TernaryTraceResult<T> {
  readonly value: T;
  readonly trace: readonly TernaryTraceStep[];
}

// ─── Type Guards & Leaf Helper ───────────────────────────────────────────────

/**
 * Wraps a value (e.g. a function) as an explicit leaf so recursive evaluation
 * returns it without calling it as a thunk.
 */
export function literal<T>(value: T): TernaryLeaf<T> {
  return { [TERNARY_LEAF_SYMBOL]: true, value };
}

export function isTernaryLeaf(value: unknown): value is TernaryLeaf<unknown> {
  return (
    isTypeof(value, "object") &&
    isNotNull(value) &&
    TERNARY_LEAF_SYMBOL in value &&
    (value as { [TERNARY_LEAF_SYMBOL]?: unknown })[TERNARY_LEAF_SYMBOL] === true
  );
}

export function isTernaryNode(value: unknown): value is TernaryNode<unknown> {
  return (
    isTypeof(value, "object") &&
    isNotNull(value) &&
    TERNARY_NODE_SYMBOL in value &&
    (value as { [TERNARY_NODE_SYMBOL]?: unknown })[TERNARY_NODE_SYMBOL] === true
  );
}

export function isTernary(value: unknown): value is Ternary<unknown> {
  return (
    isTypeof(value, "object") &&
    isNotNull(value) &&
    TERNARY_INSTANCE_SYMBOL in value &&
    (value as { [TERNARY_INSTANCE_SYMBOL]?: unknown })[
      TERNARY_INSTANCE_SYMBOL
    ] === true
  );
}

// ─── Recursive Evaluators, Tracer & Mapper ───────────────────────────────────

/**
 * Creates a raw recursive `TernaryNode` struct directly.
 */
export function branch<A, B>(
  condition: TernaryCondition,
  consequent: A,
  alternate: B,
  label?: string,
): TernaryNode<UnwrapTernary<A> | UnwrapTernary<B>> {
  return {
    [TERNARY_NODE_SYMBOL]: true,
    ...(label !== undefined ? { label } : {}),
    condition,
    consequent: consequent as TernaryBranch<
      UnwrapTernary<A> | UnwrapTernary<B>
    >,
    alternate: alternate as TernaryBranch<UnwrapTernary<A> | UnwrapTernary<B>>,
  };
}

/**
 * Creates a raw recursive `AsyncTernaryNode` struct directly.
 */
export function asyncBranch<A, B>(
  condition: AsyncTernaryCondition,
  consequent: A,
  alternate: B,
  label?: string,
): AsyncTernaryNode<UnwrapAsyncTernary<A> | UnwrapAsyncTernary<B>> {
  return {
    [TERNARY_NODE_SYMBOL]: true,
    ...(label !== undefined ? { label } : {}),
    condition,
    consequent: consequent as AsyncTernaryBranch<
      UnwrapAsyncTernary<A> | UnwrapAsyncTernary<B>
    >,
    alternate: alternate as AsyncTernaryBranch<
      UnwrapAsyncTernary<A> | UnwrapAsyncTernary<B>
    >,
  };
}

function resolveSyncBranch<T>(
  input: unknown,
  depth: number,
  maxDepth: number,
  trace?: TernaryTraceStep[],
): T {
  if (depth > maxDepth) {
    throw new RangeError(
      `evalTernary: maximum recursion depth (${maxDepth}) exceeded.`,
    );
  }

  if (isTernaryLeaf(input)) {
    return input.value as T;
  }

  if (isTernary(input)) {
    return resolveSyncBranch<T>(input.toNode(), depth, maxDepth, trace);
  }

  if (isTernaryNode(input)) {
    const conditionResult = Boolean(
      isFunction(input.condition) ? input.condition() : input.condition,
    );
    const direction: "then" | "else" = conditionResult ? "then" : "else";
    if (trace) {
      trace.push({
        depth,
        ...(not(isUndefined(input.label)) ? { label: input.label } : {}),
        conditionResult,
        direction,
      });
    }
    const nextBranch = conditionResult ? input.consequent : input.alternate;
    return resolveSyncBranch<T>(nextBranch, depth + 1, maxDepth, trace);
  }

  if (isFunction(input)) {
    const produced = (input as () => unknown)();
    return resolveSyncBranch<T>(produced, depth + 1, maxDepth, trace);
  }

  return input as T;
}

/**
 * Recursively evaluates a `Ternary`, `TernaryNode`, or `TernaryBranch` down to its leaf value.
 * Untaken branches are never evaluated (strict short-circuiting).
 */
export function evalTernary<B>(
  target: B,
  options: EvalTernaryOptions = {},
): UnwrapTernary<B> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  return resolveSyncBranch<UnwrapTernary<B>>(target, 0, maxDepth);
}

/**
 * Recursively evaluates a ternary tree while recording every evaluated condition and path taken.
 */
export function traceTernary<B>(
  target: B,
  options: EvalTernaryOptions = {},
): TernaryTraceResult<UnwrapTernary<B>> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const trace: TernaryTraceStep[] = [];
  const value = resolveSyncBranch<UnwrapTernary<B>>(target, 0, maxDepth, trace);
  return { value, trace };
}

async function resolveAsyncBranch<T>(
  input: unknown,
  depth: number,
  maxDepth: number,
): Promise<T> {
  if (depth > maxDepth) {
    throw new RangeError(
      `evalTernaryAsync: maximum recursion depth (${maxDepth}) exceeded.`,
    );
  }

  const awaited = await input;

  if (isTernaryLeaf(awaited)) {
    return awaited.value as T;
  }

  if (isTernary(awaited)) {
    return resolveAsyncBranch<T>(awaited.toNode(), depth, maxDepth);
  }

  if (isTernaryNode(awaited)) {
    const rawCond = isFunction(awaited.condition)
      ? await (awaited.condition as () => boolean | Promise<boolean>)()
      : await awaited.condition;
    const nextBranch = Boolean(rawCond)
      ? awaited.consequent
      : awaited.alternate;
    return resolveAsyncBranch<T>(nextBranch, depth + 1, maxDepth);
  }

  if (isFunction(awaited)) {
    const produced = await (awaited as () => unknown)();
    return resolveAsyncBranch<T>(produced, depth + 1, maxDepth);
  }

  return awaited as T;
}

/**
 * Recursively evaluates an asynchronous ternary tree where conditions or branches
 * may return Promises.
 */
export function evalTernaryAsync<B>(
  target: B,
  options: EvalTernaryOptions = {},
): Promise<UnwrapAsyncTernary<B>> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  return resolveAsyncBranch<UnwrapAsyncTernary<B>>(target, 0, maxDepth);
}

function mapBranch<T, U>(
  input: TernaryBranch<T>,
  fn: (value: T) => U,
): TernaryBranch<U> {
  if (isTernaryLeaf(input)) {
    return literal(fn(input.value as T));
  }
  if (isTernary(input)) {
    return input.map(fn);
  }
  if (isTernaryNode(input)) {
    return mapTernary(input as TernaryNode<T>, fn);
  }
  if (typeof input === "function") {
    return () => {
      const resolved = resolveSyncBranch<T>(input, 0, DEFAULT_MAX_DEPTH);
      return literal(fn(resolved));
    };
  }
  return literal(fn(input as T));
}

/**
 * Recursively transforms every leaf outcome of a `TernaryNode<T>` into `TernaryNode<U>`.
 */
export function mapTernary<T, U>(
  node: TernaryNode<T>,
  fn: (value: T) => U,
): TernaryNode<U> {
  return {
    [TERNARY_NODE_SYMBOL]: true,
    ...(node.label !== undefined ? { label: node.label } : {}),
    condition: node.condition,
    consequent: mapBranch(node.consequent, fn),
    alternate: mapBranch(node.alternate, fn),
  };
}

function computeDepth(input: unknown, seen: WeakSet<object>): number {
  if (isTernary(input)) {
    return computeDepth(input.toNode(), seen);
  }
  if (!isTernaryNode(input)) {
    return 0;
  }
  if (seen.has(input)) {
    return 0;
  }
  seen.add(input);
  const left = computeDepth(input.consequent, seen);
  const right = computeDepth(input.alternate, seen);
  return 1 + Math.max(left, right);
}

// ─── Ternary Struct Wrapper Class ────────────────────────────────────────────

/**
 * Immutable, composable recursive ternary tree struct.
 * Can be evaluated directly via `.eval()`, traced via `.trace()`, transformed via `.map()`,
 * or nested inside another `ternary(...).then(...)` / `.else(...)` expression.
 */
export class Ternary<T> {
  public readonly [TERNARY_INSTANCE_SYMBOL] = true as const;
  private readonly node: TernaryNode<T>;

  constructor(node: TernaryNode<T>) {
    this.node = node;
  }

  /** Recursively evaluates the ternary tree and returns the winning leaf value. */
  eval(options?: EvalTernaryOptions): T {
    return evalTernary(this.node, options) as T;
  }

  /** Alias for `.eval()`. */
  resolve(options?: EvalTernaryOptions): T {
    return this.eval(options);
  }

  /** Recursively evaluates and returns both the value and decision path trace. */
  trace(options?: EvalTernaryOptions): TernaryTraceResult<T> {
    return traceTernary(this.node, options) as TernaryTraceResult<T>;
  }

  /** Recursively transforms leaf values into a new `Ternary<U>`. */
  map<U>(fn: (value: T) => U): Ternary<U> {
    return new Ternary<U>(mapTernary(this.node, fn));
  }

  /** Returns the underlying recursive `TernaryNode<T>` AST struct. */
  toNode(): TernaryNode<T> {
    return this.node;
  }

  /** Recursively computes the maximum nesting depth of static ternary nodes. */
  depth(): number {
    return computeDepth(this.node, new WeakSet<object>());
  }
}

// ─── Fluent Builder (`ternary(...)`) ─────────────────────────────────────────

interface PendingEntry {
  readonly condition: TernaryCondition;
  readonly consequent: unknown;
  readonly label?: string;
}

function foldChainToNode<T>(
  entries: readonly PendingEntry[],
  alternate: unknown,
): TernaryNode<T> {
  // Fold right-to-left to build the canonical right-nested recursive ternary tree:
  // c1 ? v1 : (c2 ? v2 : (... : alternate))
  let current: unknown = alternate;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    current = {
      [TERNARY_NODE_SYMBOL]: true,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      condition: entry.condition,
      consequent: entry.consequent,
      alternate: current,
    } satisfies TernaryNode<unknown>;
  }
  return current as TernaryNode<T>;
}

export interface TernaryPending {
  /** Sets the `then` (consequent) branch (may be a value, thunk, or nested `Ternary`). */
  then<A>(consequent: A): TernaryChain<UnwrapTernary<A>>;
}

export interface TernaryChain<T> {
  /** Chains another conditional branch (builds a right-nested recursive node). */
  elseIf<U>(
    condition: TernaryCondition,
    consequent: U,
    label?: string,
  ): TernaryChain<T | UnwrapTernary<U>>;

  /** Completes the ternary chain with the `else` branch and returns a composable `Ternary` struct. */
  else<U>(alternate: U): Ternary<T | UnwrapTernary<U>>;

  /** Shorthand for `.else(alternate).eval()` to resolve immediately. */
  elseEval<U>(alternate: U, options?: EvalTernaryOptions): T | UnwrapTernary<U>;
}

class TernaryChainBuilder<T> implements TernaryChain<T> {
  private readonly entries: readonly PendingEntry[];

  constructor(entries: readonly PendingEntry[]) {
    this.entries = entries;
  }

  elseIf<U>(
    condition: TernaryCondition,
    consequent: U,
    label?: string,
  ): TernaryChain<T | UnwrapTernary<U>> {
    return new TernaryChainBuilder<T | UnwrapTernary<U>>([
      ...this.entries,
      { condition, consequent, label },
    ]);
  }

  else<U>(alternate: U): Ternary<T | UnwrapTernary<U>> {
    const root = foldChainToNode<T | UnwrapTernary<U>>(this.entries, alternate);
    return new Ternary<T | UnwrapTernary<U>>(root);
  }

  elseEval<U>(
    alternate: U,
    options?: EvalTernaryOptions,
  ): T | UnwrapTernary<U> {
    return this.else(alternate).eval(options);
  }
}

/**
 * Starts a fluent recursive ternary struct.
 *
 * Supports both:
 * - `ternary(cond).then(a).else(b)` (nestable binary tree)
 * - `ternary(cond, a).elseIf(cond2, b).else(c)` (chained ternary ladder)
 *
 * @example
 * ```ts
 * const discount = ternary(isMember)
 *   .then(
 *     ternary(total > 100)
 *       .then(ternary(isVip).then(0.3).else(0.2))
 *       .else(0.1),
 *   )
 *   .else(ternary(hasCoupon).then(0.05).else(0))
 *   .eval();
 * ```
 */
export function ternary(condition: TernaryCondition): TernaryPending;
export function ternary<A>(
  condition: TernaryCondition,
  consequent: A,
  label?: string,
): TernaryChain<UnwrapTernary<A>>;
export function ternary(
  condition: TernaryCondition,
  consequent?: unknown,
  label?: string,
): TernaryPending | TernaryChain<unknown> {
  if (arguments.length === 1) {
    return {
      then<A>(thenBranch: A): TernaryChain<UnwrapTernary<A>> {
        return new TernaryChainBuilder<UnwrapTernary<A>>([
          { condition, consequent: thenBranch },
        ]);
      },
    };
  }

  return new TernaryChainBuilder<unknown>([{ condition, consequent, label }]);
}

/**
 * Starts a labeled ternary node for decision tracing (`trace()` / `traceTernary()`).
 */
export function labeledTernary(
  label: string,
  condition: TernaryCondition,
): TernaryPending {
  return {
    then<A>(consequent: A): TernaryChain<UnwrapTernary<A>> {
      return new TernaryChainBuilder<UnwrapTernary<A>>([
        { condition, consequent, label },
      ]);
    },
  };
}

// ─── Declarative Array-Based Recursive `cond()` ──────────────────────────────

export type CondPair<T> = readonly [
  condition: TernaryCondition,
  consequent: TernaryBranch<T>,
  label?: string,
];

/**
 * Recursively evaluates an ordered list of `[condition, branch]` pairs against a fallback,
 * short-circuiting on the first truthy condition. Any branch may itself be a nested
 * `Ternary`, `TernaryNode`, or lazy thunk.
 */
export function cond<T, F>(
  pairs: readonly CondPair<T>[],
  fallback: TernaryBranch<F>,
  options?: EvalTernaryOptions,
): T | F {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (pairs.length === 0) {
    return resolveSyncBranch<T | F>(fallback, 0, maxDepth);
  }
  const entries: PendingEntry[] = pairs.map(
    ([condition, consequent, label]) => ({
      condition,
      consequent,
      label,
    }),
  );
  const root = foldChainToNode<T | F>(entries, fallback);
  return resolveSyncBranch<T | F>(root, 0, maxDepth);
}

// ─── Subject-Bound Recursive Ternary (`ternaryFor` & `ternaryRule`) ──────────

export type SubjectBranch<Subject, Out> =
  | Out
  | TernaryLeaf<Out>
  | ((
      subject: Subject,
    ) => Out | Ternary<Out> | TernaryNode<Out> | TernaryLeaf<Out>)
  | Ternary<Out>
  | TernaryNode<Out>
  | TernaryRule<Subject, Out>;

type SubjectLeafWrapper<V> = TernaryRule<never, V> | TernaryLeaf<V>;
type SubjectTernaryWrapper<V> =
  Ternary<V> | TernaryNode<V> | ((subject: never) => V);

export type UnwrapSubjectBranch<B> =
  B extends SubjectLeafWrapper<infer R>
    ? R
    : B extends SubjectTernaryWrapper<infer V>
      ? UnwrapTernary<V>
      : B;

interface SubjectEntry<Subject> {
  readonly predicate: (subject: Subject) => boolean;
  readonly consequent: unknown;
  readonly label?: string;
}

function isTernaryRule(value: unknown): value is TernaryRule<unknown, unknown> {
  return (
    isTypeof(value, "object") &&
    isNotNull(value) &&
    TERNARY_RULE_SYMBOL in value &&
    (value as { [TERNARY_RULE_SYMBOL]?: unknown })[TERNARY_RULE_SYMBOL] === true
  );
}

function bindSubjectBranch<Subject, Out>(
  branchValue: unknown,
  subject: Subject,
): TernaryBranch<Out> {
  if (isTernaryLeaf(branchValue)) {
    return branchValue as TernaryLeaf<Out>;
  }
  if (isTernaryRule(branchValue)) {
    return branchValue.bind(subject) as Ternary<Out>;
  }
  if (isTernary(branchValue) || isTernaryNode(branchValue)) {
    return branchValue as Ternary<Out> | TernaryNode<Out>;
  }
  if (isFunction(branchValue)) {
    return () => (branchValue as (s: Subject) => TernaryBranch<Out>)(subject);
  }
  return literal(branchValue as Out);
}

/**
 * Reusable, subject-parameterized recursive ternary decision rule.
 * Can be evaluated on any `Subject` via `.eval(subject)`, traced via `.trace(subject)`,
 * or nested inside another `ternaryRule` / `ternaryFor`.
 */
export class TernaryRule<Subject, Out> {
  public readonly [TERNARY_RULE_SYMBOL] = true as const;
  private readonly entries: readonly SubjectEntry<Subject>[];
  private readonly fallback: unknown;

  constructor(entries: readonly SubjectEntry<Subject>[], fallback: unknown) {
    this.entries = entries;
    this.fallback = fallback;
  }

  /** Binds a concrete `subject` to produce a `Ternary<Out>` tree struct. */
  bind(subject: Subject): Ternary<Out> {
    const boundEntries: PendingEntry[] = this.entries.map((entry) => ({
      condition: () => entry.predicate(subject),
      consequent: bindSubjectBranch<Subject, Out>(entry.consequent, subject),
      label: entry.label,
    }));
    const boundFallback = bindSubjectBranch<Subject, Out>(
      this.fallback,
      subject,
    );
    if (boundEntries.length === 0) {
      const leafNode: TernaryNode<Out> = {
        [TERNARY_NODE_SYMBOL]: true,
        condition: true,
        consequent: boundFallback,
        alternate: boundFallback,
      };
      return new Ternary<Out>(leafNode);
    }
    return new Ternary<Out>(foldChainToNode<Out>(boundEntries, boundFallback));
  }

  /** Evaluates the rule recursively for `subject`. */
  eval(subject: Subject, options?: EvalTernaryOptions): Out {
    return this.bind(subject).eval(options);
  }

  /** Evaluates the rule for `subject` and returns both value and decision trace. */
  trace(
    subject: Subject,
    options?: EvalTernaryOptions,
  ): TernaryTraceResult<Out> {
    return this.bind(subject).trace(options);
  }
}

export interface TernaryRuleBuilder<Subject, Remaining, Out = never> {
  /** Adds a branch guarded by a TypeScript type-guard predicate with a callback resolver. */
  when<Narrowed extends Remaining, R>(
    predicate: (value: Remaining) => value is Narrowed,
    consequent: (value: Narrowed) => R,
    label?: string,
  ): TernaryRuleBuilder<
    Subject,
    Exclude<Remaining, Narrowed>,
    Out | UnwrapTernary<R>
  >;

  /** Adds a branch guarded by a TypeScript type-guard predicate with a nested `TernaryRule`. */
  when<Narrowed extends Remaining, R>(
    predicate: (value: Remaining) => value is Narrowed,
    consequent: TernaryRule<Narrowed, R>,
    label?: string,
  ): TernaryRuleBuilder<Subject, Exclude<Remaining, Narrowed>, Out | R>;

  /** Adds a branch guarded by a TypeScript type-guard predicate with a static or `Ternary` branch. */
  when<Narrowed extends Remaining, B>(
    predicate: (value: Remaining) => value is Narrowed,
    consequent: B,
    label?: string,
  ): TernaryRuleBuilder<
    Subject,
    Exclude<Remaining, Narrowed>,
    Out | UnwrapSubjectBranch<B>
  >;

  /** Adds a branch guarded by a boolean predicate with a callback resolver. */
  when<R>(
    predicate: (value: Remaining) => boolean,
    consequent: (value: Remaining) => R,
    label?: string,
  ): TernaryRuleBuilder<Subject, Remaining, Out | UnwrapTernary<R>>;

  /** Adds a branch guarded by a boolean predicate with a nested `TernaryRule`. */
  when<R>(
    predicate: (value: Remaining) => boolean,
    consequent: TernaryRule<Remaining, R>,
    label?: string,
  ): TernaryRuleBuilder<Subject, Remaining, Out | R>;

  /** Adds a branch guarded by a boolean predicate with a static or `Ternary` branch. */
  when<B>(
    predicate: (value: Remaining) => boolean,
    consequent: B,
    label?: string,
  ): TernaryRuleBuilder<Subject, Remaining, Out | UnwrapSubjectBranch<B>>;

  /** Completes the reusable rule with a callback fallback. */
  else<R>(
    alternate: (value: Remaining) => R,
  ): TernaryRule<Subject, Out | UnwrapTernary<R>>;

  /** Completes the reusable rule with a nested `TernaryRule` fallback. */
  else<R>(alternate: TernaryRule<Remaining, R>): TernaryRule<Subject, Out | R>;

  /** Completes the reusable rule with a static or `Ternary` fallback. */
  else<B>(alternate: B): TernaryRule<Subject, Out | UnwrapSubjectBranch<B>>;
}

class TernaryRuleBuilderImpl<
  Subject,
  Remaining,
  Out = never,
> implements TernaryRuleBuilder<Subject, Remaining, Out> {
  private readonly entries: readonly SubjectEntry<Subject>[];

  constructor(entries: readonly SubjectEntry<Subject>[] = []) {
    this.entries = entries;
  }

  when(
    predicate: (value: never) => boolean,
    consequent: unknown,
    label?: string,
  ): TernaryRuleBuilderImpl<Subject, never, unknown> {
    return new TernaryRuleBuilderImpl<Subject, never, unknown>([
      ...this.entries,
      {
        predicate: predicate as (s: Subject) => boolean,
        consequent,
        label,
      },
    ]);
  }

  else<B>(alternate: B): TernaryRule<Subject, Out | UnwrapSubjectBranch<B>> {
    return new TernaryRule<Subject, Out | UnwrapSubjectBranch<B>>(
      this.entries,
      alternate,
    );
  }
}

export interface SubjectTernaryBuilder<Subject, Remaining, Out = never> {
  /** Adds a branch guarded by a TypeScript type-guard predicate with a callback resolver. */
  when<Narrowed extends Remaining, R>(
    predicate: (value: Remaining) => value is Narrowed,
    consequent: (value: Narrowed) => R,
    label?: string,
  ): SubjectTernaryBuilder<
    Subject,
    Exclude<Remaining, Narrowed>,
    Out | UnwrapTernary<R>
  >;

  /** Adds a branch guarded by a TypeScript type-guard predicate with a nested `TernaryRule`. */
  when<Narrowed extends Remaining, R>(
    predicate: (value: Remaining) => value is Narrowed,
    consequent: TernaryRule<Narrowed, R>,
    label?: string,
  ): SubjectTernaryBuilder<Subject, Exclude<Remaining, Narrowed>, Out | R>;

  /** Adds a branch guarded by a TypeScript type-guard predicate with a static or `Ternary` branch. */
  when<Narrowed extends Remaining, B>(
    predicate: (value: Remaining) => value is Narrowed,
    consequent: B,
    label?: string,
  ): SubjectTernaryBuilder<
    Subject,
    Exclude<Remaining, Narrowed>,
    Out | UnwrapSubjectBranch<B>
  >;

  /** Adds a branch guarded by a boolean predicate with a callback resolver. */
  when<R>(
    predicate: (value: Remaining) => boolean,
    consequent: (value: Remaining) => R,
    label?: string,
  ): SubjectTernaryBuilder<Subject, Remaining, Out | UnwrapTernary<R>>;

  /** Adds a branch guarded by a boolean predicate with a nested `TernaryRule`. */
  when<R>(
    predicate: (value: Remaining) => boolean,
    consequent: TernaryRule<Remaining, R>,
    label?: string,
  ): SubjectTernaryBuilder<Subject, Remaining, Out | R>;

  /** Adds a branch guarded by a boolean predicate with a static or `Ternary` branch. */
  when<B>(
    predicate: (value: Remaining) => boolean,
    consequent: B,
    label?: string,
  ): SubjectTernaryBuilder<Subject, Remaining, Out | UnwrapSubjectBranch<B>>;

  /** Completes the subject-bound ternary with a callback fallback. */
  else<R>(alternate: (value: Remaining) => R): Ternary<Out | UnwrapTernary<R>>;

  /** Completes the subject-bound ternary with a nested `TernaryRule` fallback. */
  else<R>(alternate: TernaryRule<Remaining, R>): Ternary<Out | R>;

  /** Completes the subject-bound ternary with a static or `Ternary` fallback. */
  else<B>(alternate: B): Ternary<Out | UnwrapSubjectBranch<B>>;

  /** Shorthand for `.else(alternate).eval()` with a callback fallback. */
  elseEval<R>(
    alternate: (value: Remaining) => R,
    options?: EvalTernaryOptions,
  ): Out | UnwrapTernary<R>;

  /** Shorthand for `.else(alternate).eval()` with a nested `TernaryRule` fallback. */
  elseEval<R>(
    alternate: TernaryRule<Remaining, R>,
    options?: EvalTernaryOptions,
  ): Out | R;

  /** Shorthand for `.else(alternate).eval()` with a static or `Ternary` fallback. */
  elseEval<B>(
    alternate: B,
    options?: EvalTernaryOptions,
  ): Out | UnwrapSubjectBranch<B>;
}

class SubjectTernaryBuilderImpl<
  Subject,
  Remaining,
  Out = never,
> implements SubjectTernaryBuilder<Subject, Remaining, Out> {
  private readonly subject: Subject;
  private readonly entries: readonly SubjectEntry<Subject>[];

  constructor(
    subject: Subject,
    entries: readonly SubjectEntry<Subject>[] = [],
  ) {
    this.subject = subject;
    this.entries = entries;
  }

  when(
    predicate: (value: never) => boolean,
    consequent: unknown,
    label?: string,
  ): SubjectTernaryBuilderImpl<Subject, never, unknown> {
    return new SubjectTernaryBuilderImpl<Subject, never, unknown>(
      this.subject,
      [
        ...this.entries,
        {
          predicate: predicate as (s: Subject) => boolean,
          consequent,
          label,
        },
      ],
    );
  }

  else<B>(alternate: B): Ternary<Out | UnwrapSubjectBranch<B>> {
    return new TernaryRule<Subject, Out | UnwrapSubjectBranch<B>>(
      this.entries,
      alternate,
    ).bind(this.subject);
  }

  elseEval<B>(
    alternate: B,
    options?: EvalTernaryOptions,
  ): Out | UnwrapSubjectBranch<B> {
    return this.else(alternate).eval(options);
  }
}

/**
 * Starts a reusable, subject-parameterized recursive ternary rule that can be
 * invoked repeatedly on different inputs or nested inside `ternaryFor(...)`.
 */
export function ternaryRule<Subject>(): TernaryRuleBuilder<
  Subject,
  Subject,
  never
> {
  return new TernaryRuleBuilderImpl<Subject, Subject, never>();
}

/**
 * Starts a subject-bound recursive ternary builder replacing deeply nested
 * ternary chains on a single value (with TypeScript type-guard narrowing).
 *
 * @example
 * ```ts
 * const kind = ternaryFor(fieldVal)
 *   .when((v): v is null => v === null, "null")
 *   .when(Array.isArray, "array")
 *   .when((v): v is Date => v instanceof Date, "date")
 *   .elseEval((v) => typeof v);
 * ```
 */
export function ternaryFor<Subject>(
  subject: Subject,
): SubjectTernaryBuilder<Subject, Subject, never> {
  return new SubjectTernaryBuilderImpl<Subject, Subject, never>(subject);
}
