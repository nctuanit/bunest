import { ContextStorage as AsyncLocalStorage } from "@bunest/core";
import { QueryFailedError } from "../errors";
import type {
  OrmDialect,
  OrmQueryExecutor,
  OrmQueryLogEvent,
  OrmQueryResult,
} from "../types";
import { emitQueryLog, type OrmDriver } from "./driver.interface";

export interface LibSqlOrmDriverOptions {
  /**
   * Turso / LibSQL URL (`libsql://...`, `https://...`, or `http://localhost:8080`).
   */
  readonly url: string | URL;
  readonly authToken?: string;
  readonly headers?: Record<string, string>;
  readonly logging?: boolean | ((event: OrmQueryLogEvent) => void);
}

interface HranaValue {
  readonly type: "null" | "integer" | "float" | "text" | "blob";
  readonly value?: string | number;
  readonly base64?: string;
}

interface HranaPipelineResponse {
  readonly baton?: string | null;
  readonly base_url?: string | null;
  readonly results?: Array<{
    readonly type: "ok" | "error";
    readonly response?: {
      readonly type?: string;
      readonly result?: {
        readonly cols?: Array<{ readonly name: string | null }>;
        readonly rows?: HranaValue[][];
        readonly affected_row_count?: number;
        readonly last_insert_rowid?: string | number | null;
      };
    };
    readonly error?: { readonly message?: string; readonly code?: string };
  }>;
}

interface LibSqlTxContext {
  baton: string | null;
  baseUrl: string;
  depth: number;
}

function normalizeHranaUrl(raw: string | URL): string {
  const s = String(raw).replace(/\/+$/, "");
  if (s.startsWith("libsql://")) {
    return `https://${s.slice("libsql://".length)}`;
  }
  if (s.startsWith("wss://")) {
    return `https://${s.slice("wss://".length)}`;
  }
  if (s.startsWith("ws://")) {
    return `http://${s.slice("ws://".length)}`;
  }
  return s;
}

function encodeHranaValue(val: unknown): HranaValue {
  if (val === null || val === undefined) {
    return { type: "null" };
  }
  if (typeof val === "boolean") {
    return { type: "integer", value: val ? "1" : "0" };
  }
  if (typeof val === "bigint") {
    return { type: "integer", value: val.toString() };
  }
  if (typeof val === "number") {
    if (Number.isInteger(val)) {
      return { type: "integer", value: String(val) };
    }
    return { type: "float", value: val };
  }
  if (val instanceof Date) {
    return { type: "text", value: val.toISOString() };
  }
  if (val instanceof Uint8Array) {
    return { type: "blob", base64: Buffer.from(val).toString("base64") };
  }
  return { type: "text", value: String(val) };
}

function decodeHranaValue(v: HranaValue | undefined): unknown {
  if (!v || v.type === "null") return null;
  if (v.type === "integer") {
    const n = Number(v.value);
    return Number.isSafeInteger(n) ? n : BigInt(String(v.value));
  }
  if (v.type === "float") return Number(v.value);
  if (v.type === "blob") {
    return v.base64 ? new Uint8Array(Buffer.from(v.base64, "base64")) : new Uint8Array();
  }
  return v.value ?? null;
}

/**
 * Zero-dependency Turso / LibSQL driver powered natively by Bun's `fetch()`
 * speaking the official **Hrana HTTP v2** protocol (`/v2/pipeline`) with interactive
 * baton transactions & nested `SAVEPOINT`s via `AsyncLocalStorage`.
 */
export class LibSqlOrmDriver implements OrmDriver {
  readonly dialect: OrmDialect = "libsql";
  readonly driverKind = "libsql-http";

  private readonly baseUrl: string;
  private readonly options: LibSqlOrmDriverOptions;
  private readonly txStorage = new AsyncLocalStorage<LibSqlTxContext>();
  private connected = false;
  private savepointSeq = 0;

