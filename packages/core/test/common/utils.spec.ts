import { describe, expect, it } from "bun:test";
import {
  and,
  assertNever,
  chunk,
  compact,
  computeBackoffDelay,
  countBy,
  deepClone,
  deepEqual,
  deepMerge,
  definedOnly,
  deleteNestedValue,
  describeError,
  describeValue,
  ensureError,
  err,
  filterObject,
  flatMapResult,
  flow,
  formatDuration,
  getNestedValue,
  groupBy,
  hasNestedValue,
  hasOwn,
  identity,
  include,
  indexBy,
  invariant,
  isAllDefined,
  isAllNullish,
  isAnyNull,
  isAnyNullish,
  isAnyUndefined,
  isArray,
  isBigInt,
  isBoolean,
  isDate,
  isDefined,
  isDuration,
  isEmptyObject,
  isEqual,
  isErr,
  isError,
  isFiniteNumber,
  isFunction,
  isInstanceof,
  isInteger,
  isMap,
  isNonEmptyArray,
  isNonEmptyString,
  isNotNull,
  isNotUndefined,
  isNull,
  isNullish,
  isNumber,
  isObject,
  isOk,
  isOneOf,
  isPlainObject,
  isPrimitive,
  isPromiseLike,
  isRegExp,
  isSet,
  isString,
  isSymbol,
  isTypeof,
  isUndefined,
  isValidDate,
  isValidUuid,
  mapResult,
  mapResultErr,
  mapValues,
  matchResult,
  memoize,
  noop,
  not,
  ok,
  omit,
  once,
  or,
  parseDuration,
  parseRetryAfter,
  partition,
  pick,
  pipe,
  range,
  resolveBackoff,
  retry,
  setNestedValue,
  sleep,
  sortBy,
  sumBy,
  ternaryFor,
  truncateUtf8,
  tryCatch,
  tryCatchAsync,
  unique,
  uniqueBy,
  unwrapResult,
  unwrapResultOr,
  uuidv4,
  uuidv7,
  zip,
} from "../../src/common";

