import { QueryFailedError } from "../errors";
import type {
  CloudflareD1DatabaseLike,
  OrmDialect,
  OrmQueryExecutor,
  OrmQueryLogEvent,
  OrmQueryResult,
} from "../types";
import { emitQueryLog, type OrmDriver } from "./driver.interface";

export interface D1OrmDriverOptions {
  /**
   * Direct Cloudflare D1 binding (`env.DB`) when running inside Workers / local Miniflare.
   */
  readonly binding?: CloudflareD1DatabaseLike;
  /**
   * Cloudflare REST API credentials (used over Bun's native `fetch()` when `binding` is omitted).
   */
  readonly accountId?: string;
  readonly databaseId?: string;
  readonly apiToken?: string;
  /**
   * Optional custom REST base URL (defaults to `https://api.cloudflare.com/client/v4`).
   */
  readonly apiBaseUrl?: string;
  readonly headers?: Record<string, string>;
  readonly logging?: boolean | ((event: OrmQueryLogEvent) => void);
}

interface D1ApiResponse<T> {
  readonly success?: boolean;
  readonly errors?: Array<{ readonly message?: string }>;
  readonly result?: Array<{
    readonly results?: T[];
    readonly success?: boolean;
    readonly meta?: {
      readonly changes?: number;
      readonly last_row_id?: number;
    };
  }>;
}

/**
 * Zero-dependency Cloudflare D1 driver supporting BOTH:
 * 1. Direct Cloudflare `D1Database` binding (`d1Binding: env.DB`)
 * 2. Remote Cloudflare D1 HTTP REST API powered natively by Bun's `fetch()`!
 */
export class D1OrmDriver implements OrmDriver {
  readonly dialect: OrmDialect = "d1";
  readonly driverKind = "d1";

  private readonly options: D1OrmDriverOptions;
  private connected = false;
  private inTx = false;

  constructor(options: D1OrmDriverOptions) {
    this.options = options;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (
      !this.options.binding &&
      (!this.options.accountId ||
        !this.options.databaseId ||
        !this.options.apiToken)
    ) {
      throw new Error(
        "D1OrmDriver requires either `d1Binding` OR (`accountId`, `databaseId`, `apiToken`).",
      );
    }
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
    return this.inTx;
  }

  private normalizeParams(params: readonly unknown[]): unknown[] {
    return params.map((p) => {
      if (p === undefined) return null;
      if (typeof p === "boolean") return p ? 1 : 0;
      if (p instanceof Date) return p.toISOString();
      if (typeof p === "bigint") return Number(p);
      return p;
    });
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<OrmQueryResult<T>> {
    const start = performance.now();
    const bound = this.normalizeParams(params);
    try {
      if (this.options.binding) {
        const prepared = this.options.binding.prepare(sql);
        const stmt = bound.length > 0 ? prepared.bind(...bound) : prepared;
        const res = await stmt.all<T>();
        const rows = res.results ?? [];
        emitQueryLog(this.options.logging, sql, params, start);
        return {
          rows,
          affectedRows: res.meta?.changes ?? rows.length,
          lastInsertRowid: res.meta?.last_row_id ?? null,
        };
      }

      const base = (
        this.options.apiBaseUrl ?? "https://api.cloudflare.com/client/v4"
      ).replace(/\/+$/, "");
      const url = `${base}/accounts/${this.options.accountId}/d1/database/${this.options.databaseId}/query`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.apiToken}`,
          ...(this.options.headers ?? {}),
        },
        body: JSON.stringify({ sql, params: bound }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        throw new Error(`Cloudflare D1 HTTP ${response.status}: ${text}`);
      }

      const data = (await response.json()) as D1ApiResponse<T>;
      if (data.success === false) {
        throw new Error(
          data.errors?.map((e) => e.message).join("; ") || "Cloudflare D1 query failed",
        );
      }

      const first = data.result?.[0];
      const rows = first?.results ?? [];
      emitQueryLog(this.options.logging, sql, params, start);
      return {
        rows,
        affectedRows: first?.meta?.changes ?? rows.length,
        lastInsertRowid: first?.meta?.last_row_id ?? null,
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
    // D1 executes statements atomically per batch; run sequentially in logical tx scope
    const prev = this.inTx;
    this.inTx = true;
    try {
      return await run(this);
    } finally {
      this.inTx = prev;
    }
  }
}