  constructor(options: LibSqlOrmDriverOptions) {
    this.options = options;
    this.baseUrl = normalizeHranaUrl(options.url);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  async ping(): Promise<boolean> {
    const res = await this.query<{ ok: number }>("SELECT 1 AS ok");
    return Number(res.rows[0]?.ok) === 1;
  }

  isInTransaction(): boolean {
    return this.txStorage.getStore() !== undefined;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.options.headers ?? {}),
    };
    if (this.options.authToken) {
      headers["Authorization"] = `Bearer ${this.options.authToken}`;
    }
    return headers;
  }

  private async sendPipeline(
    requests: readonly Record<string, unknown>[],
    tx?: LibSqlTxContext,
  ): Promise<HranaPipelineResponse> {
    const endpoint = `${tx?.baseUrl ?? this.baseUrl}/v2/pipeline`;
    const body = {
      ...(tx?.baton ? { baton: tx.baton } : {}),
      requests,
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(`LibSQL Hrana HTTP ${response.status}: ${text}`);
    }

    const parsed = (await response.json()) as HranaPipelineResponse;
    if (tx) {
      tx.baton = parsed.baton ?? null;
      if (parsed.base_url) {
        tx.baseUrl = parsed.base_url.replace(/\/+$/, "");
      }
    }
    return parsed;
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<OrmQueryResult<T>> {
    const start = performance.now();
    const tx = this.txStorage.getStore();
    try {
      const reqs: Record<string, unknown>[] = [
        {
          type: "execute",
          stmt: {
            sql,
            args: params.map(encodeHranaValue),
          },
        },
      ];
      // Close ephemeral stream when outside a transaction
      if (!tx) {
        reqs.push({ type: "close" });
      }

      const payload = await this.sendPipeline(reqs, tx);
      const first = payload.results?.[0];
      if (!first) {
        emitQueryLog(this.options.logging, sql, params, start);
        return { rows: [], affectedRows: 0 };
      }
      if (first.type === "error") {
        throw new Error(
          first.error?.message ?? `LibSQL execution error (${first.error?.code ?? "UNKNOWN"})`,
        );
      }

      const res = first.response?.result;
      const cols = res?.cols ?? [];
      const rawRows = res?.rows ?? [];
      const rows: T[] = rawRows.map((rowVals) => {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < cols.length; i++) {
          const colName = cols[i]?.name ?? `col_${i}`;
          obj[colName] = decodeHranaValue(rowVals[i]);
        }
        return obj as T;
      });

      const affectedRows =
        res?.affected_row_count !== undefined
          ? Number(res.affected_row_count)
          : rows.length;

      emitQueryLog(this.options.logging, sql, params, start);
      return {
        rows,
        affectedRows,
        lastInsertRowid:
          res?.last_insert_rowid !== undefined && res?.last_insert_rowid !== null
            ? Number(res.last_insert_rowid)
            : null,
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
    return this.query(sql, params);
  }

  async transaction<T>(
    run: (executor: OrmQueryExecutor) => Promise<T> | T,
  ): Promise<T> {
    const existing = this.txStorage.getStore();
    if (existing) {
      const sp = `bunest_libsql_sp_${++this.savepointSeq}`;
      await this.execute(`SAVEPOINT ${sp}`);
      try {
        const result = await this.txStorage.run(
          { ...existing, depth: existing.depth + 1 },
          () => run(this),
        );
        await this.execute(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (err) {
        try {
          await this.execute(`ROLLBACK TO SAVEPOINT ${sp}`);
          await this.execute(`RELEASE SAVEPOINT ${sp}`);
        } catch {
          // Ignore secondary rollback error
        }
        throw err;
      }
    }

    const txCtx: LibSqlTxContext = {
      baton: null,
      baseUrl: this.baseUrl,
      depth: 1,
    };

    return await this.txStorage.run(txCtx, async () => {
      await this.sendPipeline(
        [{ type: "execute", stmt: { sql: "BEGIN" } }],
        txCtx,
      );
      try {
        const result = await run(this);
        await this.sendPipeline(
          [
            { type: "execute", stmt: { sql: "COMMIT" } },
            { type: "close" },
          ],
          txCtx,
        );
        return result;
      } catch (err) {
        try {
          await this.sendPipeline(
            [
              { type: "execute", stmt: { sql: "ROLLBACK" } },
              { type: "close" },
            ],
            txCtx,
          );
        } catch {
          // Ignore secondary rollback error
        }
        throw err;
      }
    });
  }
}
