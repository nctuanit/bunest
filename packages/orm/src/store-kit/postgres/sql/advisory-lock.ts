import type { SqlTransaction } from "../../interfaces/sql-executor.interface";

/**
 * What `advisoryLock()` takes besides the keys.
 */
export interface AdvisoryLockOptions {
  /** Shared locks exclude exclusive ones, not each other. Default: `false` (exclusive). */
  shared?: boolean;
  /**
   * Takes the locks in PostgreSQL's other advisory lock space, `pg_advisory_xact_lock(hashtext(namespace),
   * hashtext(key))`: the two-key form's locks never meet the one-key form's, nor another namespace's.
   */
  namespace?: string;
}

/**
 * Takes transaction-scoped advisory locks (`pg_advisory_xact_lock(hashtext(key))`), held until the transaction ends.
 * Several keys are taken by one statement, in the order of their lock numbers (their hashes), each lock once.
 */
export async function advisoryLock(
  transaction: SqlTransaction,
  keys: string | readonly string[],
  options: AdvisoryLockOptions = {},
): Promise<void> {
  const { namespace } = options;
  if (namespace !== undefined && typeof namespace !== "string") {
    throw new TypeError(
      `advisoryLock() takes a string namespace, not ${JSON.stringify(namespace)}.`,
    );
  }
  const lock = `pg_advisory_xact_lock${options.shared ? "_shared" : ""}`;
  const unique = typeof keys === "string" ? [keys] : [...new Set(keys)];
  if (unique.length === 0) {
    return;
  }
  if (unique.length === 1) {
    await transaction.query(
      namespace === undefined
        ? `SELECT ${lock}(hashtext($1::text))::text AS locked`
        : `SELECT ${lock}(hashtext($1::text), hashtext($2::text))::text AS locked`,
      namespace === undefined ? unique : [namespace, unique[0]],
    );
    return;
  }
  await transaction.query(
    `SELECT ${namespace === undefined ? `${lock}(k.h)` : `${lock}(hashtext($2::text), k.h)`}::text AS locked
FROM (SELECT DISTINCT hashtext(t.key) AS h FROM jsonb_array_elements_text($1::text::jsonb) AS t(key)) AS k
ORDER BY k.h`,
    namespace === undefined
      ? [JSON.stringify(unique)]
      : [JSON.stringify(unique), namespace],
  );
}
