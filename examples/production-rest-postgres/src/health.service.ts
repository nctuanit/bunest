import { Inject, Injectable } from "@bunest/core";
import { DataSource, InjectDataSource } from "@bunest/orm";
import type { AppConfig } from "./config";

export const APP_CONFIG = Symbol("APP_CONFIG");

export interface ReadinessResult {
  readonly ready: boolean;
  readonly status: "ok" | "error";
  readonly reason?: string;
  readonly database: "up" | "down" | "skipped";
  readonly responseTimeMs: number;
}

@Injectable()
export class HealthService {
  private shuttingDown = false;
  private readonly startedAtMs = Date.now();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  beginShutdown(): void {
    this.shuttingDown = true;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  liveness(): {
    status: "ok";
    uptimeSeconds: number;
    pid: number;
    version: string;
  } {
    return {
      status: "ok",
      uptimeSeconds: Math.floor((Date.now() - this.startedAtMs) / 1000),
      pid: process.pid,
      version: this.config.appVersion,
    };
  }

  async readiness(): Promise<ReadinessResult> {
    const start = performance.now();
    if (this.shuttingDown) {
      return {
        ready: false,
        status: "error",
        reason: "shutting_down",
        database: "skipped",
        responseTimeMs: Math.round(performance.now() - start),
      };
    }

    const timeoutMs = this.config.readyDbTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pingPromise = this.dataSource.driver.ping
        ? this.dataSource.driver.ping()
        : this.dataSource.driver.query("SELECT 1 AS ok").then(() => true);
      const ok = await Promise.race<boolean>([
        pingPromise,
        new Promise<boolean>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`PostgreSQL readiness check timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
          if (typeof timer === "object" && timer && "unref" in timer) {
            timer.unref();
          }
        }),
      ]);
      const elapsed = Math.round(performance.now() - start);
      if (!ok) {
        return {
          ready: false,
          status: "error",
          reason: "database_unavailable",
          database: "down",
          responseTimeMs: elapsed,
        };
      }
      return {
        ready: true,
        status: "ok",
        database: "up",
        responseTimeMs: elapsed,
      };
    } catch {
      return {
        ready: false,
        status: "error",
        reason: "database_unavailable",
        database: "down",
        responseTimeMs: Math.round(performance.now() - start),
      };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
