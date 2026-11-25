import { describe, expect, it } from "bun:test";
import { InMemoryIdempotencyStore } from "../../src/idempotency/index";
import { idempotencyStoreContract } from "../../src/idempotency/testing/index";

describe("InMemoryIdempotencyStore — idempotencyStoreContract", () => {
  const cases = idempotencyStoreContract(() => new InMemoryIdempotencyStore(), {
    concurrent: true,
    lockTtl: 120,
  });

  for (const c of cases) {
    it(c.name, c.run);
  }
});

describe("InMemoryIdempotencyStore helpers & contract validation", () => {
  it("supports peek(), size, clear(), and expiry sweeping", async () => {
    const store = new InMemoryIdempotencyStore();
    expect(store.size).toBe(0);
    expect(store.peek("k1")).toBeUndefined();

    await store.acquire("k1", "owner-1", "fp-1", 5_000);
    expect(store.size).toBe(1);
    const lockEntry = store.peek("k1");
    expect(lockEntry?.state).toBe("in-flight");

    await store.complete(
      "k1",
      "owner-1",
      { status: 201, headers: {}, body: { ok: true } },
      5_000,
    );
    const completedEntry = store.peek("k1");
    expect(completedEntry?.state).toBe("completed");

    // Expired entry is filtered by peek() and size
    await store.acquire("k2", "owner-2", "fp-2", 5);
    await new Promise((r) => setTimeout(r, 15));
    expect(store.peek("k2")).toBeUndefined();
    expect(store.size).toBe(1);

    store.clear();
    expect(store.size).toBe(0);
  });

  it("validates idempotencyStoreContract options", () => {
    expect(() =>
      idempotencyStoreContract(() => new InMemoryIdempotencyStore(), {
        lockTtl: 2,
      }),
    ).toThrow(RangeError);

    expect(() =>
      idempotencyStoreContract(() => new InMemoryIdempotencyStore(), {
        concurrent: { callers: 1 },
      }),
    ).toThrow(RangeError);

    expect(() =>
      idempotencyStoreContract(() => new InMemoryIdempotencyStore(), {
        lockTtl: 15 * 24 * 60 * 60 * 1000,
      }),
    ).toThrow(RangeError);
  });
});
