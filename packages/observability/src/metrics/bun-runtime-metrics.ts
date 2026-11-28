import * as bunJsc from "bun:jsc";
import type { MetricsRegistry, Gauge } from "./metrics.registry";

export interface JscMemoryUsageSnapshot {
  readonly current: number;
  readonly peak: number;
  readonly currentCommit: number;
  readonly peakCommit: number;
  readonly pageFaults: number;
}

export interface JscHeapStatsSnapshot {
  readonly heapSize?: number;
  readonly heapCapacity?: number;
  readonly extraMemorySize?: number;
  readonly objectCount?: number;
  readonly protectedObjectCount?: number;
  readonly globalObjectCount?: number;
}

export interface BunDnsCacheStatsSnapshot {
  readonly cacheHitsCompleted: number;
  readonly cacheHitsInflight: number;
  readonly cacheMisses: number;
  readonly size: number;
  readonly errors: number;
  readonly totalCount: number;
}

interface BunJscModuleLike {
  memoryUsage?(): JscMemoryUsageSnapshot;
  heapStats?(): JscHeapStatsSnapshot;
}

export function loadBunJsc(): BunJscModuleLike | undefined {
  return bunJsc as unknown as BunJscModuleLike;
}

export function readBunDnsCacheStats(): BunDnsCacheStatsSnapshot | undefined {
  try {
    const dns = (
      Bun as unknown as {
        dns?: { getCacheStats?: () => BunDnsCacheStatsSnapshot };
      }
    ).dns;
    return dns?.getCacheStats?.();
  } catch {
    return undefined;
  }
}

/**
 * Collects live Bun JavaScriptCore (`bun:jsc`) memory/heap gauges and
 * `Bun.dns.getCacheStats()` gauges into a `MetricsRegistry`.
 */
export class BunRuntimeMetricsCollector {
  private readonly jscCurrentBytes: Gauge;
  private readonly jscPeakBytes: Gauge;
  private readonly jscCommitBytes: Gauge;
  private readonly jscPageFaults: Gauge;
  private readonly jscHeapObjects: Gauge;
  private readonly dnsCacheSize: Gauge;
  private readonly dnsCacheHits: Gauge;
  private readonly dnsCacheMisses: Gauge;
  private readonly dnsCacheErrors: Gauge;

  constructor(registry: MetricsRegistry) {
    this.jscCurrentBytes = registry.createGauge({
      name: "bun_jsc_memory_current_bytes",
      help: "Current JavaScriptCore memory footprint in bytes (bun:jsc memoryUsage)",
    });
    this.jscPeakBytes = registry.createGauge({
      name: "bun_jsc_memory_peak_bytes",
      help: "Peak JavaScriptCore memory footprint in bytes (bun:jsc memoryUsage)",
    });
    this.jscCommitBytes = registry.createGauge({
      name: "bun_jsc_memory_commit_bytes",
      help: "Current JavaScriptCore committed memory in bytes (bun:jsc memoryUsage)",
    });
    this.jscPageFaults = registry.createGauge({
      name: "bun_jsc_page_faults_total",
      help: "Process page faults reported by bun:jsc memoryUsage",
    });
    this.jscHeapObjects = registry.createGauge({
      name: "bun_jsc_heap_objects",
      help: "Live JavaScriptCore heap object count (bun:jsc heapStats)",
    });
    this.dnsCacheSize = registry.createGauge({
      name: "bun_dns_cache_size",
      help: "Current entries stored in Bun DNS cache (Bun.dns.getCacheStats)",
    });
    this.dnsCacheHits = registry.createGauge({
      name: "bun_dns_cache_hits_total",
      help: "Completed + inflight Bun DNS cache hits",
    });
    this.dnsCacheMisses = registry.createGauge({
      name: "bun_dns_cache_misses_total",
      help: "Bun DNS cache misses",
    });
    this.dnsCacheErrors = registry.createGauge({
      name: "bun_dns_cache_errors_total",
      help: "Bun DNS lookup errors",
    });
  }

  collect(): void {
    const jsc = loadBunJsc();
    if (jsc) {
      const mem = jsc.memoryUsage?.();
      if (mem) {
        this.jscCurrentBytes.set(mem.current);
        this.jscPeakBytes.set(mem.peak);
        this.jscCommitBytes.set(mem.currentCommit);
        this.jscPageFaults.set(mem.pageFaults);
      }
      const stats = jsc.heapStats?.();
      if (stats && typeof stats.objectCount === "number") {
        this.jscHeapObjects.set(stats.objectCount);
      }
    }

    const dns = readBunDnsCacheStats();
    if (dns) {
      this.dnsCacheSize.set(dns.size);
      this.dnsCacheHits.set(dns.cacheHitsCompleted + dns.cacheHitsInflight);
      this.dnsCacheMisses.set(dns.cacheMisses);
      this.dnsCacheErrors.set(dns.errors);
    }
  }
}
