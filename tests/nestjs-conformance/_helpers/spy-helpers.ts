import { expect, mock, spyOn, type Mock } from "bun:test";

const MATCH_PREDICATE_SYMBOL = Symbol.for("bunest:conformance:match_predicate");

export interface MatchPredicate {
  readonly [MATCH_PREDICATE_SYMBOL]: true;
  readonly description: string;
  readonly test: (actual: unknown) => boolean;
}

function createMatcher(
  description: string,
  test: (actual: unknown) => boolean,
): MatchPredicate {
  return {
    [MATCH_PREDICATE_SYMBOL]: true,
    description,
    test,
  };
}

export function isMatchPredicate(value: unknown): value is MatchPredicate {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<MatchPredicate>)[MATCH_PREDICATE_SYMBOL] === true
  );
}

/**
 * Lightweight Sinon-inspired argument matchers for `spy.calledWith(...)`.
 */
export const match = Object.freeze({
  any: createMatcher("match.any", () => true),
  string: createMatcher("match.string", (v) => typeof v === "string"),
  number: createMatcher("match.number", (v) => typeof v === "number"),
  bool: createMatcher("match.bool", (v) => typeof v === "boolean"),
  func: createMatcher("match.func", (v) => typeof v === "function"),
  object: createMatcher(
    "match.object",
    (v) => typeof v === "object" && v !== null,
  ),
  array: createMatcher("match.array", (v) => Array.isArray(v)),
  defined: createMatcher("match.defined", (v) => v !== undefined),
  truthy: createMatcher("match.truthy", (v) => Boolean(v)),
  falsy: createMatcher("match.falsy", (v) => !v),
  instanceOf: <T>(ctor: abstract new (...args: any[]) => T): MatchPredicate =>
    createMatcher(
      `match.instanceOf(${ctor.name || "Constructor"})`,
      (v) => v instanceof ctor,
    ),
  has: (
    property: string | symbol,
    ...rest: [expectedValue?: unknown]
  ): MatchPredicate => {
    const hasExpected = rest.length > 0;
    const expectedValue = rest[0];
    return createMatcher(`match.has(${String(property)})`, (v) => {
      if ((typeof v !== "object" && typeof v !== "function") || v === null) {
        return false;
      }
      if (!(property in v)) {
        return false;
      }
      if (!hasExpected) {
        return true;
      }
      return deepMatch(
        (v as Record<PropertyKey, unknown>)[property],
        expectedValue,
      );
    });
  },
  regex: (pattern: RegExp): MatchPredicate =>
    createMatcher(
      `match.regex(${String(pattern)})`,
      (v) => typeof v === "string" && pattern.test(v),
    ),
  predicate: (
    fn: (actual: unknown) => boolean,
    description = "match.predicate",
  ): MatchPredicate => createMatcher(description, fn),
});

/**
 * Structural deep equality supporting `MatchPredicate` matchers, `Date`,
 * `RegExp`, `Array`, `Map`, `Set`, plain objects, and cyclic graphs.
 */
export function deepMatch(
  actual: unknown,
  expected: unknown,
  seen = new WeakMap<object, WeakSet<object>>(),
): boolean {
  if (isMatchPredicate(expected)) {
    return expected.test(actual);
  }
  if (Object.is(actual, expected)) {
    return true;
  }
  if (
    typeof actual !== "object" ||
    actual === null ||
    typeof expected !== "object" ||
    expected === null
  ) {
    return false;
  }

  let seenTargets = seen.get(actual);
  if (seenTargets?.has(expected)) {
    return true;
  }
  if (!seenTargets) {
    seenTargets = new WeakSet<object>();
    seen.set(actual, seenTargets);
  }
  seenTargets.add(expected);

  if (actual instanceof Date && expected instanceof Date) {
    return Object.is(actual.getTime(), expected.getTime());
  }
  if (actual instanceof RegExp && expected instanceof RegExp) {
    return actual.source === expected.source && actual.flags === expected.flags;
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) {
      return false;
    }
    if (actual.length !== expected.length) {
      return false;
    }
    for (let i = 0; i < actual.length; i += 1) {
      if (!deepMatch(actual[i], expected[i], seen)) {
        return false;
      }
    }
    return true;
  }
  if (actual instanceof Map && expected instanceof Map) {
    if (actual.size !== expected.size) {
      return false;
    }
    for (const [key, val] of expected.entries()) {
      if (!actual.has(key) || !deepMatch(actual.get(key), val, seen)) {
        return false;
      }
    }
    return true;
  }
  if (actual instanceof Set && expected instanceof Set) {
    if (actual.size !== expected.size) {
      return false;
    }
    for (const val of expected.values()) {
      if (!actual.has(val)) {
        return false;
      }
    }
    return true;
  }

  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  if (actualKeys.length !== expectedKeys.length) {
    return false;
  }
  const actualRec = actual as Record<string, unknown>;
  const expectedRec = expected as Record<string, unknown>;
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(actualRec, key)) {
      return false;
    }
    if (!deepMatch(actualRec[key], expectedRec[key], seen)) {
      return false;
    }
  }
  return true;
}

