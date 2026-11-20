import { AsyncLocalStorage } from "node:async_hooks";
import { SQL, type ReservedSQL, type TransactionSQL } from "bun";
import {
  DecoratorRegistry,
  Injectable,
  hasEntitySchema,
  type Abstract,
  type OnModuleDestroy,
  type OnModuleInit,
  type Type,
} from "@bunest/common";
import type {
  DatabaseAdapter,
  QueryResult,
  TransactionContext,
} from "./contracts";
import { normalizeSqlDialect } from "./identifiers";
import type {
  SqlMigrationExecutor,
  SqlModuleForRootInput,
  SqlModuleOptions,
  SqlQueryEvent,
  SqlRepositoryMetadata,
  SqlTagFunction,
  SqlTransactionOptions,
} from "./interfaces";
import { generateCreateTableSql } from "./schema-generator";
import { SqlMigrationRunner } from "./sql-migration-runner";
import { DEFAULT_SQL_CONNECTION } from "./tokens";

export type { SqlTagFunction } from "./interfaces";

const SAFE_SAVEPOINT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeSqlInput(input?: SqlModuleForRootInput): SqlModuleOptions {
  if (input === undefined) {
    return {};
  }
  if (typeof input === "string" || input instanceof URL) {
    return { url: input };
  }
  return input;
}

function createBunSqlClient(options: SqlModuleOptions): SQL {
  if (options.client) {
    return options.client;
  }
  if (options.url !== undefined && options.options !== undefined) {
    const {
      url: _ignoredUrl,
      filename: _ignoredFilename,
      ...rest
    } = options.options as Bun.SQL.SQLiteOptions & Bun.SQL.PostgresOrMySQLOptions;
    return new SQL(options.url, rest);
  }
  if (options.url !== undefined) {
    return new SQL(options.url);
  }
  if (options.options !== undefined) {
    return new SQL(options.options);
  }
  return new SQL();
}

function isSqliteAdapterClient(client: SQL): boolean {
  try {
    const opts = client.options as { adapter?: string } | undefined;
    return opts?.adapter === "sqlite";
  } catch {
    return false;
  }
}

/**
 * Bunest service wrapping Bun's native `Bun.SQL` client (PostgreSQL, MySQL/MariaDB, and SQLite)
 * with:
 * - ALS-propagated tagged template (`sqlService.sql\`...\``) and parameterized `unsafe()` / `simple()` execution
 * - Automatic nested `SAVEPOINT` transactions via `AsyncLocalStorage` with per-parent savepoint serialization
 * - FIFO transaction serialization for single-connection SQLite URLs (pooled concurrency for Postgres/MySQL)
 * - Dedicated connection reservation (`reserve()`), `connect()`, `queryScalar()`, `autoMigrate`, and `onQuery` hook
 * - `healthCheck()` (`SELECT 1`) and graceful `close()` on `onModuleDestroy()`
 */