describe("Type Guards", () => {
  it("accurately distinguishes primitives, objects, collections, and special instances", () => {
    expect(isUndefined(undefined)).toBe(true);
    expect(isNull(null)).toBe(true);
    expect(isNullish(null)).toBe(true);
    expect(isNullish(undefined)).toBe(true);
    expect(isNullish(0)).toBe(false);
    expect([1, null, 2, undefined, 3].filter(isDefined)).toEqual([1, 2, 3]);

    expect(isString("hi")).toBe(true);
    expect(isNonEmptyString("  hi  ")).toBe(true);
    expect(isNonEmptyString("   ")).toBe(false);
    expect(isNonEmptyString("   ", false)).toBe(true);

    expect(isNumber(42)).toBe(true);
    expect(isNumber(Number.NaN)).toBe(false);
    expect(isFiniteNumber(Infinity)).toBe(false);
    expect(isFiniteNumber(3.14)).toBe(true);
    expect(isInteger(10)).toBe(true);
    expect(isInteger(10.5)).toBe(false);

    expect(isBoolean(false)).toBe(true);
    expect(isBigInt(1n)).toBe(true);
    expect(isSymbol(Symbol("x"))).toBe(true);
    expect(isPrimitive(null)).toBe(true);
    expect(isPrimitive({})).toBe(false);
    expect(isFunction(() => 1)).toBe(true);

    expect(isObject({})).toBe(true);
    expect(isObject([])).toBe(false);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject(new Date())).toBe(false);

    expect(isArray([1])).toBe(true);
    expect(isNonEmptyArray([1])).toBe(true);
    expect(isNonEmptyArray([])).toBe(false);
    expect(isDate(new Date())).toBe(true);
    expect(isValidDate(new Date("invalid"))).toBe(false);
    expect(isRegExp(/abc/)).toBe(true);
    expect(isError(new Error("boom"))).toBe(true);
    expect(isPromiseLike(Promise.resolve(1))).toBe(true);
    expect(isPromiseLike({ then: () => {} })).toBe(true);
    expect(isMap(new Map())).toBe(true);
    expect(isSet(new Set())).toBe(true);
    expect(hasOwn({ a: 1 }, "a")).toBe(true);
    expect(hasOwn({ a: 1 }, "toString")).toBe(false);
  });

  it("handles multi-value nullish helpers, isInstanceof, isTypeof, not, and, or, include, isOneOf, isEqual, and curried pick/omit", () => {
    // Replaces `a === null || b === null || a === undefined || b === undefined`
    expect(isAnyNullish(1, null)).toBe(true);
    expect(isAnyNullish(undefined, "x")).toBe(true);
    expect(isAnyNullish(1, "x", 0, false)).toBe(false);
    expect(isAllNullish(null, undefined)).toBe(true);
    expect(isAllNullish(null, 0)).toBe(false);
    expect(isAllDefined(1, "a", false)).toBe(true);
    expect(isAllDefined(1, undefined)).toBe(false);
    expect(isAnyNull(1, null)).toBe(true);
    expect(isAnyNull(1, undefined)).toBe(false);
    expect(isAnyUndefined(1, undefined)).toBe(true);
    expect(isNotNull(0)).toBe(true);
    expect(isNotUndefined(null)).toBe(true);

    // isInstanceof (direct & curried)
    const now = new Date();
    expect(isInstanceof(now, Date)).toBe(true);
    expect(isInstanceof(undefined, Date)).toBe(false);
    expect([now, "nope", new Date()].filter(isInstanceof(Date)).length).toBe(2);

    // isTypeof (direct & curried, single & array of tags)
    expect(isTypeof("hello", "string")).toBe(true);
    expect(isTypeof(undefined, "undefined")).toBe(true);
    expect(isTypeof(42, ["string", "number"] as const)).toBe(true);
    expect(isTypeof(true, ["string", "number"] as const)).toBe(false);
    expect(["a", 1, true, "b"].filter(isTypeof("string"))).toEqual(["a", "b"]);
    expect(
      ["a", 1, true, 2n].filter(isTypeof(["number", "bigint"] as const)),
    ).toEqual([1, 2n]);

    // Composable with ternaryFor (e.g. query-matcher $type check)
    const detectType = (val: unknown): string =>
      ternaryFor(val)
        .when(isNull, "null")
        .when(isArray, "array")
        .when(isInstanceof(Date), "date")
        .when(isInstanceof(RegExp), "regexp")
        .elseEval((v) => typeof v);
    expect(detectType(null)).toBe("null");
    expect(detectType([1])).toBe("array");
    expect(detectType(new Date())).toBe("date");
    expect(detectType(/a/)).toBe("regexp");
    expect(detectType("abc")).toBe("string");

    // not, and, or
    expect(not(true)).toBe(false);
    expect(not(false)).toBe(true);
    expect([1, null, 2, null].filter(not(isNull))).toEqual([1, 2]);
    expect([1, undefined, 2].filter(not(isUndefined))).toEqual([1, 2]);
    const isNullOrUndef = or(isNull, isUndefined);
    expect(isNullOrUndef(null)).toBe(true);
    expect(isNullOrUndef(undefined)).toBe(true);
    expect(isNullOrUndef(0)).toBe(false);
    const isPositiveEven = and(
      (n: number) => n > 0,
      (n: number) => n % 2 === 0,
    );
    expect(isPositiveEven(4)).toBe(true);
    expect(isPositiveEven(-4)).toBe(false);

    // include (string, Array, Set, Map, object, and curried)
    expect(include("bunest framework", "bunest")).toBe(true);
    expect(include(["asc", "desc"] as const, "desc")).toBe(true);
    expect(include(new Set([1, 2, 3]), 2)).toBe(true);
    expect(include(new Map([["k", 1]]), "k")).toBe(true);
    expect(include({ a: 1, b: 2 }, "a")).toBe(true);
    expect(include({ a: 1 }, "toString")).toBe(false);
    expect(["foo", "bar", "foobar"].filter(include("foo"))).toEqual([
      "foo",
      "foobar",
    ]);

    // isOneOf & isEqual
    const isSortDir = isOneOf(["asc", "desc"] as const);
    expect(isSortDir("asc")).toBe(true);
    expect(isSortDir("up")).toBe(false);
    expect(isOneOf(["a", "b"] as const, "b")).toBe(true);
    expect(isEqual(Number.NaN, Number.NaN)).toBe(true);
    expect([1, 2, 1, 3].filter(isEqual(1))).toEqual([1, 1]);

    // Curried pick / omit in pipe & map
    const users = [
      { id: 1, name: "Alice", secret: "x" },
      { id: 2, name: "Bob", secret: "y" },
    ];
    expect(users.map(pick(["id", "name"]))).toEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
    expect(users.map(omit(["secret"]))).toEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
    expect(pipe(users[0]!, omit(["secret"]), pick(["name"]))).toEqual({
      name: "Alice",
    });
  });
});

