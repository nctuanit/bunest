import type { MetricLabels, MetricsRegistry } from "./metrics.registry";

export type StatsdCounterMode = "delta" | "cumulative";

export interface UdpStatsdExporterOptions {
  /** Target StatsD / DogStatsD host (default `"127.0.0.1"`). Supports IPv4 and IPv6 (`"::1"`). */
  readonly host?: string;
  /** Target StatsD / DogStatsD UDP port (default `8125`). */
  readonly port?: number;
  /** Optional metric name prefix (e.g. `"myapp."`). */
  readonly prefix?: string;
  /** Optional global DogStatsD tags applied to every emitted datagram. */
  readonly globalTags?: Readonly<Record<string, string>>;
  /** Maximum UDP payload size in bytes before splitting datagrams (default `1400`). */
  readonly maxDatagramBytes?: number;
  /**
   * How cumulative Prometheus counters (and histogram `.count`) are emitted on `flush()`.
   * `"delta"` (default) tracks previous values and emits increments matching StatsD `|c` semantics;
   * `"cumulative"` emits raw totals on every flush.
   */
  readonly counterMode?: StatsdCounterMode;
}

interface BunUdpSocketLike {
  send(data: string | Uint8Array, port: number, address: string): number | boolean;
  unref?(): void;
  close(): void;
}

function sanitizeMetricName(name: string): string {
  return name.replace(/[\r\n:|]+/g, "_");
}

function sanitizeTagPart(value: string): string {
  return value.replace(/[\r\n|,]+/g, "_");
}

function normalizeUdpHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function formatDogStatsdTags(
  globalTags: Readonly<Record<string, string>> | undefined,
  labels: MetricLabels | undefined,
): string {
  const parts: string[] = [];
  if (globalTags) {
    for (const [k, v] of Object.entries(globalTags)) {
      parts.push(`${sanitizeTagPart(k)}:${sanitizeTagPart(v)}`);
    }
  }
  if (labels) {
    for (const [k, v] of Object.entries(labels)) {
      parts.push(`${sanitizeTagPart(k)}:${sanitizeTagPart(String(v))}`);
    }
  }
  return parts.length > 0 ? `|#${parts.join(",")}` : "";
}

/**
 * Zero-dependency StatsD / DogStatsD UDP exporter backed by Bun's native
 * `Bun.udpSocket()`. Serializes `MetricsRegistry` snapshots (or direct metric
 * lines) into bounded UDP datagrams.
 */
export class UdpStatsdExporter {
  private readonly host: string;
  private readonly port: number;
  private readonly prefix: string;
  private readonly globalTags?: Readonly<Record<string, string>>;
  private readonly maxDatagramBytes: number;
  private readonly counterMode: StatsdCounterMode;
  private readonly lastCounters = new Map<string, number>();
  private socketPromise?: Promise<BunUdpSocketLike>;
  private closed = false;

  constructor(options: UdpStatsdExporterOptions = {}) {
    this.host = normalizeUdpHost(options.host ?? "127.0.0.1");
    this.port = options.port ?? 8125;
    this.prefix = options.prefix ?? "";
    this.globalTags = options.globalTags;
    this.maxDatagramBytes = Math.max(256, options.maxDatagramBytes ?? 1400);
    this.counterMode = options.counterMode ?? "delta";
  }

  private getSocket(): Promise<BunUdpSocketLike> {
    if (this.closed) {
      return Promise.reject(
        new Error("UdpStatsdExporter has already been closed."),
      );
    }
    if (!this.socketPromise) {
      const bindHostname = this.host.includes(":") ? "::" : "0.0.0.0";
      const udpSocketFn = (
        Bun as unknown as {
          udpSocket(opts?: Record<string, unknown>): Promise<BunUdpSocketLike>;
        }
      ).udpSocket;
      this.socketPromise = udpSocketFn({ hostname: bindHostname }).then(
        (sock) => {
          sock.unref?.();
          if (this.closed) {
            try {
              sock.close();
            } catch {
              // ignore close errors
            }
            throw new Error("UdpStatsdExporter has already been closed.");
          }
          return sock;
        },
        (err) => {
          this.socketPromise = undefined;
          throw err;
        },
      );
    }
    return this.socketPromise;
  }

