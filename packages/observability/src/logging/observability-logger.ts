import {
  ALL_LOG_LEVELS,
  Inject,
  Injectable,
  LOG_LEVEL_COLORS,
  Logger,
  Optional,
  clc,
  formatNestTimestamp,
  isColorAllowed,
  type LogLevel,
  type LoggerOptions,
  type LoggerService,
} from "@bunest/core";
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
 * Structured correlated logger built on `@bunest/core`'s `Logger` redaction engine.
 * Automatically injects active `traceId`, `spanId`, `parentSpanId`, and `requestId`
 * from `TraceContextStorage` into every log entry while deeply redacting secrets.
 */
@Injectable()
export class ObservabilityLogger implements LoggerService {
  private context?: string;
  private levels: Set<LogLevel>;
  private readonly json: boolean;
  private readonly timestamp: boolean;
  private readonly colors?: boolean;
  private readonly prefix: string;
  private readonly showPid: boolean;
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
    this.colors = options.colors;
    this.prefix = options.prefix ?? "Bunest";
    this.showPid = options.pid ?? true;
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

    const useColors = this.colors ?? isColorAllowed();
    const colorize = (s: string): string =>
      useColors ? LOG_LEVEL_COLORS[level](s) : s;
    const colorYellow = (s: string): string => (useColors ? clc.yellow(s) : s);

    const pidPrefix = this.showPid
      ? `[${this.prefix}] ${process.pid}  - `
      : `[${this.prefix}] `;
    const pidMessage = colorize(pidPrefix);
    const tsPart = this.timestamp ? `${formatNestTimestamp()} ` : "";
    const formattedLevel = colorize(level.toUpperCase().padStart(7, " "));

    const tags: string[] = [];
    if (this.serviceName) tags.push(colorYellow(`[${this.serviceName}]`));
    if (resolvedContext) tags.push(colorYellow(`[${resolvedContext}]`));
    if (spanCtx?.traceId) {
      tags.push(colorYellow(`[trace=${spanCtx.traceId} span=${spanCtx.spanId}]`));
    }
    if (spanCtx?.requestId) {
      tags.push(colorYellow(`[req=${spanCtx.requestId}]`));
    }
    const tagsPart = tags.length > 0 ? `${tags.join(" ")} ` : "";

    const bodyParts: string[] = [
      typeof redactedMessage === "string"
        ? colorize(redactedMessage)
        : Bun.inspect(redactedMessage, { colors: useColors, compact: true }),
    ];
    for (const p of redactedParams) {
      bodyParts.push(
        typeof p === "string"
          ? colorize(p)
          : Bun.inspect(p, { colors: useColors, compact: true }),
      );
    }

    this.writer(
      `${pidMessage}${tsPart}${formattedLevel} ${tagsPart}${bodyParts.join(" ")}`,
      level,
    );
  }
}
