import type {
  OrmDialect,
  OrmDriverLike,
  OrmQueryExecutor,
  OrmQueryResult,
  OrmTransactionOptions,
} from "../types";

/**
 * TypeORM-style Master / Read-Replica router wrapping any Bun-native `OrmDriver`:
 * - Routes read-only `SELECT` / `WITH` / `PRAGMA` / `EXPLAIN` queries round-robin
 *   across read replicas (`slaves`) when outside a transaction.
 * - Routes ALL writes (`INSERT`, `UPDATE`, `DELETE`, DDL), `execute()`, and EVERY
 *   query inside an active `transaction()` strictly to `master`!
 */
export class ReplicatedOrmDriver implements OrmDriverLike {
  readonly dialect: OrmDialect;
  readonly driverKind = "replicated";

  private slaveCursor = 0;

  constructor(
    readonly master: OrmDriverLike,
    readonly slaves: readonly OrmDriverLike[],
    private readonly defaultMode: "master" | "slave" = "slave",
  ) {
    this.dialect = master.dialect;
  }

  get isConnected(): boolean {
    return this.master.isConnected;
  }

  async connect(): Promise<void> {
    await this.master.connect();
    for (const slave of this.slaves) {
      await slave.connect();
    }
  }

  async close(): Promise<void> {
    await this.master.close();
    for (const slave of this.slaves) {
      await slave.close();
    }
  }

  async ping(): Promise<boolean> {
    if (this.master.ping) {
      return await this.master.ping();
    }
    return this.master.isConnected;
  }

  isInTransaction(): boolean {
    return this.master.isInTransaction();
  }

  async setForeignKeysEnabled(enabled: boolean): Promise<void> {
    if (this.master.setForeignKeysEnabled) {
      await this.master.setForeignKeysEnabled(enabled);
    }
  }

  private isReadOnlySql(sql: string): boolean {
    const upper = sql.trimStart().toUpperCase();
    return (
      (upper.startsWith("SELECT") ||
        upper.startsWith("WITH") ||
        upper.startsWith("EXPLAIN") ||
        upper.startsWith("SHOW")) &&
      !/\bFOR\s+UPDATE\b/i.test(upper) &&
      !/\bRETURNING\b/i.test(upper)
    );
  }

  private pickReadNode(): OrmDriverLike {
    if (
      this.slaves.length === 0 ||
      this.defaultMode === "master" ||
      this.master.isInTransaction()
    ) {
      return this.master;
    }
    const idx = this.slaveCursor % this.slaves.length;
    this.slaveCursor = (this.slaveCursor + 1) % this.slaves.length;
    return this.slaves[idx]!;
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<OrmQueryResult<T>> {
    const target = this.isReadOnlySql(sql) ? this.pickReadNode() : this.master;
    return await target.query<T>(sql, params);
  }

  async execute(
    sql: string,
    params?: readonly unknown[],
  ): Promise<OrmQueryResult> {
    return await this.master.execute(sql, params);
  }

  get dataSourceName(): string | undefined {
    return this.master.dataSourceName;
  }

  get supportsManagedTransactions(): boolean {
    return this.master.supportsManagedTransactions === true;
  }

  async transaction<T>(
    run: (executor: OrmQueryExecutor) => Promise<T> | T,
    options?: OrmTransactionOptions,
  ): Promise<T> {
    return await this.master.transaction(() => run(this.master), options);
  }
}
