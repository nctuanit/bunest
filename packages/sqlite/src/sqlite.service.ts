import { AsyncLocalStorage } from "node:async_hooks";
import {
  Database,
  type DatabaseOptions,
  type SQLQueryBindings,
  type Statement,
} from "bun:sqlite";
import {
  DecoratorRegistry,
  Injectable,
  hasEntitySchema,
  type Abstract,
  type OnModuleDestroy,
  type OnModuleInit,
  type Type,
} from "@bunest/common";
import { assertSafeSqlIdentifier } from "./identifiers";
import type {
  SqliteDatabaseAdapter,
  SqliteModuleOptions,
  SqliteParamValue,
  SqliteQueryEvent,
  SqliteQueryExecutor,
  SqliteQueryParams,
  SqliteRepositoryMetadata,
  SqliteRunResult,
  SqliteTransactionContext,
  SqliteTransactionMode,
  SqliteTransactionOptions,
} from "./interfaces";
import { SqliteMigrationRunner } from "./migration-runner";
import { generateCreateTableSql } from "./schema-generator";
import { DEFAULT_SQLITE_CONNECTION } from "./tokens";

const SAFE_PRAGMA_VALUE = /^[A-Za-z0-9_.-]+$/;
const DDL_STATEMENT_PATTERN =
  /\b(CREATE|ALTER|DROP|ATTACH|DETACH|VACUUM|REINDEX)\b/i;
const VALID_TX_MODES: ReadonlySet<SqliteTransactionMode> = new Set([
  "DEFERRED",
  "IMMEDIATE",
  "EXCLUSIVE",
]);

/**
 * Bunest service wrapping Bun's native `bun:sqlite` `Database` with:
 * - Bounded LRU prepared statement caching (with automatic DDL cache invalidation)
 * - Parameterized `query`, `queryOne`, `queryValue`, `values`, `iterate`, `run`, and raw `exec`
 * - `AsyncLocalStorage`-propagated transactions with automatic nested `SAVEPOINT` serialization
 *   and FIFO top-level transaction locking for concurrent async callers
 * - Optional auto-migrations on `onModuleInit()` and `onQuery` observability hooks
 * - Leak-free handle cleanup on constructor errors and `onModuleDestroy()`
 */
