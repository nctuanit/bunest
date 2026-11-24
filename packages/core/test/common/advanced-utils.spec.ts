import { describe, expect, it } from "bun:test";
import {
  BatchLoader,
  BiMap,
  EnvError,
  LruCache,
  MultiMap,
  Mutex,
  PriorityQueue,
  RingBuffer,
  Semaphore,
  Singleflight,
  addDuration,
  applyPatch,
  base64UrlDecode,
  base64UrlEncode,
  batchAsync,
  buildQueryString,
  coalesceAsync,
  collectAsync,
  compareAsc,
  compareBy,
  compareDesc,
  composeComparators,
  createFakeClock,
  diffMs,
  diffObjects,
  endOfDay,
  envBool,
  envDuration,
  envEnum,
  envJson,
  envList,
  envNumber,
  envString,
  filterAsync,
  fromArrayAsync,
  fromUnixSeconds,
  hmacSha256,
  isBetween,
  isExpired,
  isGt,
  isGte,
  isLt,
  isLte,
  isSafeUrl,
  isSameDay,
  joinUrl,
  mapAsync,
  mergeAsyncIterables,
  normalizeHeaders,
  normalizePath,
  parseQueryString,
  randomHex,
  randomToken,
  redactFields,
  reverseComparator,
  sha256,
  sleep,
  startOfDay,
  subDuration,
  systemClock,
  takeAsync,
  timingSafeEqualStr,
  toUnixSeconds,
  type Brand,
  type DeepPartial,
  type PathOf,
  type PathValue,
  type RequireAtLeastOne,
  type RequireOnlyOne,
  type StrictOmit,
} from "../../src/common";

describe("1. Comparison & Ordering Utils", () => {
  it("supports multi-key sorting and direct/curried predicates", () => {
    const rows = [
      { dept: "eng", salary: 100 },
      { dept: "ops", salary: 120 },
      { dept: "eng", salary: 150 },
    ];
    const cmp = composeComparators(
      compareBy<(typeof rows)[number]>((r) => r.dept, "asc"),
      compareBy<(typeof rows)[number]>((r) => r.salary, "desc"),
    );
    expect([...rows].sort(cmp)).toEqual([
      { dept: "eng", salary: 150 },
      { dept: "eng", salary: 100 },
      { dept: "ops", salary: 120 },
    ]);

    expect(reverseComparator(compareAsc)(1, 2)).toBe(1);
    expect(compareDesc(1, 2)).toBe(1);
    expect(isGt(5, 3)).toBe(true);
    expect([1, 5, 10].filter(isGte(5))).toEqual([5, 10]);
    expect([1, 5, 10].filter(isLt(5))).toEqual([1]);
    expect(isLte(5, 5)).toBe(true);
    expect(isBetween(5, 1, 10)).toBe(true);
    expect(isBetween(10, 1, 10, false)).toBe(false);
    expect([0, 3, 7, 12].filter(isBetween(1, 10))).toEqual([3, 7]);
  });
});

describe("2. Crypto & Security Utils", () => {
  it("hashes, signs HMAC, compares timing-safely, generates tokens, and base64url encodes/decodes", () => {
    expect(sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256("bunest")).toBe(
      "43d87af085bbe29bba7aa7aa613c13f40b269a9a527e446563645e2fa199abf7",
    );
    const sig1 = hmacSha256("secret", "payload");
    const sig2 = hmacSha256("secret", "payload");
    const sig3 = hmacSha256("other", "payload");
    expect(timingSafeEqualStr(sig1, sig2)).toBe(true);
    expect(timingSafeEqualStr(sig1, sig3)).toBe(false);
    expect(timingSafeEqualStr("short", "much-longer")).toBe(false);

    expect(randomHex(16).length).toBe(32);
    expect(randomToken(24).length).toBeGreaterThan(20);

    const encoded = base64UrlEncode("Xin chào Bunest +/=");
    expect(encoded.includes("+")).toBe(false);
    expect(encoded.includes("/")).toBe(false);
    expect(encoded.includes("=")).toBe(false);
    expect(base64UrlDecode(encoded)).toBe("Xin chào Bunest +/=");
  });
});

