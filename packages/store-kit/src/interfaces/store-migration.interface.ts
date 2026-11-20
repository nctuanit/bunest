/**
 * One version of a store's schema. Migrations only ever add (tables, nullable or defaulted columns, indexes).
 * Downgrades aren't supported.
 */
export interface StoreMigration {
  /** 1, 2, 3...: the schema's version once it's applied. */
  version: number;
  /** Recorded with the version: letters, digits and underscores (`initial`, `delivery_attempts`). */
  name: string;
  /**
   * Its statements, for the schema (`s`, quoted: `"nest_outbox"`). Each runs on its own, in the migration's
   * transaction.
   */
  up(s: string): string[];
}