@Injectable()
export class SqliteService
  implements SqliteQueryExecutor, OnModuleInit, OnModuleDestroy, Disposable
{
  public readonly connectionName: string;
  public readonly filename: string;

  private readonly db: Database;
  private readonly options: SqliteModuleOptions;
  private readonly onQueryHook?: (info: SqliteQueryEvent) => void;
  private readonly statementCache = new Map<string, Statement>();
  private readonly statementCacheSize: number;
  private readonly txStorage =
    new AsyncLocalStorage<SqliteTransactionContext>();
  private readonly childSavepointLocks = new WeakMap<
    SqliteTransactionContext,
    Promise<void>
  >();

  private txLockTail: Promise<void> = Promise.resolve();
  private txLockHeld = false;
  private txSeq = 0;
  private savepointSeq = 0;
  private closed = false;
  private readonly syncedEntities = new Set<Function>();

  constructor(options: SqliteModuleOptions = {}) {
    this.options = options;
    this.connectionName = options.name ?? DEFAULT_SQLITE_CONNECTION;
    this.filename = options.filename ?? ":memory:";
    this.onQueryHook = options.onQuery;
    this.statementCacheSize = Math.max(
      0,
      Math.floor(options.statementCacheSize ?? 100),
    );

    if (options.readonly && options.autoMigrate) {
      throw new Error(
        `SQLite connection "${this.connectionName}" cannot enable "autoMigrate" when "readonly" is true.`,
      );
    }
    if (options.readonly && options.autoSync) {
      throw new Error(
        `SQLite connection "${this.connectionName}" cannot enable "autoSync" when "readonly" is true.`,
      );
    }

    const dbOptions = this.buildDatabaseOptions(options);
    this.db = new Database(this.filename, dbOptions);
    try {
      this.applyPragmas(options);
    } catch (err) {
      this.closed = true;
      try {
        this.db.close(true);
      } catch {
        // Preserve original PRAGMA error while preventing handle leak
      }
      throw err;
    }
  }

  get raw(): Database {
    this.assertOpen();
    return this.db;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get inDatabaseTransaction(): boolean {
    return !this.closed && this.db.inTransaction;
  }

  /**
   * Returns the active `AsyncLocalStorage` transaction context for the current
   * async execution chain on this connection, if any.
   */
  getCurrentTransaction(): SqliteTransactionContext | undefined {
    return this.txStorage.getStore();
  }

  isInTransaction(): boolean {
    return this.txStorage.getStore() !== undefined;
  }

  getCachedStatementCount(): number {
    return this.statementCache.size;
  }

  clearStatementCache(): void {
    for (const stmt of this.statementCache.values()) {
      try {
        stmt.finalize();
      } catch {
        // Statement may already be finalized
      }
    }
    this.statementCache.clear();
  }

  /**
   * Prepares a typed `bun:sqlite` `Statement` directly (caller manages lifecycle).
   */
  prepare<T = Record<string, unknown>>(sql: string): Statement<T> {
    this.assertOpen();
    return this.db.prepare<T, SQLQueryBindings[]>(sql);
  }

  /**
   * Executes a parameterized SQL query and returns all matching rows.
   * Automatically participates in any active transaction/savepoint on this connection.
   */
  query<T = Record<string, unknown>>(
    sql: string,
    params?: SqliteQueryParams,
  ): T[] {
    return this.measureQuery(sql, () =>
      this.withStatement(sql, (stmt) => {
        if (params === undefined) {
          return stmt.all() as T[];
        }
        if (Array.isArray(params)) {
          return stmt.all(...(params as SQLQueryBindings[])) as T[];
        }
        return stmt.all(params as SQLQueryBindings) as T[];
      }),
    );
  }

  /**
   * Executes a parameterized SQL query and returns the first row or `null`.
   * Automatically participates in any active transaction/savepoint on this connection.
   */
  queryOne<T = Record<string, unknown>>(
    sql: string,
    params?: SqliteQueryParams,
  ): T | null {
    return this.measureQuery(sql, () =>
      this.withStatement(sql, (stmt) => {
        const row =
          params === undefined
            ? stmt.get()
            : Array.isArray(params)
              ? stmt.get(...(params as SQLQueryBindings[]))
              : stmt.get(params as SQLQueryBindings);
        return (row ?? null) as T | null;
      }),
    );
  }

  /**
   * Executes a parameterized SQL query and returns the first column of the first row, or `null`.
   */
  queryValue<T = SqliteParamValue>(
    sql: string,
    params?: SqliteQueryParams,
  ): T | null {
    return this.measureQuery(sql, () =>
      this.withStatement(sql, (stmt) => {
        const rows =
          params === undefined
            ? stmt.values()
            : Array.isArray(params)
              ? stmt.values(...(params as SQLQueryBindings[]))
              : stmt.values(params as SQLQueryBindings);
        if (!rows || rows.length === 0 || rows[0]!.length === 0) {
          return null;
        }
        return (rows[0]![0] ?? null) as T | null;
      }),
    );
  }

  /**
   * Executes a parameterized SQL query and returns zero-object tuple rows via `stmt.values()`.
   */
  values<T extends unknown[] = unknown[]>(
    sql: string,
    params?: SqliteQueryParams,
  ): T[] {
    return this.measureQuery(sql, () =>
      this.withStatement(sql, (stmt) => {
        if (params === undefined) {
          return stmt.values() as T[];
        }
        if (Array.isArray(params)) {
          return stmt.values(...(params as SQLQueryBindings[])) as T[];
        }
        return stmt.values(params as SQLQueryBindings) as T[];
      }),
    );
  }

  /**
   * Streams matching rows lazily via `bun:sqlite` `stmt.iterate()`.
   */
  iterate<T = Record<string, unknown>>(
    sql: string,
    params?: SqliteQueryParams,
  ): IterableIterator<T> {
    this.assertOpen();
    const start = this.onQueryHook ? performance.now() : 0;

    if (this.statementCacheSize === 0) {
      const stmt = this.db.prepare(sql);
      const rawIter = (
        params === undefined
          ? stmt.iterate()
          : Array.isArray(params)
            ? stmt.iterate(...(params as SQLQueryBindings[]))
            : stmt.iterate(params as SQLQueryBindings)
      ) as IterableIterator<T>;

      const emit = () => {
        if (this.onQueryHook) {
          this.onQueryHook({
            sql,
            durationMs: performance.now() - start,
            inTransaction: this.isInTransaction() || this.inDatabaseTransaction,
            connectionName: this.connectionName,
          });
        }
      };

      return (function* () {
        try {
          yield* rawIter;
        } finally {
          emit();
          try {
            stmt.finalize();
          } catch {
            // ignore already finalized
          }
        }
      })();
    }

    const stmt = this.getOrCacheStatement(sql);
    const rawIter = (
      params === undefined
        ? stmt.iterate()
        : Array.isArray(params)
          ? stmt.iterate(...(params as SQLQueryBindings[]))
          : stmt.iterate(params as SQLQueryBindings)
    ) as IterableIterator<T>;

    if (!this.onQueryHook) {
      return rawIter;
    }

    const hook = this.onQueryHook;
    const connectionName = this.connectionName;
    const isInTx = () => this.isInTransaction() || this.inDatabaseTransaction;

    return (function* () {
      try {
        yield* rawIter;
      } finally {
        hook({
          sql,
          durationMs: performance.now() - start,
          inTransaction: isInTx(),
          connectionName,
        });
      }
    })();
  }

  /**
   * Serializes the entire SQLite database into an in-memory `Uint8Array` snapshot.
   */
  serialize(name?: string): Uint8Array {
    this.assertOpen();
    return this.db.serialize(name);
  }

  /**
   * Returns a structural `DatabaseAdapter` bridge compatible with `@bunest/sql` contracts.
   */
  toDatabaseAdapter(): SqliteDatabaseAdapter {
    const service = this;
    return {
      connectionName: this.connectionName,
      get isClosed() {
        return service.isClosed;
      },
      query: <T = Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[] | Record<string, unknown>,
      ) => {
        const trimmed = sql.trimStart();
        const cmd = trimmed.split(/\s+/, 1)[0]?.toUpperCase() ?? null;
        if (
          cmd === "SELECT" ||
          cmd === "PRAGMA" ||
          cmd === "WITH" ||
          /\bRETURNING\b/i.test(sql)
        ) {
          const rows = this.query<T>(
            sql,
            params as SqliteQueryParams | undefined,
          );
          return {
            rows,
            rowCount: rows.length,
            command: cmd,
          };
        }
        const res = this.run(sql, params as SqliteQueryParams | undefined);
        return {
          rows: [],
          rowCount: res.changes,
          affectedRows: res.changes,
          lastInsertRowid: res.lastInsertRowid,
          command: cmd,
        };
      },
      transaction: <T>(
        fn: (tx: {
          readonly id: string;
          readonly connectionName: string;
          readonly depth: number;
          readonly savepointName?: string;
          readonly isNested: boolean;
          readonly client: Database;
        }) => Promise<T> | T,
      ) =>
        this.transaction((tx) =>
          fn({
            id: tx.id,
            connectionName: tx.connectionName,
            depth: tx.depth,
            savepointName: tx.savepointName,
            isNested: tx.isNested,
            client: tx.database,
          }),
        ),
      getCurrentTransaction: () => {
        const tx = this.getCurrentTransaction();
        if (!tx) return undefined;
        return {
          id: tx.id,
          connectionName: tx.connectionName,
          depth: tx.depth,
          savepointName: tx.savepointName,
          isNested: tx.isNested,
          client: tx.database,
        };
      },
      healthCheck: () => this.healthCheck(),
      close: () => this.close(),
    };
  }

  /**
   * Executes a parameterized write statement (`INSERT`, `UPDATE`, `DELETE`) and
   * returns `{ changes, lastInsertRowid }`.
   */
  run(sql: string, params?: SqliteQueryParams): SqliteRunResult {
    return this.measureQuery(sql, () =>
      this.withStatement(sql, (stmt) => {
        const result =
          params === undefined
            ? stmt.run()
            : Array.isArray(params)
              ? stmt.run(...(params as SQLQueryBindings[]))
              : stmt.run(params as SQLQueryBindings);
        return {
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid,
        };
      }),
    );
  }

  /**
   * Executes one or more raw SQL statements (e.g. DDL scripts, PRAGMAs) without returning rows.
   * Automatically invalidates cached prepared statements when DDL statements are executed.
   */
  exec(sql: string): void {
    this.assertOpen();
    this.measureQuery(sql, () => {
      this.db.run(sql);
    });
    if (DDL_STATEMENT_PATTERN.test(sql) && this.statementCache.size > 0) {
      this.clearStatementCache();
    }
  }

  /**
   * Runs `fn` inside a database transaction propagated via `AsyncLocalStorage`.
   * - Top-level calls acquire a FIFO per-connection async lock so concurrent
   *   `Promise.all([db.transaction(...), db.transaction(...)])` calls remain ACID-isolated.
   * - Nested calls automatically create a SQLite `SAVEPOINT` serialized per parent
   *   transaction context, preventing concurrent sibling savepoint stack corruption.
   */
  async transaction<T>(
    fn: (tx: SqliteTransactionContext) => Promise<T> | T,
    options?: SqliteTransactionOptions,
  ): Promise<T> {
    this.assertOpen();

    const parent = this.txStorage.getStore();
    if (parent) {
      const releaseSavepointLock = await this.acquireChildSavepointLock(parent);
      try {
        this.assertOpen();
        const spName = this.nextSavepointName(options?.savepointName);
        const childCtx: SqliteTransactionContext = {
          id: `${parent.id}.${spName}`,
          connectionName: this.connectionName,
          depth: parent.depth + 1,
          savepointName: spName,
          isNested: true,
          database: this.db,
        };

        this.db.run(`SAVEPOINT "${spName}"`);
        try {
          const result = await this.txStorage.run(childCtx, () => fn(childCtx));
          this.assertOpen();
          this.db.run(`RELEASE SAVEPOINT "${spName}"`);
          return result;
        } catch (err) {
          if (!this.closed && this.db.inTransaction) {
            try {
              this.db.run(`ROLLBACK TO SAVEPOINT "${spName}"`);
              this.db.run(`RELEASE SAVEPOINT "${spName}"`);
            } catch {
              // Outer transaction may have already terminated
            }
          }
          throw err;
        }
      } finally {
        releaseSavepointLock();
      }
    }

    const releaseLock = await this.acquireTxLock();
    try {
      this.assertOpen();
      const mode = this.validateTransactionMode(options?.mode ?? "DEFERRED");
      const rootCtx: SqliteTransactionContext = {
        id: `tx_${++this.txSeq}`,
        connectionName: this.connectionName,
        depth: 0,
        isNested: false,
        database: this.db,
      };

      this.db.run(`BEGIN ${mode}`);
      try {
        const result = await this.txStorage.run(rootCtx, () => fn(rootCtx));
        this.assertOpen();
        this.db.run("COMMIT");
        return result;
      } catch (err) {
        if (!this.closed && this.db.inTransaction) {
          try {
            this.db.run("ROLLBACK");
          } catch {
            // Connection may have been closed during callback
          }
        }
        throw err;
      }
    } finally {
      releaseLock();
    }
  }

  /**
   * Synchronous transaction helper supporting nested `SAVEPOINT`s when called inside
   * an existing transaction context. Throws if another async transaction currently holds
   * the connection lock.
   */
  transactionSync<T>(
    fn: (tx: SqliteTransactionContext) => T,
    options?: SqliteTransactionOptions,
  ): T {
    this.assertOpen();

    const parent = this.txStorage.getStore();
    if (parent) {
      const spName = this.nextSavepointName(options?.savepointName);
      const childCtx: SqliteTransactionContext = {
        id: `${parent.id}.${spName}`,
        connectionName: this.connectionName,
        depth: parent.depth + 1,
        savepointName: spName,
        isNested: true,
        database: this.db,
      };

      this.db.run(`SAVEPOINT "${spName}"`);
      try {
        const result = this.txStorage.run(childCtx, () => fn(childCtx));
        this.assertOpen();
        this.db.run(`RELEASE SAVEPOINT "${spName}"`);
        return result;
      } catch (err) {
        if (!this.closed && this.db.inTransaction) {
          try {
            this.db.run(`ROLLBACK TO SAVEPOINT "${spName}"`);
            this.db.run(`RELEASE SAVEPOINT "${spName}"`);
          } catch {
            // Outer transaction may have already terminated
          }
        }
        throw err;
      }
    }

    if (this.txLockHeld || this.db.inTransaction) {
      throw new Error(
        `Cannot start synchronous transaction on SQLite connection "${this.connectionName}" while another transaction is active. Use async transaction() instead.`,
      );
    }

    const mode = this.validateTransactionMode(options?.mode ?? "DEFERRED");
    const rootCtx: SqliteTransactionContext = {
      id: `tx_${++this.txSeq}`,
      connectionName: this.connectionName,
      depth: 0,
      isNested: false,
      database: this.db,
    };

    this.txLockHeld = true;
    this.db.run(`BEGIN ${mode}`);
    try {
      const result = this.txStorage.run(rootCtx, () => fn(rootCtx));
      this.assertOpen();
      this.db.run("COMMIT");
      return result;
    } catch (err) {
      if (!this.closed && this.db.inTransaction) {
        try {
          this.db.run("ROLLBACK");
        } catch {
          // Ignore rollback failure if connection closed
        }
      }
      throw err;
    } finally {
      this.txLockHeld = false;
    }
  }

  /**
   * Verifies that the SQLite connection is open and responsive.
   */
  healthCheck(): boolean {
    if (this.closed) {
      return false;
    }
    try {
      const row = this.queryOne<{ ok: number }>("SELECT 1 AS ok");
      return row?.ok === 1;
    } catch {
      return false;
    }
  }

  get isAutoSyncEnabled(): boolean {
    return this.options.autoSync === true;
  }

  /**
   * Idempotently creates tables and indexes (`CREATE TABLE IF NOT EXISTS` /
   * `CREATE [UNIQUE] INDEX IF NOT EXISTS`) for the supplied `@Entity()` classes.
   */
  syncEntities(
    entities: ReadonlyArray<Type<unknown> | Abstract<unknown>>,
  ): void {
    this.assertOpen();
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      if (!entity || this.syncedEntities.has(entity) || !hasEntitySchema(entity)) {
        continue;
      }
      const { tableSql, indexSqls } = generateCreateTableSql(entity, "sqlite");
      this.exec(tableSql);
      for (let j = 0; j < indexSqls.length; j++) {
        this.exec(indexSqls[j]!);
      }
      this.syncedEntities.add(entity);
    }
  }

  async onModuleInit(): Promise<void> {
    if (this.options.autoSync && !this.closed) {
      this.syncEntities(this.collectAutoSyncEntities());
    }
    if (
      this.options.autoMigrate &&
      this.options.migrations &&
      this.options.migrations.length > 0
    ) {
      const runner = new SqliteMigrationRunner(
        this,
        this.options.migrations,
        this.options.migrationsTable,
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
        DecoratorRegistry.getByKind<SqliteRepositoryMetadata>("sqlite-repository");
      for (let i = 0; i < repos.length; i++) {
        const entry = repos[i]!;
        const repoConn = entry.meta?.connectionName ?? DEFAULT_SQLITE_CONNECTION;
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

  onModuleDestroy(): void {
    this.close();
  }

  /**
   * Finalizes all cached statements and closes the underlying SQLite connection.
   * Safe to call multiple times (idempotent).
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.clearStatementCache();
    try {
      this.db.clearQueryCache();
    } catch {
      // Ignore if already cleared
    }
    this.db.close(true);
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(
        `SQLite connection "${this.connectionName}" has been closed.`,
      );
    }
  }

  private measureQuery<R>(sql: string, invoke: () => R): R {
    if (!this.onQueryHook) {
      return invoke();
    }
    const start = performance.now();
    try {
      return invoke();
    } finally {
      this.onQueryHook({
        sql,
        durationMs: performance.now() - start,
        inTransaction: this.isInTransaction() || this.inDatabaseTransaction,
        connectionName: this.connectionName,
      });
    }
  }

  private getOrCacheStatement(sql: string): Statement {
    const cached = this.statementCache.get(sql);
    if (cached) {
      // Refresh LRU position
      this.statementCache.delete(sql);
      this.statementCache.set(sql, cached);
      return cached;
    }

    const stmt = this.db.prepare(sql);
    if (this.statementCache.size >= this.statementCacheSize) {
      const oldestKey = this.statementCache.keys().next().value;
      if (oldestKey !== undefined) {
        const evicted = this.statementCache.get(oldestKey);
        this.statementCache.delete(oldestKey);
        if (evicted) {
          try {
            evicted.finalize();
          } catch {
            // Ignore already finalized statement
          }
        }
      }
    }
    this.statementCache.set(sql, stmt);
    return stmt;
  }

  private withStatement<R>(sql: string, invoke: (stmt: Statement) => R): R {
    this.assertOpen();

    if (this.statementCacheSize === 0) {
      const stmt = this.db.prepare(sql);
      try {
        return invoke(stmt);
      } finally {
        stmt.finalize();
      }
    }

    const stmt = this.getOrCacheStatement(sql);
    return invoke(stmt);
  }

  private buildDatabaseOptions(options: SqliteModuleOptions): DatabaseOptions {
    const base: DatabaseOptions = {
      safeIntegers: options.safeIntegers,
      strict: options.strict,
    };
    if (options.readonly) {
      return { ...base, readonly: true };
    }
    return {
      ...base,
      create: options.create ?? true,
      readwrite: options.readwrite ?? true,
    };
  }

  private applyPragmas(options: SqliteModuleOptions): void {
    const busyTimeout = options.busyTimeout ?? 5000;
    if (!Number.isFinite(busyTimeout) || busyTimeout < 0) {
      throw new Error(
        `Invalid busyTimeout "${busyTimeout}": expected a non-negative finite number.`,
      );
    }
    this.db.run(`PRAGMA busy_timeout = ${Math.floor(busyTimeout)}`);

    const foreignKeys = options.foreignKeys ?? true;
    this.db.run(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);

    const isMemory = this.filename === ":memory:" || this.filename === "";
    if (!options.readonly) {
      const enableWal = options.wal ?? !isMemory;
      if (enableWal) {
        this.db.run("PRAGMA journal_mode = WAL");
      }
    }

    if (options.pragmas) {
      for (const [key, rawValue] of Object.entries(options.pragmas)) {
        const safeKey = assertSafeSqlIdentifier(key, "PRAGMA name");
        let formattedValue: string;
        if (typeof rawValue === "boolean") {
          formattedValue = rawValue ? "ON" : "OFF";
        } else if (typeof rawValue === "number") {
          if (!Number.isFinite(rawValue)) {
            throw new Error(
              `Invalid PRAGMA "${safeKey}" numeric value: must be finite.`,
            );
          }
          formattedValue = String(rawValue);
        } else {
          if (!SAFE_PRAGMA_VALUE.test(rawValue)) {
            throw new Error(
              `Invalid PRAGMA "${safeKey}" value "${rawValue}": contains disallowed characters.`,
            );
          }
          formattedValue = rawValue;
        }
        this.db.run(`PRAGMA ${safeKey} = ${formattedValue}`);
      }
    }
  }

  private nextSavepointName(customName?: string): string {
    const seq = ++this.savepointSeq;
    if (customName !== undefined) {
      const safe = assertSafeSqlIdentifier(customName, "savepoint name");
      return `${safe}_${seq}`;
    }
    return `bunest_sp_${seq}`;
  }

  private validateTransactionMode(
    mode: SqliteTransactionMode,
  ): SqliteTransactionMode {
    if (!VALID_TX_MODES.has(mode)) {
      throw new Error(
        `Invalid SQLite transaction mode "${String(mode)}": expected DEFERRED, IMMEDIATE, or EXCLUSIVE.`,
      );
    }
    return mode;
  }

  private async acquireChildSavepointLock(
    parent: SqliteTransactionContext,
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
    this.txLockHeld = true;

    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.txLockHeld = false;
        release();
      }
    };
  }
}

DecoratorRegistry.markInternal(SqliteService);