describe("Object & Nested Path Utils", () => {
  it("deep-clones complex graphs including circular references, Map, Set, Date, RegExp, and Uint8Array", () => {
    const original: Record<string, unknown> = {
      date: new Date("2026-06-01T00:00:00Z"),
      regex: /bunest/gi,
      bytes: new Uint8Array([1, 2, 3]),
      map: new Map([["k", { nested: true }]]),
      set: new Set([1, 2]),
      arr: [{ x: 1 }],
    };
    original.self = original;

    const cloned = deepClone(original);
    expect(cloned).not.toBe(original);
    expect(cloned.self).toBe(cloned);
    expect(cloned.date).toEqual(original.date);
    expect(cloned.date).not.toBe(original.date);
    expect(cloned.regex).toEqual(original.regex);
    expect(cloned.bytes).toEqual(original.bytes);
    expect(cloned.bytes).not.toBe(original.bytes);
    expect(deepEqual(cloned, original)).toBe(true);
  });

  it("deepEqual handles NaN, Dates, RegExps, Maps, Sets, and circular objects", () => {
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(
      deepEqual(
        { a: [1, 2], b: new Set([3, 4]) },
        { a: [1, 2], b: new Set([4, 3]) },
      ),
    ).toBe(true);
    expect(
      deepEqual(new Map([[{ id: 1 }, "x"]]), new Map([[{ id: 1 }, "x"]])),
    ).toBe(true);
    expect(deepEqual(/abc/i, /abc/g)).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });

  it("deepMerge merges nested objects immutably and blocks prototype pollution", () => {
    const merged = deepMerge<{ a: { x: number; y: number }; arr: number[] }>(
      { a: { x: 1, y: 2 }, arr: [1, 2] },
      { a: { y: 99 }, arr: [3] } as Record<string, unknown>,
      JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>,
    );

    expect(merged).toEqual({ a: { x: 1, y: 99 }, arr: [3] });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("reads, writes, checks, and deletes nested paths safely", () => {
    const doc: Record<string, unknown> = {
      user: {
        name: "Alice",
        tags: [{ key: "a" }, { key: "b" }],
        empty: undefined,
      },
    };

    expect(getNestedValue(doc, "user.name")).toBe("Alice");
    expect(getNestedValue(doc, "user.tags.key")).toEqual(["a", "b"]);
    expect(getNestedValue(doc, "user.tags.1.key")).toBe("b");
    expect(hasNestedValue(doc, "user.empty")).toBe(true);
    expect(hasNestedValue(doc, "user.missing")).toBe(false);

    expect(setNestedValue(doc, "user.profile.city", "Hanoi")).toBe(true);
    expect(getNestedValue(doc, "user.profile.city")).toBe("Hanoi");

    expect(setNestedValue(doc, "__proto__.hacked", true)).toBe(false);
    expect(deleteNestedValue(doc, "user.profile.city")).toBe(true);
    expect(hasNestedValue(doc, "user.profile.city")).toBe(false);
  });

  it("supports pick, omit, definedOnly, mapValues, filterObject, and isEmptyObject", () => {
    const obj = { a: 1, b: 2, c: undefined as number | undefined };
    expect(pick(obj, ["a", "b"])).toEqual({ a: 1, b: 2 });
    expect(omit(obj, ["c"])).toEqual({ a: 1, b: 2 });
    expect(definedOnly(obj)).toEqual({ a: 1, b: 2 });
    expect(mapValues({ a: 2, b: 3 }, (v) => v * 10)).toEqual({ a: 20, b: 30 });
    expect(filterObject({ a: 1, b: 5, c: 2 }, (v) => v >= 2)).toEqual({
      b: 5,
      c: 2,
    });
    expect(isEmptyObject({})).toBe(true);
    expect(isEmptyObject({ a: 1 })).toBe(false);
  });
});

describe("Collection Utils", () => {
  it("transforms arrays immutably", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => chunk([1], 0)).toThrow(RangeError);

    const items = [
      { id: 1, role: "admin" },
      { id: 2, role: "user" },
      { id: 3, role: "admin" },
    ];
    expect(groupBy(items, (x) => x.role)).toEqual({
      admin: [
        { id: 1, role: "admin" },
        { id: 3, role: "admin" },
      ],
      user: [{ id: 2, role: "user" }],
    });
    expect(indexBy(items, (x) => x.id)).toEqual({
      1: { id: 1, role: "admin" },
      2: { id: 2, role: "user" },
      3: { id: 3, role: "admin" },
    });
    expect(countBy(items, (x) => x.role)).toEqual({ admin: 2, user: 1 });

    expect(unique([1, 2, 1, 3, 2])).toEqual([1, 2, 3]);
    expect(uniqueBy(items, (x) => x.role).map((x) => x.id)).toEqual([1, 2]);
    expect(partition([1, 2, 3, 4], (n) => n % 2 === 0)).toEqual([
      [2, 4],
      [1, 3],
    ]);
    expect(compact([1, null, 2, undefined, 0, ""])).toEqual([1, 2, 0, ""]);
    expect(sortBy([3, 1, 2], (n) => n, "desc")).toEqual([3, 2, 1]);
    expect(range(4)).toEqual([0, 1, 2, 3]);
    expect(range(2, 8, 2)).toEqual([2, 4, 6]);
    expect(range(3, 0, -1)).toEqual([3, 2, 1]);
    expect(zip(["a", "b"], [1, 2, 3])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(sumBy([{ v: 10 }, { v: 25 }], (x) => x.v)).toBe(35);
  });
});

describe("Functional & Result Utils", () => {
  it("supports pipe, flow, once, memoize, identity, noop, invariant, assertNever", () => {
    expect(identity("x")).toBe("x");
    expect(noop()).toBeUndefined();

    const piped = pipe(
      "  bunest  ",
      (s) => s.trim(),
      (s) => s.toUpperCase(),
      (s) => `${s}!`,
    );
    expect(piped).toBe("BUNEST!");

    const compute = flow(
      (a: number, b: number) => a + b,
      (n) => n * 2,
      (n) => `val=${n}`,
    );
    expect(compute(3, 4)).toBe("val=14");

    let count = 0;
    const init = once(() => ++count);
    expect(init()).toBe(1);
    expect(init()).toBe(1);
    expect(count).toBe(1);

    let memoCalls = 0;
    const square = memoize(
      (n: number) => {
        memoCalls++;
        return n * n;
      },
      { maxSize: 2 },
    );
    expect(square(2)).toBe(4);
    expect(square(2)).toBe(4);
    expect(square(3)).toBe(9);
    expect(square(4)).toBe(16); // evicts 2
    expect(square.size).toBe(2);
    expect(memoCalls).toBe(3);

    expect(() => invariant(false, "must be true")).toThrow("must be true");
    expect(() => assertNever("oops" as never)).toThrow();
  });

  it("supports Result<T, E>, tryCatch, tryCatchAsync, and ensureError", async () => {
    const r1 = ok(10);
    const r2 = err("bad");
    expect(isOk(r1)).toBe(true);
    expect(isErr(r2)).toBe(true);
    expect(unwrapResult(r1)).toBe(10);
    expect(() => unwrapResult(r2)).toThrow();
    expect(unwrapResultOr(r2, (e) => e.length)).toBe(3);

    const chained = flatMapResult(
      mapResult(r1, (n) => n * 2),
      (n) => (n > 15 ? ok(n) : err("too small")),
    );
    expect(
      matchResult(chained, {
        ok: (v) => `ok:${v}`,
        err: (e) => `err:${e}`,
      }),
    ).toBe("ok:20");
    expect(mapResultErr(r2, (e) => e.toUpperCase())).toEqual({
      ok: false,
      error: "BAD",
    });

    const syncFail = tryCatch(() => {
      throw "string-boom";
    });
    expect(isErr(syncFail)).toBe(true);
    if (isErr(syncFail)) {
      expect(syncFail.error).toBeInstanceOf(Error);
      expect(syncFail.error.message).toBe("string-boom");
    }

    const asyncOk = await tryCatchAsync(async () => Promise.resolve("done"));
    expect(asyncOk).toEqual({ ok: true, value: "done" });
    expect(ensureError({ code: 500 })).toBeInstanceOf(Error);
  });
});

describe("Shared Runtime Utils (Duration, Retry, Error, UUID)", () => {
  it("parses, validates, and formats durations", () => {
    expect(isDuration("15m")).toBe(true);
    expect(isDuration(-5)).toBe(false);
    expect(parseDuration(250)).toBe(250);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("1.5m")).toBe(90_000);
    expect(parseDuration("1w")).toBe(604_800_000);
    expect(() => parseDuration(-1)).toThrow(TypeError);
    expect(() => parseDuration("5y" as never)).toThrow(TypeError);

    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(250)).toBe("250ms");
    expect(formatDuration(1_500)).toBe("1.5s");
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(90_000)).toBe("90s");
    expect(formatDuration(90_500)).toBe("1.51m");
  });

  it("resolves backoff, retries with jitter, and respects AbortSignal", async () => {
    const resolved = resolveBackoff({
      delay: "100ms",
      factor: 2,
      maxDelay: "500ms",
      jitter: "none",
    });
    expect(computeBackoffDelay(resolved, 1)).toBe(100);
    expect(computeBackoffDelay(resolved, 2)).toBe(200);
    expect(computeBackoffDelay(resolved, 4)).toBe(500);

    const now = Date.parse("Tue, 22 Sep 2026 12:00:00 GMT");
    expect(parseRetryAfter("12", now)).toBe(12_000);
    expect(parseRetryAfter("Tue, 22 Sep 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Tue, 22 Sep 2026 11:59:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("1.5", now)).toBeUndefined();
    expect(parseRetryAfter("not-a-date", now)).toBeUndefined();
    expect(parseRetryAfter(undefined, now)).toBeUndefined();

    let attempts = 0;
    const value = await retry(
      (attempt) => {
        attempts = attempt;
        if (attempt < 3) {
          throw new Error("transient");
        }
        return "recovered";
      },
      {
        attempts: 4,
        backoff: { delay: 1, factor: 1, jitter: "none" },
      },
    );
    expect(value).toBe("recovered");
    expect(attempts).toBe(3);

    const ac = new AbortController();
    ac.abort(new Error("cancelled"));
    await expect(sleep("10s", ac.signal)).rejects.toThrow("cancelled");
  });

  it("describes errors/values safely and truncates UTF-8 without splitting multibyte chars", () => {
    expect(describeError(new TypeError("bad\u0000input"))).toBe(
      "TypeError: bad\uFFFDinput",
    );
    expect(
      describeError(new AggregateError([new Error("e1"), "e2"], "multi")),
    ).toBe("AggregateError: multi [Error: e1; e2]");
    expect(describeValue("false")).toBe('the string "false"');
    expect(describeValue(null)).toBe("null");
    expect(describeValue([1, 2])).toBe("an array");

    // Emoji "🚀" is 4 UTF-8 bytes; ellipsis "…" is 3 bytes
    const truncated = truncateUtf8("hi 🚀🚀", 10);
    expect(new TextEncoder().encode(truncated).byteLength).toBeLessThanOrEqual(
      10,
    );
    expect(truncated.isWellFormed()).toBe(true);
    expect(truncated.endsWith("\u2026")).toBe(true);
  });

  it("generates monotonic RFC 9562 UUIDv7 and valid UUIDv4", () => {
    const ids = Array.from({ length: 50 }, () => uuidv7());
    for (let i = 0; i < ids.length; i++) {
      expect(isValidUuid(ids[i], 7)).toBe(true);
      if (i > 0) {
        expect(ids[i]! > ids[i - 1]!).toBe(true);
      }
    }
    const id4 = uuidv4();
    expect(isValidUuid(id4, 4)).toBe(true);
    expect(isValidUuid("not-a-uuid")).toBe(false);
  });
});
