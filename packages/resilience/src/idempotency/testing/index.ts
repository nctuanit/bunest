/**
 * `@bunest/resilience/idempotency/testing`: the `IdempotencyStore` contract as runner-agnostic
 * test cases. Each case throws (`AssertionError`) on failure and uses random keys
 * so cases can safely share one store instance.
 */
import { strictAssert as assert } from "@bunest/core";
import type {
  IdempotencyAcquireResult,
  IdempotencyStore,
  IdempotencyStoredPayload,
  IdempotencyStoredResponse,
} from "../interfaces/idempotency-store.interface";

/** 30 days in ms: past a 32-bit integer (2,147,483,647). */
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
/** Node's maximum `setTimeout` delay, in ms: larger values clamp and fire almost immediately. */
const MAX_TIMER_DELAY = 2 ** 31 - 1;
/** The smallest lock ttl whose expiry margin (`lockTtl / 4`) is at least 1 ms. */
const MIN_LOCK_TTL = 4;
/**
 * The lock ttl and record ttl for the cases that aren't about expiry.
 */
const LONG_LOCK_TTL = 60 * 60 * 1000;
const LONG_RECORD_TTL = LONG_LOCK_TTL;

const response: IdempotencyStoredResponse = {
  status: 201,
  headers: {},
  body: { receiptId: "ch_0001" },
};

export interface IdempotencyStoreContractOptions {
  /**
   * Moves the clock the store reads forward by `ms`, for the expiry cases.
   * Default: wait in real time.
   */
  advanceTime?: (ms: number) => unknown;
  /**
   * The lock's time to live, in ms, used by the expiry cases: a record's ttl
   * is `3 * lockTtl` and each expiry margin is `lockTtl / 4`, rounded.
   * Must be an integer >= 4. Default: `600`.
   */
  lockTtl?: number;
  /**
   * Also run the concurrency cases: many callers race for one key (a free
   * one, an expired lock, an expired record) and exactly one may win, and
   * `acquire()` races `release()` and `complete()`. `true` uses 16 callers per race.
   */
  concurrent?: boolean | { callers?: number };
}

export interface IdempotencyStoreContractCase {
  name: string;
  run: () => Promise<void>;
}

/**
 * The `IdempotencyStore` contract as runner-agnostic cases. `createStore` is
 * called once per case; it may return the same store every time.
 */
