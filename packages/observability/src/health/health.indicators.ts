import { statfs } from "node:fs/promises";
import { createConnection } from "node:net";
import {
  Inject,
  Injectable,
  Optional,
  type LoggerService,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@bunest/common";
import {
  HealthCheckAttempt,
  HealthIndicatorService,
} from "./health-indicator.service";
import {
  CHECK_DISK_SPACE_LIB,
  HealthIndicator,
  HealthIndicatorStatus,
  TERMINUS_LOGGER,
  type HealthIndicatorResult,
} from "./health.interface";
import {
  NotServingError,
  ResponseStatusError,
  TimeoutError,
  formatErrorMessage,
  toBytes,
  type ByteSize,
} from "./units";

export const MEMORY_HEALTH_HEAP_LIMIT = Symbol.for(
  "bunest:observability:memory_health_heap_limit",
);
export const MEMORY_HEALTH_RSS_LIMIT = Symbol.for(
  "bunest:observability:memory_health_rss_limit",
);
export const EVENT_LOOP_HEALTH_MAX_DELAY = Symbol.for(
  "bunest:observability:event_loop_health_max_delay",
);

/**
 * Checks process heapUsed and RSS memory against configured byte thresholds
 * (accepts raw bytes or human-readable `ByteSize` strings like `'150mb'`).
 */
@Injectable()
export class MemoryHealthIndicator extends HealthIndicator {
  private readonly indicatorService: HealthIndicatorService;
  private readonly defaultHeapBytes: number;
  private readonly defaultRssBytes: number;

  constructor(
    @Optional()
    healthIndicatorServiceOrHeapLimit?: HealthIndicatorService | number,
    @Optional()
    @Inject(MEMORY_HEALTH_RSS_LIMIT)
    defaultRssBytes = 1024 * 1024 * 1024,
    @Optional()
    @Inject(MEMORY_HEALTH_HEAP_LIMIT)
    injectedHeapLimit?: number,
  ) {
    super();
    if (healthIndicatorServiceOrHeapLimit instanceof HealthIndicatorService) {
      this.indicatorService = healthIndicatorServiceOrHeapLimit;
      this.defaultHeapBytes = injectedHeapLimit ?? 512 * 1024 * 1024;
    } else {
      this.indicatorService = new HealthIndicatorService();
      this.defaultHeapBytes =
        typeof healthIndicatorServiceOrHeapLimit === "number"
          ? healthIndicatorServiceOrHeapLimit
          : (injectedHeapLimit ?? 512 * 1024 * 1024);
    }
    this.defaultRssBytes = defaultRssBytes;
  }

  check(key = "memory"): HealthIndicatorResult {
    const usage = process.memoryUsage();
    const heapOk = usage.heapUsed <= this.defaultHeapBytes;
    const rssOk = usage.rss <= this.defaultRssBytes;
    const ok = heapOk && rssOk;

    return this.getStatus(key, ok, {
      heapUsedBytes: usage.heapUsed,
      heapLimitBytes: this.defaultHeapBytes,
      rssBytes: usage.rss,
      rssLimitBytes: this.defaultRssBytes,
      ...(ok
        ? {}
        : { message: "Process memory usage exceeded configured threshold" }),
    });
  }

  checkHeap<Key extends string = string>(
    key: Key,
    heapUsedThreshold: ByteSize,
  ): HealthCheckAttempt<Key> {
    const threshold = toBytes(heapUsedThreshold, "Heap threshold");
    const heapUsed = process.memoryUsage().heapUsed;
    return this.indicatorService
      .check(key)
      .attempt(() => {
        const current = process.memoryUsage().heapUsed;
        if (current > threshold) {
          throw new Error(
            `Used heap (${current} bytes) exceeded threshold (${threshold} bytes)`,
          );
        }
      })
      .withData({
        heapUsedBytes: heapUsed,
        thresholdBytes: threshold,
      }) as unknown as HealthCheckAttempt<Key>;
  }

  checkRSS<Key extends string = string>(
    key: Key,
    rssThreshold: ByteSize,
  ): HealthCheckAttempt<Key> {
    const threshold = toBytes(rssThreshold, "RSS threshold");
    const rss = process.memoryUsage().rss;
    return this.indicatorService
      .check(key)
      .attempt(() => {
        const current = process.memoryUsage().rss;
        if (current > threshold) {
          throw new Error(
            `Used RSS (${current} bytes) exceeded threshold (${threshold} bytes)`,
          );
        }
      })
      .withData({
        rssBytes: rss,
        thresholdBytes: threshold,
      }) as unknown as HealthCheckAttempt<Key>;
  }
}

/**
 * Measures event loop scheduling lag against a configurable millisecond threshold.
 */
@Injectable()
export class EventLoopHealthIndicator extends HealthIndicator {
  constructor(
    @Optional()
    @Inject(EVENT_LOOP_HEALTH_MAX_DELAY)
    private readonly maxDelayMs = 150,
  ) {
    super();
  }

  async check(
    key = "event_loop",
    maxDelayMs = this.maxDelayMs,
  ): Promise<HealthIndicatorResult> {
    const sampleMs = 5;
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, sampleMs);
      if (
        typeof timer === "object" &&
        timer !== null &&
        "unref" in timer &&
        typeof timer.unref === "function"
      ) {
        timer.unref();
      }
    });
    const lagMs = Math.max(0, performance.now() - start - sampleMs);
    const ok = lagMs <= maxDelayMs;

    return this.getStatus(key, ok, {
      lagMs: Number(lagMs.toFixed(2)),
      thresholdMs: maxDelayMs,
      ...(ok
        ? {}
        : {
            message: `Event loop lag (${lagMs.toFixed(2)}ms) exceeded threshold (${maxDelayMs}ms)`,
          }),
    });
  }
}

