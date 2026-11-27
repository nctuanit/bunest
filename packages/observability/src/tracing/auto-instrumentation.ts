import {
  Inject,
  Injectable,
  Optional,
  diagnosticsChannel,
  registerAmbientTraceparentProvider,
  type DiagnosticChannel,
  type DiagnosticChannelSubscriber,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@bunest/core";
import type { SpanAttributeValue, SpanKind } from "./span";
import {
  formatTraceParent,
  parseTraceParent,
  traceContextStorage,
  type SpanContext,
} from "./trace-context";
import { Tracer } from "./tracer";

export const AUTO_INSTRUMENT_OPTIONS = Symbol.for(
  "bunest:observability:auto_instrument_options",
);

export const ORM_QUERY_DIAGNOSTICS_CHANNEL = "bunest:orm:query";
export const ORM_TRANSACTION_DIAGNOSTICS_CHANNEL = "bunest:orm:transaction";
export const JOBS_ENQUEUE_DIAGNOSTICS_CHANNEL = "bunest:jobs:enqueue";
export const JOBS_PROCESS_DIAGNOSTICS_CHANNEL = "bunest:jobs:process";
export const RPC_CLIENT_DIAGNOSTICS_CHANNEL = "bunest:rpc:client";
export const RPC_SERVER_DIAGNOSTICS_CHANNEL = "bunest:rpc:server";
export const HTTP_CLIENT_REQUEST_DIAGNOSTICS_CHANNEL =
  "bunest:http-client:request";

export interface AutoInstrumentOptions {
  /**
   * Master switch controlling whether auto-instrumentation activates on init.
   * @default true
   */
  readonly enabled?: boolean;
  /** Subscribe to `"bunest:orm:query"` and `"bunest:orm:transaction"`. @default true */
  readonly orm?: boolean;
  /** Subscribe to `"bunest:jobs:enqueue"` and `"bunest:jobs:process"`. @default true */
  readonly jobs?: boolean;
  /** Subscribe to `"bunest:rpc:client"` and `"bunest:rpc:server"`. @default true */
  readonly rpc?: boolean;
  /** Subscribe to `"bunest:http-client:request"`. @default true */
  readonly httpClient?: boolean;
  /**
   * Register the ambient W3C `traceparent` provider on `@bunest/core` so
   * `HttpClient`, `Queue`, and `ClientProxy` auto-inject `traceparent` with
   * zero cross-package coupling.
   * @default true
   */
  readonly ambientTraceparent?: boolean;
  /** Maximum characters kept for `db.statement` attributes. @default 2048 */
  readonly maxSqlLength?: number;
}

interface RawEventRecord {
  readonly [key: string]: unknown;
}

function asRecord(value: unknown): RawEventRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as RawEventRecord;
}

function readString(
  rec: RawEventRecord,
  key: string,
): string | undefined {
  const val = rec[key];
  return typeof val === "string" && val.length > 0 ? val : undefined;
}

function readNumber(
  rec: RawEventRecord,
  key: string,
): number | undefined {
  const val = rec[key];
  return typeof val === "number" && Number.isFinite(val) ? val : undefined;
}

function parseTraceParentContext(
  traceparent: string | undefined,
): SpanContext | undefined {
  if (!traceparent) return undefined;
  const parsed = parseTraceParent(traceparent);
  if (!parsed) return undefined;
  return {
    traceId: parsed.traceId,
    spanId: parsed.spanId,
    traceFlags: parsed.traceFlags,
    sampled: parsed.sampled,
  };
}

function extractSqlOperation(sql: string | undefined): string {
  if (!sql) return "QUERY";
  const match = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*([a-zA-Z]+)/.exec(sql);
  return match?.[1] ? match[1].toUpperCase() : "QUERY";
}

function truncateStatement(sql: string, maxLen: number): string {
  if (sql.length <= maxLen) return sql;
  return `${sql.slice(0, Math.max(0, maxLen - 3))}...`;
}

