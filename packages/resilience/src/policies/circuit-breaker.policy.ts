import { CircuitOpenError } from "../errors/circuit-open.error";
import { OptionError } from "../errors/option.error";
import { RejectionError } from "../errors/rejection.error";
import { ResilienceTimeoutError } from "../errors/resilience-timeout.error";
import type { CircuitState } from "../events/resilience-events.interface";
import type { CircuitBreakerOptions } from "../interfaces/circuit-breaker-options.interface";
import {
  callPredicate,
  countOption,
  durationOption,
  numberOption,
} from "../utils/options.util";
import {
  abortedBeforeCall,
  call,
  isClientError,
  ResiliencePolicy,
  type Execution,
  type Next,
} from "./resilience.policy";

/** `CircuitBreakerPolicy.options`: the options with defaults applied and durations in milliseconds. */
export interface ResolvedCircuitBreakerOptions {
  failureRateThreshold: number;
  minimumCalls: number;
  slidingWindow: {
    type: "count" | "time";
    size: number;
  };
  openDuration: number;
  halfOpenMaxCalls: number;
  recordIf: (error: unknown) => boolean;
}

export interface WindowStats {
  total: number;
  failures: number;
}

interface SlidingWindow {
  stats(): WindowStats;
  record(failure: boolean): void;
  reset(): void;
}

interface Permit {
  generation: number;
  halfOpen: boolean;
}

const defaultRecordIf = (error: unknown): boolean => !isClientError(error);

class CountWindow implements SlidingWindow {
  private readonly outcomes: boolean[] = [];
  private next = 0;
  private failures = 0;

  constructor(private readonly size: number) {}

  stats(): WindowStats {
    return { total: this.outcomes.length, failures: this.failures };
  }

  record(failure: boolean): void {
    if (this.outcomes.length < this.size) {
      this.outcomes.push(failure);
    } else {
      if (this.outcomes[this.next]) {
        this.failures--;
      }
      this.outcomes[this.next] = failure;
      this.next = (this.next + 1) % this.size;
    }
    if (failure) {
      this.failures++;
    }
  }

  reset(): void {
    this.outcomes.length = 0;
    this.next = 0;
    this.failures = 0;
  }
}

/** Ten buckets of `size / 10` ms each; a bucket drops out once it is `size` ms old. */
class TimeWindow implements SlidingWindow {
  private static readonly BUCKETS = 10;
  private readonly buckets: Array<{
    id: number;
    total: number;
    failures: number;
  }>;
  private readonly width: number;

  constructor(size: number) {
    this.buckets = Array.from({ length: TimeWindow.BUCKETS }, () => ({
      id: -Infinity,
      total: 0,
      failures: 0,
    }));
    this.width = size / TimeWindow.BUCKETS;
  }

  stats(): WindowStats {
    const oldest = Math.floor(Date.now() / this.width) - TimeWindow.BUCKETS;
    const stats: WindowStats = { total: 0, failures: 0 };
    for (const bucket of this.buckets) {
      if (bucket.id <= oldest) {
        continue;
      }
      stats.total += bucket.total;
      stats.failures += bucket.failures;
    }
    return stats;
  }

  record(failure: boolean): void {
    const id = Math.floor(Date.now() / this.width);
    const idx =
      ((id % TimeWindow.BUCKETS) + TimeWindow.BUCKETS) % TimeWindow.BUCKETS;
    const bucket = this.buckets[idx]!;
    if (bucket.id !== id) {
      bucket.id = id;
      bucket.total = 0;
      bucket.failures = 0;
    }
    bucket.total++;
    if (failure) {
      bucket.failures++;
    }
  }

  reset(): void {
    for (const bucket of this.buckets) {
      bucket.id = -Infinity;
      bucket.total = 0;
      bucket.failures = 0;
    }
  }
}

function isIgnoredAbort(execution: Execution): boolean {
  const { signal } = execution;
  if (!signal.aborted) {
    return false;
  }
  return (
    !(signal.reason instanceof ResilienceTimeoutError) ||
    abortedBeforeCall.has(execution)
  );
}

function resolveWindow(
  window: NonNullable<CircuitBreakerOptions["slidingWindow"]>,
): { type: "count" | "time"; size: number } {
  switch (window.type) {
    case "time":
      return {
        type: "time",
        size: durationOption(window.size, "slidingWindow.size", true),
      };
    case "count":
      return {
        type: "count",
        size: countOption(window.size, "slidingWindow.size", 1),
      };
    default: {
      const type = JSON.stringify((window as { type?: unknown }).type);
      throw new OptionError(
        "slidingWindow.type",
        `Invalid type ${type}. Use 'count' or 'time'.`,
      );
    }
  }
}

/**
 * closed -> open when, with at least `minimumCalls` in the window, the failure
 * rate reaches `failureRateThreshold`. open -> half-open once `openDuration`
 * has passed (checked lazily on the next call or `state` read). half-open lets
 * `halfOpenMaxCalls` probes through and rejects the rest; when they finish it
 * closes if their failure rate is below threshold, and opens again otherwise.
 */
export class CircuitBreakerPolicy extends ResiliencePolicy {
  readonly options: ResolvedCircuitBreakerOptions;
  private current: CircuitState = "closed";
  private generation = 0;
  private openedAt = 0;
  private readonly window: SlidingWindow;
  private probes = { started: 0, finished: 0, failures: 0 };

