/**
 * The MySQL error number of `error`, whichever client raised it, or `undefined` for an error that isn't MySQL's.
 */
export function mysqlErrorCode(error: unknown): number | undefined {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 8 && typeof current === "object" && current !== null;
    depth++
  ) {
    const candidate = current as {
      errno?: unknown;
      sqlMessage?: unknown;
      sqlState?: unknown;
      meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
      driverError?: unknown;
      cause?: unknown;
    };
    if (
      typeof candidate.errno === "number" &&
      candidate.errno > 0 &&
      (candidate.sqlMessage !== undefined || candidate.sqlState !== undefined)
    ) {
      return candidate.errno;
    }
    const original = candidate.meta?.driverAdapterError?.cause?.originalCode;
    if (typeof original === "string" && /^\d+$/.test(original)) {
      return Number(original);
    }
    current = candidate.driverError ?? candidate.cause;
  }
  return undefined;
}
