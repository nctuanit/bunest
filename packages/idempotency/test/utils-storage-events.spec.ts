import { StreamableFile } from "@bunest/common";
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { subscribe as dcSubscribe, unsubscribe as dcUnsubscribe } from "node:diagnostics_channel";
import { withDurationsInMs } from "../src/decorators/idempotent.decorator";
import { UnreadableRecordError } from "../src/errors/unreadable-record.error";
import { UnreplayableResult } from "../src/errors/unreplayable-result.error";
import {
  IdempotencyEvents,
  IdempotencyStorage,
  IdempotencyStoreTimeoutError,
  InMemoryIdempotencyStore,
  type IdempotencyEvent,
  type IdempotencyStoredResponse,
} from "../src/index";
import { LOCK_STORAGE } from "../src/storage/idempotency.storage";
import { toMs } from "../src/utils/duration.util";
import { plaintextCodec, ResponseCipher } from "../src/utils/encryption.util";
import { canonicalJson, sha256 } from "../src/utils/fingerprint.util";
import {
  decodeResult,
  encodeResult,
  unreplayableReason,
} from "../src/utils/result.util";

describe("duration.util & withDurationsInMs", () => {
  it("converts numbers and duration strings accurately", () => {
    expect(toMs(0)).toBe(0);
    expect(toMs(250)).toBe(250);
    expect(toMs("250ms")).toBe(250);
    expect(toMs("30s")).toBe(30_000);
    expect(toMs("1.5s")).toBe(1_500);
    expect(toMs("15m")).toBe(900_000);
    expect(toMs("6h")).toBe(21_600_000);
    expect(toMs("3d")).toBe(259_200_000);
    expect(toMs("1w")).toBe(604_800_000);
  });

  it("rejects invalid durations and enforces minimums", () => {
    expect(() => toMs(-1)).toThrow(TypeError);
    expect(() => toMs(Number.NaN)).toThrow(TypeError);
    expect(() => toMs("10x" as never)).toThrow(TypeError);

    const converted = withDurationsInMs(
      { ttl: "10s", retryAfter: 0 },
      "@Idempotent()",
    );
    expect(converted.ttl as unknown).toBe(10_000);
    expect(converted.retryAfter).toBe(0);
    expect(() => withDurationsInMs({ ttl: 0 }, "@Idempotent()")).toThrow(
      TypeError,
    );
    expect(() => withDurationsInMs({ lockTtl: 0 }, "@Idempotent()")).toThrow(
      TypeError,
    );
  });
});

