import { ContextStorage as AsyncLocalStorage } from "@bunest/core";
import { Database, type DatabaseOptions } from "bun:sqlite";
import { QueryFailedError } from "../errors";
import type {
  OrmDialect,
  OrmQueryExecutor,
  OrmQueryLogEvent,
  OrmQueryResult,
} from "../types";
import { emitQueryLog, type OrmDriver } from "./driver.interface";

interface SqliteTxContext {
  readonly depth: number;
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
}

/**
 * Zero-dependency native `bun:sqlite` driver with AsyncLocalStorage nested
 * `SAVEPOINT` transactions, WAL mode, busy timeout, and FIFO transaction serialization.
 */
export class SqliteOrmDriver implements OrmDriver {
  readonly dialect: OrmDialect = "sqlite";
  readonly driverKind = "bun-sqlite";

  private db?: Database;
  private readonly options: SqliteOrmDriverOptions;
  private readonly txStorage = new AsyncLocalStorage<SqliteTxContext>();
  private savepointSeq = 0;
  private txQueueTail: Promise<void> = Promise.resolve();

  constructor(options: SqliteOrmDriverOptions = {}) {
    this.options = options;
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
    const start = performance.now();
    const bound = this.normalizeSqliteParams(params);
    try {
      const stmt = db.query(sql);
      const args = bound as Parameters<typeof stmt.all>;
      if (this.isReadReturningSql(sql)) {
        const rows = stmt.all(...args) as T[];
        emitQueryLog(this.options.logging, sql, params, start);
        return {
          rows,
          affectedRows: rows.length,
        };
      }
      const res = stmt.run(...args);
      emitQueryLog(this.options.logging, sql, params, start);
      return {
        rows: [],
        affectedRows: Number(res.changes ?? 0),
        lastInsertRowid: res.lastInsertRowid ?? null,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      emitQueryLog(this.options.logging, sql, params, start, error);
      throw new QueryFailedError(error.message, sql, params, error);
    }
  }

  async execute(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<OrmQueryResult> {
    if (params.length === 0) {
      const db = this.rawDatabase;
      const start = performance.now();
      try {
        const res = db.run(sql);
        emitQueryLog(this.options.logging, sql, params, start);
        return {
          rows: [],
          affectedRows: Number(res.changes ?? 0),
          lastInsertRowid: res.lastInsertRowid ?? null,
        };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        emitQueryLog(this.options.logging, sql, params, start, error);
        throw new QueryFailedError(error.message, sql, params, error);
      }
    }
    return this.query(sql, params);
  }

  async transaction<T>(
    run: (executor: OrmQueryExecutor) => Promise<T> | T,
  ): Promise<T> {
    const db = this.rawDatabase;
    const existing = this.txStorage.getStore();

    if (existing) {
      const spName = `bunest_orm_sp_${++this.savepointSeq}`;
      db.run(`SAVEPOINT ${spName}`);
      try {
        const result = await this.txStorage.run(
          { depth: existing.depth + 1 },
          () => run(this),
        );
        db.run(`RELEASE SAVEPOINT ${spName}`);
        return result;
      } catch (err) {
        try {
          db.run(`ROLLBACK TO SAVEPOINT ${spName}`);
          db.run(`RELEASE SAVEPOINT ${spName}`);
        } catch {
          // Ignore secondary rollback error
        }
        throw err;
      }
    }

    const prev = this.txQueueTail;
    let release!: () => void;
    this.txQueueTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await prev;
    try {
      db.run("BEGIN IMMEDIATE");
      try {
        const result = await this.txStorage.run({ depth: 1 }, () => run(this));
        db.run("COMMIT");
        return result;
      } catch (err) {
        try {
          db.run("ROLLBACK");
        } catch {
          // Ignore secondary rollback error
        }
        throw err;
      }
    } finally {
      release();
    }
  }
}
