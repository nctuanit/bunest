/**
 * Normalized query result shape shared across Bunest database adapters.
 */
export interface QueryResult<T = Record<string, unknown>> {
  readonly rows: readonly T[];
  readonly rowCount: number;
  readonly affectedRows?: number;
  readonly lastInsertRowid?: number | bigint | string | null;
  readonly command?: string | null;
}

/**
 * Active transaction context propagated via `AsyncLocalStorage`.
 */
export interface TransactionContext<TClient = unknown> {
  readonly id: string;
  readonly connectionName: string;
  readonly depth: number;
  readonly savepointName?: string;
  readonly isNested: boolean;
  readonly client: TClient;
}

/**
 * Unified database adapter contract for Bunest persistence modules.
 */
export interface DatabaseAdapter<TClient = unknown> {
  readonly connectionName: string;
  readonly isClosed: boolean;

  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[] | Record<string, unknown>,
  ): Promise<QueryResult<T>> | QueryResult<T>;

  transaction<T>(
    fn: (tx: TransactionContext<TClient>) => Promise<T> | T,
  ): Promise<T>;

  getCurrentTransaction(): TransactionContext<TClient> | undefined;

  healthCheck(): Promise<boolean> | boolean;

  close(): Promise<void> | void;
}

/**
 * Schema migration definition compatible across Bunest database runners.
 */
export interface MigrationDefinition<TExecutor = unknown> {
  readonly id: string;
  readonly name?: string;
  readonly up: string | ((executor: TExecutor) => Promise<void> | void);
  readonly down?: string | ((executor: TExecutor) => Promise<void> | void);
  readonly transactional?: boolean;
}

/**
 * Metadata record for an applied migration.
 */
export interface AppliedMigration {
  readonly id: string;
  readonly name: string;
  readonly batch: number;
  readonly appliedAt: string;
}

/**
 * Summary of applied and pending migrations.
 */
export interface MigrationStatus<TExecutor = unknown> {
  readonly applied: readonly AppliedMigration[];
  readonly pending: readonly MigrationDefinition<TExecutor>[];
}

/**
 * Unified migration runner contract for Bunest database modules.
 */
export interface MigrationRunner<TExecutor = unknown> {
  up(
    migrations?: readonly MigrationDefinition<TExecutor>[],
    options?: { steps?: number },
  ): Promise<readonly AppliedMigration[]>;

  down(
    migrations?: readonly MigrationDefinition<TExecutor>[],
    options?: { steps?: number; all?: boolean },
  ): Promise<readonly AppliedMigration[]>;

  status(
    migrations?: readonly MigrationDefinition<TExecutor>[],
  ): Promise<MigrationStatus<TExecutor>> | MigrationStatus<TExecutor>;
}