let globalInvocationCounter = 0;

export interface SpyCall<TArgs extends unknown[] = any[], TReturn = any> {
  readonly args: TArgs;
  readonly returnValue: TReturn | undefined;
  readonly exception: unknown;
  readonly threw: boolean;
  readonly order: number;
  calledWith(...expectedArgs: unknown[]): boolean;
  calledWithExactly(...expectedArgs: unknown[]): boolean;
}

export interface SinonLikeSpy<
  TArgs extends unknown[] = any[],
  TReturn = any,
> extends Mock<(...args: TArgs) => TReturn> {
  readonly called: boolean;
  readonly notCalled: boolean;
  readonly calledOnce: boolean;
  readonly calledTwice: boolean;
  readonly calledThrice: boolean;
  readonly callCount: number;
  readonly args: TArgs[];
  readonly returnValues: Array<TReturn | undefined>;
  readonly firstCall: SpyCall<TArgs, TReturn> | null;
  readonly secondCall: SpyCall<TArgs, TReturn> | null;
  readonly thirdCall: SpyCall<TArgs, TReturn> | null;
  readonly lastCall: SpyCall<TArgs, TReturn> | null;
  getCall(index: number): SpyCall<TArgs, TReturn> | null;
  calledWith(...expectedArgs: unknown[]): boolean;
  calledWithExactly(...expectedArgs: unknown[]): boolean;
  calledOnceWith(...expectedArgs: unknown[]): boolean;
  calledOnceWithExactly(...expectedArgs: unknown[]): boolean;
  calledBefore(other: SinonLikeSpy<any, any>): boolean;
  calledAfter(other: SinonLikeSpy<any, any>): boolean;
  resetHistory(): void;
  restore(): void;
}

export interface StubCallBehavior<
  TArgs extends unknown[] = any[],
  TReturn = any,
> {
  returns(value: TReturn): SinonLikeStub<TArgs, TReturn>;
  returnsArg(index: number): SinonLikeStub<TArgs, TReturn>;
  returnsThis(): SinonLikeStub<TArgs, TReturn>;
  resolves(value: Awaited<TReturn>): SinonLikeStub<TArgs, TReturn>;
  rejects(error?: unknown): SinonLikeStub<TArgs, TReturn>;
  throws(error?: unknown): SinonLikeStub<TArgs, TReturn>;
  callsFake(fn: (...args: TArgs) => TReturn): SinonLikeStub<TArgs, TReturn>;
  callThrough(): SinonLikeStub<TArgs, TReturn>;
}

export interface SinonLikeStub<TArgs extends unknown[] = any[], TReturn = any>
  extends SinonLikeSpy<TArgs, TReturn>, StubCallBehavior<TArgs, TReturn> {
  onCall(index: number): StubCallBehavior<TArgs, TReturn>;
  onFirstCall(): StubCallBehavior<TArgs, TReturn>;
  onSecondCall(): StubCallBehavior<TArgs, TReturn>;
  onThirdCall(): StubCallBehavior<TArgs, TReturn>;
  resetBehavior(): void;
  reset(): void;
}

type StubAction<TArgs extends unknown[], TReturn> =
  | { readonly kind: "default" }
  | { readonly kind: "return"; readonly value: TReturn }
  | { readonly kind: "returnArg"; readonly index: number }
  | { readonly kind: "returnThis" }
  | { readonly kind: "resolve"; readonly value: unknown }
  | { readonly kind: "reject"; readonly error: unknown }
  | { readonly kind: "throw"; readonly error: unknown }
  | { readonly kind: "fake"; readonly fn: (...args: TArgs) => TReturn }
  | { readonly kind: "callThrough" };