  constructor(options: CircuitBreakerOptions = {}) {
    super(options.name ?? "circuit-breaker");
    this.options = {
      failureRateThreshold: numberOption(
        options.failureRateThreshold ?? 50,
        "failureRateThreshold",
        0,
        100,
        true,
      ),
      minimumCalls: countOption(options.minimumCalls ?? 10, "minimumCalls", 1),
      openDuration: durationOption(
        options.openDuration ?? 30_000,
        "openDuration",
      ),
      halfOpenMaxCalls: countOption(
        options.halfOpenMaxCalls ?? 1,
        "halfOpenMaxCalls",
        1,
      ),
      recordIf: options.recordIf ?? defaultRecordIf,
      slidingWindow: resolveWindow(
        options.slidingWindow ?? { type: "count", size: 20 },
      ),
    };

    const { minimumCalls, slidingWindow } = this.options;
    if (slidingWindow.type === "count" && minimumCalls > slidingWindow.size) {
      throw new OptionError(
        "minimumCalls",
        `Invalid value ${minimumCalls}. A count window of ${slidingWindow.size} calls never holds that many: ` +
          `use at most ${slidingWindow.size}, or a larger slidingWindow.size.`,
      );
    }

    this.window =
      this.options.slidingWindow.type === "time"
        ? new TimeWindow(this.options.slidingWindow.size)
        : new CountWindow(this.options.slidingWindow.size);
  }

  get state(): CircuitState {
    this.checkOpenDuration();
    return this.current;
  }

  /** Current window contents (closed state). */
  get stats(): WindowStats & { failureRate: number } {
    const { total, failures } = this.window.stats();
    return {
      total,
      failures,
      failureRate: total ? (failures / total) * 100 : 0,
    };
  }

  /** Back to closed with an empty window. */
  reset(): void {
    this.transition("closed");
  }

  /** Opens the breaker now, for `openDuration`, e.g. from a health check or a test. */
  trip(): void {
    this.transition("open");
  }

  /** @internal */
  override async run<T>(next: Next<T>, execution: Execution): Promise<T> {
    const permit = this.acquire(execution);
    let result: T;
    try {
      result = await call(next, execution);
    } catch (error) {
      let outcome: "failure" | "ignored" = "failure";
      try {
        const ignored =
          isIgnoredAbort(execution) ||
          error instanceof RejectionError ||
          !callPredicate("recordIf", this.options.recordIf, error);
        if (ignored) {
          outcome = "ignored";
        }
      } finally {
        this.release(permit, outcome);
      }
      throw error;
    }
    this.release(permit, "success");
    return result;
  }

  private acquire(execution: Execution): Permit {
    this.checkOpenDuration();
    if (this.current === "closed") {
      return { generation: this.generation, halfOpen: false };
    }
    if (
      this.current === "half-open" &&
      this.probes.started < this.options.halfOpenMaxCalls
    ) {
      this.probes.started++;
      return { generation: this.generation, halfOpen: true };
    }
    const retryAfter =
      this.current === "open"
        ? Math.max(0, this.openedAt + this.options.openDuration - Date.now())
        : 0;
    this.emit({
      type: "circuit-rejected",
      policy: this.name,
      source: execution.source,
      retryAfterMs: retryAfter,
    });
    throw new CircuitOpenError(this.name, retryAfter);
  }

  private release(
    permit: Permit,
    outcome: "success" | "failure" | "ignored",
  ): void {
    if (permit.generation !== this.generation) {
      return;
    }
    if (!permit.halfOpen) {
      if (outcome === "ignored") {
        return;
      }
      this.window.record(outcome === "failure");
      const { total, failureRate } = this.stats;
      if (
        total >= this.options.minimumCalls &&
        failureRate >= this.options.failureRateThreshold
      ) {
        this.transition("open");
      }
      return;
    }
    if (outcome === "ignored") {
      this.probes.started--;
      return;
    }
    this.probes.finished++;
    if (outcome === "failure") {
      this.probes.failures++;
    }
    if (this.probes.finished < this.options.halfOpenMaxCalls) {
      return;
    }
    const rate = (this.probes.failures / this.probes.finished) * 100;
    this.transition(
      rate >= this.options.failureRateThreshold ? "open" : "closed",
    );
  }

  private checkOpenDuration(): void {
    if (
      this.current === "open" &&
      Date.now() - this.openedAt >= this.options.openDuration
    ) {
      this.transition("half-open");
    }
  }

  private transition(to: CircuitState): void {
    const from = this.current;
    this.current = to;
    this.generation++;
    if (to === "open") {
      this.openedAt = Date.now();
    }
    if (to === "closed") {
      this.window.reset();
    }
    if (to === "half-open") {
      this.probes = { started: 0, finished: 0, failures: 0 };
    }
    if (from === to) {
      return;
    }
    if (to === "open") {
      this.emit({ type: "circuit-open", policy: this.name, from, to });
    } else if (to === "half-open") {
      this.emit({ type: "circuit-half-open", policy: this.name, from, to });
    } else {
      this.emit({ type: "circuit-closed", policy: this.name, from, to });
    }
  }
}