describe("3. URL & HTTP Query Utils", () => {
  it("normalizes paths, joins URLs, builds/parses query strings, validates safe URLs, and normalizes headers", () => {
    expect(normalizePath("//api///v1/users/")).toBe("/api/v1/users");
    expect(normalizePath("/")).toBe("/");
    expect(joinUrl("https://api.bunest.dev/", "/v1/", "users", "?active=1")).toBe(
      "https://api.bunest.dev/v1/users/?active=1",
    );

    const qs = buildQueryString({
      q: "bunest",
      tag: ["a", "b"],
      skip: undefined,
      empty: null,
      page: 2,
    });
    expect(qs).toBe("q=bunest&tag=a&tag=b&page=2");
    expect(parseQueryString(`?${qs}`)).toEqual({
      q: "bunest",
      tag: ["a", "b"],
      page: "2",
    });

    expect(isSafeUrl("https://bunest.dev/docs")).toBe(true);
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("data:text/html,hi")).toBe(false);
    expect(isSafeUrl("not-a-url")).toBe(false);

    expect(
      normalizeHeaders({
        "Content-Type": "application/json",
        "X-Retry": 3,
        "X-Tags": ["a", "b"],
        "X-Empty": undefined,
      }),
    ).toEqual({
      "content-type": "application/json",
      "x-retry": "3",
      "x-tags": "a, b",
    });
  });
});

describe("4. Environment & Config Utils", () => {
  it("reads typed env vars with defaults and throws descriptive EnvError on bad/missing inputs", () => {
    const env = {
      APP_NAME: "  bunest  ",
      PORT: "3000",
      DEBUG: "yes",
      DISABLED: "0",
      NODE_ENV: "production",
      ORIGINS: "https://a.com, https://b.com , ",
      TIMEOUT: "15s",
      META: '{"region":"ap-southeast-1"}',
      BAD_NUM: "abc",
    };

    expect(envString("APP_NAME", undefined, env)).toBe("bunest");
    expect(envString("MISSING", "fallback", env)).toBe("fallback");
    expect(() => envString("MISSING", undefined, env)).toThrow(EnvError);

    expect(envNumber("PORT", undefined, env)).toBe(3000);
    expect(() => envNumber("BAD_NUM", undefined, env)).toThrow(EnvError);

    expect(envBool("DEBUG", undefined, env)).toBe(true);
    expect(envBool("DISABLED", undefined, env)).toBe(false);
    expect(envBool("MISSING_BOOL", true, env)).toBe(true);

    expect(
      envEnum("NODE_ENV", ["development", "production"] as const, undefined, env),
    ).toBe("production");
    expect(() =>
      envEnum("NODE_ENV", ["staging"] as const, undefined, env),
    ).toThrow(EnvError);

    expect(envList("ORIGINS", undefined, ",", env)).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
    expect(envDuration("TIMEOUT", undefined, env)).toBe(15_000);
    expect(envJson<{ region: string }>("META", undefined, env)).toEqual({
      region: "ap-southeast-1",
    });
  });
});