export type CustomIndicatorCallback = (
  key: string,
) => Promise<boolean | HealthIndicatorResult> | boolean | HealthIndicatorResult;

/**
 * Wraps any custom synchronous or asynchronous health check callback.
 */
export class CustomHealthIndicator extends HealthIndicator {
  constructor(private readonly fn: CustomIndicatorCallback) {
    super();
  }

  async check(key: string): Promise<HealthIndicatorResult> {
    const res = await this.fn(key);
    if (typeof res === "boolean") {
      return this.getStatus(
        key,
        res,
        res ? undefined : { message: `Health check "${key}" returned false` },
      );
    }
    return res;
  }
}

export interface SqlHealthTarget {
  healthCheck?(): Promise<boolean> | boolean;
  query?(sql: string): Promise<unknown> | unknown;
  queryOne?(sql: string): Promise<unknown> | unknown;
}

/**
 * Checks connectivity of any `@bunest/sql`, `@bunest/sqlite`, or custom SQL adapter.
 */
export class SqlHealthIndicator extends HealthIndicator {
  constructor(
    private readonly target: SqlHealthTarget,
    private readonly probeQuery = "SELECT 1",
  ) {
    super();
  }

  async check(key = "database"): Promise<HealthIndicatorResult> {
    const start = performance.now();
    try {
      let ok = true;
      if (typeof this.target.healthCheck === "function") {
        ok = Boolean(await this.target.healthCheck());
      } else if (typeof this.target.queryOne === "function") {
        await this.target.queryOne(this.probeQuery);
      } else if (typeof this.target.query === "function") {
        await this.target.query(this.probeQuery);
      } else {
        throw new Error(
          "SqlHealthIndicator target must implement healthCheck(), queryOne(), or query()",
        );
      }

      const latencyMs = Number((performance.now() - start).toFixed(2));
      return this.getStatus(key, ok, {
        latencyMs,
        ...(ok ? {} : { message: "Database healthCheck() returned false" }),
      });
    } catch (err) {
      const latencyMs = Number((performance.now() - start).toFixed(2));
      return this.getStatus(key, false, {
        latencyMs,
        message: formatErrorMessage(err),
      });
    }
  }
}

export interface QueueHealthCounts {
  readonly waiting?: number;
  readonly active?: number;
  readonly failed?: number;
  readonly deadLetter?: number;
}

export interface QueueHealthTarget {
  getCounts(): Promise<QueueHealthCounts> | QueueHealthCounts;
}

export interface QueueHealthThresholds {
  maxDeadLetter?: number;
  maxWaiting?: number;
  maxFailed?: number;
}