function parseUrlParts(rawUrl: string): {
  readonly pathname: string;
  readonly hostname?: string;
  readonly port?: number;
} {
  try {
    const parsed = new URL(rawUrl);
    return {
      pathname: parsed.pathname || "/",
      hostname: parsed.hostname || undefined,
      port: parsed.port ? Number(parsed.port) : undefined,
    };
  } catch {
    return { pathname: rawUrl };
  }
}

/**
 * Zero-config cross-subsystem OpenTelemetry auto-instrumentation service.
 *
 * Subscribes to `@bunest/core`'s native `diagnosticsChannel()` bus for ORM,
 * Jobs, Microservices RPC, and `HttpClient` events — converting them into
 * OpenTelemetry spans via `Tracer` — and registers the single-realm ambient
 * W3C `traceparent` provider so outbound calls propagate trace context with
 * zero cross-package coupling.
 */
@Injectable()
export class OtelAutoInstrumentation implements OnModuleInit, OnModuleDestroy {
  private readonly subscriptions: Array<{
    readonly channel: DiagnosticChannel;
    readonly listener: DiagnosticChannelSubscriber;
  }> = [];
  private disposeAmbientTraceparent?: () => void;
  private active = false;
  private readonly enabled: boolean;
  private readonly ormEnabled: boolean;
  private readonly jobsEnabled: boolean;
  private readonly rpcEnabled: boolean;
  private readonly httpClientEnabled: boolean;
  private readonly ambientTraceparentEnabled: boolean;
  private readonly maxSqlLength: number;

  constructor(
    private readonly tracer: Tracer,
    @Optional()
    @Inject(AUTO_INSTRUMENT_OPTIONS)
    options: AutoInstrumentOptions = {},
  ) {
    this.enabled = options.enabled !== false;
    this.ormEnabled = options.orm !== false;
    this.jobsEnabled = options.jobs !== false;
    this.rpcEnabled = options.rpc !== false;
    this.httpClientEnabled = options.httpClient !== false;
    this.ambientTraceparentEnabled = options.ambientTraceparent !== false;
    this.maxSqlLength = Math.max(64, Math.floor(options.maxSqlLength ?? 2048));

    if (this.enabled) {
      this.start();
    }
  }

  get isActive(): boolean {
    return this.active;
  }

