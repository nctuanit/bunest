import type { SqlExecutorContractTarget } from "./contract.types";

/** A random pause of up to 4 ms, to shuffle the calls a race starts together. */
export const jitter = (): Promise<void> => Bun.sleep(Math.random() * 4);

export function show(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v) =>
      v === undefined ? "<undefined>" : typeof v === "bigint" ? `${v}n` : v,
    ) ?? String(value)
  );
}

export function equal(actual: unknown, expected: unknown, label: string): void {
  if (!Bun.deepEquals(actual, expected, true)) {
    throw new Error(
      `${label}: expected ${show(expected)}, got ${show(actual)}`,
    );
  }
}

/** What `promise` rejects with; throws when it resolves. */
export async function rejection(
  promise: Promise<unknown>,
  label: string,
): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error(`${label}: expected a rejection`);
}

/** The error's message and its causes'. */
export function messages(error: unknown): string {
  const parts: string[] = [];
  for (
    let current: unknown = error, depth = 0;
    current !== undefined && current !== null && depth < 5;
    current = (current as { cause?: unknown }).cause, depth++
  ) {
    parts.push(String((current as { message?: unknown }).message ?? current));
  }
  return parts.join(" / ");
}

export function isTypeError(error: unknown, label: string): void {
  if (!(error instanceof TypeError)) {
    throw new Error(
      `${label}: expected a TypeError, got ${error instanceof Error ? `${error.name}: ${error.message}` : show(error)}`,
    );
  }
}

/**
 * Whether the target's executor sets `native` (optional in `SqlTransaction`).
 */
export async function setsNative({
  executor,
  transaction,
}: SqlExecutorContractTarget): Promise<boolean> {
  const inside = await executor.transaction(async (tx) => {
    if (tx.native === tx) {
      throw new Error(
        "the native of a transaction transaction() opened: expected the client's own transaction object, got that SqlTransaction itself",
      );
    }
    return tx.native !== undefined;
  });
  const outside = await transaction(async (tx) => {
    const { native } = executor.wrapTransaction(tx);
    return native === undefined ? "none" : native === tx ? "given" : "another";
  });
  if (!inside && outside === "none") {
    return false;
  }
  if (!inside) {
    throw new Error(
      "the native of a transaction transaction() opened: expected the client's own transaction object, as wrapTransaction() sets one, got none",
    );
  }
  if (outside !== "given") {
    throw new Error(
      `wrapTransaction(x).native: expected x, as it was given, got ${outside === "none" ? "none, though transaction()'s transactions set one" : "another object"}`,
    );
  }
  return true;
}