/**
 * Checks queue depth and dead-letter thresholds against any `@bunest/queues` queue/driver.
 */
export class QueueHealthIndicator extends HealthIndicator {
  constructor(
    private readonly target: QueueHealthTarget,
    private readonly thresholds: QueueHealthThresholds = {},
  ) {
    super();
  }

  async check(key = "queue"): Promise<HealthIndicatorResult> {
    try {
      const counts = await this.target.getCounts();
      const violations: string[] = [];

      if (
        this.thresholds.maxDeadLetter !== undefined &&
        (counts.deadLetter ?? 0) > this.thresholds.maxDeadLetter
      ) {
        violations.push(
          `deadLetter (${counts.deadLetter}) > ${this.thresholds.maxDeadLetter}`,
        );
      }
      if (
        this.thresholds.maxWaiting !== undefined &&
        (counts.waiting ?? 0) > this.thresholds.maxWaiting
      ) {
        violations.push(
          `waiting (${counts.waiting}) > ${this.thresholds.maxWaiting}`,
        );
      }
      if (
        this.thresholds.maxFailed !== undefined &&
        (counts.failed ?? 0) > this.thresholds.maxFailed
      ) {
        violations.push(
          `failed (${counts.failed}) > ${this.thresholds.maxFailed}`,
        );
      }

      const ok = violations.length === 0;
      return this.getStatus(key, ok, {
        ...counts,
        ...(ok ? {} : { message: violations.join("; ") }),
      });
    } catch (err) {
      return this.getStatus(key, false, {
        message: formatErrorMessage(err),
      });
    }
  }
}

// ============================================================================
// FetchHealthIndicator & HttpHealthIndicator (Zero-Dep Native `fetch()`)
// ============================================================================

export interface HttpResponseLike {
  status: number;
  statusText?: string;
}

export interface FetchLikeInit {
  method: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
}

export type FetchLike<TResponse extends HttpResponseLike = HttpResponseLike> = (
  url: string,
  init: FetchLikeInit,
) => Promise<TResponse>;

export interface FetchCheckOptions<
  TResponse extends HttpResponseLike = Response,
> {
  /** Sends the request. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike<TResponse>;
  /** HTTP method. Defaults to `"GET"`. */
  method?: string;
  headers?: Record<string, string>;
  /**
   * Custom response verifier. Return `true` for `up`, `false` for `down`,
   * or throw an error for `down` with a custom error message.
   */
  verify?: (response: TResponse) => boolean | Promise<boolean>;
}

function is2xxStatus(res: HttpResponseLike): boolean {
  return res.status >= 200 && res.status < 300;
}

function extractThrownResponse(err: unknown): HttpResponseLike | undefined {
  if (typeof err === "object" && err !== null && "response" in err) {
    const resp = (err as { response?: unknown }).response;
    if (
      typeof resp === "object" &&
      resp !== null &&
      "status" in resp &&
      typeof (resp as { status?: unknown }).status === "number"
    ) {
      return resp as HttpResponseLike;
    }
  }
  return undefined;
}

function extractThrownStatus(err: unknown): HttpResponseLike | undefined {
  if (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as { status?: unknown }).status === "number"
  ) {
    return err as HttpResponseLike;
  }
  return undefined;
}

async function discardResponseBody(response: unknown): Promise<void> {
  if (typeof response !== "object" || response === null) return;
  const r = response as {
    body?: { cancel?: () => Promise<unknown> };
    bodyUsed?: boolean;
  };
  if (r.body && typeof r.body.cancel === "function" && !r.bodyUsed) {
    await r.body.cancel().catch(() => undefined);
  }
}

/**
 * Checks HTTP endpoints using native `fetch()` or any `FetchLike` implementation.
 * Zero external runtime dependencies.
 */
@Injectable()
export class FetchHealthIndicator extends HealthIndicator {
  private readonly indicatorService: HealthIndicatorService;

  constructor(
    @Optional()
    healthIndicatorService?: HealthIndicatorService,
  ) {
    super();
    this.indicatorService =
      healthIndicatorService ?? new HealthIndicatorService();
  }

