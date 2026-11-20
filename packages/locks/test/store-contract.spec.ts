import { describe, expect, it } from "bun:test";
import { InMemoryLockStore, ManualLockClock } from "../src/index";
import { lockStoreContract } from "../src/testing/index";

describe("InMemoryLockStore contract (@bunest/locks/testing)", () => {
  const clock = new ManualLockClock();
  const cases = lockStoreContract(() => new InMemoryLockStore({ clock }), {
    advanceTime: (ms) => clock.advance(ms),
    concurrent: true,
  });

  it("exposes all 16 contract cases when concurrent is enabled", () => {
    expect(cases.length).toBe(16);
  });

  for (const contractCase of cases) {
    it(contractCase.name, contractCase.run);
  }
});

describe("InMemoryLockStore extras & lockStoreContract validation", () => {
  it("peek() returns a copy of live locks and undefined once expired or released", async () => {
    const clock = new ManualLockClock(10_000);
    const store = new InMemoryLockStore({ clock });

    expect(store.peek("k")).toBeUndefined();
    const res = await store.acquire("k", "owner-1", 5_000);
    expect(res).toEqual({ acquired: true, fencingToken: 1 });

    const snapshot = store.peek("k");
    expect(snapshot).toEqual({
      owner: "owner-1",
      fencingToken: 1,
      expiresAt: 15_000,
    });

    // Mutating the returned copy must not affect internal store state.
    snapshot!.owner = "tampered";
    expect(store.peek("k")?.owner).toBe("owner-1");

    await clock.advance(5_000);
    expect(store.peek("k")).toBeUndefined();
  });

  it("periodically sweeps expired locks after 1000 operations", async () => {
    const clock = new ManualLockClock(0);
    const store = new InMemoryLockStore({ clock });

    for (let i = 0; i < 1005; i++) {
      await store.acquire(`sweep-${i}`, `owner-${i}`, 100);
      if (i === 500) {
        await clock.advance(200);
      }
    }
    expect(store.peek("sweep-0")).toBeUndefined();
    expect(store.peek("sweep-1004")).toBeDefined();
  });

  it("validates lockStoreContract options", () => {
    const casesNoConcurrent = lockStoreContract(() => new InMemoryLockStore());
    expect(casesNoConcurrent.length).toBe(10);

    expect(() =>
      lockStoreContract(() => new InMemoryLockStore(), {
        concurrent: { callers: 1 },
      }),
    ).toThrow(RangeError);

    expect(() =>
      lockStoreContract(() => new InMemoryLockStore(), { ttl: 50 }),
    ).toThrow(RangeError);
  });
});
