import {
  emitOrmQueryDiagnostic,
  hasOrmQuerySubscribers,
} from "../diagnostics";
import type {
  OrmDataSourceOptions,
  OrmDialect,
  OrmDocumentDriverLike,
  OrmDriverLike,
  OrmQueryLogEvent,
} from "../types";

export type OrmDriver = OrmDriverLike;
export type OrmDocumentDriver = OrmDocumentDriverLike;

export type OrmDriverFactory = (options: OrmDataSourceOptions) => OrmDriverLike;

export function isDocumentDriver(
  driver: OrmDriverLike,
): driver is OrmDocumentDriverLike {
  return (
    "isDocumentDriver" in driver &&
    (driver as { isDocumentDriver?: unknown }).isDocumentDriver === true
  );
}

const DRIVER_REGISTRY_SYMBOL = Symbol.for("bunest:orm:driver_registry:v1");

function getRegistryMap(): Map<string, OrmDriverFactory> {
  const g = globalThis as Record<PropertyKey, unknown>;
  let map = g[DRIVER_REGISTRY_SYMBOL] as Map<string, OrmDriverFactory> | undefined;
  if (!map) {
    map = new Map<string, OrmDriverFactory>();
    g[DRIVER_REGISTRY_SYMBOL] = map;
  }
  return map;
}

/**
 * Global extensible driver registry allowing custom or enterprise SQL adapters
 * (e.g., MSSQL, Oracle, SAP HANA, Spanner, ClickHouse, or custom HTTP bridges)
 * to plug cleanly into `new DataSource({ type: "..." })`.
 */
export class OrmDriverRegistry {
  static register(type: string, factory: OrmDriverFactory): void {
    getRegistryMap().set(type.toLowerCase(), factory);
  }

  static unregister(type: string): boolean {
    return getRegistryMap().delete(type.toLowerCase());
  }

  static get(type: string): OrmDriverFactory | undefined {
    return getRegistryMap().get(type.toLowerCase());
  }

  static has(type: string): boolean {
    return getRegistryMap().has(type.toLowerCase());
  }

  static list(): string[] {
    return [...getRegistryMap().keys()];
  }

  static clear(): void {
    getRegistryMap().clear();
  }
}

export function emitQueryLog(
  logging: boolean | ((event: OrmQueryLogEvent) => void) | undefined,
  sql: string,
  params: readonly unknown[],
  startTime: number,
  error?: Error,
): void {
  if (!logging) return;
  const durationMs = performance.now() - startTime;
  const event: OrmQueryLogEvent = {
    sql,
    params,
    durationMs,
    ...(error !== undefined ? { error } : {}),
  };
  if (typeof logging === "function") {
    logging(event);
    return;
  }
  if (error) {
    console.error(
      `[BunestORM] QUERY ERROR (${durationMs.toFixed(2)}ms): ${sql}`,
      params,
      error.message,
    );
  } else {
    console.log(`[BunestORM] QUERY (${durationMs.toFixed(2)}ms): ${sql}`, params);
  }
}

export function shouldTrackQuery(
  logging: boolean | ((event: OrmQueryLogEvent) => void) | undefined,
): boolean {
  return Boolean(logging) || hasOrmQuerySubscribers();
}

export function emitQueryTelemetry(
  logging: boolean | ((event: OrmQueryLogEvent) => void) | undefined,
  dialect: OrmDialect,
  sql: string,
  params: readonly unknown[],
  startTime: number,
  rowCount?: number,
  error?: Error,
  dataSource?: string,
): void {
  const hasSubs = hasOrmQuerySubscribers();
  if (!logging && !hasSubs) return;
  const durationMs = performance.now() - startTime;
  if (logging) {
    const event: OrmQueryLogEvent = {
      sql,
      params,
      durationMs,
      ...(error !== undefined ? { error } : {}),
    };
    if (typeof logging === "function") {
      logging(event);
    } else if (error) {
      console.error(
        `[BunestORM] QUERY ERROR (${durationMs.toFixed(2)}ms): ${sql}`,
        params,
        error.message,
      );
    } else {
      console.log(`[BunestORM] QUERY (${durationMs.toFixed(2)}ms): ${sql}`, params);
    }
  }
  if (hasSubs) {
    emitOrmQueryDiagnostic({
      sql,
      dialect,
      durationMs,
      ...(rowCount !== undefined ? { rowCount } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(dataSource !== undefined ? { dataSource } : {}),
    });
  }
}