interface RecordedCallMeta {
  readonly order: number;
  readonly threw: boolean;
  readonly returnValue: unknown;
  readonly exception: unknown;
}

function toThrowable(error: unknown, fallbackMessage: string): unknown {
  if (error === undefined) {
    return new Error(fallbackMessage);
  }
  if (typeof error === "string") {
    return new Error(error);
  }
  return error;
}

function matchesPrefix(
  actualArgs: readonly unknown[],
  expectedArgs: readonly unknown[],
): boolean {
  if (actualArgs.length < expectedArgs.length) {
    return false;
  }
  for (let i = 0; i < expectedArgs.length; i += 1) {
    if (!deepMatch(actualArgs[i], expectedArgs[i])) {
      return false;
    }
  }
  return true;
}

function matchesExact(
  actualArgs: readonly unknown[],
  expectedArgs: readonly unknown[],
): boolean {
  if (actualArgs.length !== expectedArgs.length) {
    return false;
  }
  return matchesPrefix(actualArgs, expectedArgs);
}

function executeAction<TArgs extends unknown[], TReturn>(
  action: StubAction<TArgs, TReturn>,
  thisArg: unknown,
  args: TArgs,
  originalFn?: (...args: TArgs) => TReturn,
): TReturn {
  switch (action.kind) {
    case "default":
      return undefined as TReturn;
    case "return":
      return action.value;
    case "returnArg":
      return args[action.index] as TReturn;
    case "returnThis":
      return thisArg as TReturn;
    case "resolve":
      return Promise.resolve(action.value) as unknown as TReturn;
    case "reject":
      return Promise.reject(
        toThrowable(action.error, "Stub rejected"),
      ) as unknown as TReturn;
    case "throw":
      throw toThrowable(action.error, "Stub threw an error");
    case "fake":
      return action.fn.apply(thisArg, args);
    case "callThrough":
      return originalFn
        ? originalFn.apply(thisArg, args)
        : (undefined as TReturn);
  }
}

const ORIGINAL_FN_SYMBOL = Symbol.for("bunest:conformance:spy_original_fn");

function unwrapOriginalFn(fn: unknown): ((...args: any[]) => any) | undefined {
  if (typeof fn !== "function") {
    return undefined;
  }
  const stored = (fn as unknown as Record<symbol, unknown>)[ORIGINAL_FN_SYMBOL];
  return typeof stored === "function"
    ? (stored as (...args: any[]) => any)
    : (fn as (...args: any[]) => any);
}

