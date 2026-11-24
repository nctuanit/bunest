/**
 * Pure-TypeScript strict assertion helpers powered by `Bun.deepEquals(a, b, true)`
 * (zero `node:assert` dependency).
 */

export type AssertPredicate =
  | RegExp
  | (new (...args: any[]) => unknown)
  | ((err: unknown) => boolean)
  | Error
  | Record<string, unknown>;

export interface AssertionErrorOptions {
  message?: string;
  actual?: unknown;
  expected?: unknown;
  operator?: string;
  stackStartFn?: Function;
}

export class AssertionError extends Error {
  readonly code = "ERR_ASSERTION";
  readonly actual: unknown;
  readonly expected: unknown;
  readonly operator: string;
  readonly generatedMessage: boolean;

  constructor(options: AssertionErrorOptions = {}) {
    const generated = options.message === undefined;
    const msg =
      options.message ??
      `${formatPreview(options.actual)} ${options.operator ?? "=="} ${formatPreview(options.expected)}`;
    super(msg);
    this.name = "AssertionError";
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = options.operator ?? "strictEqual";
    this.generatedMessage = generated;
    if (Error.captureStackTrace && options.stackStartFn) {
      Error.captureStackTrace(this, options.stackStartFn);
    }
  }
}

function formatPreview(value: unknown): string {
  try {
    return Bun.inspect(value, { colors: false, compact: true, depth: 3 });
  } catch {
    return String(value);
  }
}

function failWith(
  options: AssertionErrorOptions,
  message?: string | Error,
): never {
  if (message instanceof Error) {
    throw message;
  }
  throw new AssertionError({
    ...options,
    ...(message !== undefined ? { message } : {}),
  });
}

function matchesErrorPredicate(
  actual: unknown,
  predicate: AssertPredicate,
): boolean {
  if (predicate instanceof RegExp) {
    const text =
      actual instanceof Error
        ? `${actual.name}: ${actual.message}`
        : String(actual);
    return (
      predicate.test(text) ||
      (actual instanceof Error && predicate.test(actual.message))
    );
  }

  if (typeof predicate === "function") {
    if (predicate.prototype !== undefined && actual instanceof predicate) {
      return true;
    }
    if (
      predicate === Error ||
      Error.isPrototypeOf(predicate) ||
      (predicate.prototype && predicate.prototype instanceof Error)
    ) {
      return false;
    }
    const result = (predicate as (err: unknown) => unknown)(actual);
    return result === true;
  }

  if (typeof predicate === "object" && predicate !== null) {
    if (typeof actual !== "object" || actual === null) {
      return false;
    }
    const actualRecord = actual as Record<string, unknown>;
    const keys =
      predicate instanceof Error
        ? Array.from(
            new Set(["name", "message", ...Object.keys(predicate)]),
          )
        : Object.keys(predicate);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      const expectedVal = (predicate as Record<string, unknown>)[k];
      const actualVal = actualRecord[k];
      if (expectedVal instanceof RegExp) {
        if (typeof actualVal !== "string" || !expectedVal.test(actualVal)) {
          return false;
        }
      } else if (!Bun.deepEquals(actualVal, expectedVal, true)) {
        return false;
      }
    }
    return true;
  }

  return false;
}

function resolvePredicateAndMessage(
  errorOrMessage?: AssertPredicate | string,
  maybeMessage?: string | Error,
): { predicate?: AssertPredicate; message?: string | Error } {
  if (typeof errorOrMessage === "string") {
    return { message: errorOrMessage };
  }
  return { predicate: errorOrMessage, message: maybeMessage };
}

function assertOk(value: unknown, message?: string | Error): asserts value {
  if (!value) {
    failWith(
      {
        actual: value,
        expected: true,
        operator: "==",
        message:
          typeof message === "string"
            ? message
            : `The expression evaluated to a falsy value: ${formatPreview(value)}`,
        stackStartFn: assertOk,
      },
      message,
    );
  }
}

function assertEqual<T>(
  actual: unknown,
  expected: T,
  message?: string | Error,
): asserts actual is T {
  if (!Object.is(actual, expected)) {
    failWith(
      {
        actual,
        expected,
        operator: "strictEqual",
        stackStartFn: assertEqual,
      },
      message,
    );
  }
}

function assertNotEqual(
  actual: unknown,
  expected: unknown,
  message?: string | Error,
): void {
  if (Object.is(actual, expected)) {
    failWith(
      {
        actual,
        expected,
        operator: "notStrictEqual",
        stackStartFn: assertNotEqual,
      },
      message,
    );
  }
}

function assertDeepEqual<T>(
  actual: unknown,
  expected: T,
  message?: string | Error,
): asserts actual is T {
  if (!Bun.deepEquals(actual, expected, true)) {
    failWith(
      {
        actual,
        expected,
        operator: "deepStrictEqual",
        stackStartFn: assertDeepEqual,
      },
      message,
    );
  }
}

function assertNotDeepEqual(
  actual: unknown,
  expected: unknown,
  message?: string | Error,
): void {
  if (Bun.deepEquals(actual, expected, true)) {
    failWith(
      {
        actual,
        expected,
        operator: "notDeepStrictEqual",
        stackStartFn: assertNotDeepEqual,
      },
      message,
    );
  }
}

function assertThrows(
  fn: () => unknown,
  errorOrMessage?: AssertPredicate | string,
  maybeMessage?: string | Error,
): void {
  const { predicate, message } = resolvePredicateAndMessage(
    errorOrMessage,
    maybeMessage,
  );
  let threw = false;
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    threw = true;
    caught = err;
  }

  if (!threw) {
    failWith(
      {
        actual: undefined,
        expected: predicate,
        operator: "throws",
        message: "Missing expected exception.",
        stackStartFn: assertThrows,
      },
      message,
    );
  }

  if (predicate !== undefined && !matchesErrorPredicate(caught, predicate)) {
    failWith(
      {
        actual: caught,
        expected: predicate,
        operator: "throws",
        message: `Thrown error did not match expected predicate: ${formatPreview(caught)}`,
        stackStartFn: assertThrows,
      },
      message,
    );
  }
}

