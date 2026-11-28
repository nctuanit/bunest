import { describe, expect, it } from "bun:test";
import {
  AesGcmPayloadCodec,
  assertPriority,
  assertScheduleId,
  backoffDelay,
  InMemoryScheduleStore,
  isEncodedPayload,
  LeasedWorker,
  ManualClock,
  MAX_PRIORITY,
  nextOccurrences,
  nextRetry,
  occurrenceId,
  parseDuration,
  parseSchedule,
  PayloadCodecs,
  rateWindowRoom,
  resolveConcurrency,
  resolveRateLimit,
  resolveRetry,
  ResultWaiter,
  Scheduler,
  systemClock,
  takeRateWindow,
  type DeclaredSchedule,
  type LeasedRun,
  type PayloadCodec,
  type PayloadContext,
  type ScheduleRecord,
  type ScheduleSkip,
  type SerializedError,
} from "../src/core/index";

const silentLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
};

describe("core/time", () => {
  it("parses numeric and string durations across all supported units", () => {
    expect(parseDuration(0)).toBe(0);
    expect(parseDuration(250)).toBe(250);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("1.5s")).toBe(1_500);
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("3d")).toBe(259_200_000);
    expect(parseDuration("1w")).toBe(604_800_000);
  });

  it("rejects invalid durations with TypeError", () => {
    expect(() => parseDuration(-1)).toThrow(TypeError);
    expect(() => parseDuration(Number.NaN)).toThrow(TypeError);
    expect(() => parseDuration(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => parseDuration("10y" as never)).toThrow(TypeError);
    expect(() => parseDuration("" as never)).toThrow(TypeError);
    expect(() => parseDuration("-5s" as never)).toThrow(TypeError);
  });

  it("supports ManualClock defaults, advance(), set(), and systemClock", () => {
    const clock = new ManualClock();
    expect(clock.now()).toBe(Date.UTC(2026, 0, 1));
    expect(clock.advance("1h")).toBe(Date.UTC(2026, 0, 1, 1));
    expect(clock.advance(500)).toBe(Date.UTC(2026, 0, 1, 1, 0, 0, 500));
    clock.set(new Date("2026-06-15T12:00:00Z"));
    expect(clock.now()).toBe(Date.UTC(2026, 5, 15, 12));
    clock.set(1_700_000_000_000);
    expect(clock.now()).toBe(1_700_000_000_000);
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(1_000);
  });
});

describe("core/retries", () => {
  it("resolves retry defaults, shorthands, partial overrides, and backoff functions", () => {
    const defaults = resolveRetry(undefined);
    expect(defaults).toEqual({
      attempts: 3,
      backoff: { delay: 1_000, factor: 2, maxDelay: 300_000, jitter: "none" },
    });

    expect(resolveRetry(false, defaults).attempts).toBe(1);
    expect(resolveRetry(0, defaults).attempts).toBe(1);
    expect(resolveRetry(5, defaults).attempts).toBe(5);

    const customBase = resolveRetry({
      attempts: 4,
      backoff: { delay: "2s", factor: 3, maxDelay: "1m", jitter: "equal" },
      retryIf: (err) => err instanceof Error,
    });
    const merged = resolveRetry({ backoff: { jitter: "full" } }, customBase);
    expect(merged.attempts).toBe(4);
    expect(merged.backoff).toEqual({
      delay: 2_000,
      factor: 3,
      maxDelay: 60_000,
      jitter: "full",
    });
    expect(merged.retryIf).toBe(customBase.retryIf);

    const fnPolicy = resolveRetry({ backoff: (attempt) => `${attempt * 2}s` });
    expect(typeof fnPolicy.backoff).toBe("function");
    if (typeof fnPolicy.backoff === "function") {
      expect(fnPolicy.backoff(3, new Error("boom"))).toBe(6_000);
    }

    // Object backoff over a function base falls back to DEFAULT_BACKOFF fields
    const overFn = resolveRetry({ backoff: { delay: "500ms" } }, fnPolicy);
    expect(overFn.backoff).toEqual({
      delay: 500,
      factor: 2,
      maxDelay: 300_000,
      jitter: "none",
    });
  });

  it("rejects invalid retry settings", () => {
    expect(() => resolveRetry(-1)).toThrow(TypeError);
    expect(() => resolveRetry(1.5)).toThrow(TypeError);
    expect(() => resolveRetry({ backoff: { factor: 0 } })).toThrow(TypeError);
    expect(() => resolveRetry({ backoff: { factor: -2 } })).toThrow(TypeError);
    expect(() => resolveRetry({ backoff: { jitter: "bad" as never } })).toThrow(
      TypeError,
    );
  });

  it("computes exponential backoff with cap and jitter modes", () => {
    const none = {
      delay: 1_000,
      factor: 2,
      maxDelay: 5_000,
      jitter: "none" as const,
    };
    expect(backoffDelay(none, 1)).toBe(1_000);
    expect(backoffDelay(none, 2)).toBe(2_000);
    expect(backoffDelay(none, 3)).toBe(4_000);
    expect(backoffDelay(none, 4)).toBe(5_000);

    expect(backoffDelay({ ...none, jitter: "full" }, 2, () => 0.5)).toBe(1_000);
    expect(backoffDelay({ ...none, jitter: "full" }, 2, () => 0)).toBe(0);
    expect(backoffDelay({ ...none, jitter: "equal" }, 2, () => 0)).toBe(1_000);
    expect(backoffDelay({ ...none, jitter: "equal" }, 2, () => 0.5)).toBe(
      1_500,
    );
  });

  it("evaluates nextRetry decisions for retry, exhausted, refused, and threw", () => {
    const policy = resolveRetry({
      attempts: 3,
      backoff: { delay: "1s", factor: 2 },
      retryIf: (err) => (err as Error).message !== "fatal",
    });

    expect(nextRetry(policy, 1, new Error("transient"))).toEqual({
      retry: true,
      delay: 1_000,
    });
    expect(nextRetry(policy, 2, new Error("transient"))).toEqual({
      retry: true,
      delay: 2_000,
    });
    expect(nextRetry(policy, 3, new Error("transient"))).toEqual({
      retry: false,
      reason: "exhausted",
    });
    expect(nextRetry(policy, 1, new Error("fatal"))).toEqual({
      retry: false,
      reason: "refused",
    });

    const bug = new Error("predicate bug");
    const throwingRetryIf = resolveRetry({
      attempts: 3,
      retryIf: () => {
        throw bug;
      },
    });
    expect(nextRetry(throwingRetryIf, 1, new Error("orig"))).toEqual({
      retry: false,
      reason: "threw",
      error: bug,
    });

    const badDuration = resolveRetry({
      attempts: 3,
      backoff: () => "invalid" as never,
    });
    const decision = nextRetry(badDuration, 1, new Error("orig"));
    expect(decision.retry).toBe(false);
    if (!decision.retry && decision.reason === "threw") {
      expect(decision.error).toBeInstanceOf(TypeError);
    } else {
      throw new Error("Expected threw decision");
    }
  });
});