  pingCheck<
    const TKey extends string,
    TResponse extends HttpResponseLike = Response,
  >(
    key: TKey,
    url: string | URL,
    {
      fetch = globalThis.fetch as unknown as FetchLike<TResponse>,
      method = "GET",
      headers,
      verify = is2xxStatus as (response: TResponse) => boolean,
    }: FetchCheckOptions<TResponse> = {},
  ): HealthCheckAttempt<
    TKey,
    void,
    {},
    undefined,
    { statusCode?: number; statusText?: string }
  > {
    return this.indicatorService
      .check(key)
      .attempt(async ({ signal }) => {
        let response: TResponse;
        try {
          response = await fetch(url.toString(), { method, headers, signal });
        } catch (err) {
          const thrown = extractThrownResponse(err);
          if (!thrown) {
            const failed = extractThrownStatus(err);
            if (failed) {
              throw new ResponseStatusError(
                `Request failed with status code ${failed.status}`,
                failed.status,
                failed.statusText,
              );
            }
            if (err instanceof TypeError && err.cause instanceof Error) {
              throw new Error(`${err.message}: ${err.cause.message}`);
            }
            throw err;
          }
          response = thrown as TResponse;
        }

        let healthy: boolean;
        try {
          healthy = await verify(response);
        } catch (err) {
          throw new ResponseStatusError(
            formatErrorMessage(err),
            response.status,
            response.statusText,
          );
        } finally {
          await discardResponseBody(response);
        }

        if (!healthy && is2xxStatus(response)) {
          throw new ResponseStatusError(
            "Response did not pass the check",
            response.status,
            response.statusText,
          );
        }
        if (!healthy) {
          throw new ResponseStatusError(
            `Request failed with status code ${response.status}`,
            response.status,
            response.statusText,
          );
        }
      })
      .withFailureData((error) => {
        if (error instanceof ResponseStatusError) {
          return {
            statusCode: error.statusCode,
            statusText: error.statusText,
          };
        }
        return {};
      })
      .withTimeout(1000);
  }
}

export interface HttpHealthResponse<T = any> {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: T;
}

export interface HttpHealthCheckRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  timeout?: number;
  fetch?: FetchLike<Response>;
  httpClient?: {
    request<T = any>(
      config: Record<string, unknown>,
    ): Promise<HttpHealthResponse<T>>;
  };
  [key: string]: unknown;
}

/**
 * Compatibility HTTP health indicator powered natively by `fetch()` (zero Axios/RxJS deps).
 * Prefer `FetchHealthIndicator` for fluent `HealthCheckAttempt` chaining.
 */
