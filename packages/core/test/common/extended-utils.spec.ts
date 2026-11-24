import { describe, expect, it } from "bun:test";
import {
  TimeoutError,
  allSettledPartition,
  average,
  camelCase,
  capitalize,
  clamp,
  debounce,
  deepFreeze,
  deferred,
  difference,
  ensurePrefix,
  ensureSuffix,
  entriesOf,
  escapeRegExp,
  first,
  flatMapOption,
  flattenObject,
  fromNullable,
  inRange,
  intersection,
  invertObject,
  isEmpty,
  isNone,
  isNotEmpty,
  isSome,
  kebabCase,
  keysOf,
  last,
  mapLimit,
  mapOption,
  maskSecret,
  maxBy,
  minBy,
  none,
  parseJsonOr,
  pascalCase,
  pipe,
  pollUntil,
  roundTo,
  safeDivide,
  safeJsonParse,
  safeJsonStringify,
  sleep,
  slugify,
  snakeCase,
  some,
  splitOnce,
  stableStringify,
  sum,
  tap,
  throttle,
  toArray,
  toInt,
  toNumber,
  trimPrefix,
  trimSuffix,
  truncate,
  uncapitalize,
  unflattenObject,
  unwrapOptionOr,
  valuesOf,
  withTimeout,
} from "../../src/common";

describe("String Utils", () => {
  it("converts cases, slugifies Vietnamese text, trims/ensures affixes, splits, escapes, and masks secrets", () => {
    expect(capitalize("bunest")).toBe("Bunest");
    expect(uncapitalize("Bunest")).toBe("bunest");
    expect(camelCase("hello_world-foo bar")).toBe("helloWorldFooBar");
    expect(pascalCase("user_profile-dto")).toBe("UserProfileDto");
    expect(snakeCase("HTTPRequestHandler")).toBe("http_request_handler");
    expect(kebabCase("parseSortSpec")).toBe("parse-sort-spec");
    expect(slugify("Xin chào Đà Nẵng 2026!")).toBe("xin-chao-da-nang-2026");

    expect(truncate("hello world", 8)).toBe("hello w\u2026");
    expect(truncate("hi", 5)).toBe("hi");
    expect(trimPrefix("Bearer token", "Bearer ")).toBe("token");
    expect(trimSuffix("index.spec.ts", ".spec.ts")).toBe("index");
    expect(ensurePrefix("users", "/")).toBe("/users");
    expect(ensurePrefix("/users", "/")).toBe("/users");
    expect(ensureSuffix("api", "/")).toBe("api/");
    expect(splitOnce("key=val=extra", "=")).toEqual(["key", "val=extra"]);
    expect(splitOnce("plain", "=")).toEqual(["plain", undefined]);
    expect(escapeRegExp("a.b+c?")).toBe("a\\.b\\+c\\?");
    expect(maskSecret("sk_live_1234567890", 3, 4)).toBe("sk_***********7890");
    expect(maskSecret("short", 3, 4)).toBe("*****");
  });
});

describe("Number & Math Utils", () => {
  it("clamps, checks ranges, rounds, safely converts, divides, and computes aggregates", () => {
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(inRange(5, 1, 10)).toBe(true);
    expect(inRange(10, 1, 10, false)).toBe(false);
    expect(roundTo(3.14159, 2)).toBe(3.14);
    expect(toNumber("42.5")).toBe(42.5);
    expect(toNumber("  ", 99)).toBe(99);
    expect(toNumber(null, 0)).toBe(0);
    expect(toInt("19.9")).toBe(19);
    expect(toInt("abc", -1)).toBe(-1);
    expect(safeDivide(10, 0, -1)).toBe(-1);
    expect(safeDivide(10, 4)).toBe(2.5);
    expect(sum([1, 2, 3, 4])).toBe(10);
    expect(average([2, 4, 6])).toBe(4);
    expect(average([])).toBe(0);
    expect(minBy([{ k: "a", v: 5 }, { k: "b", v: 2 }], (x) => x.v)?.k).toBe("b");
    expect(maxBy([{ k: "a", v: 5 }, { k: "b", v: 2 }], (x) => x.v)?.k).toBe("a");
  });
});