describe("core/codecs", () => {
  const key1 = crypto.getRandomValues(new Uint8Array(32));
  const key2 = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64",
  );

  it("encrypts, compresses, authenticates context AAD, and rotates keys in AesGcmPayloadCodec", async () => {
    const codec = new AesGcmPayloadCodec({ keys: { k1: key1 }, current: "k1" });
    expect(codec.id).toBe("aes-256-gcm");

    const ctx: PayloadContext = {
      field: "input",
      instanceId: "order-1",
      entry: "charge",
    };
    const small = { amount: 42, currency: "USD" };
    const encSmall = await codec.encode(small, ctx);
    expect(encSmall.startsWith("k1.")).toBe(true);
    expect(await codec.decode(encSmall, ctx)).toEqual(small);

    // Compression above 1024B threshold
    const large = { data: "a".repeat(4_000) };
    const encLarge = await codec.encode(large, ctx);
    expect(encLarge.length).toBeLessThan(400);
    expect(await codec.decode(encLarge, ctx)).toEqual(large);

    // Custom context keys (non-workflow places)
    const queueCtx: PayloadContext = {
      field: "data",
      queue: "emails",
      job: "job-99",
    };
    const encQueue = await codec.encode({ to: "a@b.com" }, queueCtx);
    expect(await codec.decode(encQueue, queueCtx)).toEqual({ to: "a@b.com" });
    await expect(
      codec.decode(encQueue, {
        field: "data",
        queue: "emails",
        job: "job-100",
      }),
    ).rejects.toThrow(/failed authentication/);

    // Context binding rejects moved payload
    await expect(
      codec.decode(encSmall, { ...ctx, field: "result" }),
    ).rejects.toThrow(/entry "charge" of instance "order-1" \(result\)/);
    await expect(
      codec.decode(encSmall, { ...ctx, instanceId: "order-2" }),
    ).rejects.toThrow(/failed authentication/);

    // Tampered ciphertext fails authentication
    const tampered =
      encSmall.slice(0, -2) + (encSmall.endsWith("AA") ? "BB" : "AA");
    await expect(codec.decode(tampered, ctx)).rejects.toThrow(
      /failed authentication/,
    );

    // Key rotation: k2 encrypts, k1 still decrypts
    const rotated = new AesGcmPayloadCodec({
      keys: { k1: key1, k2: key2 },
      current: "k2",
      compress: false,
    });
    expect(await rotated.decode(encSmall, ctx)).toEqual(small);
    const encWithK2 = await rotated.encode(small, ctx);
    expect(encWithK2.startsWith("k2.")).toBe(true);
    expect(await rotated.decode(encWithK2, ctx)).toEqual(small);

    // Missing key error
    const onlyK2 = new AesGcmPayloadCodec({
      keys: { k2: key2 },
      current: "k2",
    });
    await expect(onlyK2.decode(encSmall, ctx)).rejects.toThrow(
      /encrypted with key "k1"/,
    );
  });

  it("validates AesGcmPayloadCodec options strictly", () => {
    expect(() => new AesGcmPayloadCodec(null as never)).toThrow(TypeError);
    expect(
      () =>
        new AesGcmPayloadCodec({ keys: { "bad id": key1 }, current: "bad id" }),
    ).toThrow(TypeError);
    expect(
      () => new AesGcmPayloadCodec({ keys: { k1: key1 }, current: "missing" }),
    ).toThrow(TypeError);
    expect(
      () => new AesGcmPayloadCodec({ keys: { k1: "" }, current: "k1" }),
    ).toThrow(TypeError);
    expect(
      () =>
        new AesGcmPayloadCodec({ keys: { k1: "not!base64!" }, current: "k1" }),
    ).toThrow(TypeError);
    expect(
      () =>
        new AesGcmPayloadCodec({
          keys: { k1: Buffer.alloc(16) },
          current: "k1",
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new AesGcmPayloadCodec({
          keys: { k1: undefined as never },
          current: "k1",
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new AesGcmPayloadCodec({
          keys: { k1: key1 },
          current: "k1",
          compress: -1,
        }),
    ).toThrow(TypeError);
  });

  it("manages envelopes, rotation, plain protection, sync/async codecs, and error encoding in PayloadCodecs", async () => {
    const aes = new AesGcmPayloadCodec({ keys: { k1: key1 }, current: "k1" });
    const base64: PayloadCodec = {
      id: "base64",
      encode: (value) => Buffer.from(JSON.stringify(value)).toString("base64"),
      decode: (data) =>
        JSON.parse(Buffer.from(data, "base64").toString("utf8")),
    };
    const asyncCodec: PayloadCodec = {
      id: "async-b64",
      encode: async (value) =>
        Buffer.from(JSON.stringify(value)).toString("base64"),
      decode: async (data) =>
        JSON.parse(Buffer.from(data, "base64").toString("utf8")),
    };

    const ctx: PayloadContext = { field: "input", instanceId: "wf-1" };

    // Empty codecs: passthrough except strings starting with $wf1:
    const empty = new PayloadCodecs([]);
    expect(empty.encodes).toBe(false);
    expect(empty.encode({ a: 1 }, ctx)).toEqual({ a: 1 });
    expect(empty.encode(null, ctx)).toBeNull();
    expect(empty.encode(undefined, ctx)).toBeUndefined();
    const tricky = "$wf1:fake:payload";
    const wrapped = empty.encode(tricky, ctx);
    expect(isEncodedPayload(wrapped)).toBe(true);
    expect(wrapped).toBe(`$wf1:plain:${JSON.stringify(tricky)}`);
    expect(empty.decode(wrapped, ctx)).toBe(tricky);
    expect(() => empty.decode("$wf1:aes-256-gcm:abc", ctx)).toThrow(
      /encoded by the codec "aes-256-gcm"/,
    );

    // Sync codec stays synchronous (not a Promise)
    const syncCodecs = new PayloadCodecs([base64]);
    const encSync = syncCodecs.encode({ old: 123 }, ctx);
    expect(typeof encSync).toBe("string");
    expect(isEncodedPayload(encSync)).toBe(true);
    expect(syncCodecs.decode(encSync, ctx)).toEqual({ old: 123 });

    // Primary WebCrypto AES-GCM codec + secondary sync codec
    const codecs = new PayloadCodecs([aes, base64], {
      name: "WorkflowsModule's codec",
    });
    expect(codecs.encodes).toBe(true);
    const encAes = await codecs.encode({ secret: "top" }, ctx);
    expect(typeof encAes).toBe("string");
    expect(isEncodedPayload(encAes)).toBe(true);
    expect(await codecs.decode(encAes, ctx)).toEqual({ secret: "top" });

    // Legacy unencoded value passes through decode()
    expect(codecs.decode({ legacy: true }, ctx)).toEqual({ legacy: true });

    // Secondary codec decodes what it wrote
    expect(codecs.decode(encSync, ctx)).toEqual({ old: 123 });

    // Async codec works
    const asyncCodecs = new PayloadCodecs([asyncCodec]);
    const encAsync = await asyncCodecs.encode({ hello: "world" }, ctx);
    expect(isEncodedPayload(encAsync)).toBe(true);
    expect(await asyncCodecs.decode(encAsync, ctx)).toEqual({ hello: "world" });

    // encodeError & decodeError preserve name, hide message/stack, handle nested errors
    const err: SerializedError & { compensation?: SerializedError } = {
      name: "PaymentError",
      message: "Card 4242 declined",
      stack: "PaymentError: Card 4242 declined\n    at charge()",
      compensation: { name: "RefundError", message: "Refund failed for 4242" },
    };
    const encodedErr = (await codecs.encodeError(
      err,
      ctx,
    )) as SerializedError & {
      compensation?: SerializedError;
    };
    expect(encodedErr.name).toBe("PaymentError");
    expect(isEncodedPayload(encodedErr.message)).toBe(true);
    expect(encodedErr.stack).toBeUndefined();
    expect(encodedErr.compensation?.name).toBe("RefundError");
    expect(isEncodedPayload(encodedErr.compensation?.message)).toBe(true);

    const decodedErr = await codecs.decodeError(encodedErr, ctx);
    expect(decodedErr).toEqual(err);
    expect(await codecs.decodeError(null, ctx)).toBeNull();
    expect(codecs.encodeError(undefined, ctx)).toBeUndefined();

    // Error with $wf1: message under empty codecs is wrapped with plain
    const trickyErr: SerializedError = {
      name: "Error",
      message: "$wf1:evil:x",
    };
    const plainEncErr = empty.encodeError(trickyErr, ctx) as SerializedError;
    expect(plainEncErr.message.startsWith("$wf1:plain:")).toBe(true);
    expect(await empty.decodeError(plainEncErr, ctx)).toEqual(trickyErr);

    // Constructor validations
    expect(() => new PayloadCodecs([null as never])).toThrow(TypeError);
    expect(
      () =>
        new PayloadCodecs([
          { id: "plain", encode: () => "", decode: () => null },
        ]),
    ).toThrow(TypeError);
    expect(
      () =>
        new PayloadCodecs([
          { id: "bad id", encode: () => "", decode: () => null },
        ]),
    ).toThrow(TypeError);
    expect(() => new PayloadCodecs([base64, base64])).toThrow(TypeError);
  });
});

describe("core/limits", () => {
  it("validates priorities and MAX_PRIORITY", () => {
    expect(MAX_PRIORITY).toBe(2_097_151);
    expect(() => assertPriority(0, "start()")).not.toThrow();
    expect(() => assertPriority(1, "start()")).not.toThrow();
    expect(() => assertPriority(MAX_PRIORITY, "start()")).not.toThrow();
    expect(() => assertPriority(-1, "start()")).toThrow(TypeError);
    expect(() => assertPriority(1.5, "start()")).toThrow(
      /start\(\): invalid priority/,
    );
    expect(() => assertPriority(MAX_PRIORITY + 1, "start()")).toThrow(
      TypeError,
    );
    expect(() => assertPriority("1", "start()")).toThrow(TypeError);
  });

  it("resolves concurrency limits (single and global + per-key)", () => {
    const keyFn = (order: { customerId: string }) => order.customerId;
    expect(resolveConcurrency('workflow "orders"', { limit: 10 })).toEqual({
      limit: 10,
      perKey: null,
    });
    expect(
      resolveConcurrency('workflow "orders"', [
        { limit: 20 },
        { limit: 1, key: keyFn },
      ]),
    ).toEqual({
      limit: 20,
      perKey: 1,
      key: keyFn,
    });

    expect(() => resolveConcurrency('workflow "orders"', [])).toThrow(
      TypeError,
    );
    expect(() =>
      resolveConcurrency('workflow "orders"', [
        { limit: 1 },
        { limit: 2 },
        { limit: 3 },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      resolveConcurrency('workflow "orders"', [{ limit: 1 }, { limit: 2 }]),
    ).toThrow(/two concurrency limits without a key/);
    expect(() =>
      resolveConcurrency('workflow "orders"', [
        { limit: 1, key: keyFn },
        { limit: 2, key: keyFn },
      ]),
    ).toThrow(/two concurrency limits with a key/);
    expect(() => resolveConcurrency('workflow "orders"', { limit: 0 })).toThrow(
      TypeError,
    );
    expect(() =>
      resolveConcurrency('workflow "orders"', {
        limit: 1,
        key: "bad" as never,
      }),
    ).toThrow(TypeError);
  });

  it("resolves rate limits and computes window room & updates", () => {
    const keyFn = (o: { tenant: string }) => o.tenant;
    expect(
      resolveRateLimit('queue "emails"', { max: 100, duration: "1m" }),
    ).toEqual({
      limit: { max: 100, duration: 60_000 },
      perKey: null,
    });
    expect(
      resolveRateLimit('queue "emails"', [
        { max: 100, duration: "1m" },
        { max: 5, duration: "10s", key: keyFn },
      ]),
    ).toEqual({
      limit: { max: 100, duration: 60_000 },
      perKey: { max: 5, duration: 10_000 },
      key: keyFn,
    });

    expect(() => resolveRateLimit('queue "emails"', [])).toThrow(TypeError);
    expect(() =>
      resolveRateLimit('queue "emails"', { max: 0, duration: "1s" }),
    ).toThrow(TypeError);
    expect(() =>
      resolveRateLimit('queue "emails"', { max: 5, duration: 0 }),
    ).toThrow(TypeError);
    expect(() =>
      resolveRateLimit('queue "emails"', {
        max: 5,
        duration: "invalid" as never,
      }),
    ).toThrow(TypeError);
    expect(() =>
      resolveRateLimit('queue "emails"', {
        max: 5,
        duration: "1s",
        key: 123 as never,
      }),
    ).toThrow(TypeError);

    // Rate window arithmetic
    expect(rateWindowRoom(undefined, 10, 1_000)).toBe(10);
    expect(rateWindowRoom(null, 10, 1_000)).toBe(10);
    expect(rateWindowRoom({ windowEnd: 60_000, count: 7 }, 10, 30_000)).toBe(3);
    expect(rateWindowRoom({ windowEnd: 60_000, count: 7 }, 10, 60_000)).toBe(
      10,
    );

    expect(takeRateWindow(undefined, 60_000, 1_000)).toEqual({
      windowEnd: 61_000,
      count: 1,
    });
    expect(
      takeRateWindow({ windowEnd: 61_000, count: 1 }, 60_000, 2_000, 2),
    ).toEqual({ windowEnd: 61_000, count: 3 });
    expect(
      takeRateWindow({ windowEnd: 61_000, count: 5 }, 60_000, 61_000, 1),
    ).toEqual({ windowEnd: 121_000, count: 1 });
  });
});

describe("core/results", () => {
  it("resolves immediately from read(), via polling, or via local settle()", async () => {
    let calls = 0;
    const waiter = new ResultWaiter<string>({
      read: async (id) => {
        calls++;
        if (id === "immediate") return { value: "ok" };
        if (id === "failed") return { error: new Error("job failed") };
        if (id === "polled" && calls >= 3) return { value: "polled-ok" };
        return null;
      },
    });

    expect(await waiter.wait("immediate")).toBe("ok");
    await expect(waiter.wait("failed")).rejects.toThrow("job failed");

    calls = 0;
    expect(await waiter.wait("polled", { timeout: "2s" })).toBe("polled-ok");
    expect(calls).toBeGreaterThanOrEqual(3);

    // Lazy settle factory not called when nobody waits
    let factoryCalls = 0;
    waiter.settle("nobody", () => {
      factoryCalls++;
      return { value: "unused" };
    });
    expect(factoryCalls).toBe(0);

    // Local settle wakes pending wait immediately; first outcome wins
    const waiting = waiter.wait("local", { timeout: "5s" });
    await Bun.sleep(5);
    waiter.settle("local", () => {
      factoryCalls++;
      return { value: "settled-first" };
    });
    waiter.settle("local", { value: "settled-second" });
    expect(await waiting).toBe("settled-first");
    expect(factoryCalls).toBe(1);
  });

  it("rejects on timeout, AbortSignal, and close()", async () => {
    const waiter = new ResultWaiter<string>({
      read: () => new Promise(() => {}), // never settles
      timeoutError: (id, ms) => new Error(`custom-timeout:${id}:${ms}`),
      closedError: (id) => new Error(`custom-closed:${id}`),
    });

    await expect(waiter.wait("slow", { timeout: 20 })).rejects.toThrow(
      "custom-timeout:slow:20",
    );

    const ac = new AbortController();
    const abortedWait = waiter.wait("aborted", { signal: ac.signal });
    setTimeout(() => ac.abort(new Error("client-gone")), 10);
    await expect(abortedWait).rejects.toThrow("client-gone");

    // Already aborted signal rejects immediately
    await expect(
      waiter.wait("already", {
        signal: AbortSignal.abort(new Error("pre-aborted")),
      }),
    ).rejects.toThrow("pre-aborted");

    // Closing rejects active and future waits
    expect(waiter.closed).toBe(false);
    const active = waiter.wait("on-close");
    const closePromise = waiter.close();
    await expect(active).rejects.toThrow("custom-closed:on-close");
    await closePromise;
    expect(waiter.closed).toBe(true);
    await expect(waiter.wait("after-close")).rejects.toThrow(
      "custom-closed:after-close",
    );
  });
});

describe("core/scheduling/schedule-spec", () => {
  it("parses cron (5-field, 6-field, nicknames, L, nL, n#k, DOM/DOW rules), every, and rrule", () => {
    const every = parseSchedule({ every: "15m" });
    expect(every).toEqual({
      every: 900_000,
      tz: "UTC",
      startAt: null,
      endAt: null,
      limit: null,
      missed: "skip",
      overlap: "skip",
    });

    // Every occurrences from epoch & from startAt
    expect(nextOccurrences(every, { from: 0, count: 3 })).toEqual([
      900_000, 1_800_000, 2_700_000,
    ]);
    const anchored = parseSchedule({
      every: "10s",
      startAt: Date.UTC(2026, 0, 1, 0, 0, 5),
      endAt: Date.UTC(2026, 0, 1, 0, 0, 25),
    });
    expect(
      nextOccurrences(anchored, {
        from: Date.UTC(2026, 0, 1, 0, 0, 0),
        count: 5,
      }),
    ).toEqual([
      Date.UTC(2026, 0, 1, 0, 0, 5),
      Date.UTC(2026, 0, 1, 0, 0, 15),
      Date.UTC(2026, 0, 1, 0, 0, 25),
    ]);

    // 6-field cron with seconds & nickname
    const sixField = parseSchedule({ cron: "30 0 8 * * MON" });
    expect(
      nextOccurrences(sixField, { from: Date.UTC(2026, 0, 1), count: 2 }),
    ).toEqual([
      Date.UTC(2026, 0, 5, 8, 0, 30),
      Date.UTC(2026, 0, 12, 8, 0, 30),
    ]);
    const daily = parseSchedule({ cron: "@daily" });
    expect(
      nextOccurrences(daily, { from: Date.UTC(2026, 0, 1), count: 2 }),
    ).toEqual([Date.UTC(2026, 0, 2, 0, 0, 0), Date.UTC(2026, 0, 3, 0, 0, 0)]);

    // Cron L (last day of month), 5L (last Friday), 1#2 (second Monday)
    const lastDay = parseSchedule({ cron: "0 0 L 2 *" });
    expect(
      nextOccurrences(lastDay, { from: Date.UTC(2026, 0, 1), count: 3 }),
    ).toEqual([
      Date.UTC(2026, 1, 28, 0, 0),
      Date.UTC(2027, 1, 28, 0, 0),
      Date.UTC(2028, 1, 29, 0, 0),
    ]);
    const lastFriday = parseSchedule({ cron: "0 17 * * 5L" });
    expect(
      nextOccurrences(lastFriday, { from: Date.UTC(2026, 0, 1), count: 2 }),
    ).toEqual([Date.UTC(2026, 0, 30, 17, 0), Date.UTC(2026, 1, 27, 17, 0)]);
    const secondMonday = parseSchedule({ cron: "0 9 * * 1#2" });
    expect(
      nextOccurrences(secondMonday, { from: Date.UTC(2026, 0, 1), count: 1 }),
    ).toEqual([Date.UTC(2026, 0, 12, 9, 0)]);

    // RRULE with ordinals, INTERVAL, COUNT, UNTIL
    const monthlyLastFri = parseSchedule({
      rrule: "FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17;BYMINUTE=0",
    });
    expect(
      nextOccurrences(monthlyLastFri, { from: Date.UTC(2026, 0, 1), count: 2 }),
    ).toEqual([Date.UTC(2026, 0, 30, 17, 0), Date.UTC(2026, 1, 27, 17, 0)]);
    const counted = parseSchedule({
      rrule: "RRULE:FREQ=DAILY;INTERVAL=2;COUNT=3;BYHOUR=10",
      startAt: Date.UTC(2026, 0, 1, 0, 0),
    });
    expect(
      nextOccurrences(counted, { from: Date.UTC(2025, 11, 31), count: 10 }),
    ).toEqual([
      Date.UTC(2026, 0, 1, 10, 0),
      Date.UTC(2026, 0, 3, 10, 0),
      Date.UTC(2026, 0, 5, 10, 0),
    ]);
    const withUntil = parseSchedule({
      rrule: "FREQ=DAILY;BYHOUR=8;UNTIL=20260103",
    });
    expect(
      nextOccurrences(withUntil, {
        from: Date.UTC(2026, 0, 1, 0, 0),
        count: 10,
      }),
    ).toEqual([
      Date.UTC(2026, 0, 1, 8, 0),
      Date.UTC(2026, 0, 2, 8, 0),
      Date.UTC(2026, 0, 3, 8, 0),
    ]);

    // limit + runs preview cap
    const limited = parseSchedule({ every: "1m", limit: 5 });
    expect(nextOccurrences(limited, { from: 0, count: 10, runs: 3 })).toEqual([
      60_000, 120_000,
    ]);
  });

  it("handles DST spring-forward gaps and fall-back repeated hours in IANA time zones", () => {
    // Europe/Warsaw spring-forward 2026-03-29: 02:00 CET -> 03:00 CEST (UTC+1 -> UTC+2)
    // 02:30 wall time doesn't exist, lands 1 hour later at 03:30 CEST = 01:30 UTC
    const springCron = parseSchedule({
      cron: "30 2 * * *",
      tz: "Europe/Warsaw",
    });
    expect(
      nextOccurrences(springCron, {
        from: Date.UTC(2026, 2, 28, 23, 0),
        count: 2,
      }),
    ).toEqual([
      Date.UTC(2026, 2, 29, 1, 30), // 03:30 CEST (gap shifted)
      Date.UTC(2026, 2, 30, 0, 30), // 02:30 CEST normal
    ]);

    const springRRule = parseSchedule({
      rrule: "FREQ=DAILY;BYHOUR=2;BYMINUTE=30",
      tz: "Europe/Warsaw",
    });
    expect(
      nextOccurrences(springRRule, {
        from: Date.UTC(2026, 2, 28, 23, 0),
        count: 2,
      }),
    ).toEqual([Date.UTC(2026, 2, 29, 1, 30), Date.UTC(2026, 2, 30, 0, 30)]);

    // Europe/Warsaw fall-back 2026-10-25: 03:00 CEST -> 02:00 CET (UTC+2 -> UTC+1)
    // 02:30 occurs twice (00:30 UTC CEST and 01:30 UTC CET); runs ONCE at the first instant (00:30 UTC)
    const fallCron = parseSchedule({ cron: "30 2 * * *", tz: "Europe/Warsaw" });
    expect(
      nextOccurrences(fallCron, {
        from: Date.UTC(2026, 9, 24, 23, 0),
        count: 2,
      }),
    ).toEqual([
      Date.UTC(2026, 9, 25, 0, 30), // first 02:30 (CEST)
      Date.UTC(2026, 9, 26, 1, 30), // next day 02:30 (CET)
    ]);

    const fallRRule = parseSchedule({
      rrule: "FREQ=DAILY;BYHOUR=2;BYMINUTE=30",
      tz: "Europe/Warsaw",
    });
    expect(
      nextOccurrences(fallRRule, {
        from: Date.UTC(2026, 9, 24, 23, 0),
        count: 2,
      }),
    ).toEqual([Date.UTC(2026, 9, 25, 0, 30), Date.UTC(2026, 9, 26, 1, 30)]);

    // Every-minute cron in fall-back repeated hour skips the second pass (falls back to pure-TS)
    const fallWildcard = parseSchedule({
      cron: "* 2 * * *",
      tz: "Europe/Warsaw",
    });
    expect(
      nextOccurrences(fallWildcard, {
        from: Date.UTC(2026, 9, 25, 0, 59), // 02:59 CEST (last minute of first 02:xx pass)
        count: 1,
      }),
    ).toEqual([Date.UTC(2026, 9, 26, 1, 0)]); // skips 02:00 CET repeat, goes to next day 02:00 CET

    // Vixie DOM_STAR step rule (`0 0 */2 * 1`: odd days that are Mondays) is preserved accurately
    const domStarStep = parseSchedule({ cron: "0 0 */2 * 1" });
    expect(
      nextOccurrences(domStarStep, {
        from: Date.UTC(2026, 5, 14, 0, 0),
        count: 2,
      }),
    ).toEqual([
      Date.UTC(2026, 5, 15, 0, 0), // Mon Jun 15 (odd)
      Date.UTC(2026, 5, 29, 0, 0), // Mon Jun 29 (odd; skips Mon Jun 22 which is even)
    ]);
  });

  it("validates schedule specs, ids, and occurrenceId formatting", () => {
    expect(occurrenceId("weekly-digest", Date.UTC(2026, 0, 5, 7))).toBe(
      "weekly-digest@2026-01-05T07:00:00.000Z",
    );
    expect(() => assertScheduleId("weekly-digest:v1.0_ok")).not.toThrow();
    expect(() => assertScheduleId("bad@id", 'queue "emails"')).toThrow(
      /Invalid schedule id "bad@id" of queue "emails"/,
    );
    expect(() => assertScheduleId("with space")).toThrow(TypeError);
    expect(() => assertScheduleId(42)).toThrow(TypeError);

    expect(() => parseSchedule({})).toThrow(TypeError);
    expect(() => parseSchedule({ cron: "@daily", every: "1m" })).toThrow(
      TypeError,
    );
    expect(() => parseSchedule({ every: "500ms" })).toThrow(
      /at least a second/,
    );
    expect(() => parseSchedule({ every: "1m", tz: "Europe/Warsaw" })).toThrow(
      /tz doesn't apply/,
    );
    expect(() => parseSchedule({ cron: "0 0 30 2 *" })).toThrow(
      /February has no 30th/,
    );
    expect(() => parseSchedule({ cron: "@daily", tz: "Mars/Olympus" })).toThrow(
      /Invalid time zone/,
    );
    expect(() => parseSchedule({ rrule: "FREQ=DAILY;COUNT=5" })).toThrow(
      /startAt/,
    );
    expect(() => parseSchedule({ rrule: "FREQ=WEEKLY;BYMONTHDAY=1" })).toThrow(
      TypeError,
    );
    expect(() =>
      parseSchedule({ every: "1m", missed: "all", overlap: "skip" }),
    ).toThrow(/overlap: 'allow'/);
    expect(() =>
      parseSchedule({ every: "1m", startAt: 2_000, endAt: 1_000 }),
    ).toThrow(/endAt/);
    expect(() =>
      nextOccurrences(parseSchedule({ every: "1m" }), { count: 0 }),
    ).toThrow(TypeError);
    expect(() =>
      nextOccurrences(parseSchedule({ every: "1m" }), { from: Number.NaN }),
    ).toThrow(TypeError);
  });
});

describe("core/scheduling/InMemoryScheduleStore & Scheduler", () => {
  it("enforces conditional saves, claims, fencing, and cloning in InMemoryScheduleStore", async () => {
    const store = new InMemoryScheduleStore();
    const spec = parseSchedule({ every: "1m" });
    const baseSave = {
      id: "s1",
      target: "emails",
      declared: false,
      spec,
      payload: { nested: [1] },
      paused: false,
      wakeAt: 1_000,
      state: { next: 1_000, runs: 0, buffered: null, pending: [] },
      expectRevision: null,
      releaseLease: false,
      now: 500,
    };

    const created = await store.saveSchedule(baseSave);
    expect(created).not.toBeNull();
    expect(created!.revision).toBe(1);
    // Duplicate insert rejected
    expect(await store.saveSchedule(baseSave)).toBeNull();
    // Mutating returned object does not affect stored record
    (created!.payload as { nested: number[] }).nested.push(2);
    expect((await store.getSchedule("s1"))!.payload).toEqual({ nested: [1] });

    // Claiming & fencing
    const claimed = await store.claimSchedules({
      owner: "w1",
      token: "tok-1",
      now: 1_000,
      leaseUntil: 10_000,
      limit: 10,
      targets: ["emails"],
    });
    expect(claimed).toHaveLength(1);
    // Already leased -> second claim returns empty
    expect(
      await store.claimSchedules({
        owner: "w2",
        token: "tok-2",
        now: 2_000,
        leaseUntil: 12_000,
        limit: 10,
        targets: ["emails"],
      }),
    ).toEqual([]);
    // Wrong token cannot write
    expect(
      await store.writeSchedule("s1", "wrong", {
        now: 2_000,
        state: {},
        wakeAt: 2_000,
        release: true,
      }),
    ).toBe(false);
    // Correct token writes & releases
    expect(
      await store.writeSchedule("s1", "tok-1", {
        now: 2_000,
        state: { ok: true },
        wakeAt: 61_000,
        release: true,
      }),
    ).toBe(true);
    const updated = await store.getSchedule("s1");
    expect(updated!.revision).toBe(2);
    expect(updated!.leaseUntil).toBeNull();

    // Revision-checked delete
    expect(await store.deleteSchedule("s1", 1)).toBe(false);
    expect(await store.deleteSchedule("s1", 2)).toBe(true);
    expect(await store.getSchedule("s1")).toBeNull();
  });

  it("produces occurrences with missed/overlap policies, pause/resume, limits, retries, and declared reconciliation", async () => {
    const store = new InMemoryScheduleStore();
    const clock = new ManualClock(Date.UTC(2026, 0, 1, 0, 0, 0));
    const fired: Array<{ id: string; at: number; payload: unknown }> = [];
    const cancelled: Array<{ id: string; reason: string }> = [];
    const skipped: ScheduleSkip[] = [];
    let activeRuns: string[] = [];
    let failFireOnce = false;

    const declaredMap = new Map<string, DeclaredSchedule>([
      [
        "digest",
        {
          id: "digest",
          target: "emails",
          version: 1,
          spec: parseSchedule({
            every: "1m",
            missed: "once",
            overlap: "buffer-one",
            limit: 3,
          }),
          payload: { kind: "digest" },
        },
      ],
    ]);

    const aes = new AesGcmPayloadCodec({
      keys: { k1: crypto.getRandomValues(new Uint8Array(32)) },
      current: "k1",
    });
    const scheduler = new Scheduler({
      store,
      clock,
      codecs: new PayloadCodecs([aes]),
      logger: silentLogger,
      targets: () => ["emails"],
      declared: () => declaredMap,
      fire: async ({ schedule, id, at }) => {
        if (failFireOnce) {
          failFireOnce = false;
          throw new Error("temporary store failure");
        }
        fired.push({ id, at, payload: schedule.payload });
        return { created: true };
      },
      running: async () => activeRuns,
      cancel: async (id, reason) => {
        cancelled.push({ id, reason });
        return true;
      },
      skipped: (_record, skip) => {
        skipped.push(skip);
      },
    });

    await scheduler.synced();

    // Stored payload in underlying store is encrypted; read() decodes it
    const raw = await store.getSchedule("digest");
    expect(isEncodedPayload(raw!.payload)).toBe(true);
    const decoded = await scheduler.read("digest");
    expect(decoded!.payload).toEqual({ kind: "digest" });

    // Advance 3 minutes -> missed: 'once' skips first two, fires the latest (00:03)
    clock.advance("3m");
    const prod1 = await scheduler.produce("w1", 30_000);
    expect(prod1.started).toBe(1);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.at).toBe(Date.UTC(2026, 0, 1, 0, 3));
    expect(skipped).toEqual([
      {
        reason: "missed",
        from: Date.UTC(2026, 0, 1, 0, 1),
        to: Date.UTC(2026, 0, 1, 0, 2),
      },
    ]);

    // Next minute while run is still active -> buffered due to overlap: 'buffer-one'
    activeRuns = [fired[0]!.id];
    clock.advance("1m");
    const prod2 = await scheduler.produce("w1", 30_000);
    expect(prod2.started).toBe(0);
    expect(
      scheduler.progress((await scheduler.read("digest"))!).bufferedAt,
    ).toBe(Date.UTC(2026, 0, 1, 0, 4));

    // Active run finishes -> buffered occurrence fires with transient fire failure retried on next tick
    activeRuns = [];
    failFireOnce = true;
    const prod3 = await scheduler.produce("w1", 30_000);
    expect(prod3.started).toBe(0); // failed attempt 1, backed off 1s
    clock.advance("2s");
    const prod4 = await scheduler.produce("w1", 30_000);
    expect(prod4.started).toBe(1);
    expect(fired[1]!.at).toBe(Date.UTC(2026, 0, 1, 0, 4));

    // Pause & resume skips occurrences during pause
    const paused = await scheduler.pause("digest");
    expect(paused!.paused).toBe(true);
    expect(scheduler.progress(paused!).nextAt).toBeNull();
    clock.advance("5m");
    expect((await scheduler.produce("w1", 30_000)).started).toBe(0);
    const resumed = await scheduler.resume("digest");
    expect(resumed!.paused).toBe(false);
    expect(scheduler.progress(resumed!).nextAt).toBe(
      Date.UTC(2026, 0, 1, 0, 10),
    );

    // Advance to 00:10 -> 3rd run hits limit: 3, nextAt becomes null
    clock.advance("1m");
    expect((await scheduler.produce("w1", 30_000)).started).toBe(1);
    expect(scheduler.progress((await scheduler.read("digest"))!)).toEqual({
      nextAt: null,
      runs: 3,
      bufferedAt: null,
    });

    // Overlap: 'cancel-previous' runtime schedule
    await scheduler.save("canceller", (cur) =>
      scheduler.changed(cur, {
        target: "emails",
        declared: false,
        spec: parseSchedule({ every: "1m", overlap: "cancel-previous" }),
        payload: { x: 1 },
      }),
    );
    activeRuns = ["prev-run-1"];
    clock.advance("1m");
    const prodCancel = await scheduler.produce("w1", 30_000);
    expect(prodCancel.started).toBe(1);
    expect(prodCancel.cancelled).toEqual(["prev-run-1"]);
    expect(cancelled[0]!.id).toBe("prev-run-1");

    // Removing declared schedule from code deletes it once stale (5 minutes without confirmation)
    declaredMap.clear();
    clock.advance("6m");
    await scheduler.produce("w1", 30_000);
    expect(await store.getSchedule("digest")).toBeNull();
  });
});

describe("core/workers/LeasedWorker", () => {
  it("validates worker options", () => {
    const noop = {
      claim: async () => [],
      renew: async () => true,
      execute: async () => {},
    };
    expect(() => new LeasedWorker({ ...noop, concurrency: 0 })).toThrow(
      TypeError,
    );
    expect(() => new LeasedWorker({ ...noop, pollInterval: 0 })).toThrow(
      TypeError,
    );
    expect(
      () =>
        new LeasedWorker({
          ...noop,
          leaseDuration: "1s",
          heartbeatInterval: "1s",
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new LeasedWorker({
          ...noop,
          leaseDuration: "1s",
          heartbeatInterval: "2s",
        }),
    ).toThrow(TypeError);
  });

  it("drains produced items round by round and tracks leases", async () => {
    const clock = new ManualClock();
    const queue: string[] = [];
    const executed: string[] = [];
    let produced = false;

    const worker = new LeasedWorker<string>({
      name: "test-worker",
      owner: "worker-1",
      concurrency: 2,
      leaseDuration: "30s",
      clock,
      produce: async () => {
        if (!produced) {
          produced = true;
          queue.push("a", "b", "c");
          return 3;
        }
        return 0;
      },
      claim: async (lease, limit) => {
        expect(lease.owner).toBe("worker-1");
        expect(lease.until).toBe(clock.now() + 30_000);
        return queue.splice(0, limit);
      },
      renew: async () => true,
      execute: async (item) => {
        executed.push(item);
      },
    });

    const total = await worker.drain();
    expect(total).toBe(3);
    expect(executed).toEqual(["a", "b", "c"]);
    expect(worker.running).toEqual([]);
  });

  it("aborts run.signal on lost lease, serializes renewals, and detaches stuck items on shutdown", async () => {
    let renewCount = 0;
    let leaseHeld = true;
    const errors: Array<{ stage: string; error: unknown }> = [];
    let capturedRun: LeasedRun | undefined;
    let releaseWork!: () => void;
    const workBlocked = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    let items = ["item-1"];

    const worker = new LeasedWorker<string>({
      concurrency: 1,
      pollInterval: "20ms",
      leaseDuration: "100ms",
      heartbeatInterval: "30ms",
      shutdownTimeout: "40ms",
      claim: async () => {
        const next = items;
        items = [];
        return next;
      },
      renew: async () => {
        renewCount++;
        return leaseHeld;
      },
      execute: async (_item, run) => {
        capturedRun = run;
        expect(await run.renew()).toBe(true);
        leaseHeld = false;
        expect(await run.renew()).toBe(false);
        expect(run.leaseLost).toBe(true);
        expect(run.signal.aborted).toBe(true);
        await workBlocked;
      },
      onError: (error, stage) => {
        errors.push({ stage, error });
      },
    });

    worker.start();
    worker.kick();
    // Wait until execute has observed lease loss and blocked on workBlocked
    for (let i = 0; i < 50 && !capturedRun?.leaseLost; i++) {
      await Bun.sleep(5);
    }
    expect(capturedRun?.leaseLost).toBe(true);
    expect(renewCount).toBeGreaterThanOrEqual(2);
    expect(worker.running).toEqual(["item-1"]);

    // Shutdown times out waiting for blocked item and detaches it
    await worker.shutdown();
    expect(capturedRun?.detached).toBe(true);
    releaseWork();
    await Bun.sleep(10);
    expect(errors).toEqual([]);
  });

  it("reports claim, produce, and execute errors to onError and carries on", async () => {
    const stages: string[] = [];
    let claimed = false;

    const worker = new LeasedWorker<string>({
      pollInterval: "10ms",
      leaseDuration: "100ms",
      heartbeatInterval: "30ms",
      produce: async () => {
        throw new Error("produce-err");
      },
      claim: async () => {
        if (!claimed) {
          claimed = true;
          return ["boom"];
        }
        throw new Error("claim-err");
      },
      renew: async () => true,
      execute: async () => {
        throw new Error("exec-err");
      },
      onError: (_err, stage) => {
        stages.push(stage);
      },
    });

    worker.start();
    for (
      let i = 0;
      i < 50 &&
      !(
        stages.includes("produce") &&
        stages.includes("execute") &&
        stages.includes("claim")
      );
      i++
    ) {
      await Bun.sleep(10);
    }
    await worker.shutdown();
    expect(stages).toContain("produce");
    expect(stages).toContain("execute");
    expect(stages).toContain("claim");
  });
});

// Compile-time type check ensuring ScheduleRecord & other core types are exported cleanly
const _typeCheck: ScheduleRecord | null = null;
void _typeCheck;