function assertDoesNotThrow(
  fn: () => unknown,
  errorOrMessage?: AssertPredicate | string,
  maybeMessage?: string | Error,
): void {
  const { predicate, message } = resolvePredicateAndMessage(
    errorOrMessage,
    maybeMessage,
  );
  try {
    fn();
  } catch (err) {
    if (predicate === undefined || matchesErrorPredicate(err, predicate)) {
      failWith(
        {
          actual: err,
          expected: undefined,
          operator: "doesNotThrow",
          message: `Got unwanted exception: ${formatPreview(err)}`,
          stackStartFn: assertDoesNotThrow,
        },
        message,
      );
    }
    throw err;
  }
}

async function assertRejects(
  asyncFn: (() => unknown) | Promise<unknown>,
  errorOrMessage?: AssertPredicate | string,
  maybeMessage?: string | Error,
): Promise<void> {
  const { predicate, message } = resolvePredicateAndMessage(
    errorOrMessage,
    maybeMessage,
  );
  let rejected = false;
  let caught: unknown;
  try {
    const promise = typeof asyncFn === "function" ? asyncFn() : asyncFn;
    await promise;
  } catch (err) {
    rejected = true;
    caught = err;
  }

  if (!rejected) {
    failWith(
      {
        actual: undefined,
        expected: predicate,
        operator: "rejects",
        message: "Missing expected rejection.",
        stackStartFn: assertRejects,
      },
      message,
    );
  }

  if (predicate !== undefined && !matchesErrorPredicate(caught, predicate)) {
    failWith(
      {
        actual: caught,
        expected: predicate,
        operator: "rejects",
        message: `Rejected error did not match expected predicate: ${formatPreview(caught)}`,
        stackStartFn: assertRejects,
      },
      message,
    );
  }
}

async function assertDoesNotReject(
  asyncFn: (() => unknown) | Promise<unknown>,
  errorOrMessage?: AssertPredicate | string,
  maybeMessage?: string | Error,
): Promise<void> {
  const { predicate, message } = resolvePredicateAndMessage(
    errorOrMessage,
    maybeMessage,
  );
  try {
    const promise = typeof asyncFn === "function" ? asyncFn() : asyncFn;
    await promise;
  } catch (err) {
    if (predicate === undefined || matchesErrorPredicate(err, predicate)) {
      failWith(
        {
          actual: err,
          expected: undefined,
          operator: "doesNotReject",
          message: `Got unwanted rejection: ${formatPreview(err)}`,
          stackStartFn: assertDoesNotReject,
        },
        message,
      );
    }
    throw err;
  }
}

function assertMatch(
  value: string,
  regexp: RegExp,
  message?: string | Error,
): void {
  if (typeof value !== "string" || !regexp.test(value)) {
    failWith(
      {
        actual: value,
        expected: regexp,
        operator: "match",
        message: `The input ${formatPreview(value)} did not match ${String(regexp)}`,
        stackStartFn: assertMatch,
      },
      message,
    );
  }
}

function assertDoesNotMatch(
  value: string,
  regexp: RegExp,
  message?: string | Error,
): void {
  if (typeof value === "string" && regexp.test(value)) {
    failWith(
      {
        actual: value,
        expected: regexp,
        operator: "doesNotMatch",
        message: `The input ${formatPreview(value)} was expected not to match ${String(regexp)}`,
        stackStartFn: assertDoesNotMatch,
      },
      message,
    );
  }
}

function assertFail(message?: string | Error): never {
  failWith(
    {
      actual: undefined,
      expected: undefined,
      operator: "fail",
      message: "Failed",
      stackStartFn: assertFail,
    },
    message,
  );
}

export interface StrictAssert {
  (value: unknown, message?: string | Error): asserts value;
  ok: typeof assertOk;
  equal: typeof assertEqual;
  strictEqual: typeof assertEqual;
  notEqual: typeof assertNotEqual;
  notStrictEqual: typeof assertNotEqual;
  deepEqual: typeof assertDeepEqual;
  deepStrictEqual: typeof assertDeepEqual;
  notDeepEqual: typeof assertNotDeepEqual;
  notDeepStrictEqual: typeof assertNotDeepEqual;
  throws: typeof assertThrows;
  doesNotThrow: typeof assertDoesNotThrow;
  rejects: typeof assertRejects;
  doesNotReject: typeof assertDoesNotReject;
  match: typeof assertMatch;
  doesNotMatch: typeof assertDoesNotMatch;
  fail: typeof assertFail;
  AssertionError: typeof AssertionError;
}

export const strictAssert: StrictAssert = Object.assign(
  function strictAssertFn(
    value: unknown,
    message?: string | Error,
  ): asserts value {
    assertOk(value, message);
  },
  {
    ok: assertOk,
    equal: assertEqual,
    strictEqual: assertEqual,
    notEqual: assertNotEqual,
    notStrictEqual: assertNotEqual,
    deepEqual: assertDeepEqual,
    deepStrictEqual: assertDeepEqual,
    notDeepEqual: assertNotDeepEqual,
    notDeepStrictEqual: assertNotDeepEqual,
    throws: assertThrows,
    doesNotThrow: assertDoesNotThrow,
    rejects: assertRejects,
    doesNotReject: assertDoesNotReject,
    match: assertMatch,
    doesNotMatch: assertDoesNotMatch,
    fail: assertFail,
    AssertionError,
  },
);