@Injectable()
export class HttpHealthIndicator
  extends HealthIndicator
  implements OnModuleInit
{
  private readonly indicatorService: HealthIndicatorService;

  constructor(
    @Optional()
    @Inject(TERMINUS_LOGGER)
    private readonly logger?: LoggerService,
    @Optional()
    healthIndicatorService?: HealthIndicatorService,
  ) {
    super();
    this.indicatorService =
      healthIndicatorService ?? new HealthIndicatorService(this.logger);
  }

  async onModuleInit(): Promise<void> {
    // Native fetch() requires no external peer dependency initialization.
  }

  async pingCheck<Key extends string>(
    key: Key,
    url: URL | string,
    options: HttpHealthCheckRequestOptions = {},
  ): Promise<HealthIndicatorResult<Key>> {
    const { timeout = 1000, method = "GET", headers, fetch, httpClient } = options;

    if (httpClient && typeof httpClient.request === "function") {
      return (await this.indicatorService
        .check(key)
        .attempt(async () => {
          const res = await httpClient.request({
            url: url.toString(),
            method,
            headers,
          });
          if (!is2xxStatus(res)) {
            throw new ResponseStatusError(
              `Request failed with status code ${res.status}`,
              res.status,
              res.statusText,
            );
          }
        })
        .withFailureData((err) =>
          err instanceof ResponseStatusError
            ? { statusCode: err.statusCode, statusText: err.statusText }
            : {},
        )
        .withTimeout(timeout)) as unknown as HealthIndicatorResult<Key>;
    }

    const fetchIndicator = new FetchHealthIndicator(this.indicatorService);
    return (await fetchIndicator
      .pingCheck(key, url, { fetch, method, headers })
      .withTimeout(timeout)) as unknown as HealthIndicatorResult<Key>;
  }

  async responseCheck<T = any, Key extends string = string>(
    key: Key,
    url: URL | string,
    callback: (response: HttpHealthResponse<T>) => boolean | Promise<boolean>,
    options: HttpHealthCheckRequestOptions = {},
  ): Promise<HealthIndicatorResult<Key>> {
    const {
      timeout = 1000,
      method = "GET",
      headers,
      fetch = globalThis.fetch as unknown as FetchLike<Response>,
      httpClient,
    } = options;

    return (await this.indicatorService
      .check(key)
      .attempt(async ({ signal }) => {
        let httpRes: HttpHealthResponse<T>;
        if (httpClient && typeof httpClient.request === "function") {
          httpRes = await httpClient.request<T>({
            url: url.toString(),
            method,
            headers,
          });
        } else {
          const raw = await fetch(url.toString(), { method, headers, signal });
          const contentType = raw.headers?.get?.("content-type") ?? "";
          let data: unknown;
          if (typeof raw.text === "function") {
            const text = await raw.text();
            if (contentType.includes("application/json") && text.length > 0) {
              try {
                data = JSON.parse(text);
              } catch {
                data = text;
              }
            } else {
              data = text;
            }
          }
          const headerRecord: Record<string, string> = {};
          raw.headers?.forEach?.((value, k) => {
            headerRecord[k] = value;
          });
          httpRes = {
            status: raw.status,
            statusText: raw.statusText ?? "",
            headers: headerRecord,
            data: data as T,
          };
        }

        const ok = await callback(httpRes);
        if (!ok) {
          throw new ResponseStatusError(
            "Response did not pass the check",
            httpRes.status,
            httpRes.statusText,
          );
        }
      })
      .withFailureData((err) =>
        err instanceof ResponseStatusError
          ? { statusCode: err.statusCode, statusText: err.statusText }
          : {},
      )
      .withTimeout(timeout)) as unknown as HealthIndicatorResult<Key>;
  }
}

// ============================================================================
// DiskHealthIndicator (Zero-Dep Native `node:fs/promises` `statfs()`)
// ============================================================================

export interface DiskSpaceInfo {
  free: number;
  size: number;
}

export type CheckDiskSpace = (path: string) => Promise<DiskSpaceInfo>;

interface DiskOptionsBase {
  path: string;
}

export type DiskOptionsWithThreshold = DiskOptionsBase & {
  threshold: ByteSize;
  thresholdPercent?: never;
};

export type DiskOptionsWithThresholdPercent = DiskOptionsBase & {
  thresholdPercent: number;
  threshold?: never;
};

export type DiskHealthIndicatorOptions =
  | DiskOptionsWithThreshold
  | DiskOptionsWithThresholdPercent;

export async function defaultCheckDiskSpace(
  targetPath: string,
): Promise<DiskSpaceInfo> {
  const stats = await statfs(targetPath);
  const blockSize = Number(stats.bsize);
  const totalBlocks = Number(stats.blocks);
  const availableBlocks = Number(stats.bavail);
  return {
    free: availableBlocks * blockSize,
    size: totalBlocks * blockSize,
  };
}

/**
 * Checks disk storage usage using native `fs.promises.statfs` (zero external deps).
 */
@Injectable()
export class DiskHealthIndicator extends HealthIndicator {
  private readonly checkDiskSpace: CheckDiskSpace;
  private readonly indicatorService: HealthIndicatorService;

  constructor(
    @Optional()
    @Inject(CHECK_DISK_SPACE_LIB)
    checkDiskSpace?: CheckDiskSpace,
    @Optional()
    healthIndicatorService?: HealthIndicatorService,
  ) {
    super();
    this.checkDiskSpace = checkDiskSpace ?? defaultCheckDiskSpace;
    this.indicatorService =
      healthIndicatorService ?? new HealthIndicatorService();
  }