function augmentBunMock<TArgs extends unknown[], TReturn>(
  bunMock: Mock<(...args: TArgs) => TReturn>,
  options: {
    readonly initialAction: StubAction<TArgs, TReturn>;
    readonly originalFn?: (...args: TArgs) => TReturn;
    readonly isStub: boolean;
  },
): SinonLikeStub<TArgs, TReturn> {
  if (
    options.originalFn &&
    !(ORIGINAL_FN_SYMBOL in (bunMock as unknown as Record<symbol, unknown>))
  ) {
    Object.defineProperty(bunMock, ORIGINAL_FN_SYMBOL, {
      value: options.originalFn,
      configurable: true,
    });
  }
  let defaultAction: StubAction<TArgs, TReturn> = options.initialAction;
  const perCallActions = new Map<number, StubAction<TArgs, TReturn>>();
  const callMetas: RecordedCallMeta[] = [];

  const dispatcher = function (this: unknown, ...args: TArgs): TReturn {
    const callIdx = callMetas.length;
    const order = ++globalInvocationCounter;
    const action = perCallActions.get(callIdx) ?? defaultAction;
    try {
      const returnValue = executeAction(action, this, args, options.originalFn);
      callMetas.push({
        order,
        threw: false,
        returnValue,
        exception: undefined,
      });
      return returnValue;
    } catch (exception) {
      callMetas.push({
        order,
        threw: true,
        returnValue: undefined,
        exception,
      });
      throw exception;
    }
  };

  bunMock.mockImplementation(dispatcher);

  const enhanced = bunMock as unknown as SinonLikeStub<TArgs, TReturn>;

  const buildCall = (index: number): SpyCall<TArgs, TReturn> | null => {
    const rawArgs = bunMock.mock.calls[index];
    const meta = callMetas[index];
    if (!rawArgs || !meta) {
      return null;
    }
    const callArgs = rawArgs as TArgs;
    return {
      args: callArgs,
      returnValue: meta.returnValue as TReturn | undefined,
      exception: meta.exception,
      threw: meta.threw,
      order: meta.order,
      calledWith: (...expectedArgs: unknown[]) =>
        matchesPrefix(callArgs, expectedArgs),
      calledWithExactly: (...expectedArgs: unknown[]) =>
        matchesExact(callArgs, expectedArgs),
    };
  };

  Object.defineProperties(enhanced, {
    called: {
      configurable: true,
      get: () => bunMock.mock.calls.length > 0,
    },
    notCalled: {
      configurable: true,
      get: () => bunMock.mock.calls.length === 0,
    },
    calledOnce: {
      configurable: true,
      get: () => bunMock.mock.calls.length === 1,
    },
    calledTwice: {
      configurable: true,
      get: () => bunMock.mock.calls.length === 2,
    },
    calledThrice: {
      configurable: true,
      get: () => bunMock.mock.calls.length === 3,
    },
    callCount: {
      configurable: true,
      get: () => bunMock.mock.calls.length,
    },
    args: {
      configurable: true,
      get: () => bunMock.mock.calls as TArgs[],
    },
    returnValues: {
      configurable: true,
      get: () => callMetas.map((m) => m.returnValue as TReturn | undefined),
    },
    firstCall: {
      configurable: true,
      get: () => buildCall(0),
    },
    secondCall: {
      configurable: true,
      get: () => buildCall(1),
    },
    thirdCall: {
      configurable: true,
      get: () => buildCall(2),
    },
    lastCall: {
      configurable: true,
      get: () =>
        bunMock.mock.calls.length > 0
          ? buildCall(bunMock.mock.calls.length - 1)
          : null,
    },
  });

  enhanced.getCall = (index: number) => buildCall(index);

  enhanced.calledWith = (...expectedArgs: unknown[]) =>
    bunMock.mock.calls.some((callArgs) =>
      matchesPrefix(callArgs, expectedArgs),
    );

  enhanced.calledWithExactly = (...expectedArgs: unknown[]) =>
    bunMock.mock.calls.some((callArgs) => matchesExact(callArgs, expectedArgs));

  enhanced.calledOnceWith = (...expectedArgs: unknown[]) =>
    bunMock.mock.calls.length === 1 &&
    matchesPrefix(bunMock.mock.calls[0] ?? [], expectedArgs);

  enhanced.calledOnceWithExactly = (...expectedArgs: unknown[]) =>
    bunMock.mock.calls.length === 1 &&
    matchesExact(bunMock.mock.calls[0] ?? [], expectedArgs);

  enhanced.calledBefore = (other: SinonLikeSpy<any, any>) => {
    const mine = enhanced.firstCall;
    const theirs = other.firstCall;
    if (!mine || !theirs) {
      return false;
    }
    return mine.order < theirs.order;
  };

  enhanced.calledAfter = (other: SinonLikeSpy<any, any>) => {
    const mine = enhanced.firstCall;
    const theirs = other.firstCall;
    if (!mine || !theirs) {
      return false;
    }
    return mine.order > theirs.order;
  };

  enhanced.resetHistory = () => {
    bunMock.mockClear();
    callMetas.length = 0;
  };

  enhanced.restore = () => {
    bunMock.mockRestore();
  };

  const makeBehaviorSetter = (
    assign: (action: StubAction<TArgs, TReturn>) => void,
  ): StubCallBehavior<TArgs, TReturn> => ({
    returns(value: TReturn) {
      assign({ kind: "return", value });
      return enhanced;
    },
    returnsArg(index: number) {
      assign({ kind: "returnArg", index });
      return enhanced;
    },
    returnsThis() {
      assign({ kind: "returnThis" });
      return enhanced;
    },
    resolves(value: Awaited<TReturn>) {
      assign({ kind: "resolve", value });
      return enhanced;
    },
    rejects(error?: unknown) {
      assign({ kind: "reject", error });
      return enhanced;
    },
    throws(error?: unknown) {
      assign({ kind: "throw", error });
      return enhanced;
    },
    callsFake(fn: (...args: TArgs) => TReturn) {
      assign({ kind: "fake", fn });
      return enhanced;
    },
    callThrough() {
      assign({ kind: "callThrough" });
      return enhanced;
    },
  });

  if (options.isStub) {
    const defaultSetter = makeBehaviorSetter((action) => {
      defaultAction = action;
    });
    enhanced.returns = defaultSetter.returns;
    enhanced.returnsArg = defaultSetter.returnsArg;
    enhanced.returnsThis = defaultSetter.returnsThis;
    enhanced.resolves = defaultSetter.resolves;
    enhanced.rejects = defaultSetter.rejects;
    enhanced.throws = defaultSetter.throws;
    enhanced.callsFake = defaultSetter.callsFake;
    enhanced.callThrough = defaultSetter.callThrough;

    enhanced.onCall = (index: number) =>
      makeBehaviorSetter((action) => {
        perCallActions.set(index, action);
      });
    enhanced.onFirstCall = () => enhanced.onCall(0);
    enhanced.onSecondCall = () => enhanced.onCall(1);
    enhanced.onThirdCall = () => enhanced.onCall(2);

    enhanced.resetBehavior = () => {
      perCallActions.clear();
      defaultAction = { kind: "default" };
    };
    enhanced.reset = () => {
      enhanced.resetHistory();
      enhanced.resetBehavior();
    };
  }

  return enhanced;
}