describe("Async & Concurrency Utils", () => {
  it("supports deferred, withTimeout, mapLimit, allSettledPartition, debounce, throttle, and pollUntil", async () => {
    const d = deferred<string>();
    d.resolve("ok");
    expect(await d.promise).toBe("ok");

    await expect(
      withTimeout(new Promise(() => {}), 15, "too slow"),
    ).rejects.toThrow("too slow");
    expect(new TimeoutError(10).timeoutMs).toBe(10);

    let active = 0;
    let maxActive = 0;
    const mapped = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(5);
      active--;
      return n * 10;
    });
    expect(mapped).toEqual([10, 20, 30, 40, 50]);
    expect(maxActive).toBeLessThanOrEqual(2);

    const settled = await allSettledPartition([
      Promise.resolve(1),
      Promise.reject("bad"),
      Promise.resolve(2),
    ]);
    expect(settled).toEqual({ fulfilled: [1, 2], rejected: ["bad"] });

    // debounce + flush
    const debouncedCalls: number[] = [];
    const fn = debounce((x: number) => debouncedCalls.push(x), 50);
    fn(1);
    fn(2);
    fn.flush();
    expect(debouncedCalls).toEqual([2]);

    // throttle leading + cancel
    const throttledCalls: number[] = [];
    const tfn = throttle((x: number) => throttledCalls.push(x), 50);
    tfn(1);
    tfn(2);
    tfn.cancel();
    expect(throttledCalls).toEqual([1]);

    // pollUntil
    let tick = 0;
    const ready = await pollUntil(
      () => ++tick,
      (v) => v >= 3,
      { interval: 2, timeout: 500 },
    );
    expect(ready).toBe(3);
  });
});

describe("JSON, Option, Collection & Object Additions", () => {
  it("handles safeJsonParse, safeJsonStringify (BigInt + circular), stableStringify, Option, tap, and extra collection/object utils", () => {
    expect(safeJsonParse<{ a: number }>('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(safeJsonParse("{bad").ok).toBe(false);
    expect(parseJsonOr("{bad", { fallback: true })).toEqual({ fallback: true });

    const cyclic: Record<string, unknown> = { id: 1n };
    cyclic.self = cyclic;
    const str = safeJsonStringify(cyclic);
    expect(str.ok).toBe(true);
    if (str.ok) {
      expect(JSON.parse(str.value)).toEqual({ id: "1", self: "[Circular]" });
    }

    expect(stableStringify({ b: 2, a: { d: 4, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 4 }, b: 2 }),
    );

    // Option<T> + tap
    const opt = flatMapOption(
      mapOption(fromNullable("bunest"), (s) => s.toUpperCase()),
      (s) => (s.length > 0 ? some(s) : none()),
    );
    expect(isSome(opt)).toBe(true);
    expect(unwrapOptionOr(opt, "none")).toBe("BUNEST");
    expect(isNone(fromNullable(null))).toBe(true);
    expect(unwrapOptionOr(none(), () => "lazy")).toBe("lazy");

    let tapped = 0;
    expect(pipe(5, tap((n) => { tapped = n; }), (n) => n * 2)).toBe(10);
    expect(tapped).toBe(5);

    // Collection & Object additions
    expect(toArray(null)).toEqual([]);
    expect(toArray(42)).toEqual([42]);
    expect(toArray([1, 2])).toEqual([1, 2]);
    expect(first([10, 20])).toBe(10);
    expect(last([10, 20])).toBe(20);
    expect(difference([1, 2, 3, 4], [2, 4])).toEqual([1, 3]);
    expect(intersection([1, 2, 3, 2], [2, 3, 5])).toEqual([2, 3]);
    expect(isEmpty("")).toBe(true);
    expect(isEmpty([])).toBe(true);
    expect(isEmpty({})).toBe(true);
    expect(isEmpty(new Map())).toBe(true);
    expect(isNotEmpty([1])).toBe(true);

    expect(keysOf({ a: 1, b: 2 })).toEqual(["a", "b"]);
    expect(valuesOf({ a: 1, b: 2 })).toEqual([1, 2]);
    expect(entriesOf({ a: 1 })).toEqual([["a", 1]]);
    expect(invertObject({ a: "1", b: "2" })).toEqual({ 1: "a", 2: "b" });
    expect(flattenObject({ a: { b: { c: 1 } }, d: 2 })).toEqual({
      "a.b.c": 1,
      d: 2,
    });
    expect(unflattenObject({ "a.b.c": 1, d: 2 })).toEqual({
      a: { b: { c: 1 } },
      d: 2,
    });

    const frozen = deepFreeze({ nested: { x: 1 } });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.nested)).toBe(true);
  });
});