@Injectable()
export class SqlService
  implements
    DatabaseAdapter<SQL>,
    SqlMigrationExecutor,
    OnModuleInit,
    OnModuleDestroy,
    AsyncDisposable
{
  public readonly connectionName: string;

  /**
   * Tagged template & SQL helper function that automatically routes queries through
   * the active `AsyncLocalStorage` transaction or savepoint when called inside `transaction()`.
   */
  public readonly sql: SqlTagFunction;

  private readonly client: SQL;
  private readonly options: SqlModuleOptions;
  private readonly onQueryHook?: (info: SqlQueryEvent) => void;
  private readonly isSqliteClient: boolean;
  private readonly txStorage =
    new AsyncLocalStorage<TransactionContext<TransactionSQL>>();
  private readonly childSavepointLocks = new WeakMap<
    TransactionContext<TransactionSQL>,
    Promise<void>
  >();

  private txLockTail: Promise<void> = Promise.resolve();
  private txSeq = 0;
  private savepointSeq = 0;
  private closed = false;
  private readonly syncedEntities = new Set<Function>();

  constructor(input?: SqlModuleForRootInput) {
    this.options = normalizeSqlInput(input);
    this.connectionName = this.options.name ?? DEFAULT_SQL_CONNECTION;
    this.onQueryHook = this.options.onQuery;
    this.client = createBunSqlClient(this.options);
    this.isSqliteClient = isSqliteAdapterClient(this.client);

    this.sql = ((...args: unknown[]) => {
      const active = this.getActiveClient();
      return (active as unknown as (...callArgs: unknown[]) => unknown)(
        ...args,
      );
    }) as SqlTagFunction;
  }

  get raw(): SQL {
    this.assertOpen();
    return this.client;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get adapter(): string | undefined {
    try {
      const opts = this.client.options as { adapter?: string } | undefined;
      return opts?.adapter;
    } catch {
      return undefined;
    }
  }

  /**
   * Returns the active `Bun.SQL` client (current transaction/savepoint client if inside
   * `transaction()`, otherwise the root pool/client).
   */
  getActiveClient(): SQL {
    this.assertOpen();
    return this.txStorage.getStore()?.client ?? this.client;
  }

  getCurrentTransaction(): TransactionContext<TransactionSQL> | undefined {
    return this.txStorage.getStore();
  }

  isInTransaction(): boolean {
    return this.txStorage.getStore() !== undefined;
  }

  /**
   * Explicitly establishes a connection to the underlying database.
   */
  async connect(): Promise<void> {
    this.assertOpen();
    await this.client.connect();
  }

  /**
   * Reserves a dedicated pooled connection (for `SET LOCAL`, temp tables, `LISTEN`, etc.).
   * Caller is responsible for calling `reserved.release()` (or using `await using`).
   */
  async reserve(): Promise<ReservedSQL> {
    this.assertOpen();
    return await this.client.reserve();
  }

  /**
   * Executes a raw parameterized SQL string on the active client (transaction-aware).
   * Placeholders match the underlying driver (`$1` on Postgres, `?` on MySQL, either or named on SQLite).
   */
  unsafe<T = Record<string, unknown>>(
    query: string,
    params?: readonly unknown[] | Record<string, unknown>,
  ): Bun.SQL.Query<T[]> {
    const active = this.getActiveClient();
    if (params === undefined) {
      return active.unsafe<T[]>(query);
    }
    const normalized = Array.isArray(params) ? [...params] : params;
    return active.unsafe<T[]>(
      query,
      normalized as unknown[] | Record<string, unknown>,
    );
  }

  /**
   * Executes raw SQL (including multi-statement DDL scripts on PostgreSQL) using
   * `Bun.SQL`'s simple query protocol (`.simple()`) when supported by the underlying driver.
   */
  async simple<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    return await this.measureQuery(sql, async () => {
      const query = this.unsafe<T>(sql) as Bun.SQL.Query<T[]> & {
        simple?: () => Promise<T[]>;
      };
      const result =
        typeof query.simple === "function" ? await query.simple() : await query;
      return Array.isArray(result) ? ([...result] as T[]) : [];
    });
  }

  /**
   * Executes a parameterized query and returns a normalized `QueryResult<T>`
   * satisfying the unified `DatabaseAdapter` contract.
   */
  async query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[] | Record<string, unknown>,
  ): Promise<QueryResult<T>> {
    return await this.measureQuery(sql, async () => {
      const result = await this.unsafe<T>(sql, params);
      const rows = Array.isArray(result) ? ([...result] as T[]) : [];
      const affectedRows =
        typeof result.affectedRows === "number"
          ? result.affectedRows
          : undefined;
      return {
        rows,
        rowCount: typeof result.count === "number" ? result.count : rows.length,
        affectedRows,
        lastInsertRowid: result.lastInsertRowid ?? null,
        command: result.command ?? null,
      };
    });
  }

  /**
   * Executes a parameterized query and returns the first row or `null`.
   */
  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[] | Record<string, unknown>,
  ): Promise<T | null> {
    const result = await this.query<T>(sql, params);
    return result.rows[0] ?? null;
  }

  /**
   * Executes a parameterized query and returns the first column value of the first row, or `null`.
   */
  async queryScalar<T = unknown>(
    sql: string,
    params?: readonly unknown[] | Record<string, unknown>,
  ): Promise<T | null> {
    const row = await this.queryOne<Record<string, unknown>>(sql, params);
    if (!row || typeof row !== "object") {
      return null;
    }
    const keys = Object.keys(row);
    if (keys.length === 0) {
      return null;
    }
    const val = row[keys[0]!];
    return (val ?? null) as T | null;
  }

  /**
   * Executes a SQL file on the active client (transaction-aware).
   */
  file<T = Record<string, unknown>>(
    filename: string,
    params?: readonly unknown[] | Record<string, unknown>,
  ): Bun.SQL.Query<T[]> {
    const active = this.getActiveClient();
    if (params === undefined) {
      return active.file<T[]>(filename);
    }
    const normalized = Array.isArray(params) ? [...params] : params;
    return active.file<T[]>(
      filename,
      normalized as unknown[] | Record<string, unknown>,
    );
  }

  /**
   * Helper to wrap a JSON parameter for `sql` tagged template interpolation.
   */
  json(value: unknown): ReturnType<SQL["json"]> {
    const active = this.getActiveClient();
    if (typeof active.json !== "function") {
      throw new Error(
        `SQL adapter "${this.adapter ?? "unknown"}" does not support sql.json() helper.`,
      );
    }
    return active.json(value);
  }

  /**
   * Helper to wrap a PostgreSQL array parameter for `sql` tagged template interpolation.
   */
  array(
    values: unknown[] | NodeJS.TypedArray,
    typeNameOrTypeID?: Parameters<SQL["array"]>[1],
  ): ReturnType<SQL["array"]> {
    const active = this.getActiveClient();
    if (typeof active.array !== "function") {
      throw new Error(
        `SQL adapter "${this.adapter ?? "unknown"}" does not support sql.array() helper.`,
      );
    }
    return active.array(values, typeNameOrTypeID);
  }

  /**
   * Runs `fn` inside a `Bun.SQL` transaction propagated via `AsyncLocalStorage`.
   * - Any nested `transaction()` call automatically creates a `SAVEPOINT` via `tx.savepoint()`
   *   serialized per parent transaction context so concurrent sibling savepoints never interleave.
   * - Calls to `sqlService.sql\`...\``, `sqlService.unsafe()`, and `sqlService.query()` inside
   *   `fn` automatically execute on the active transaction/savepoint client.
   * - Errors trigger automatic rollback (or rollback-to-savepoint for nested calls).
   */
  async transaction<T>(
    fn: (tx: TransactionContext<TransactionSQL>) => Promise<T> | T,
    options?: SqlTransactionOptions,
  ): Promise<T> {
    this.assertOpen();

    const parent = this.txStorage.getStore();
    if (parent) {
      const releaseSavepointLock = await this.acquireChildSavepointLock(parent);
      try {
        this.assertOpen();
        const spName = this.nextSavepointName(options?.savepointName);
        const executeSavepoint = async (
          spClient: TransactionSQL,
        ): Promise<T> => {
          const childCtx: TransactionContext<TransactionSQL> = {
            id: `${parent.id}.${spName}`,
            connectionName: this.connectionName,
            depth: parent.depth + 1,
            savepointName: spName,
            isNested: true,
            client: spClient,
          };
          return await this.txStorage.run(childCtx, () => fn(childCtx));
        };

        const result = await parent.client.savepoint<T>(
          spName,
          executeSavepoint,
        );
        return result as T;
      } finally {
        releaseSavepointLock();
      }
    }

    const runTopLevel = async (): Promise<T> => {
      this.assertOpen();
      const txId = `sql_tx_${++this.txSeq}`;
      const executeTx = async (txClient: TransactionSQL): Promise<T> => {
        const rootCtx: TransactionContext<TransactionSQL> = {
          id: txId,
          connectionName: this.connectionName,
          depth: 0,
          isNested: false,
          client: txClient,
        };
        return await this.txStorage.run(rootCtx, () => fn(rootCtx));
      };

      const result = options?.options
        ? await this.client.begin<T>(options.options, executeTx)
        : await this.client.begin<T>(executeTx);
      return result as T;
    };

    if (this.isSqliteClient) {
      const releaseLock = await this.acquireTxLock();
      try {
        return await runTopLevel();
      } finally {
        releaseLock();
      }
    }

    return await runTopLevel();
  }

  /**
   * Executes `SELECT 1` to verify database connectivity.
   */
  async healthCheck(): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    try {
      const rows = await this.sql<{ ok: number }>`SELECT 1 AS ok`;
      return rows.length > 0 && Number(rows[0]?.ok) === 1;
    } catch {
      return false;
    }
  }

  get isAutoSyncEnabled(): boolean {
    return this.options.autoSync === true;
  }

  /**
   * Idempotently creates tables and indexes (`CREATE TABLE IF NOT EXISTS` /
   * `CREATE [UNIQUE] INDEX IF NOT EXISTS`) for the supplied `@Entity()` classes
   * using the active SQL dialect.
   */
  async syncEntities(
    entities: ReadonlyArray<Type<unknown> | Abstract<unknown>>,
  ): Promise<void> {
    this.assertOpen();
    const dialect = normalizeSqlDialect(this.adapter);
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      if (!entity || this.syncedEntities.has(entity) || !hasEntitySchema(entity)) {
        continue;
      }
      const { tableSql, indexSqls } = generateCreateTableSql(entity, dialect);
      await this.query(tableSql);
      for (let j = 0; j < indexSqls.length; j++) {
        await this.query(indexSqls[j]!);
      }
      this.syncedEntities.add(entity);
    }
  }

  async onModuleInit(): Promise<void> {
    if (this.options.connectOnInit && !this.closed) {
      await this.client.connect();
    }
    if (this.options.autoSync && !this.closed) {
      await this.syncEntities(this.collectAutoSyncEntities());
    }
    if (
      this.options.autoMigrate &&
      this.options.migrations &&
      this.options.migrations.length > 0 &&
      !this.closed
    ) {
      const runner = new SqlMigrationRunner(
        this,
        this.options.migrations,
        this.options.migrationsTable,
        {
          advisoryLock: this.options.advisoryLock,
          advisoryLockId: this.options.advisoryLockId,
        },
      );
      await runner.up();
    }
  }

  private collectAutoSyncEntities(): Array<Type<unknown> | Abstract<unknown>> {
    const seen = new Set<Function>();
    const result: Array<Type<unknown> | Abstract<unknown>> = [];
    const add = (cls: unknown): void => {
      if (typeof cls === "function" && !seen.has(cls) && hasEntitySchema(cls)) {
        seen.add(cls);
        result.push(cls as Type<unknown> | Abstract<unknown>);
      }
    };

    if (this.options.entities) {
      for (let i = 0; i < this.options.entities.length; i++) {
        add(this.options.entities[i]);
      }
    }

    const autoRegister = this.options.autoRegisterRepositories === true;
    if (autoRegister) {
      const repos =
        DecoratorRegistry.getByKind<SqlRepositoryMetadata>("sql-repository");
      for (let i = 0; i < repos.length; i++) {
        const entry = repos[i]!;
        const repoConn = entry.meta?.connectionName ?? DEFAULT_SQL_CONNECTION;
        if (repoConn === this.connectionName && entry.meta?.entity) {
          add(entry.meta.entity);
        }
      }
      if (this.options.entities === undefined) {
        const allEntities = DecoratorRegistry.getEntities();
        for (let i = 0; i < allEntities.length; i++) {
          add(allEntities[i]);
        }
      }
    }

    return result;
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  /**
   * Gracefully closes the underlying `Bun.SQL` pool/connection.
   * Safe to call multiple times (idempotent).
   */
  async close(options?: { readonly timeout?: number }): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const timeout = options?.timeout ?? this.options.closeTimeout;
    if (timeout !== undefined) {
      await this.client.close({ timeout });
    } else {
      await this.client.close();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(
        `SQL connection "${this.connectionName}" has been closed.`,
      );
    }
  }

  private async measureQuery<R>(sql: string, invoke: () => Promise<R>): Promise<R> {
    if (!this.onQueryHook) {
      return await invoke();
    }
    const start = performance.now();
    try {
      return await invoke();
    } finally {
      this.onQueryHook({
        sql,
        durationMs: performance.now() - start,
        inTransaction: this.isInTransaction(),
        connectionName: this.connectionName,
      });
    }
  }

  private nextSavepointName(customName?: string): string {
    const seq = ++this.savepointSeq;
    if (customName !== undefined) {
      if (!SAFE_SAVEPOINT_NAME.test(customName)) {
        throw new Error(
          `Invalid savepoint name "${customName}": must match ${SAFE_SAVEPOINT_NAME.source}`,
        );
      }
      return `${customName}_${seq}`;
    }
    return `bunest_sp_${seq}`;
  }

  private async acquireChildSavepointLock(
    parent: TransactionContext<TransactionSQL>,
  ): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.childSavepointLocks.get(parent) ?? Promise.resolve();
    this.childSavepointLocks.set(
      parent,
      prev.then(() => next),
    );
    await prev;

    let released = false;
    return () => {
      if (!released) {
        released = true;
        release();
      }
    };
  }

  private async acquireTxLock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.txLockTail;
    this.txLockTail = prev.then(() => next);
    await prev;

    let released = false;
    return () => {
      if (!released) {
        released = true;
        release();
      }
    };
  }
}

DecoratorRegistry.markInternal(SqlService);