describe("5. Concurrency Primitives", () => {
  it("enforces Semaphore, Mutex, Singleflight/coalesceAsync, and BatchLoader", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      [1, 2, 3, 4].map(() =>
        sem.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await sleep(5);
          active--;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(sem.availablePermits).toBe(2);

    const mutex = new Mutex();
    const order: number[] = [];
    await Promise.all([
      mutex.run(async () => {
        order.push(1);
        await sleep(5);
        order.push(2);
      }),
      mutex.run(async () => {
        order.push(3);
      }),
    ]);
    expect(order).toEqual([1, 2, 3]);

    // Singleflight / coalesceAsync
    let calls = 0;
    const sf = new Singleflight<string>();
    const [r1, r2] = await Promise.all([
      sf.run("k", async () => {
        calls++;
        await sleep(5);
        return "shared";
      }),
      sf.run("k", async () => {
        calls++;
        return "duplicate";
      }),
    ]);
    expect(r1).toBe("shared");
    expect(r2).toBe("shared");
    expect(calls).toBe(1);

    let loadCalls = 0;
    const loader = coalesceAsync(async (id: number) => {
      loadCalls++;
      await sleep(5);
      return id * 2;
    });
    expect(await Promise.all([loader(7), loader(7)])).toEqual([14, 14]);
    expect(loadCalls).toBe(1);

    // BatchLoader
    const batches: Array<readonly number[]> = [];
    const batcher = new BatchLoader<number, string>(async (keys) => {
      batches.push(keys);
      return keys.map((k) => `item-${k}`);
    });
    const res = await Promise.all([
      batcher.load(1),
      batcher.load(2),
      batcher.load(3),
    ]);
    expect(res).toEqual(["item-1", "item-2", "item-3"]);
    expect(batches).toEqual([[1, 2, 3]]);
  });
});

describe("6. Data Structures (LruCache, RingBuffer, BiMap, MultiMap, PriorityQueue)", () => {
  it("supports LRU eviction + TTL, fixed RingBuffer, BiMap, MultiMap, and PriorityQueue", () => {
    const clock = createFakeClock(1_000);
    const lru = new LruCache<string, number>({
      maxSize: 2,
      ttl: "1s",
      now: clock.now,
    });
    lru.set("a", 1).set("b", 2);
    expect(lru.get("a")).toBe(1); // refreshes "a", so "b" is LRU
    lru.set("c", 3); // evicts "b"
    expect(lru.has("b")).toBe(false);
    expect(lru.get("a")).toBe(1);
    clock.advance("1s");
    expect(lru.get("a")).toBeUndefined();
    expect(lru.size).toBe(0);

    const ring = new RingBuffer<number>(3);
    ring.push(1);
    ring.push(2);
    ring.push(3);
    expect(ring.push(4)).toBe(1); // evicted oldest
    expect(ring.toArray()).toEqual([2, 3, 4]);
    expect(ring.shift()).toBe(2);
    expect(ring.peek()).toBe(3);

    const bi = new BiMap<string, number>();
    bi.set("one", 1).set("two", 2);
    expect(bi.get("one")).toBe(1);
    expect(bi.getKey(2)).toBe("two");
    bi.set("uno", 1); // replaces "one"
    expect(bi.has("one")).toBe(false);
    expect(bi.getKey(1)).toBe("uno");

    const mm = new MultiMap<string, number>();
    mm.add("a", 1).add("a", 2).add("b", 3);
    expect(mm.get("a")).toEqual([1, 2]);
    expect(mm.size).toBe(3);
    expect(mm.deleteValue("a", 1)).toBe(true);
    expect(mm.get("a")).toEqual([2]);

    const pq = new PriorityQueue<number>();
    pq.push(5).push(1).push(3).push(2);
    expect([pq.pop(), pq.pop(), pq.pop(), pq.pop()]).toEqual([1, 2, 3, 5]);
  });
});

describe("7. Diff, Patch & Redaction Utils", () => {
  it("computes deep diffs, applies patches immutably, and redacts sensitive fields safely", () => {
    const before = { name: "Alice", meta: { age: 25, role: "user" }, old: 1 };
    const after = { name: "Alice", meta: { age: 26, role: "admin" }, extra: true };

    const patches = diffObjects(before, after);
    expect(applyPatch(before, patches)).toEqual(after);
    expect(before.meta.age).toBe(25); // immutable

    const payload = {
      user: "alice",
      password: "secret",
      headers: { Authorization: "Bearer xyz", "x-req-id": "123" },
      nested: [{ apiKey: "k1", ok: true }],
    };
    const redacted = redactFields(payload);
    expect(redacted).toEqual({
      user: "alice",
      password: "[REDACTED]",
      headers: { Authorization: "[REDACTED]", "x-req-id": "123" },
      nested: [{ apiKey: "[REDACTED]", ok: true }],
    });
    expect(payload.password).toBe("secret"); // original untouched
  });
});

