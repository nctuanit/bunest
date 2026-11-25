import { Inject, Injectable, type OnModuleDestroy } from "@bunest/core";
import type { AppConfig } from "./config";
import { APP_CONFIG } from "./health.service";

const LATENCY_WINDOW = 2048;

@Injectable()
export class MetricsService implements OnModuleDestroy {
  private totalRequests = 0;
  private total5xx = 0;
  private inFlight = 0;
  private readonly latenciesMs: number[] = [];
  private latencyIdx = 0;
  private eventLoopLagMs = 0;
  private maxEventLoopLagMs = 0;
  private readonly lagTimer: ReturnType<typeof setInterval>;
  private drainWaiters: Array<() => void> = [];

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    let expected = performance.now() + 100;
    this.lagTimer = setInterval(() => {
      const now = performance.now();
      const lag = Math.max(0, now - expected);
      this.eventLoopLagMs = lag;
      if (lag > this.maxEventLoopLagMs) {
        this.maxEventLoopLagMs = lag;
      }
      expected = now + 100;
    }, 100);
    if (typeof this.lagTimer === "object" && this.lagTimer && "unref" in this.lagTimer) {
      this.lagTimer.unref();
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.lagTimer);
  }

  beginRequest(): void {
    this.inFlight++;
  }

  endRequest(status: number, durationMs: number): void {
    this.totalRequests++;
    if (status >= 500) {
      this.total5xx++;
    }
    if (this.latenciesMs.length < LATENCY_WINDOW) {
      this.latenciesMs.push(durationMs);
    } else {
      this.latenciesMs[this.latencyIdx] = durationMs;
      this.latencyIdx = (this.latencyIdx + 1) % LATENCY_WINDOW;
    }

    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.inFlight === 0 && this.drainWaiters.length > 0) {
      const waiters = this.drainWaiters;
      this.drainWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
    }
  }

  getInFlightCount(): number {
    return this.inFlight;
  }

  async waitForDrain(timeoutMs: number): Promise<boolean> {
    if (this.inFlight === 0) {
      return true;
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }, timeoutMs);
      if (typeof timer === "object" && timer && "unref" in timer) {
        timer.unref();
      }
      this.drainWaiters.push(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
  }

  private percentile(p: number): number {
    if (this.latenciesMs.length === 0) return 0;
    const sorted = [...this.latenciesMs].sort((a, b) => a - b);
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    );
    return sorted[idx] ?? 0;
  }

  renderPrometheus(): string {
    const mem = process.memoryUsage();
    const p95 = this.percentile(95);
    const p99 = this.percentile(99);
    const lines = [
      "# HELP bunest_http_requests_total Total HTTP requests handled",
      "# TYPE bunest_http_requests_total counter",
      `bunest_http_requests_total ${this.totalRequests}`,
      "# HELP bunest_http_requests_5xx_total Total HTTP 5xx responses",
      "# TYPE bunest_http_requests_5xx_total counter",
      `bunest_http_requests_5xx_total ${this.total5xx}`,
      "# HELP bunest_http_requests_in_flight Current in-flight HTTP requests",
      "# TYPE bunest_http_requests_in_flight gauge",
      `bunest_http_requests_in_flight ${this.inFlight}`,
      "# HELP bunest_http_request_duration_ms_p95 Rolling 95th percentile HTTP duration in ms",
      "# TYPE bunest_http_request_duration_ms_p95 gauge",
      `bunest_http_request_duration_ms_p95 ${p95.toFixed(3)}`,
      "# HELP bunest_http_request_duration_ms_p99 Rolling 99th percentile HTTP duration in ms",
      "# TYPE bunest_http_request_duration_ms_p99 gauge",
      `bunest_http_request_duration_ms_p99 ${p99.toFixed(3)}`,
      "# HELP bunest_process_resident_memory_bytes Process RSS in bytes",
      "# TYPE bunest_process_resident_memory_bytes gauge",
      `bunest_process_resident_memory_bytes ${mem.rss}`,
      "# HELP bunest_event_loop_lag_ms Current event-loop lag in ms",
      "# TYPE bunest_event_loop_lag_ms gauge",
      `bunest_event_loop_lag_ms ${this.eventLoopLagMs.toFixed(3)}`,
      "# HELP bunest_event_loop_lag_max_ms Max observed event-loop lag in ms",
      "# TYPE bunest_event_loop_lag_max_ms gauge",
      `bunest_event_loop_lag_max_ms ${this.maxEventLoopLagMs.toFixed(3)}`,
      "# HELP bunest_db_pool_max Configured PostgreSQL pool max connections",
      "# TYPE bunest_db_pool_max gauge",
      `bunest_db_pool_max ${this.config.dbPoolMax}`,
      "",
    ];
    return lines.join("\n");
  }
}
