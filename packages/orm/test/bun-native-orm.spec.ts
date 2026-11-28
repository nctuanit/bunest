import { describe, expect, it } from "bun:test";
import { executeWithTransactionRetries } from "../src/transaction-hooks";

describe("Wave 4 — @bunest/orm Bun 1.4.5 Native APIs (Bun.sleep retry backoff)", () => {
  it("executeWithTransactionRetries retries retryable serialization/lock errors with Bun.sleep backoff and succeeds", async () => {
    const seenAttempts: number[] = [];
    const seenFinals: boolean[] = [];

    const result = await executeWithTransactionRetries(
      3,
      2,
      async (attempt, isFinal) => {
        seenAttempts.push(attempt);
        seenFinals.push(isFinal);
        if (attempt < 2) {
          const err = Object.assign(new Error("could not serialize access"), {
            code: "40001",
          });
          throw err;
        }
        return "committed";
      },
    );

    expect(result).toBe("committed");
    expect(seenAttempts).toEqual([0, 1, 2]);
    expect(seenFinals).toEqual([false, false, false]);
  });

  it("executeWithTransactionRetries fails immediately on non-retryable errors", async () => {
    let attempts = 0;
    await expect(
      executeWithTransactionRetries(3, 2, async () => {
        attempts += 1;
        throw new Error("unique constraint violated");
      }),
    ).rejects.toThrow("unique constraint violated");
    expect(attempts).toBe(1);
  });

  it("executeWithTransactionRetries rethrows once maxRetries are exhausted", async () => {
    const finals: boolean[] = [];
    await expect(
      executeWithTransactionRetries(2, 1, async (_attempt, isFinal) => {
        finals.push(isFinal);
        throw Object.assign(new Error("SQLITE_BUSY"), { code: "SQLITE_BUSY" });
      }),
    ).rejects.toThrow("SQLITE_BUSY");
    expect(finals).toEqual([false, false, true]);
  });
});