describe("8. Date, Time & Clock Utils", () => {
  it("handles duration arithmetic, day boundaries, Unix seconds, and FakeClock", () => {
    const base = new Date("2026-06-15T10:30:00.000Z");
    expect(addDuration(base, "15m").toISOString()).toBe("2026-06-15T10:45:00.000Z");
    expect(subDuration(base, "30m").toISOString()).toBe("2026-06-15T10:00:00.000Z");
    expect(isExpired(subDuration(base, "1s"), base)).toBe(true);
    expect(isExpired(addDuration(base, "1s"), base)).toBe(false);
    expect(isSameDay(base, new Date("2026-06-15T23:59:59.000Z"))).toBe(true);
    expect(startOfDay(base).toISOString()).toBe("2026-06-15T00:00:00.000Z");
    expect(endOfDay(base).toISOString()).toBe("2026-06-15T23:59:59.999Z");

    const unix = toUnixSeconds(base);
    expect(fromUnixSeconds(unix).getTime()).toBe(base.getTime());
    expect(diffMs(addDuration(base, "2s"), base)).toBe(2_000);

    const clock = createFakeClock(base);
    clock.advance("1h");
    expect(clock.date().toISOString()).toBe("2026-06-15T11:30:00.000Z");
    expect(systemClock.now()).toBeGreaterThan(0);
  });
});

describe("9. Stream & AsyncIterable Utils", () => {
  it("maps, filters, batches, takes, collects, and merges AsyncIterables", async () => {
    const source = fromArrayAsync([1, 2, 3, 4, 5, 6]);
    const pipeline = takeAsync(
      batchAsync(
        mapAsync(
          filterAsync(source, (n) => n % 2 === 0),
          (n) => n * 10,
        ),
        2,
      ),
      2,
    );
    expect(await collectAsync(pipeline)).toEqual([[20, 40], [60]]);

    const merged = await collectAsync(
      mergeAsyncIterables(fromArrayAsync(["a", "b"]), fromArrayAsync(["c"])),
    );
    expect(merged.sort()).toEqual(["a", "b", "c"]);
  });
});

describe("10. Type-Level Utilities", () => {
  it("provides Brand, PathOf, PathValue, StrictOmit, DeepPartial, RequireAtLeastOne, RequireOnlyOne", () => {
    type UserId = Brand<string, "UserId">;
    const id = "u-1" as UserId;

    interface Profile {
      user: { name: string; address: { city: string } };
      age: number;
    }
    type ValidPath = PathOf<Profile>;
    const p1: ValidPath = "user.address.city";
    const city: PathValue<Profile, "user.address.city"> = "Da Nang";
    const partial: DeepPartial<Profile> = { user: { address: {} } };
    const omitted: StrictOmit<Profile, "age"> = {
      user: { name: "Alice", address: { city: "HN" } },
    };
    const atLeastOne: RequireAtLeastOne<{ a?: number; b?: string }> = { a: 1 };
    const onlyOne: RequireOnlyOne<{ email?: string; phone?: string }> = {
      email: "a@b.com",
    };

    expect(id).toBe("u-1" as UserId);
    expect(p1).toBe("user.address.city");
    expect(city).toBe("Da Nang");
    expect(partial.user?.address).toEqual({});
    expect(omitted.user.name).toBe("Alice");
    expect(atLeastOne.a).toBe(1);
    expect(onlyOne.email).toBe("a@b.com");
  });
});