  onModuleInit(): void {
    if (this.enabled) {
      this.start();
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /**
   * Attaches all configured `diagnosticsChannel` subscribers and registers the
   * ambient W3C `traceparent` provider. Idempotent when already active.
   */
  start(): void {
    if (this.active) {
      return;
    }
    this.active = true;

    if (this.ambientTraceparentEnabled) {
      this.disposeAmbientTraceparent = registerAmbientTraceparentProvider(
        () => {
          const ctx = traceContextStorage.getCurrentSpanContext();
          return ctx ? formatTraceParent(ctx) : undefined;
        },
      );
    }

    if (this.ormEnabled) {
      this.attach(ORM_QUERY_DIAGNOSTICS_CHANNEL, (msg) =>
        this.handleOrmQuery(msg),
      );
      this.attach(ORM_TRANSACTION_DIAGNOSTICS_CHANNEL, (msg) =>
        this.handleOrmTransaction(msg),
      );
    }

    if (this.jobsEnabled) {
      this.attach(JOBS_ENQUEUE_DIAGNOSTICS_CHANNEL, (msg) =>
        this.handleJobEnqueue(msg),
      );
      this.attach(JOBS_PROCESS_DIAGNOSTICS_CHANNEL, (msg) =>
        this.handleJobProcess(msg),
      );
    }

    if (this.rpcEnabled) {
      this.attach(RPC_CLIENT_DIAGNOSTICS_CHANNEL, (msg) =>
        this.handleRpcEvent(msg, "CLIENT"),
      );
      this.attach(RPC_SERVER_DIAGNOSTICS_CHANNEL, (msg) =>
        this.handleRpcEvent(msg, "SERVER"),
      );
    }

    if (this.httpClientEnabled) {
      this.attach(HTTP_CLIENT_REQUEST_DIAGNOSTICS_CHANNEL, (msg) =>
        this.handleHttpClientRequest(msg),
      );
    }
  }

  /**
   * Unsubscribes all `diagnosticsChannel` listeners and unregisters the ambient
   * W3C `traceparent` provider. Safe to call multiple times.
   */
  stop(): void {
    if (!this.active) {
      return;
    }
    this.active = false;

    for (const sub of this.subscriptions.splice(0)) {
      sub.channel.unsubscribe(sub.listener);
    }

    if (this.disposeAmbientTraceparent) {
      const dispose = this.disposeAmbientTraceparent;
      this.disposeAmbientTraceparent = undefined;
      dispose();
    }
  }

  private attach(
    channelName: string,
    listener: DiagnosticChannelSubscriber,
  ): void {
    const ch = diagnosticsChannel(channelName);
    ch.subscribe(listener);
    this.subscriptions.push({ channel: ch, listener });
  }

  private recordCompletedSpan(input: {
    readonly name: string;
    readonly kind: SpanKind;
    readonly parentContext?: SpanContext;
    readonly durationMs?: number;
    readonly attributes: Readonly<Record<string, SpanAttributeValue>>;
    readonly error?: unknown;
    readonly errorStatusMessage?: string;
  }): void {
    const endMs = Date.now();
    const durationMs =
      input.durationMs !== undefined && input.durationMs >= 0
        ? input.durationMs
        : 0;
    const startTimeMs = endMs - durationMs;

    const span = this.tracer.startSpan(input.name, {
      kind: input.kind,
      parentContext: input.parentContext,
      attributes: input.attributes,
      startTimeMs,
    });

    if (input.error !== undefined) {
      span.recordException(input.error);
    } else if (input.errorStatusMessage !== undefined) {
      span.setStatus("ERROR", input.errorStatusMessage);
    } else {
      span.setStatus("OK");
    }

    span.end(endMs);
  }

  private handleOrmQuery(message: unknown): void {
    const ev = asRecord(message);
    if (!ev) return;
    const phase = readString(ev, "phase");
    if (phase === "start") return;

    const rawSql = readString(ev, "sql") ?? readString(ev, "statement") ?? "";
    const dialect = readString(ev, "dialect") ?? readString(ev, "system") ?? "sql";
    const op = extractSqlOperation(rawSql);
    const durationMs = readNumber(ev, "durationMs");
    const rowCount = readNumber(ev, "rowCount");
    const dataSource = readString(ev, "dataSource");
    const traceparent = readString(ev, "traceparent");

    const attributes: Record<string, SpanAttributeValue> = {
      "db.system": dialect,
      "db.operation": op,
      ...(rawSql
        ? { "db.statement": truncateStatement(rawSql, this.maxSqlLength) }
        : {}),
      ...(durationMs !== undefined ? { "db.duration_ms": durationMs } : {}),
      ...(rowCount !== undefined ? { "db.rows_affected": rowCount } : {}),
      ...(dataSource !== undefined ? { "db.name": dataSource } : {}),
    };

    const parentContext =
      traceContextStorage.getCurrentSpanContext() ??
      parseTraceParentContext(traceparent);

    this.recordCompletedSpan({
      name: `DB ${op}`,
      kind: "CLIENT",
      parentContext,
      durationMs,
      attributes,
      error: ev.error,
    });
  }

  private handleOrmTransaction(message: unknown): void {
    const ev = asRecord(message);
    if (!ev) return;
    const phase = readString(ev, "phase");
    if (phase === "begin" || phase === "start") {
      return;
    }

    const durationMs = readNumber(ev, "durationMs");
    const isolationLevel = readString(ev, "isolationLevel");
    const propagation = readString(ev, "propagation");
    const dataSource = readString(ev, "dataSource");
    const dialect = readString(ev, "dialect") ?? "sql";
    const traceparent = readString(ev, "traceparent");

    const attributes: Record<string, SpanAttributeValue> = {
      "db.system": dialect,
      "db.operation": "TRANSACTION",
      "db.statement": phase ? `TRANSACTION ${phase.toUpperCase()}` : "TRANSACTION",
      ...(phase ? { "db.transaction.phase": phase } : {}),
      ...(isolationLevel
        ? { "db.transaction.isolation_level": isolationLevel }
        : {}),
      ...(propagation ? { "db.transaction.propagation": propagation } : {}),
      ...(dataSource ? { "db.name": dataSource } : {}),
      ...(durationMs !== undefined ? { "db.duration_ms": durationMs } : {}),
    };

    const parentContext =
      traceContextStorage.getCurrentSpanContext() ??
      parseTraceParentContext(traceparent);

    this.recordCompletedSpan({
      name: phase ? `DB TRANSACTION ${phase}` : "DB TRANSACTION",
      kind: "CLIENT",
      parentContext,
      durationMs,
      attributes,
      error: ev.error,
      errorStatusMessage:
        ev.error === undefined && phase === "rollback"
          ? "Transaction rolled back"
          : undefined,
    });
  }

  private handleJobEnqueue(message: unknown): void {
    const ev = asRecord(message);
    if (!ev) return;
    const phase = readString(ev, "phase");
    if (phase === "start") return;

    const queue = readString(ev, "queue") ?? "default";
    const jobId =
      ev.jobId !== undefined && ev.jobId !== null ? String(ev.jobId) : undefined;
    const jobName = readString(ev, "jobName");
    const groupId = readString(ev, "groupId");
    const traceparent = readString(ev, "traceparent");
    const durationMs = readNumber(ev, "durationMs");
    const status = readString(ev, "status");

    const attributes: Record<string, SpanAttributeValue> = {
      "messaging.system": "bunest.jobs",
      "messaging.operation": "publish",
      "messaging.destination.name": queue,
      ...(jobId !== undefined
        ? { "messaging.message.id": jobId, "bunest.job.id": jobId }
        : {}),
      ...(jobName !== undefined ? { "bunest.job.name": jobName } : {}),
      ...(groupId !== undefined ? { "bunest.job.group_id": groupId } : {}),
      ...(traceparent !== undefined
        ? { "bunest.job.traceparent": traceparent }
        : {}),
      ...(status !== undefined ? { "bunest.job.status": status } : {}),
    };

    const parentContext =
      traceContextStorage.getCurrentSpanContext() ??
      parseTraceParentContext(traceparent);

    this.recordCompletedSpan({
      name: `jobs.enqueue ${queue}`,
      kind: "PRODUCER",
      parentContext,
      durationMs,
      attributes,
      error: ev.error,
      errorStatusMessage:
        ev.error === undefined && (status === "failed" || status === "error")
          ? `Job enqueue ${status}`
          : undefined,
    });
  }

  private handleJobProcess(message: unknown): void {
    const ev = asRecord(message);
    if (!ev) return;
    const phase = readString(ev, "phase");
    if (phase === "start") return;

    const queue = readString(ev, "queue") ?? "default";
    const jobId =
      ev.jobId !== undefined && ev.jobId !== null ? String(ev.jobId) : undefined;
    const jobName = readString(ev, "jobName");
    const groupId = readString(ev, "groupId");
    const traceparent = readString(ev, "traceparent");
    const durationMs = readNumber(ev, "durationMs");
    const status = readString(ev, "status");

    const attributes: Record<string, SpanAttributeValue> = {
      "messaging.system": "bunest.jobs",
      "messaging.operation": "process",
      "messaging.destination.name": queue,
      ...(jobId !== undefined
        ? { "messaging.message.id": jobId, "bunest.job.id": jobId }
        : {}),
      ...(jobName !== undefined ? { "bunest.job.name": jobName } : {}),
      ...(groupId !== undefined ? { "bunest.job.group_id": groupId } : {}),
      ...(traceparent !== undefined
        ? { "bunest.job.traceparent": traceparent }
        : {}),
      ...(status !== undefined ? { "bunest.job.status": status } : {}),
      ...(durationMs !== undefined ? { "bunest.job.duration_ms": durationMs } : {}),
    };

    // Link consumer span to the producer traceparent carried in the job payload
    const parentContext =
      parseTraceParentContext(traceparent) ??
      traceContextStorage.getCurrentSpanContext();

    this.recordCompletedSpan({
      name: `jobs.process ${queue}`,
      kind: "CONSUMER",
      parentContext,
      durationMs,
      attributes,
      error: ev.error,
      errorStatusMessage:
        ev.error === undefined && (status === "failed" || status === "error")
          ? `Job process ${status}`
          : undefined,
    });
  }

  private handleRpcEvent(message: unknown, kind: "CLIENT" | "SERVER"): void {
    const ev = asRecord(message);
    if (!ev) return;
    const phase = readString(ev, "phase");
    if (phase === "start") return;

    const transport =
      readString(ev, "transport") ?? readString(ev, "system") ?? "bunest-rpc";
    const method =
      readString(ev, "method") ?? readString(ev, "pattern") ?? "unknown";
    const rpcKind = readString(ev, "kind");
    const durationMs = readNumber(ev, "durationMs");
    const attempt = readNumber(ev, "attempt");
    const traceparent = readString(ev, "traceparent");

    const attributes: Record<string, SpanAttributeValue> = {
      "rpc.system": readString(ev, "system") ?? transport,
      "rpc.method": method,
      "bunest.rpc.transport": transport,
      ...(rpcKind !== undefined ? { "bunest.rpc.kind": rpcKind } : {}),
      ...(attempt !== undefined ? { "bunest.rpc.attempt": attempt } : {}),
      ...(durationMs !== undefined ? { "bunest.rpc.duration_ms": durationMs } : {}),
    };

    const parentContext =
      kind === "SERVER"
        ? (parseTraceParentContext(traceparent) ??
          traceContextStorage.getCurrentSpanContext())
        : (traceContextStorage.getCurrentSpanContext() ??
          parseTraceParentContext(traceparent));

    this.recordCompletedSpan({
      name: `RPC ${method}`,
      kind,
      parentContext,
      durationMs,
      attributes,
      error: ev.error,
      errorStatusMessage:
        ev.error === undefined && phase === "error"
          ? `RPC ${kind.toLowerCase()} error`
          : undefined,
    });
  }

  private handleHttpClientRequest(message: unknown): void {
    const ev = asRecord(message);
    if (!ev) return;
    const phase = readString(ev, "phase");
    if (phase === "start") return;

    const method = (readString(ev, "method") ?? "GET").toUpperCase();
    const rawUrl = readString(ev, "url") ?? "";
    const status = readNumber(ev, "status");
    const durationMs = readNumber(ev, "durationMs");
    const attempt = readNumber(ev, "attempt");
    const traceparent = readString(ev, "traceparent");
    const urlParts = parseUrlParts(rawUrl);

    const attributes: Record<string, SpanAttributeValue> = {
      "http.request.method": method,
      "url.full": rawUrl,
      "url.path": urlParts.pathname,
      ...(urlParts.hostname !== undefined
        ? { "server.address": urlParts.hostname }
        : {}),
      ...(urlParts.port !== undefined ? { "server.port": urlParts.port } : {}),
      ...(status !== undefined ? { "http.response.status_code": status } : {}),
      ...(attempt !== undefined && attempt > 1
        ? { "http.request.resend_count": attempt - 1 }
        : {}),
      ...(durationMs !== undefined ? { "http.duration_ms": durationMs } : {}),
    };

    const parentContext =
      traceContextStorage.getCurrentSpanContext() ??
      parseTraceParentContext(traceparent);

    this.recordCompletedSpan({
      name: `HTTP ${method} ${urlParts.pathname}`,
      kind: "CLIENT",
      parentContext,
      durationMs,
      attributes,
      error: ev.error,
      errorStatusMessage:
        ev.error === undefined &&
        (phase === "error" || (status !== undefined && status >= 400))
          ? status !== undefined
            ? `HTTP ${status}`
            : "HTTP client error"
          : undefined,
    });
  }
}

/**
 * Convenience helper enabling cross-subsystem OTel auto-instrumentation and
 * ambient W3C `traceparent` propagation outside DI. Call `.stop()` to clean up.
 */
export function enableAutoInstrumentation(
  tracer: Tracer,
  options: AutoInstrumentOptions = {},
): OtelAutoInstrumentation {
  return new OtelAutoInstrumentation(tracer, { ...options, enabled: true });
}