  checkStorage<Key extends string = string>(
    key: Key,
    options: DiskHealthIndicatorOptions,
  ): HealthCheckAttempt<Key> {
    const threshold = toBytes(
      "threshold" in options && options.threshold !== undefined
        ? options.threshold
        : 0,
      "Disk threshold",
    );

    return this.indicatorService.check(key).attempt(async () => {
      const { free, size } = await this.checkDiskSpace(options.path);
      const used = size - free;
      if (Number.isNaN(size) || size <= 0) {
        throw new Error("The used disk storage has exceeded the threshold");
      }

      const isHealthy =
        "thresholdPercent" in options && options.thresholdPercent != null
          ? options.thresholdPercent >= used / size
          : threshold >= used;

      if (!isHealthy) {
        throw new Error("The used disk storage has exceeded the threshold");
      }
    }) as unknown as HealthCheckAttempt<Key>;
  }
}

// ============================================================================
// PrismaHealthIndicator (Zero-Dep Structural Duck-Typing)
// ============================================================================

type PrismaPingCommand = {
  [Key in string]?: number;
};

export type PrismaHealthClient =
  | { $runCommandRaw: (command: PrismaPingCommand) => unknown }
  | { $queryRawUnsafe: (query: string) => unknown }
  | {
      $runCommandRaw?: (command: PrismaPingCommand) => unknown;
      $queryRawUnsafe?: (query: string) => unknown;
      healthCheck?: () => Promise<boolean> | boolean;
    };

export interface PrismaClientPingCheckSettings {
  /**
   * The amount of time the check should require in ms.
   * @deprecated Chain `.withTimeout(ms)` on the returned attempt instead.
   */
  timeout?: number;
}

/**
 * Checks connectivity of any Prisma Client (SQL or MongoDB) using zero-dep duck-typing.
 */
@Injectable()
export class PrismaHealthIndicator extends HealthIndicator {
  private readonly indicatorService: HealthIndicatorService;

  constructor(
    @Optional()
    healthIndicatorService?: HealthIndicatorService,
  ) {
    super();
    this.indicatorService =
      healthIndicatorService ?? new HealthIndicatorService();
  }

  private async pingDb(prismaClient: PrismaHealthClient): Promise<void> {
    const client = prismaClient as {
      $runCommandRaw?: (cmd: PrismaPingCommand) => unknown;
      $queryRawUnsafe?: (query: string) => unknown;
      healthCheck?: () => Promise<boolean> | boolean;
    };

    if (typeof client.$runCommandRaw === "function") {
      try {
        await client.$runCommandRaw({ ping: 1 });
        return;
      } catch (err) {
        if (
          typeof client.$queryRawUnsafe === "function" &&
          err instanceof Error &&
          err.toString().includes("Use the mongodb provider")
        ) {
          await client.$queryRawUnsafe("SELECT 1");
          return;
        }
        throw err;
      }
    }

    if (typeof client.$queryRawUnsafe === "function") {
      await client.$queryRawUnsafe("SELECT 1");
      return;
    }

    if (typeof client.healthCheck === "function") {
      const ok = await client.healthCheck();
      if (!ok) {
        throw new Error("Prisma healthCheck() returned false");
      }
      return;
    }

    throw new Error(
      "PrismaHealthIndicator requires a client implementing $queryRawUnsafe() or $runCommandRaw()",
    );
  }

  pingCheck<Key extends string = string>(
    key: Key,
    prismaClient: PrismaHealthClient,
    options: PrismaClientPingCheckSettings = {},
  ): HealthCheckAttempt<Key, void, {}, undefined, { code?: string | number }> {
    return this.indicatorService
      .check(key)
      .attempt(() => this.pingDb(prismaClient))
      .withFailureData((error) => {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? (error as { code?: string | number }).code
            : undefined;
        return { code };
      })
      .withTimeout(options.timeout ?? 1000);
  }
}

// ============================================================================
// MicroserviceHealthIndicator (Zero-Dep TCP/Transport Probe)
// ============================================================================

export interface MicroserviceOptionsLike {
  transport?: number | string;
  options?: Record<string, unknown> & {
    host?: string;
    port?: number;
    url?: string;
    urls?: readonly string[];
    servers?: readonly string[];
    queue?: string;
  };
  client?: {
    connect(): Promise<unknown> | unknown;
    close?(): Promise<unknown> | unknown;
  };
  ping?: (signal: AbortSignal) => Promise<void> | void;
}