/**
 * Creates a standalone callable spy backed by `bun:test`'s `mock()` with
 * Sinon-compatible inspection helpers (`.calledOnce`, `.calledWith`, etc.).
 */
export function createSpy<
  TFn extends (...args: any[]) => any = (...args: any[]) => any,
>(fn?: TFn): SinonLikeSpy<Parameters<TFn>, ReturnType<TFn>> {
  const bunMock = mock(
    (..._args: Parameters<TFn>) => undefined as ReturnType<TFn>,
  );
  return augmentBunMock<Parameters<TFn>, ReturnType<TFn>>(bunMock, {
    initialAction: fn ? { kind: "fake", fn } : { kind: "default" },
    originalFn: fn,
    isStub: false,
  });
}

/**
 * Spies on an existing object method via `bun:test`'s `spyOn()`, forwarding
 * calls to the original method while exposing Sinon-compatible helpers.
 */
export function spyOnMethod<
  T extends object,
  K extends {
    [P in keyof T]: T[P] extends (...args: any[]) => any ? P : never;
  }[keyof T],
>(
  target: T,
  method: K,
): T[K] extends (...args: infer TArgs) => infer TReturn
  ? SinonLikeSpy<TArgs, TReturn>
  : SinonLikeSpy {
  const original = unwrapOriginalFn(target[method]);
  const bunSpy = spyOn(target, method as any) as unknown as Mock<
    (...args: any[]) => any
  >;
  return augmentBunMock(bunSpy, {
    initialAction: { kind: "callThrough" },
    originalFn: original,
    isStub: false,
  }) as any;
}

/**
 * Creates a standalone Sinon-compatible stub backed by `bun:test`'s `mock()`.
 */
export function createStub<
  TFn extends (...args: any[]) => any = (...args: any[]) => any,
>(fn?: TFn): SinonLikeStub<Parameters<TFn>, ReturnType<TFn>> {
  const bunMock = mock(
    (..._args: Parameters<TFn>) => undefined as ReturnType<TFn>,
  );
  return augmentBunMock<Parameters<TFn>, ReturnType<TFn>>(bunMock, {
    initialAction: fn ? { kind: "fake", fn } : { kind: "default" },
    originalFn: fn,
    isStub: true,
  });
}

/**
 * Replaces an object method with a Sinon-compatible stub backed by `bun:test`'s
 * `spyOn()` (returns `undefined` by default unless configured via `.returns()`,
 * `.resolves()`, `.throws()`, `.callsFake()`, or `.callThrough()`).
 */
export function stubMethod<
  T extends object,
  K extends {
    [P in keyof T]: T[P] extends (...args: any[]) => any ? P : never;
  }[keyof T],
>(
  target: T,
  method: K,
): T[K] extends (...args: infer TArgs) => infer TReturn
  ? SinonLikeStub<TArgs, TReturn>
  : SinonLikeStub {
  const original = unwrapOriginalFn(target[method]);
  const bunSpy = spyOn(target, method as any) as unknown as Mock<
    (...args: any[]) => any
  >;
  return augmentBunMock(bunSpy, {
    initialAction: { kind: "default" },
    originalFn: original,
    isStub: true,
  }) as any;
}

