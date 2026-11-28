import { ContextStorage as AsyncLocalStorage } from "@bunest/core";
import { Database, type DatabaseOptions } from "bun:sqlite";
import {
  emitOrmTransactionDiagnostic,
  hasOrmTransactionSubscribers,
} from "../diagnostics";
import { QueryFailedError } from "../errors";
import {
  assertTransactionPropagation,
  completeTransactionHookCommit,
  completeTransactionHookRollback,
  createTransactionHookCollector,
  executeWithTransactionRetries,
  exitTransactionHookScope,
  isRetryableTransactionError,
  runInTransactionHookScope,
  validateIsolationLevel,
  validateTransactionPropagation,
} from "../transaction-hooks";
import type {
  OrmDialect,
  OrmQueryExecutor,
  OrmQueryLogEvent,
  OrmQueryResult,
  OrmTransactionOptions,
} from "../types";
import {
  emitQueryTelemetry,
  shouldTrackQuery,
  type OrmDriver,
} from "./driver.interface";

interface SqliteTxContext {
  readonly depth: number;
  readonly readOnly: boolean;
}

export interface SqliteOrmDriverOptions {
  readonly database?: string;
  readonly enableWAL?: boolean;
  readonly enforceForeignKeys?: boolean;
  readonly readonly?: boolean;
  readonly create?: boolean;
  readonly readwrite?: boolean;
  readonly safeIntegers?: boolean;
  readonly strict?: boolean;
  readonly busyTimeout?: number;
  readonly logging?: boolean | ((event: OrmQueryLogEvent) => void);
  readonly dataSourceName?: string;
}

/**
 * Zero-dependency native `bun:sqlite` driver with AsyncLocalStorage nested
 * `SAVEPOINT` transactions, WAL mode, busy timeout, isolation/propagation/retries,
 * transaction lifecycle hooks, diagnostics channel emission, and FIFO transaction serialization.
 */
export class SqliteOrmDriver implements OrmDriver {
  readonly dialect: OrmDialect = "sqlite";
  readonly driverKind = "bun-sqlite";
  readonly supportsManagedTransactions = true;
  readonly dataSourceName?: string;

  private db?: Database;
  private readonly options: SqliteOrmDriverOptions;
  private readonly txStorage = new AsyncLocalStorage<SqliteTxContext>();
  private savepointSeq = 0;
  private txQueueTail: Promise<void> = Promise.resolve();

  constructor(options: SqliteOrmDriverOptions = {}) {
    this.options = options;
    this.dataSourceName = options.dataSourceName;
  }

  get isConnected(): boolean {
    return this.db !== undefined;
  }

  get rawDatabase(): Database {
    if (!this.db) {
      throw new Error("SqliteOrmDriver is not connected.");
    }
    return this.db;
  }

  async connect(): Promise<void> {
    if (this.db) return;
    const filename = this.options.database || ":memory:";
    const dbOpts: DatabaseOptions = {};
    if (this.options.readonly !== undefined) dbOpts.readonly = this.options.readonly;
    if (this.options.create !== undefined) dbOpts.create = this.options.create;
    if (this.options.readwrite !== undefined) dbOpts.readwrite = this.options.readwrite;
    if (this.options.safeIntegers !== undefined) {
      dbOpts.safeIntegers = this.options.safeIntegers;
    }
    if (this.options.strict !== undefined) dbOpts.strict = this.options.strict;

    this.db =
      Object.keys(dbOpts).length > 0
        ? new Database(filename, dbOpts)
        : new Database(filename);

    if (!this.options.readonly) {
      if (this.options.enforceForeignKeys !== false) {
        this.db.run("PRAGMA foreign_keys = ON;");
      }
      if (filename !== ":memory:" && this.options.enableWAL !== false) {
        this.db.run("PRAGMA journal_mode = WAL;");
      }
    }
    if (this.options.busyTimeout !== undefined && this.options.busyTimeout > 0) {
      this.db.run(`PRAGMA busy_timeout = ${Math.floor(this.options.busyTimeout)};`);
    }
  }

  async close(): Promise<void> {
    if (!this.db) return;
    this.db.close();
    this.db = undefined;
  }

  async ping(): Promise<boolean> {
    if (!this.db) return false;
    const res = await this.query<{ ok: number }>("SELECT 1 AS ok");
    return res.rows[0]?.ok === 1;
  }

  isInTransaction(): boolean {
    return this.txStorage.getStore() !== undefined;
  }

  async setForeignKeysEnabled(enabled: boolean): Promise<void> {
    const db = this.rawDatabase;
    db.run(enabled ? "PRAGMA foreign_keys = ON;" : "PRAGMA foreign_keys = OFF;");
  }

  private isReadReturningSql(sql: string): boolean {
    const upper = sql.trimStart().toUpperCase();
    return (
      upper.startsWith("SELECT") ||
      upper.startsWith("PRAGMA") ||
      upper.startsWith("WITH") ||
      upper.startsWith("EXPLAIN") ||
      /\bRETURNING\b/i.test(upper)
    );
  }