describe("fingerprint.util", () => {
  it("produces deterministic canonical JSON regardless of object key order", () => {
    const a = canonicalJson({ b: 2, a: 1, nested: { y: true, x: "hi" } });
    const b = canonicalJson({ nested: { x: "hi", y: true }, a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("handles Dates, BigInts, binary buffers, Maps, Sets, streams, promises, and cycles", () => {
    const cyclic: Record<string, unknown> = { id: 1 };
    cyclic.self = cyclic;

    expect(canonicalJson(123n)).toBe("123n");
    expect(canonicalJson(new Date("2026-01-01T00:00:00.000Z"))).toBe(
      '"2026-01-01T00:00:00.000Z"',
    );
    expect(canonicalJson(new Set(["b", "a"]))).toBe(
      canonicalJson(new Set(["a", "b"])),
    );
    expect(
      canonicalJson(
        new Map([
          ["b", 2],
          ["a", 1],
        ]),
      ),
    ).toBe(
      canonicalJson(
        new Map([
          ["a", 1],
          ["b", 2],
        ]),
      ),
    );
    expect(canonicalJson(Buffer.from("hello"))).not.toBe(
      canonicalJson(Buffer.from("world")),
    );
    expect(canonicalJson(Promise.resolve(1))).toBe("<promise>");
    expect(canonicalJson(new ReadableStream())).toBe("<stream>");
    expect(canonicalJson(cyclic)).toBe('{"id":1,"self":<cycle>}');
  });

  it("length-prefixes sha256 parts to prevent boundary collisions", () => {
    expect(sha256("ab", "c")).not.toBe(sha256("a", "bc"));
    expect(sha256("a", "b")).toBe(sha256("a", "b"));
  });
});

describe("result.util", () => {
  it("round-trips Dates, BigInts, Buffers, Maps, Sets, and __idempotencyType objects", () => {
    const original = {
      at: new Date("2026-09-22T10:00:00.000Z"),
      badDate: new Date("invalid"),
      big: 9007199254740993n,
      bytes: new Uint8Array([1, 2, 3, 255]),
      map: new Map([["k", new Date("2026-01-01T00:00:00.000Z")]]),
      set: new Set([1n, 2n]),
      fakeTag: { __idempotencyType: "Date", value: "spoofed" },
      nested: [undefined, 42, Number.NaN],
    };
    const encoded = JSON.parse(JSON.stringify(encodeResult(original)));
    const decoded = decodeResult(encoded) as Record<string, unknown>;

    expect(decoded.at).toBeInstanceOf(Date);
    expect((decoded.at as Date).toISOString()).toBe("2026-09-22T10:00:00.000Z");
    expect(Number.isNaN((decoded.badDate as Date).getTime())).toBe(true);
    expect(decoded.big).toBe(9007199254740993n);
    expect(Buffer.from(decoded.bytes as Uint8Array)).toEqual(
      Buffer.from([1, 2, 3, 255]),
    );
    expect(decoded.map).toBeInstanceOf(Map);
    expect((decoded.map as Map<string, Date>).get("k")).toBeInstanceOf(Date);
    expect(decoded.set).toEqual(new Set([1n, 2n]));
    expect(decoded.fakeTag).toEqual({
      __idempotencyType: "Date",
      value: "spoofed",
    });
    expect(decoded.nested).toEqual([null, 42, null]);
  });

  it("handles strict mode getters, functions, promises, and circular references", () => {
    class Model {
      constructor(public readonly x: number) {}
      get doubled(): number {
        return this.x * 2;
      }
    }
    expect(encodeResult(new Model(5), { strict: true })).toEqual({
      x: 5,
      doubled: 10,
    });
    expect(() =>
      encodeResult({ fn: () => 1 }, { strict: true }),
    ).toThrow(UnreplayableResult);
    expect(() =>
      encodeResult({ p: Promise.resolve(1) }, { strict: true }),
    ).toThrow(UnreplayableResult);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => encodeResult(cyclic)).toThrow(UnreplayableResult);
  });

  it("identifies unreplayable results", () => {
    expect(unreplayableReason(new StreamableFile(Buffer.from("x")))).toContain(
      "StreamableFile",
    );
    expect(unreplayableReason(new ReadableStream())).toContain("stream");
    expect(unreplayableReason(new Response("ok"))).toContain("Response");
    expect(
      unreplayableReason({
        async *[Symbol.asyncIterator]() {
          yield 1;
        },
      }),
    ).toContain("async iterable");
    expect(unreplayableReason({ ok: true })).toBeUndefined();
  });
});

describe("ResponseCipher & plaintextCodec", () => {
  const sample: IdempotencyStoredResponse = {
    status: 201,
    headers: { location: "/orders/1" },
    body: { id: "ord_1", amount: 500 },
  };

  it("seals and opens with AES-256-GCM and supports key rotation", () => {
    const oldKey = "a".repeat(32);
    const newKey = randomBytes(32);

    const oldCipher = new ResponseCipher({ keys: [oldKey] });
    const sealed = oldCipher.seal("user1:key1", sample);
    expect(sealed.sealed.startsWith("v1.")).toBe(true);
    expect(sealed.sealed.split(".")).toHaveLength(5);

    const rotatedCipher = new ResponseCipher({ keys: [newKey, oldKey] });
    expect(rotatedCipher.open("user1:key1", sealed)).toEqual(sample);

    // New records are sealed with the first (newest) key
    const sealedNew = rotatedCipher.seal("user1:key2", sample);
    expect(rotatedCipher.open("user1:key2", sealedNew)).toEqual(sample);
    expect(() => oldCipher.open("user1:key2", sealedNew)).toThrow(
      UnreadableRecordError,
    );
  });

  it("binds AAD to storeKey and rejects tampered or plaintext records", () => {
    const cipher = new ResponseCipher({ keys: [randomBytes(32)] });
    const sealed = cipher.seal("user1:key1", sample);

    // Wrong storeKey fails GCM AAD authentication
    expect(() => cipher.open("user2:key1", sealed)).toThrow(
      UnreadableRecordError,
    );

    // Tampered ciphertext fails authentication
    const parts = sealed.sealed.split(".");
    const ctBytes = Buffer.from(parts[3]!, "base64url");
    ctBytes[0] = ctBytes[0]! ^ 0xff;
    parts[3] = ctBytes.toString("base64url");
    expect(() =>
      cipher.open("user1:key1", { sealed: parts.join(".") }),
    ).toThrow(UnreadableRecordError);

    // Plaintext rejected when encryption enabled
    expect(() => cipher.open("user1:key1", sample)).toThrow(
      UnreadableRecordError,
    );

    // Sealed rejected when encryption disabled
    expect(() => plaintextCodec.open("user1:key1", sealed)).toThrow(
      UnreadableRecordError,
    );
    expect(plaintextCodec.open("user1:key1", sample)).toEqual(sample);
  });

  it("validates key material at startup", () => {
    expect(() => new ResponseCipher({ keys: [] })).toThrow(TypeError);
    expect(() => new ResponseCipher({ keys: ["too-short"] })).toThrow(
      TypeError,
    );
    expect(() => new ResponseCipher({ keys: [` ${"a".repeat(32)}`] })).toThrow(
      TypeError,
    );
    expect(() => new ResponseCipher({ keys: [Buffer.alloc(16)] })).toThrow(
      TypeError,
    );
  });
});

describe("IdempotencyStorage", () => {
  it("registers a custom store, supports { replace: true }, and locks on first read or LOCK_STORAGE", () => {
    const storage = new IdempotencyStorage();
    const s1 = new InMemoryIdempotencyStore();
    const s2 = new InMemoryIdempotencyStore();

    storage.registerSource(s1);
    expect(() => storage.registerSource(s2)).toThrow(/already did/);
    storage.registerSource(s2, { replace: true });

    expect(storage.source).toBe(s2);
    expect(() => storage.registerSource(s1, { replace: true })).toThrow(
      /registered after/,
    );
  });

  it("validates invalid store objects", () => {
    const storage = new IdempotencyStorage();
    expect(() => storage.registerSource(null as never)).toThrow(TypeError);
    expect(() =>
      storage.registerSource({ acquire: () => {} } as never),
    ).toThrow(TypeError);
  });

  it("enforces NODE_ENV=production guard unless allowInMemoryStorage is true", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const strictStorage = new IdempotencyStorage({});
      expect(() => strictStorage[LOCK_STORAGE]()).toThrow(/NODE_ENV is "production"/);

      const allowedStorage = new IdempotencyStorage({
        allowInMemoryStorage: true,
      });
      expect(allowedStorage.source).toBeInstanceOf(InMemoryIdempotencyStore);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe("IdempotencyEvents (zero-RxJS Subscribable + AsyncIterable + diagnostics_channel)", () => {
  it("delivers events to subscribe(), async iterators, and diagnostics_channel, and completes on shutdown", async () => {
    const events = new IdempotencyEvents();
    const receivedSub: IdempotencyEvent[] = [];
    let completed = false;

    const sub = events.events$.subscribe({
      next: (e) => receivedSub.push(e),
      complete: () => {
        completed = true;
      },
    });

    const receivedDc: unknown[] = [];
    const dcHandler = (msg: unknown) => receivedDc.push(msg);
    dcSubscribe("nestjs:idempotency:replayed", dcHandler);

    const asyncCollected: IdempotencyEvent[] = [];
    const iterTask = (async () => {
      for await (const ev of events.events$) {
        asyncCollected.push(ev);
      }
    })();

    const ev1: IdempotencyEvent = {
      type: "replayed",
      context: "http",
      handler: "PaymentsController.create",
      key: "k1",
      status: 201,
    };
    const ev2: IdempotencyEvent = {
      type: "rejected",
      context: "http",
      handler: "PaymentsController.create",
      code: "IDEMPOTENCY_KEY_REUSED",
      status: 422,
      key: "k1",
    };

    events.emit(ev1);
    events.emit(ev2);
    events.onApplicationShutdown();

    await iterTask;
    sub.unsubscribe();
    dcUnsubscribe("nestjs:idempotency:replayed", dcHandler);

    expect(receivedSub).toEqual([ev1, ev2]);
    expect(asyncCollected).toEqual([ev1, ev2]);
    expect(receivedDc).toEqual([ev1]);
    expect(completed).toBe(true);

    // Subscribing after shutdown completes immediately
    let lateCompleted = false;
    events.events$.subscribe({ complete: () => (lateCompleted = true) });
    expect(lateCompleted).toBe(true);
  });

  it("constructs IdempotencyStoreTimeoutError with method and timeout properties", () => {
    const err = new IdempotencyStoreTimeoutError("acquire", 500);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("IdempotencyStoreTimeoutError");
    expect(err.method).toBe("acquire");
    expect(err.timeout).toBe(500);
    expect(err.message).toContain("acquire");
    expect(err.message).toContain("500");
  });
});