export interface SpySandbox {
  spy<TFn extends (...args: any[]) => any = (...args: any[]) => any>(
    fn?: TFn,
  ): SinonLikeSpy<Parameters<TFn>, ReturnType<TFn>>;
  spy<
    T extends object,
    K extends {
      [P in keyof T]: T[P] extends (...args: any[]) => any ? P : never;
    }[keyof T],
  >(
    target: T,
    method: K,
  ): T[K] extends (...args: infer TArgs) => infer TReturn
    ? SinonLikeSpy<TArgs, TReturn>
    : SinonLikeSpy;

  stub<TFn extends (...args: any[]) => any = (...args: any[]) => any>(
    fn?: TFn,
  ): SinonLikeStub<Parameters<TFn>, ReturnType<TFn>>;
  stub<
    T extends object,
    K extends {
      [P in keyof T]: T[P] extends (...args: any[]) => any ? P : never;
    }[keyof T],
  >(
    target: T,
    method: K,
  ): T[K] extends (...args: infer TArgs) => infer TReturn
    ? SinonLikeStub<TArgs, TReturn>
    : SinonLikeStub;

  resetHistory(): void;
  restore(): void;
}

/**
 * Creates an isolated sandbox tracking all spies and stubs for one-call
 * `afterEach(() => sandbox.restore())` cleanup (Sinon `createSandbox()` equivalent).
 */
export function createSandbox(): SpySandbox {
  const tracked: Array<SinonLikeSpy<any, any>> = [];

  const register = <S extends SinonLikeSpy<any, any>>(s: S): S => {
    tracked.push(s);
    return s;
  };

  return {
    spy(targetOrFn?: unknown, method?: PropertyKey): any {
      if (
        targetOrFn !== undefined &&
        method !== undefined &&
        (typeof targetOrFn === "object" || typeof targetOrFn === "function") &&
        targetOrFn !== null
      ) {
        return register(spyOnMethod(targetOrFn as any, method as any));
      }
      return register(
        createSpy(targetOrFn as ((...args: any[]) => any) | undefined),
      );
    },
    stub(targetOrFn?: unknown, method?: PropertyKey): any {
      if (
        targetOrFn !== undefined &&
        method !== undefined &&
        (typeof targetOrFn === "object" || typeof targetOrFn === "function") &&
        targetOrFn !== null
      ) {
        return register(stubMethod(targetOrFn as any, method as any));
      }
      return register(
        createStub(targetOrFn as ((...args: any[]) => any) | undefined),
      );
    },
    resetHistory(): void {
      for (const s of tracked) {
        s.resetHistory();
      }
    },
    restore(): void {
      for (let i = tracked.length - 1; i >= 0; i -= 1) {
        tracked[i]?.restore();
      }
      tracked.length = 0;
    },
  };
}

// Concise Chai/Sinon-style assertion shorthands backed by bun:test `expect`.

export function expectCalled(spy: SinonLikeSpy<any, any>): void {
  expect(spy.called).toBe(true);
}

export function expectNotCalled(spy: SinonLikeSpy<any, any>): void {
  expect(spy.callCount).toBe(0);
}

export function expectCalledOnce(spy: SinonLikeSpy<any, any>): void {
  expect(spy.callCount).toBe(1);
}

export function expectCalledTimes(
  spy: SinonLikeSpy<any, any>,
  times: number,
): void {
  expect(spy.callCount).toBe(times);
}

export function expectCalledWith(
  spy: SinonLikeSpy<any, any>,
  ...expectedArgs: unknown[]
): void {
  expect(spy.calledWith(...expectedArgs)).toBe(true);
}

export function expectCalledOnceWith(
  spy: SinonLikeSpy<any, any>,
  ...expectedArgs: unknown[]
): void {
  expect(spy.calledOnceWith(...expectedArgs)).toBe(true);
}

export async function expectRejectsWith<TError extends Error = Error>(
  action: Promise<unknown> | (() => unknown | Promise<unknown>),
  expected?: (abstract new (...args: any[]) => TError) | string | RegExp,
): Promise<TError> {
  let caught: unknown;
  let didThrow = false;
  try {
    await (typeof action === "function" ? action() : action);
  } catch (err) {
    didThrow = true;
    caught = err;
  }

  expect(didThrow).toBe(true);

  if (typeof expected === "function") {
    expect(caught).toBeInstanceOf(expected);
  } else if (typeof expected === "string") {
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(expected);
  } else if (expected instanceof RegExp) {
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(expected);
  }

  return caught as TError;
}