export function idempotencyStoreContract(
  createStore: () => IdempotencyStore | Promise<IdempotencyStore>,
  options: IdempotencyStoreContractOptions = {},
): IdempotencyStoreContractCase[] {
  const advanceTime =
    options.advanceTime ?? ((ms: number) => Bun.sleep(ms));
  const advance = async (ms: number): Promise<void> => {
    await advanceTime(ms);
  };

  /** The lock's time to live, the margin around each expiry, and a record's time to live. */
  const LOCK_TTL = options.lockTtl ?? 600;
  if (!Number.isInteger(LOCK_TTL) || LOCK_TTL < MIN_LOCK_TTL) {
    throw new RangeError(
      `idempotencyStoreContract(): lockTtl must be an integer of at least ${MIN_LOCK_TTL}, got ${options.lockTtl}`,
    );
  }
  const MARGIN = Math.round(LOCK_TTL / 4);
  const RECORD_TTL = 3 * LOCK_TTL;
  if (RECORD_TTL + MARGIN >= THIRTY_DAYS) {
    throw new RangeError(
      `idempotencyStoreContract(): lockTtl must keep 3 * lockTtl + lockTtl / 4 under ${THIRTY_DAYS} ms (30 days), got ${options.lockTtl}`,
    );
  }
  const defaultClock = options.advanceTime === undefined;
  if (defaultClock && RECORD_TTL + MARGIN > MAX_TIMER_DELAY) {
    throw new RangeError(
      `idempotencyStoreContract(): lockTtl must keep 3 * lockTtl + lockTtl / 4 within Node's ${MAX_TIMER_DELAY} ms timer delay (or pass an advanceTime), got ${options.lockTtl}`,
    );
  }

  const callers =
    options.concurrent === true
      ? 16
      : options.concurrent
        ? (options.concurrent.callers ?? 16)
        : 0;
  if (options.concurrent && (!Number.isInteger(callers) || callers < 2)) {
    throw new RangeError(
      `idempotencyStoreContract(): concurrent.callers must be an integer of at least 2, got ${callers}`,
    );
  }

  const cases: IdempotencyStoreContractCase[] = [];

  /** A case gets a fresh store and a key prefix of its own. */
  const testCase = (
    name: string,
    body: (
      store: IdempotencyStore,
      key: (suffix: string) => string,
    ) => Promise<void>,
  ): void => {
    cases.push({
      name,
      run: async () => {
        const prefix = `contract-${crypto.randomUUID()}:`;
        await body(await createStore(), (suffix) => prefix + suffix);
      },
    });
  };

  testCase(
    "acquire() takes a free key, and later callers see the lock with its fingerprint",
    async (store, key) => {
      const k = key("k");
      expectResult(
        await store.acquire(k, "a", "fp-a", LONG_LOCK_TTL),
        { state: "acquired" },
        "acquire() of a free key",
      );
      expectResult(
        await store.acquire(k, "b", "fp-b", LONG_LOCK_TTL),
        { state: "in-flight", fingerprint: "fp-a" },
        "acquire() of a locked key (the stored fingerprint, not the caller's)",
      );
      expectResult(
        await store.acquire(k, "a", "fp-a", LONG_LOCK_TTL),
        { state: "in-flight", fingerprint: "fp-a" },
        "acquire() by the owner itself (a lock is taken once)",
      );
    },
  );

  testCase(
    "complete() stores the response for the owner only, and acquire() returns it",
    async (store, key) => {
      const k = key("k");
      await store.acquire(k, "a", "fp-a", LONG_LOCK_TTL);
      assert.equal(
        await store.complete(k, "b", response, LONG_RECORD_TTL),
        false,
        "complete() by another owner",
      );
      assert.equal(
        await store.complete(k, "a", response, LONG_RECORD_TTL),
        true,
        "complete() by the owner",
      );
      expectResult(
        await store.acquire(k, "c", "fp-c", LONG_LOCK_TTL),
        { state: "completed", fingerprint: "fp-a", response },
        "acquire() of a completed key",
      );
    },
  );

  testCase(
    "a completed record is final: complete(), release() and extend() leave it alone",
    async (store, key) => {
      const k = key("k");
      await store.acquire(k, "a", "fp-a", LONG_LOCK_TTL);
      await store.complete(k, "a", response, LONG_RECORD_TTL);
      const other: IdempotencyStoredResponse = {
        status: 500,
        headers: {},
        body: "overwritten",
      };
      assert.equal(
        await store.complete(k, "a", other, LONG_RECORD_TTL),
        false,
        "complete() of a completed record",
      );
      assert.equal(
        await store.release(k, "a"),
        false,
        "release() of a completed record",
      );
      assert.equal(
        await store.extend(k, "a", LONG_LOCK_TTL),
        false,
        "extend() of a completed record",
      );
      expectResult(
        await store.acquire(k, "b", "fp-a", LONG_LOCK_TTL),
        { state: "completed", fingerprint: "fp-a", response },
        "acquire() after those calls",
      );
    },
  );

  testCase(
    "release() deletes the lock for the owner only, and frees the key",
    async (store, key) => {
      const k = key("k");
      await store.acquire(k, "a", "fp-a", LONG_LOCK_TTL);
      assert.equal(
        await store.release(k, "b"),
        false,
        "release() by another owner",
      );
      assert.equal(await store.release(k, "a"), true, "release() by the owner");
      assert.equal(
        await store.release(k, "a"),
        false,
        "release() of a released lock",
      );
      expectResult(
        await store.acquire(k, "b", "fp-b", LONG_LOCK_TTL),
        { state: "acquired" },
        "acquire() after release()",
      );
      expectResult(
        await store.acquire(k, "c", "fp-c", LONG_LOCK_TTL),
        { state: "in-flight", fingerprint: "fp-b" },
        "acquire() of the new lock",
      );
    },
  );

  testCase(
    "complete(), release() and extend() on a key without a record change nothing",
    async (store, key) => {
      const k = key("missing");
      assert.equal(
        await store.complete(k, "a", response, LONG_RECORD_TTL),
        false,
        "complete() of a missing key",
      );
      assert.equal(
        await store.extend(k, "a", LONG_LOCK_TTL),
        false,
        "extend() of a missing key",
      );
      assert.equal(
        await store.release(k, "a"),
        false,
        "release() of a missing key",
      );
      expectResult(
        await store.acquire(k, "a", "fp-a", LONG_LOCK_TTL),
        { state: "acquired" },
        "acquire() afterwards",
      );
    },
  );

  testCase(
    "extend() renews the lock for the owner only",
    async (store, key) => {
      const k = key("k");
      await store.acquire(k, "a", "fp-a", LOCK_TTL);
      await advance(LOCK_TTL - MARGIN);
      assert.equal(
        await store.extend(k, "b", LOCK_TTL),
        false,
        "extend() by another owner",
      );
      assert.equal(
        await store.extend(k, "a", LOCK_TTL),
        true,
        "extend() by the owner",
      );
      await advance(LOCK_TTL - MARGIN); // past the first expiry, before the renewed one
      expectResult(
        await store.acquire(k, "b", "fp-b", LOCK_TTL),
        { state: "in-flight", fingerprint: "fp-a" },
        "acquire() after the renewal, before the renewed expiry",
      );
      await advance(2 * MARGIN); // past the renewed expiry
      assert.equal(
        await store.extend(k, "a", LOCK_TTL),
        false,
        "extend() of an expired lock",
      );
      expectResult(
        await store.acquire(k, "b", "fp-b", LOCK_TTL),
        { state: "acquired" },
        "acquire() once it expired",
      );
    },
  );

  testCase(
    "extend() leaves a completed record's ttl alone",
    async (store, key) => {
      const k = key("k");
      await store.acquire(k, "a", "fp-a", LOCK_TTL);
      await store.complete(k, "a", response, RECORD_TTL);
      assert.equal(
        await store.extend(k, "a", LOCK_TTL),
        false,
        "extend() of a completed record",
      );
      await advance(RECORD_TTL - MARGIN); // past lockTtl, before ttl
      expectResult(
        await store.acquire(k, "b", "fp-a", LOCK_TTL),
        { state: "completed", fingerprint: "fp-a", response },
        "acquire() before ttl passed (the record must keep ttl, not lockTtl)",
      );
      await advance(2 * MARGIN);
      expectResult(
        await store.acquire(k, "b", "fp-b", LOCK_TTL),
        { state: "acquired" },
        "acquire() after ttl passed",
      );
    },
  );

  testCase(
    "an expired lock is taken over by the next acquire(), and the stale owner is fenced off",
    async (store, key) => {
      const k = key("k");
      await store.acquire(k, "crashed", "fp-a", LOCK_TTL);
      await advance(LOCK_TTL + MARGIN);
      expectResult(
        await store.acquire(k, "retry", "fp-b", LOCK_TTL),
        { state: "acquired" },
        "acquire() of an expired lock",
      );
      assert.equal(
        await store.extend(k, "crashed", LOCK_TTL),
        false,
        "extend() by the stale owner",
      );
      assert.equal(
        await store.complete(k, "crashed", response, RECORD_TTL),
        false,
        "complete() by the stale owner",
      );
      assert.equal(
        await store.release(k, "crashed"),
        false,
        "release() by the stale owner",
      );
      expectResult(
        await store.acquire(k, "other", "fp-c", LOCK_TTL),
        { state: "in-flight", fingerprint: "fp-b" },
        "acquire() of the new owner's lock",
      );
      const retried: IdempotencyStoredResponse = {
        ...response,
        body: { receiptId: "ch_0002" },
      };
      assert.equal(
        await store.complete(k, "retry", retried, RECORD_TTL),
        true,
        "complete() by the new owner",
      );
      expectResult(
        await store.acquire(k, "other", "fp-b", LOCK_TTL),
        { state: "completed", fingerprint: "fp-b", response: retried },
        "acquire() of the new owner's record",
      );
    },
  );

  testCase(
    "an owner whose lock expired can no longer complete or release it",
    async (store, key) => {
      const k = key("k");
      await store.acquire(k, "a", "fp-a", LOCK_TTL);
      await advance(LOCK_TTL + MARGIN);
      assert.equal(
        await store.complete(k, "a", response, RECORD_TTL),
        false,
        "complete() of an expired lock",
      );
      assert.equal(
        await store.release(k, "a"),
        false,
        "release() of an expired lock",
      );
      expectResult(
        await store.acquire(k, "b", "fp-b", LOCK_TTL),
        { state: "acquired" },
        "acquire() afterwards",
      );
    },
  );

  testCase(
    "a completed record expires after ttl, and its key is free again",
    async (store, key) => {
      const k = key("k");
      await store.acquire(k, "a", "fp-a", LOCK_TTL);
      await store.complete(k, "a", response, RECORD_TTL);
      await advance(RECORD_TTL - MARGIN);
      expectResult(
        await store.acquire(k, "b", "fp-a", LOCK_TTL),
        { state: "completed", fingerprint: "fp-a", response },
        "acquire() before ttl passed",
      );
      await advance(2 * MARGIN);
      expectResult(
        await store.acquire(k, "c", "fp-c", LOCK_TTL),
        { state: "acquired" },
        "acquire() after ttl passed",
      );
      expectResult(
        await store.acquire(k, "d", "fp-d", LOCK_TTL),
        { state: "in-flight", fingerprint: "fp-c" },
        "acquire() of the new lock",
      );
    },
  );

  testCase(
    "takes durations of weeks, past a 32-bit integer",
    async (store, key) => {
      const k = key("k");
      expectResult(
        await store.acquire(k, "a", "fp-a", THIRTY_DAYS),
        { state: "acquired" },
        "acquire() with a 30-day lockTtl",
      );
      assert.equal(
        await store.extend(k, "a", THIRTY_DAYS),
        true,
        "extend() with a 30-day lockTtl",
      );
      assert.equal(
        await store.complete(k, "a", response, THIRTY_DAYS),
        true,
        "complete() with a 30-day ttl",
      );
      await advance(RECORD_TTL);
      expectResult(
        await store.acquire(k, "b", "fp-a", LOCK_TTL),
        { state: "completed", fingerprint: "fp-a", response },
        "acquire() of a record with a 30-day ttl",
      );
    },
  );

  testCase(
    "keeps keys apart exactly, however similar or long",
    async (store, key) => {
      const long = printable(4_000);
      const names = [
        "k",
        "K",
        "k ",
        " k",
        "k\t",
        "usr_alice:k",
        "usr_alice%3Ak",
        "ключ",
        "klucz-ż",
        "🔑",
        "e\u0301",
        "é",
        "__proto__",
        "constructor",
        "toString",
        `${long}x`,
        `${long}y`,
        `y${long}`,
      ];
      for (const [i, name] of names.entries()) {
        expectResult(
          await store.acquire(key(name), "a", `fp-${i}`, LONG_LOCK_TTL),
          { state: "acquired" },
          `acquire() of key #${i}`,
        );
      }
      for (const [i, name] of names.entries()) {
        expectResult(
          await store.acquire(key(name), "b", "fp", LONG_LOCK_TTL),
          { state: "in-flight", fingerprint: `fp-${i}` },
          `acquire() of key #${i} again (${JSON.stringify(name.slice(0, 20))}): another key's record came back`,
        );
      }
    },
  );

  testCase(
    "stores every payload as given, and returns an equal copy",
    async (store, key) => {
      const payloads: IdempotencyStoredPayload[] = [
        {
          status: 402,
          headers: {
            location: "/payments/1",
            "content-language": ["en", "pl"],
          },
          body: {
            message: "O'Reilly ü \u0000 \\ \" 💳 \u2028",
            nested: [
              {
                at: {
                  __idempotencyType: "Date",
                  value: "2026-09-22T12:00:00.000Z",
                },
              },
            ],
            numbers: [0, -1, 1.5, 9007199254740991],
            empty: {},
          },
          error: "http",
        },
        { status: 200, headers: {}, body: null },
        { status: 204, headers: {}, body: "" },
        { status: 201, headers: {}, body: { text: printable(100_000) } },
        {
          sealed: `v1.abcd1234.${"A".repeat(16)}.${"B".repeat(50_000)}.${"C".repeat(22)}`,
        },
      ];
      for (const [i, payload] of payloads.entries()) {
        const k = key(`k${i}`);
        const given = structuredClone(payload);
        await store.acquire(k, "a", "fp", LONG_LOCK_TTL);
        assert.equal(
          await store.complete(k, "a", given, LONG_RECORD_TTL),
          true,
          `complete() with payload #${i}`,
        );
        mutate(given); // the caller's object is not the stored record
        const first = await store.acquire(k, "b", "fp", LONG_LOCK_TTL);
        expectResult(
          first,
          { state: "completed", fingerprint: "fp", response: payload },
          `payload #${i}`,
        );
        if (first.state === "completed") {
          mutate(first.response); // nor is what a caller got back
        }
        expectResult(
          await store.acquire(k, "b", "fp", LONG_LOCK_TTL),
          { state: "completed", fingerprint: "fp", response: payload },
          `payload #${i}, read again after the caller changed its copies`,
        );
      }
    },
  );

  if (!callers) {
    return cases;
  }

  /** What each racing caller passes as its fingerprint (its owner is `owner-<i>`). */
  const fps = Array.from({ length: callers }, (_, i) => `fp-${i}`);
  const acquires = (store: IdempotencyStore, k: string) =>
    fps.map((fp, i) => store.acquire(k, `owner-${i}`, fp, LONG_LOCK_TTL));
  const race = (store: IdempotencyStore, k: string) =>
    Promise.all(acquires(store, k));

  testCase(
    `concurrency: of ${callers} callers acquiring a free key at once, exactly one wins`,
    async (store, key) => {
      const k = key("race");
      const results = await race(store, k);
      expectOneWinner(results, fps, "acquire() of a free key");
    },
  );

  testCase(
    `concurrency: of ${callers} callers acquiring an expired lock at once, exactly one takes it over`,
    async (store, key) => {
      const k = key("race");
      await store.acquire(k, "crashed", "fp-crashed", LOCK_TTL);
      await advance(LOCK_TTL + MARGIN);
      const results = await race(store, k);
      expectOneWinner(results, fps, "acquire() of an expired lock");
      assert.equal(
        await store.complete(k, "crashed", response, RECORD_TTL),
        false,
        "complete() by the stale owner",
      );
    },
  );

  testCase(
    `concurrency: of ${callers} callers acquiring an expired record at once, exactly one wins`,
    async (store, key) => {
      const k = key("race");
      await store.acquire(k, "first", "fp-first", LOCK_TTL);
      await store.complete(k, "first", response, RECORD_TTL);
      await advance(RECORD_TTL + MARGIN);
      const results = await race(store, k);
      expectOneWinner(results, fps, "acquire() of an expired record");
    },
  );

  testCase(
    `concurrency: ${callers} callers on ${Math.ceil(callers / 2)} keys at once: one winner per key`,
    async (store, key) => {
      const keys = Array.from({ length: Math.ceil(callers / 2) }, (_, i) =>
        key(`key-${i}`),
      );
      const results = await Promise.all(
        keys.flatMap((k, i) => [
          store.acquire(k, `owner-${i}-a`, `fp-${i}-a`, LONG_LOCK_TTL),
          store.acquire(k, `owner-${i}-b`, `fp-${i}-b`, LONG_LOCK_TTL),
        ]),
      );
      keys.forEach((_, i) =>
        expectOneWinner(
          results.slice(2 * i, 2 * i + 2),
          [`fp-${i}-a`, `fp-${i}-b`],
          `acquire() of key #${i}`,
        ),
      );
    },
  );

  testCase(
    "concurrency: acquire() racing release() never fails, and at most one caller wins",
    async (store, key) => {
      const k = key("race");
      await store.acquire(k, "owner", "fp-owner", LONG_LOCK_TTL);
      const [released, ...results] = await Promise.all([
        store.release(k, "owner"),
        ...acquires(store, k),
      ]);
      assert.equal(released, true, "release() by the owner");
      const winners = results.flatMap((r, i) =>
        r.state === "acquired" ? [i] : [],
      );
      assert.ok(
        winners.length <= 1,
        `acquire() racing release(): ${winners.length} callers acquired the key`,
      );
      for (const r of results) {
        assert.ok(
          r.state === "acquired" ||
            (r.state === "in-flight" &&
              ["fp-owner", ...winners.map((i) => `fp-${i}`)].includes(
                r.fingerprint,
              )),
          `acquire() racing release() returned ${JSON.stringify(r)}`,
        );
      }
      expectResult(
        await store.acquire(k, "late", "fp-late", LONG_LOCK_TTL),
        winners.length > 0
          ? { state: "in-flight", fingerprint: `fp-${winners[0]}` }
          : { state: "acquired" },
        "acquire() once the race settled",
      );
    },
  );

  testCase(
    "concurrency: acquire() racing complete() sees the lock or the record, never a free key",
    async (store, key) => {
      const k = key("race");
      await store.acquire(k, "owner", "fp-owner", LONG_LOCK_TTL);
      const [completed, ...results] = await Promise.all([
        store.complete(k, "owner", response, LONG_RECORD_TTL),
        ...acquires(store, k),
      ]);
      assert.equal(completed, true, "complete() by the owner");
      for (const r of results) {
        if (r.state === "completed") {
          expectResult(
            r,
            { state: "completed", fingerprint: "fp-owner", response },
            "acquire() racing complete()",
          );
        } else {
          expectResult(
            r,
            { state: "in-flight", fingerprint: "fp-owner" },
            "acquire() racing complete()",
          );
        }
      }
    },
  );

  return cases;
}