export type MicroserviceHealthIndicatorOptions<
  T extends MicroserviceOptionsLike = MicroserviceOptionsLike,
> = {
  transport: NonNullable<MicroserviceOptionsLike["transport"]>;
  /**
   * The amount of time the check should require in ms.
   * @deprecated Chain `.withTimeout(ms)` on the returned attempt instead.
   */
  timeout?: number;
} & Partial<T>;

function parseHostPortFromOptions(
  opts: MicroserviceOptionsLike["options"],
): { host: string; port: number } | undefined {
  if (!opts) return undefined;
  if (typeof opts.port === "number" && opts.port > 0) {
    return {
      host: typeof opts.host === "string" && opts.host ? opts.host : "127.0.0.1",
      port: opts.port,
    };
  }
  const urlCandidate =
    typeof opts.url === "string"
      ? opts.url
      : Array.isArray(opts.urls) && typeof opts.urls[0] === "string"
        ? opts.urls[0]
        : Array.isArray(opts.servers) && typeof opts.servers[0] === "string"
          ? opts.servers[0]
          : undefined;
  if (urlCandidate) {
    try {
      const normalized = urlCandidate.includes("://")
        ? urlCandidate
        : `tcp://${urlCandidate}`;
      const parsed = new URL(normalized);
      const port = Number(parsed.port);
      if (parsed.hostname && Number.isInteger(port) && port > 0) {
        return { host: parsed.hostname, port };
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function probeTcpConnection(
  host: string,
  port: number,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new TimeoutError("Microservice ping aborted"));
      return;
    }

    const socket = createConnection({ host, port });
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.destroy();
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new TimeoutError("Microservice ping timed out"));
    };

    signal.addEventListener("abort", onAbort, { once: true });

    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    });

    socket.once("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
  });
}

/**
 * Probes microservice transport connectivity via custom client/ping hook or native TCP socket.
 */
@Injectable()
export class MicroserviceHealthIndicator
  extends HealthIndicator
  implements OnModuleInit
{
  private readonly indicatorService: HealthIndicatorService;

  constructor(
    @Optional()
    healthIndicatorService?: HealthIndicatorService,
  ) {
    super();
    this.indicatorService =
      healthIndicatorService ?? new HealthIndicatorService();
  }

  async onModuleInit(): Promise<void> {
    // Zero-dep native probe requires no external package loading.
  }

  pingCheck<
    MicroserviceClientOptions extends MicroserviceOptionsLike = MicroserviceOptionsLike,
    Key extends string = string,
  >(
    key: Key,
    options: MicroserviceHealthIndicatorOptions<MicroserviceClientOptions>,
  ): HealthCheckAttempt<Key, void, {}, undefined, { code?: string | number }> {
    return this.indicatorService
      .check(key)
      .attempt(async ({ signal }) => {
        if (typeof options.ping === "function") {
          await options.ping(signal);
          return;
        }
        if (options.client && typeof options.client.connect === "function") {
          try {
            await options.client.connect();
          } finally {
            await options.client.close?.();
          }
          return;
        }

        const endpoint = parseHostPortFromOptions(options.options);
        if (!endpoint) {
          throw new Error(
            `MicroserviceHealthIndicator("${key}") requires options.options.{host,port}, options.options.url, options.client, or options.ping`,
          );
        }

        await probeTcpConnection(endpoint.host, endpoint.port, signal);
      })
      .withFailureData((error) => {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? (error as { code?: string | number }).code
            : undefined;
        return { code };
      })
      .withTimeout(options.timeout ?? 1000);
  }
}

// ============================================================================
// GRPCHealthIndicator (Zero-Dep gRPC Health Probe)
// ============================================================================

const GrpcServingStatus: Record<number, string> = {
  0: "UNKNOWN",
  1: "SERVING",
  2: "NOT_SERVING",
  3: "SERVICE_UNKNOWN",
};

export type HealthServiceCheck = (
  healthService: any,
  service: string,
) => Promise<any>;

export interface GrpcClientOptionsLike {
  transport?: number | string;
  options?: {
    url?: string;
    package?: string | string[];
    protoPath?: string | string[];
    [key: string]: unknown;
  };
}

type GrpcOptionsOf<T extends GrpcClientOptionsLike> = NonNullable<T["options"]>;

