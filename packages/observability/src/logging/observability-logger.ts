import {
  ALL_LOG_LEVELS,
  Inject,
  Injectable,
  Logger,
  Optional,
  type LogLevel,
  type LoggerOptions,
  type LoggerService,
} from "@bunest/common";
import { traceContextStorage } from "../tracing/trace-context";

export const OBSERVABILITY_LOGGER_OPTIONS = Symbol.for(
  "bunest:observability:logger_options",
);

export interface ObservabilityLoggerOptions extends LoggerOptions {
  context?: string;
  serviceName?: string;
  includeCorrelation?: boolean;
}

function defaultWriter(line: string, level: LogLevel): void {
  if (level === "fatal" || level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * Structured correlated logger built on `@bunest/common`'s `Logger` redaction engine.
 * Automatically injects active `traceId`, `spanId`, `parentSpanId`, and `requestId`
 * from `TraceContextStorage` into every log entry while deeply redacting secrets.
 */
@Injectable()
export class ObservabilityLogger implements LoggerService {
  private context?: string;
  private levels: Set<LogLevel>;
  private readonly json: boolean;
  private readonly timestamp: boolean;
  private readonly serviceName?: string;
  private readonly includeCorrelation: boolean;
  private readonly writer: (line: string, level: LogLevel) => void;
  private readonly redactor: Logger;
  private readonly baseOptions: ObservabilityLoggerOptions;

  constructor(
    @Optional()
    @Inject(OBSERVABILITY_LOGGER_OPTIONS)
    options: ObservabilityLoggerOptions = {},
  ) {
    this.baseOptions = options;
    this.context = options.context;
    this.levels = new Set(options.levels ?? ALL_LOG_LEVELS);
    this.json = options.json ?? true;
    this.timestamp = options.timestamp ?? true;
    this.serviceName = options.serviceName;
    this.includeCorrelation = options.includeCorrelation ?? true;
    this.writer = options.writer ?? defaultWriter;
    this.redactor = new Logger(options.context, {
      levels: options.levels,
      redactKeys: options.redactKeys,
      redactionMask: options.redactionMask,
    });
  }

  child(context: string): ObservabilityLogger {
    return new ObservabilityLogger({
      ...this.baseOptions,
      context,
      levels: [...this.levels],
      json: this.json,
      timestamp: this.timestamp,
      serviceName: this.serviceName,
      includeCorrelation: this.includeCorrelation,
      writer: this.writer,
    });
  }

  setContext(context: string): void {
    this.context = context;
  }

  setLogLevels(levels: LogLevel[]): void {
    this.levels = new Set(levels);
  }

  isLevelEnabled(level: LogLevel): boolean {
    return this.levels.has(level);
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.emit("log", message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.emit("error", message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.emit("warn", message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.emit("debug", message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.emit("verbose", message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.emit("fatal", message, optionalParams);
  }

  private emit(
    level: LogLevel,
    message: unknown,
    optionalParams: unknown[],
  ): void {
    if (!this.isLevelEnabled(level)) {
      return;
    }

    let resolvedContext = this.context;
    let params = optionalParams;
    if (
      !resolvedContext &&
      params.length > 0 &&
      typeof params[params.length - 1] === "string"
    ) {
      resolvedContext = params[params.length - 1] as string;
      params = params.slice(0, -1);
    }

    const spanCtx = this.includeCorrelation
      ? traceContextStorage.getCurrentSpanContext()
      : undefined;

    const redactedMessage = this.redactor.redact(message);
    const redactedParams = params.map((p) => this.redactor.redact(p));
    const ts = this.timestamp ? new Date().toISOString() : undefined;

    if (this.json) {
      const payload: Record<string, unknown> = {
        ...(ts ? { timestamp: ts } : {}),
        level,
        ...(this.serviceName ? { service: this.serviceName } : {}),
        ...(resolvedContext ? { context: resolvedContext } : {}),
        ...(spanCtx?.traceId ? { traceId: spanCtx.traceId } : {}),
        ...(spanCtx?.spanId ? { spanId: spanCtx.spanId } : {}),
        ...(spanCtx?.parentSpanId
          ? { parentSpanId: spanCtx.parentSpanId }
          : {}),
        ...(spanCtx?.requestId ? { requestId: spanCtx.requestId } : {}),
        message: redactedMessage,
      };

      if (redactedParams.length === 1) {
        payload.meta = redactedParams[0];
      } else if (redactedParams.length > 1) {
        payload.meta = redactedParams;
      }

      this.writer(JSON.stringify(payload), level);
      return;
    }

    const parts: string[] = ["[Bunest]"];
    if (ts) parts.push(ts);
    parts.push(level.toUpperCase());
    if (this.serviceName) parts.push(`[${this.serviceName}]`);
    if (resolvedContext) parts.push(`[${resolvedContext}]`);
    if (spanCtx?.traceId) {
      parts.push(`[trace=${spanCtx.traceId} span=${spanCtx.spanId}]`);
    }
    if (spanCtx?.requestId) {
      parts.push(`[req=${spanCtx.requestId}]`);
    }
    parts.push(
      typeof redactedMessage === "string"
        ? redactedMessage
        : JSON.stringify(redactedMessage),
    );
    for (const p of redactedParams) {
      parts.push(typeof p === "string" ? p : JSON.stringify(p));
    }

    this.writer(parts.join(" "), level);
  }
}
