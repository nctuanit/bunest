import { describe, expect, it } from "bun:test";
import { NonExhaustiveError, P, isMatching, match } from "../../src/common";

type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "square"; side: number }
  | { kind: "rect"; width: number; height: number };

type ApiResponse =
  | { status: "ok"; data: { id: string; tags: string[] } }
  | { status: "error"; code: number; message: string }
  | { status: "loading" };

describe("Pattern Matching (ts-pattern style)", () => {
  it("matches discriminated unions exhaustively with full type narrowing", () => {
    const area = (shape: Shape): number =>
      match(shape)
        .with({ kind: "circle" }, (s) => Math.PI * s.radius * s.radius)
        .with({ kind: "square" }, (s) => s.side * s.side)
        .with({ kind: "rect" }, (s) => s.width * s.height)
        .exhaustive();

    expect(area({ kind: "circle", radius: 2 })).toBeCloseTo(Math.PI * 4);
    expect(area({ kind: "square", side: 5 })).toBe(25);
    expect(area({ kind: "rect", width: 3, height: 4 })).toBe(12);
  });

  it("short-circuits immediately after the first matching branch", () => {
    const calls: string[] = [];
    const result = match(10)
      .with(P.number.gt(5), () => {
        calls.push("first");
        return "gt5";
      })
      .when(
        () => {
          calls.push("second-predicate");
          return true;
        },
        () => {
          calls.push("second-handler");
          return "never";
        },
      )
      .otherwise(() => {
        calls.push("otherwise");
        return "fallback";
      });

    expect(result).toBe("gt5");
    expect(calls).toEqual(["first"]);
  });

  it("supports multiple OR patterns in a single .with() call and optional guards", () => {
    const parseSortDir = (
      dir: 1 | -1 | "asc" | "desc" | "ascending" | "descending",
    ): 1 | -1 =>
      match(dir)
        .with(-1, "desc", "descending", () => -1 as const)
        .with(1, "asc", "ascending", () => 1 as const)
        .exhaustive();

    expect(parseSortDir("desc")).toBe(-1);
    expect(parseSortDir("descending")).toBe(-1);
    expect(parseSortDir(-1)).toBe(-1);
    expect(parseSortDir("asc")).toBe(1);
    expect(parseSortDir(1)).toBe(1);

    const classify = (n: number): string =>
      match(n)
        .with(
          P.number,
          (v) => v % 2 === 0 && v > 0,
          () => "positive-even",
        )
        .with(
          P.number,
          (v) => v < 0,
          () => "negative",
        )
        .otherwise(() => "other");

    expect(classify(4)).toBe("positive-even");
    expect(classify(3)).toBe("other");
    expect(classify(-2)).toBe("negative");
  });

  it("supports chainable P.string, P.number, P.bigint, and P.array matchers immutably", () => {
    // Ensure chaining does not mutate base P.string / P.number
    const startsWithFoo = P.string.startsWith("foo");
    const endsWithBar = P.string.endsWith("bar");
    expect(isMatching(startsWithFoo, "foo123")).toBe(true);
    expect(isMatching(startsWithFoo, "bar")).toBe(false);
    expect(isMatching(endsWithBar, "foo123")).toBe(false);
    expect(isMatching(P.string, "anything")).toBe(true);

    const checkCode = (code: unknown): string =>
      match(code)
        .with(P.string.startsWith("ERR_").minLength(6), (s) => `error:${s}`)
        .with(P.string.regex(/^[A-Z]{3}-\d{2}$/), (s) => `code:${s}`)
        .with(P.number.int().between(200, 299), (n) => `ok:${n}`)
        .with(P.number.negative(), (n) => `neg:${n}`)
        .with(P.bigint.positive(), (b) => `big:${b}`)
        .with(P.NaN, () => "nan")
        .with(P.nullish, () => "empty")
        .default("unknown");

    expect(checkCode("ERR_AUTH")).toBe("error:ERR_AUTH");
    expect(checkCode("ABC-42")).toBe("code:ABC-42");
    expect(checkCode(204)).toBe("ok:204");
    expect(checkCode(204.5)).toBe("unknown");
    expect(checkCode(-7)).toBe("neg:-7");
    expect(checkCode(42n)).toBe("big:42");
    expect(checkCode(Number.NaN)).toBe("nan");
    expect(checkCode(null)).toBe("empty");
    expect(checkCode(undefined)).toBe("empty");
  });

  it("supports anonymous and named P.select() including nested arrays and optionals", () => {
    const res1: ApiResponse = {
      status: "ok",
      data: { id: "u-1", tags: ["admin", "core"] },
    };
    const res2: ApiResponse = {
      status: "error",
      code: 404,
      message: "Not found",
    };

    const handle = (res: ApiResponse): string =>
      match(res)
        .with(
          {
            status: "ok",
            data: { id: P.select("id"), tags: P.select("tags") },
          },
          ({ id, tags }) => `${id}:${tags.join(",")}`,
        )
        .with(
          { status: "error", message: P.select() },
          (msg, full) => `[${full.code}] ${msg}`,
        )
        .with({ status: "loading" }, () => "loading...")
        .exhaustive();

    expect(handle(res1)).toBe("u-1:admin,core");
    expect(handle(res2)).toBe("[404] Not found");
    expect(handle({ status: "loading" })).toBe("loading...");

    // Array selections (including empty array!)
    const extractIds = (rows: Array<{ id: number; active: boolean }>) =>
      match(rows)
        .with(P.array({ id: P.select("ids", P.number) }), ({ ids }) => ids)
        .otherwise(() => [] as number[]);

    expect(
      extractIds([
        { id: 1, active: true },
        { id: 2, active: false },
      ]),
    ).toEqual([1, 2]);
    expect(extractIds([])).toEqual([]);

    // Optional selection when key is missing
    const optRes = match({ name: "bunest" } as { name: string; alias?: string })
      .with(
        {
          name: P.select("name"),
          alias: P.optional(P.select("alias", P.string)),
        },
        ({ name, alias }) => `${name}|${alias ?? "none"}`,
      )
      .otherwise(() => "miss");
    expect(optRes).toBe("bunest|none");
  });

  it("supports P.instanceOf, P.not, P.union, P.intersection, P.record, P.set, P.map, P.eq, and tuples", () => {
    class CustomErr extends Error {
      constructor(
        public readonly code: number,
        msg: string,
      ) {
        super(msg);
      }
    }

    const inspect = (val: unknown): string =>
      match(val)
        .with(P.instanceOf(CustomErr), (e) => `custom:${e.code}`)
        .with(P.instanceOf(Date), (d) => `date:${d.getUTCFullYear()}`)
        .with([P.string, P.number], ([k, v]) => `tuple:${k}=${v}`)
        .with(P.array(P.number).nonEmpty(), (nums) => `nums:${nums.length}`)
        .with(P.set(P.string), (s) => `set:${s.size}`)
        .with(P.map(P.string, P.number), (m) => `map:${m.size}`)
        .with(P.record(P.boolean), (rec) => `flags:${Object.keys(rec).length}`)
        .default("other");

    expect(inspect(new CustomErr(418, "teapot"))).toBe("custom:418");
    expect(inspect(new Date("2026-01-01T00:00:00Z"))).toBe("date:2026");
    expect(inspect(["age", 30])).toBe("tuple:age=30");
    expect(inspect([1, 2, 3])).toBe("nums:3");
    expect(inspect(new Set(["a", "b"]))).toBe("set:2");
    expect(inspect(new Map([["x", 1]]))).toBe("map:1");
    expect(inspect({ a: true, b: false })).toBe("flags:2");

    // P.not, P.union, P.intersection, P.eq
    expect(
      match("b" as "a" | "b" | "c")
        .with(P.not("a"), (v) => `not-a:${v}`)
        .with("a", () => "is-a")
        .exhaustive(),
    ).toBe("not-a:b");

    expect(isMatching(P.union("ok", "pending"), "pending")).toBe(true);
    expect(
      isMatching(
        P.intersection(P.string.startsWith("a"), P.string.endsWith("z")),
        "abcz",
      ),
    ).toBe(true);
    expect(isMatching(P.eq({ nested: [1, 2] }), { nested: [1, 2] })).toBe(true);
  });

  it("supports .when() with type guards, .returnType<R>(), and throws NonExhaustiveError on .run()", () => {
    const isEven = (n: number): boolean => n % 2 === 0;
    const out = match(8)
      .returnType<string>()
      .when(isEven, (n) => `even:${n}`)
      .otherwise(() => "odd");
    expect(out).toBe("even:8");

    expect(() =>
      match("unhandled")
        .with("a", () => 1)
        .run(),
    ).toThrow(NonExhaustiveError);

    // Curried isMatching works cleanly with Array.prototype.filter
    const items: Array<{ type: string; value?: number }> = [
      { type: "num", value: 10 },
      { type: "str" },
      { type: "num", value: 25 },
    ];
    const matched = items.filter(
      isMatching({ type: "num", value: P.number.gt(15) }),
    );
    expect(matched).toEqual([{ type: "num", value: 25 }]);
  });

  it("narrows unknown optionals, nested shapes, and Set/Map exhaustively", () => {
    // P.optional on unknown narrows to T | undefined
    const optVal: unknown = undefined;
    const fromOpt = match(optVal)
      .with(P.optional(P.string), (v) => {
        const typed: string | undefined = v;
        return typed ?? "missing";
      })
      .default("other");
    expect(fromOpt).toBe("missing");

    // Nested P.shape / P.set / P.map / P.record on unknown unwraps to concrete types
    const structured: unknown = {
      tags: new Set(["a"]),
      counts: new Map([["a", 1]]),
      flags: { ok: true },
    };
    const summary = match(structured)
      .with(
        P.shape({
          tags: P.set(P.string),
          counts: P.map(P.string, P.number),
          flags: P.record(P.boolean),
        }),
        (v) => {
          const tags: Set<string> = v.tags;
          const counts: Map<string, number> = v.counts;
          const flags: Record<string, boolean> = v.flags;
          return `${tags.size}:${counts.get("a")}:${flags.ok}`;
        },
      )
      .default("none");
    expect(summary).toBe("1:1:true");

    // Exhaustive matching over Set and Map union members
    const describeContainer = (
      val: Set<string> | Map<string, number>,
    ): string =>
      match(val)
        .with(P.set(P.string), (s) => `set:${s.size}`)
        .with(P.map(P.string, P.number), (m) => `map:${m.size}`)
        .exhaustive();

    expect(describeContainer(new Set(["x"]))).toBe("set:1");
    expect(describeContainer(new Map([["x", 2]]))).toBe("map:1");
  });
});