export type CheckGRPCServiceOptions<
  GrpcOptions extends GrpcClientOptionsLike = GrpcClientOptionsLike,
> = Partial<GrpcOptionsOf<GrpcOptions>> & {
  /**
   * The amount of time the check should require in ms.
   * @deprecated Chain `.withTimeout(ms)` on the returned attempt instead.
   */
  timeout?: number;
  healthServiceName?: string;
  healthServiceCheck?: HealthServiceCheck;
  /** Optional pre-configured gRPC client or service stub with `check({ service })` or `getService(name)` */
  healthService?: unknown;
  client?: {
    getService?(name: string): unknown;
    close?(): void;
  };
};

/**
 * Checks gRPC service health using the standard `grpc.health.v1.Health/Check`
 * protocol or a custom `healthServiceCheck` callback (zero external runtime deps).
 */
@Injectable()
export class GRPCHealthIndicator
  extends HealthIndicator
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly indicatorService: HealthIndicatorService;
  private readonly clients = new Map<string, { close?(): void }>();

  constructor(
    @Optional()
    healthIndicatorService?: HealthIndicatorService,
  ) {
    super();
    this.indicatorService =
      healthIndicatorService ?? new HealthIndicatorService();
  }

  async onModuleInit(): Promise<void> {
    // Zero-dep implementation requires no external gRPC peer loading.
  }

  onApplicationShutdown(): void {
    for (const client of this.clients.values()) {
      try {
        client.close?.();
      } catch {
        // ignore close errors during shutdown
      }
    }
    this.clients.clear();
  }

  checkService<
    GrpcOptions extends GrpcClientOptionsLike = GrpcClientOptionsLike,
    Key extends string = string,
  >(
    key: Key,
    service: string,
    options: CheckGRPCServiceOptions<GrpcOptions> = {},
  ): HealthCheckAttempt<
    Key,
    { statusCode: number; servingStatus: string },
    {},
    { statusCode: number; servingStatus: string },
    { statusCode?: number; servingStatus?: string | number; code?: number }
  > {
    const timeout = options.timeout ?? 1000;
    const healthServiceName = options.healthServiceName ?? "Health";

    return this.indicatorService
      .check(key)
      .attempt(async ({ signal }) => {
        if (options.client) {
          this.clients.set(key, options.client);
        }

        const serviceObj =
          options.healthService ??
          options.client?.getService?.(healthServiceName);

        let response: { status: number | string };

        if (typeof options.healthServiceCheck === "function") {
          response = await options.healthServiceCheck(serviceObj, service);
        } else if (
          serviceObj &&
          typeof (serviceObj as { check?: unknown }).check === "function"
        ) {
          response = await (
            serviceObj as { check: (req: { service: string }) => Promise<any> }
          ).check({ service });
        } else if (typeof options.url === "string" && options.url.length > 0) {
          const endpoint = parseHostPortFromOptions({ url: options.url });
          if (!endpoint) {
            throw new Error(`Invalid gRPC url "${options.url}"`);
          }
          await probeTcpConnection(endpoint.host, endpoint.port, signal);
          response = { status: 1 };
        } else {
          throw new Error(
            `GRPCHealthIndicator("${key}") requires "url", "healthService", "client", or "healthServiceCheck"`,
          );
        }

        const statusCode =
          typeof response?.status === "number"
            ? response.status
            : response?.status === "SERVING"
              ? 1
              : response?.status === "NOT_SERVING"
                ? 2
                : response?.status === "SERVICE_UNKNOWN"
                  ? 3
                  : 0;
        const servingStatus =
          GrpcServingStatus[statusCode] ?? String(response?.status ?? "UNKNOWN");

        if (statusCode !== 1) {
          throw new NotServingError(statusCode, servingStatus);
        }

        return { statusCode, servingStatus };
      })
      .withSuccessData((data) => data)
      .withFailureData((error) => {
        if (error instanceof NotServingError) {
          return {
            statusCode: error.statusCode,
            servingStatus: error.servingStatus,
          };
        }
        const code =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : undefined;
        return { code };
      })
      .withTimeout(timeout);
  }
}

export { HealthIndicatorStatus };