/** Compares what `acquire()` resolved, ignoring extra properties a store may add. */
function expectResult(
  actual: IdempotencyAcquireResult,
  expected: IdempotencyAcquireResult,
  what: string,
): void {
  assert.ok(
    actual !== null &&
      typeof actual === "object" &&
      ["acquired", "in-flight", "completed"].includes(actual.state),
    `${what}: acquire() must resolve { state: 'acquired' | 'in-flight' | 'completed' }, got ${JSON.stringify(actual)}`,
  );
  const pickResult = (r: IdempotencyAcquireResult) =>
    r.state === "acquired"
      ? { state: r.state }
      : r.state === "in-flight"
        ? { state: r.state, fingerprint: r.fingerprint }
        : {
            state: r.state,
            fingerprint: r.fingerprint,
            response: r.response,
          };
  assert.deepStrictEqual(pickResult(actual), pickResult(expected), what);
}

/**
 * Exactly one caller acquired, and every other one saw the winner's lock.
 * `fingerprints[i]` is what caller `i` passed.
 */
function expectOneWinner(
  results: IdempotencyAcquireResult[],
  fingerprints: string[],
  what: string,
): void {
  const winners = results.flatMap((r, i) =>
    r.state === "acquired" ? [i] : [],
  );
  assert.equal(
    winners.length,
    1,
    `${what}: ${winners.length} of ${results.length} concurrent callers acquired the key`,
  );
  const winner = winners[0]!;
  for (const [i, r] of results.entries()) {
    if (i === winner) {
      continue;
    }
    expectResult(
      r,
      { state: "in-flight", fingerprint: fingerprints[winner]! },
      `${what}: a losing caller`,
    );
  }
}

/** Changes a payload in place, wherever it can. */
function mutate(payload: IdempotencyStoredPayload): void {
  if ("sealed" in payload) {
    payload.sealed = "tampered";
  } else {
    payload.status = 599;
    payload.headers["x-mutated"] = "yes";
    if (payload.body && typeof payload.body === "object") {
      (payload.body as Record<string, unknown>).mutated = true;
    }
  }
}

/** A deterministic string of `length` varied characters (ASCII and beyond), which doesn't compress. */
function printable(length: number): string {
  let seed = 0x2545f491;
  let out = "";
  const extra = ["ą", "ß", "ж", "中", "é", "ø"];
  while (out.length < length) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = seed % 100;
    out += n < 94 ? String.fromCharCode(33 + n) : extra[n - 94]!;
  }
  return out.slice(0, length);
}