  private normalizeSqliteParams(params: readonly unknown[]): unknown[] {
    return params.map((p) => {
      if (p === undefined) return null;
      if (typeof p === "boolean") return p ? 1 : 0;
      if (p instanceof Date) return p.toISOString();
      return p;
    });
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<OrmQueryResult<T>> {
    const db = this.rawDatabase;
    const track = shouldTrackQuery(this.options.logging);
    const start = track ? performance.now() : 0;
    const bound = this.normalizeSqliteParams(params);
    let queryResult: OrmQueryResult<T>;
    let telemetryCount: number;
    try {
      const stmt = db.query(sql);
      const args = bound as Parameters<typeof stmt.all>;
      if (this.isReadReturningSql(sql)) {
        const rows = stmt.all(...args) as T[];
        telemetryCount = rows.length;
        queryResult = {
          rows,
          affectedRows: rows.length,
        };
      } else {
        const res = stmt.run(...args);
        const affectedRows = Number(res.changes ?? 0);
        telemetryCount = affectedRows;
        queryResult = {
          rows: [],
          affectedRows,
          lastInsertRowid: res.lastInsertRowid ?? null,
        };
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (track) {
        emitQueryTelemetry(
          this.options.logging,
          this.dialect,
          sql,
          params,
          start,
          undefined,
          error,
          this.dataSourceName,
        );
      }
      throw new QueryFailedError(error.message, sql, params, error);
    }
    if (track) {
      emitQueryTelemetry(
        this.options.logging,
        this.dialect,
        sql,
        params,
        start,
        telemetryCount,
        undefined,
        this.dataSourceName,
      );
    }
    return queryResult;
  }

  async execute(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<OrmQueryResult> {
    if (params.length === 0) {
      const db = this.rawDatabase;
      const track = shouldTrackQuery(this.options.logging);
      const start = track ? performance.now() : 0;
      let queryResult: OrmQueryResult;
      let affectedRows: number;
      try {
        const res = db.run(sql);
        affectedRows = Number(res.changes ?? 0);
        queryResult = {
          rows: [],
          affectedRows,
          lastInsertRowid: res.lastInsertRowid ?? null,
        };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (track) {
          emitQueryTelemetry(
            this.options.logging,
            this.dialect,
            sql,
            params,
            start,
            undefined,
            error,
            this.dataSourceName,
          );
        }
        throw new QueryFailedError(error.message, sql, params, error);
      }
      if (track) {
        emitQueryTelemetry(
          this.options.logging,
          this.dialect,
          sql,
          params,
          start,
          affectedRows,
          undefined,
          this.dataSourceName,
        );
      }
      return queryResult;
    }
    return this.query(sql, params);
  }

  async transaction<T>(
    run: (executor: OrmQueryExecutor) => Promise<T> | T,
    options: OrmTransactionOptions = {},
  ): Promise<T> {
    const db = this.rawDatabase;
    const propagation = validateTransactionPropagation(
      options.propagation ?? "REQUIRED",
    );
    const isolationLevel =
      options.isolationLevel !== undefined
        ? validateIsolationLevel(options.isolationLevel)
        : undefined;
    const dataSource = options.dataSource ?? this.dataSourceName;
    const existing = this.txStorage.getStore();

    assertTransactionPropagation(propagation, existing !== undefined);

    if (propagation === "NEVER") {
      return await exitTransactionHookScope(() => run(this));
    }

    // Nested savepoint inside an active SQLite transaction (`REQUIRED`, `MANDATORY`,
    // or single-connection `REQUIRES_NEW` with independent hook scope).
    if (existing) {
      const isRequiresNew = propagation === "REQUIRES_NEW";
      const runSavepointAttempt = async (
        isFinalAttempt: boolean,
      ): Promise<T> => {
        const spName = `bunest_orm_sp_${++this.savepointSeq}`;
        const collector = createTransactionHookCollector(!isRequiresNew);
        const trackTx = hasOrmTransactionSubscribers();
        const start = trackTx ? performance.now() : 0;
        const setQueryOnly = options.readOnly === true && !existing.readOnly;

        if (trackTx) {
          emitOrmTransactionDiagnostic({
            phase: "begin",
            ...(isolationLevel !== undefined ? { isolationLevel } : {}),
            propagation,
            ...(dataSource !== undefined ? { dataSource } : {}),
          });
        }

        db.run(`SAVEPOINT ${spName}`);
        if (setQueryOnly) {
          db.run("PRAGMA query_only = ON;");
        }

        let result!: T;
        let succeeded = false;
        try {
          result = await this.txStorage.run(
            {
              depth: isRequiresNew ? 1 : existing.depth + 1,
              readOnly: existing.readOnly || options.readOnly === true,
            },
            () => runInTransactionHookScope(collector, () => run(this)),
          );
          if (setQueryOnly) {
            db.run("PRAGMA query_only = OFF;");
          }
          db.run(`RELEASE SAVEPOINT ${spName}`);
          succeeded = true;
        } catch (err) {
          if (setQueryOnly) {
            try {
              db.run("PRAGMA query_only = OFF;");
            } catch {
              // Ignore secondary pragma reset error
            }
          }
          try {
            db.run(`ROLLBACK TO SAVEPOINT ${spName}`);
            db.run(`RELEASE SAVEPOINT ${spName}`);
          } catch {
            // Ignore secondary rollback error
          }
          const error = err instanceof Error ? err : new Error(String(err));
          if (trackTx) {
            emitOrmTransactionDiagnostic({
              phase: "rollback",
              ...(isolationLevel !== undefined ? { isolationLevel } : {}),
              propagation,
              durationMs: performance.now() - start,
              error,
              ...(dataSource !== undefined ? { dataSource } : {}),
            });
          }
          const willRetry =
            isRequiresNew && !isFinalAttempt && isRetryableTransactionError(err);
          if (!willRetry) {
            await this.txStorage.exit(() =>
              completeTransactionHookRollback(collector),
            );
          }
          throw err;
        }

        if (succeeded) {
          if (trackTx) {
            emitOrmTransactionDiagnostic({
              phase: "commit",
              ...(isolationLevel !== undefined ? { isolationLevel } : {}),
              propagation,
              durationMs: performance.now() - start,
              ...(dataSource !== undefined ? { dataSource } : {}),
            });
          }
          if (isRequiresNew) {
            await this.txStorage.exit(() =>
              completeTransactionHookCommit(collector),
            );
          } else {
            await completeTransactionHookCommit(collector);
          }
        }
        return result;
      };

      if (isRequiresNew && options.retries && options.retries > 0) {
        return await executeWithTransactionRetries(
          options.retries,
          options.retryDelayMs,
          (_attempt, isFinal) => runSavepointAttempt(isFinal),
        );
      }
      return await runSavepointAttempt(true);
    }

    // Top-level SQLite transaction (with optional retries + jittered backoff)
    return await executeWithTransactionRetries(
      options.retries,
      options.retryDelayMs,
      async (_attempt, isFinalAttempt) => {
        const collector = createTransactionHookCollector(false);
        const trackTx = hasOrmTransactionSubscribers();
        const start = trackTx ? performance.now() : 0;

        const prev = this.txQueueTail;
        let release!: () => void;
        this.txQueueTail = new Promise<void>((resolve) => {
          release = resolve;
        });

        await prev;

        const beginSql =
          options.readOnly === true || isolationLevel === "READ UNCOMMITTED"
            ? "BEGIN DEFERRED"
            : "BEGIN IMMEDIATE";
        const setQueryOnly = options.readOnly === true;
        const setReadUncommitted = isolationLevel === "READ UNCOMMITTED";

        let result!: T;
        let caughtErr: unknown;
        let failed = false;

        try {
          if (trackTx) {
            emitOrmTransactionDiagnostic({
              phase: "begin",
              ...(isolationLevel !== undefined ? { isolationLevel } : {}),
              propagation,
              ...(dataSource !== undefined ? { dataSource } : {}),
            });
          }

          if (setReadUncommitted) {
            db.run("PRAGMA read_uncommitted = 1;");
          }
          db.run(beginSql);
          if (setQueryOnly) {
            db.run("PRAGMA query_only = ON;");
          }

          try {
            result = await this.txStorage.run(
              { depth: 1, readOnly: setQueryOnly },
              () => runInTransactionHookScope(collector, () => run(this)),
            );
            if (setQueryOnly) {
              db.run("PRAGMA query_only = OFF;");
            }
            db.run("COMMIT");
            if (setReadUncommitted) {
              db.run("PRAGMA read_uncommitted = 0;");
            }
          } catch (err) {
            if (setQueryOnly) {
              try {
                db.run("PRAGMA query_only = OFF;");
              } catch {
                // Ignore secondary pragma reset error
              }
            }
            try {
              db.run("ROLLBACK");
            } catch {
              // Ignore secondary rollback error
            }
            if (setReadUncommitted) {
              try {
                db.run("PRAGMA read_uncommitted = 0;");
              } catch {
                // Ignore secondary pragma reset error
              }
            }
            caughtErr = err;
            failed = true;
          }
        } finally {
          // Release queue lock BEFORE invoking post-commit / post-rollback hooks
          // so callbacks can safely open independent transactions without deadlocking!
          release();
        }

        if (failed) {
          const error =
            caughtErr instanceof Error ? caughtErr : new Error(String(caughtErr));
          if (trackTx) {
            emitOrmTransactionDiagnostic({
              phase: "rollback",
              ...(isolationLevel !== undefined ? { isolationLevel } : {}),
              propagation,
              durationMs: performance.now() - start,
              error,
              ...(dataSource !== undefined ? { dataSource } : {}),
            });
          }
          const willRetry =
            !isFinalAttempt && isRetryableTransactionError(caughtErr);
          if (!willRetry) {
            await completeTransactionHookRollback(collector);
          }
          throw caughtErr;
        }

        if (trackTx) {
          emitOrmTransactionDiagnostic({
            phase: "commit",
            ...(isolationLevel !== undefined ? { isolationLevel } : {}),
            propagation,
            durationMs: performance.now() - start,
            ...(dataSource !== undefined ? { dataSource } : {}),
          });
        }
        await completeTransactionHookCommit(collector);
        return result;
      },
    );
  }
}