  private resolveCounterEmission(
    seriesKey: string,
    current: number,
    consumeDelta: boolean,
  ): number | null {
    if (!consumeDelta) {
      return current;
    }
    const prev = this.lastCounters.get(seriesKey) ?? 0;
    const delta = current >= prev ? current - prev : current;
    this.lastCounters.set(seriesKey, current);
    return delta > 0 ? delta : null;
  }

  /**
   * Formats a `MetricsRegistry` snapshot into StatsD / DogStatsD lines.
   */
  formatRegistryLines(
    registry: MetricsRegistry,
    options?: { readonly consumeDeltas?: boolean },
  ): string[] {
    const consumeDeltas = options?.consumeDeltas === true;
    const lines: string[] = [];
    for (const metric of registry.getMetrics()) {
      const name = sanitizeMetricName(`${this.prefix}${metric.name}`);
      if (metric.type === "counter" || metric.type === "gauge") {
        const isCounter = metric.type === "counter";
        const typeTag = isCounter ? "c" : "g";
        const samples = (
          metric as unknown as {
            collect(): ReadonlyArray<{ labels: MetricLabels; value: number }>;
          }
        ).collect();
        for (const s of samples) {
          const tags = formatDogStatsdTags(this.globalTags, s.labels);
          const emitted = isCounter
            ? this.resolveCounterEmission(
                `${name}|${tags}`,
                s.value,
                consumeDeltas,
              )
            : s.value;
          if (emitted !== null) {
            lines.push(`${name}:${emitted}|${typeTag}${tags}`);
          }
        }
      } else if (metric.type === "histogram") {
        const samples = (
          metric as unknown as {
            collect(): ReadonlyArray<{
              labels: MetricLabels;
              count: number;
              sum: number;
            }>;
          }
        ).collect();
        for (const s of samples) {
          const tags = formatDogStatsdTags(this.globalTags, s.labels);
          const emittedCount = this.resolveCounterEmission(
            `${name}.count|${tags}`,
            s.count,
            consumeDeltas,
          );
          if (emittedCount !== null) {
            lines.push(`${name}.count:${emittedCount}|c${tags}`);
          }
          lines.push(`${name}.sum:${s.sum}|g${tags}`);
        }
      }
    }
    return lines;
  }

  /**
   * Sends a batch of StatsD lines over UDP, automatically chunking to stay under
   * `maxDatagramBytes`.
   */
  async sendLines(lines: readonly string[]): Promise<number> {
    if (this.closed) {
      throw new Error("UdpStatsdExporter has already been closed.");
    }
    if (lines.length === 0) return 0;
    const sock = await this.getSocket();
    if (this.closed) {
      throw new Error("UdpStatsdExporter has already been closed.");
    }
    let packets = 0;
    let batch = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const candidate = batch ? `${batch}\n${line}` : line;
      if (
        batch.length > 0 &&
        Buffer.byteLength(candidate, "utf8") > this.maxDatagramBytes
      ) {
        sock.send(batch, this.port, this.host);
        packets += 1;
        batch = line;
      } else {
        batch = candidate;
      }
    }

    if (batch.length > 0) {
      sock.send(batch, this.port, this.host);
      packets += 1;
    }

    return packets;
  }

  /**
   * Flushes all current metrics in `registry` to the configured StatsD UDP endpoint.
   */
  async flush(registry: MetricsRegistry): Promise<number> {
    if (this.closed) {
      throw new Error("UdpStatsdExporter has already been closed.");
    }
    const lines = this.formatRegistryLines(registry, {
      consumeDeltas: this.counterMode === "delta",
    });
    return this.sendLines(lines);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pending = this.socketPromise;
    this.socketPromise = undefined;
    if (pending) {
      try {
        const sock = await pending;
        sock.close();
      } catch {
        // ignore close errors
      }
    }
  }
}
