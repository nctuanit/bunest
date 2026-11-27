import {
  ALL_LOG_LEVELS,
  CLS_ID,
  ClsService,
  Inject,
  Injectable,
  LOG_LEVEL_COLORS,
  Logger,
  Optional,
  clc,
  formatNestTimestamp,
  getAmbientClsStore,
  isColorAllowed,
  type ClsServiceLike,
  type LogLevel,
  type LoggerOptions,
  type LoggerService,
  type OnModuleDestroy,
} from "@bunest/core";
import { traceContextStorage } from "../tracing/trace-context";

export const OBSERVABILITY_LOGGER_OPTIONS = Symbol.for(
  "bunest:observability:logger_options",
);

export interface ObservabilityLoggerOptions extends LoggerOptions {
  context?: string;
  serviceName?: string;
  includeCorrelation?: boolean;
  /**
   * Persistent structured fields included in every log record emitted by this
   * logger (and inherited/merged by `.child(bindings)`).
   */
  bindings?: Record<string, unknown>;
  /**
   * Active `ClsService` keys automatically merged into every structured log record
   * (e.g. `["tenantId", "userId", "correlationId"]`) and passed through secret redaction.
   */
  clsKeys?: readonly string[];
  /**
   * Optional explicit `ClsService` instance (when omitted, automatically reads
   * DI-injected `ClsService` or `@bunest/core`'s ambient CLS store).
   */
  cls?: ClsServiceLike;
  /**
   * When `true`, wires this `ObservabilityLogger` as the application's global
   * `Logger` via `Logger.overrideLogger(this)` and restores the previous logger
   * on module destroy.
   */
  registerGlobalLogger?: boolean;
}

const RESERVED_FIELD_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "timestamp",
  "level",
  "message",
]);

function defaultWriter(line: string, level: LogLevel): void {
  if (level === "fatal" || level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Error ||
    value instanceof Headers ||
    value instanceof Map ||
    value instanceof Set
  ) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Structured correlated logger built on `@bunest/core`'s `Logger` redaction engine.
 * Automatically injects active `traceId`, `spanId`, `parentSpanId`, and `requestId`
 * from `TraceContextStorage` into every log entry while deeply redacting secrets.
 *
 * Supports both Pino-style structured logging (`child(bindings)` + `info(fields, msg)`)
 * and NestJS-compatible logging (`child("Context")` + `log(msg, context?)`).
 */
@Injectable()
export class ObservabilityLogger implements LoggerService, OnModuleDestroy {
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
  private readonly bindings: Readonly<Record<string, unknown>>;
  private readonly clsKeys: readonly string[];
  private readonly clsService?: ClsServiceLike;
  private readonly registeredAsGlobal: boolean;
  private readonly previousGlobalLogger?: LoggerService;

  constructor(
    @Optional()
    @Inject(OBSERVABILITY_LOGGER_OPTIONS)
    options: ObservabilityLoggerOptions = {},
    @Optional()
    clsService?: ClsService,
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
    this.bindings = options.bindings ? { ...options.bindings } : {};
    this.clsKeys = options.clsKeys
      ? Object.freeze(
          options.clsKeys.filter(
            (k) =>
              typeof k === "string" &&
              k.length > 0 &&
              k !== "__proto__" &&
              k !== "constructor" &&
              k !== "prototype",
          ),
        )
      : [];
    this.clsService = options.cls ?? clsService;
    this.redactor = new Logger(options.context, {
      levels: options.levels,
      redactKeys: options.redactKeys,
      redactionMask: options.redactionMask,
    });

    if (options.registerGlobalLogger === true) {
      this.previousGlobalLogger = Logger.staticInstanceRef;
      this.registeredAsGlobal = true;
      Logger.overrideLogger(this);
    } else {
      this.registeredAsGlobal = false;
    }
  }

  onModuleDestroy(): void {
    if (
      this.registeredAsGlobal &&
      this.previousGlobalLogger &&
      Logger.staticInstanceRef === this
    ) {
      Logger.overrideLogger(this.previousGlobalLogger);
    }
  }

  /**
   * Returns a shallow copy of this logger's persistent structured bindings.
   */
  getBindings(): Readonly<Record<string, unknown>> {
    return { ...this.bindings };
  }

  /**
   * Creates a child logger scoped to a context label while inheriting parent bindings.
   */
  child(context: string): ObservabilityLogger;
  /**
   * Creates a Pino-style child logger merging persistent structured bindings
   * (e.g. `{ tenantId, component }`) onto the parent's bindings.
   */
  child(bindings: Record<string, unknown>): ObservabilityLogger;
  child(
    contextOrBindings: string | Record<string, unknown>,
  ): ObservabilityLogger {
    if (typeof contextOrBindings === "string") {
      return new ObservabilityLogger({
        ...this.baseOptions,
        context: contextOrBindings,
        bindings: { ...this.bindings },
        clsKeys: this.clsKeys,
        cls: this.clsService,
        registerGlobalLogger: false,
        levels: [...this.levels],
        json: this.json,
        timestamp: this.timestamp,
        serviceName: this.serviceName,
        includeCorrelation: this.includeCorrelation,
        writer: this.writer,
      });
    }

    const nextBindings: Record<string, unknown> = { ...this.bindings };
    let nextContext = this.context;
    for (const [key, value] of Object.entries(contextOrBindings)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
      if (key === "context" && typeof value === "string") {
        nextContext = value;
        continue;
      }
      nextBindings[key] = value;
    }

    return new ObservabilityLogger({
      ...this.baseOptions,
      context: nextContext,
      bindings: nextBindings,
      clsKeys: this.clsKeys,
      cls: this.clsService,
      registerGlobalLogger: false,
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

  log(
    fields: Record<string, unknown>,
    message: string,
    ...optionalParams: unknown[]
  ): void;
  log(message: unknown, ...optionalParams: unknown[]): void;
  log(messageOrFields: unknown, ...optionalParams: unknown[]): void {
    this.emit("log", messageOrFields, optionalParams);
  }

  /**
   * Pino-style alias for `log(...)` emitting at the `"log"` level.
   */
  info(
    fields: Record<string, unknown>,
    message: string,
    ...optionalParams: unknown[]
  ): void;
  info(message: unknown, ...optionalParams: unknown[]): void;
  info(messageOrFields: unknown, ...optionalParams: unknown[]): void {
    this.emit("log", messageOrFields, optionalParams);
  }

  error(
    fields: Record<string, unknown>,
    message: string,
    ...optionalParams: unknown[]
  ): void;
  error(message: unknown, ...optionalParams: unknown[]): void;
  error(messageOrFields: unknown, ...optionalParams: unknown[]): void {
    this.emit("error", messageOrFields, optionalParams);
  }

  warn(
    fields: Record<string, unknown>,
    message: string,
    ...optionalParams: unknown[]
  ): void;
  warn(message: unknown, ...optionalParams: unknown[]): void;
  warn(messageOrFields: unknown, ...optionalParams: unknown[]): void {
    this.emit("warn", messageOrFields, optionalParams);
  }

  debug(
    fields: Record<string, unknown>,
    message: string,
    ...optionalParams: unknown[]
  ): void;
  debug(message: unknown, ...optionalParams: unknown[]): void;
  debug(messageOrFields: unknown, ...optionalParams: unknown[]): void {
    this.emit("debug", messageOrFields, optionalParams);
  }

  verbose(
    fields: Record<string, unknown>,
    message: string,
    ...optionalParams: unknown[]
  ): void;
  verbose(message: unknown, ...optionalParams: unknown[]): void;
  verbose(messageOrFields: unknown, ...optionalParams: unknown[]): void {
    this.emit("verbose", messageOrFields, optionalParams);
  }

  fatal(
    fields: Record<string, unknown>,
    message: string,
    ...optionalParams: unknown[]
  ): void;
  fatal(message: unknown, ...optionalParams: unknown[]): void;
  fatal(messageOrFields: unknown, ...optionalParams: unknown[]): void {
    this.emit("fatal", messageOrFields, optionalParams);
  }

  private collectClsFields(): Record<string, unknown> | undefined {
    if (this.clsKeys.length === 0) {
      return undefined;
    }
    const collected: Record<string, unknown> = {};
    let count = 0;

    if (this.clsService && this.clsService.isActive()) {
      for (let i = 0; i < this.clsKeys.length; i++) {
        const key = this.clsKeys[i]!;
        let val = this.clsService.get(key);
        if (val === undefined && key === "requestId") {
          val = this.clsService.getId?.() ?? this.clsService.get(CLS_ID);
        }
        if (val !== undefined) {
          collected[key] = val;
          count++;
        }
      }
      return count > 0 ? collected : undefined;
    }

    const store = getAmbientClsStore();
    if (!store) {
      return undefined;
    }
    for (let i = 0; i < this.clsKeys.length; i++) {
      const key = this.clsKeys[i]!;
      let val = store.get(key);
      if (val === undefined && key === "requestId") {
        val = store.get(CLS_ID);
      }
      if (val !== undefined) {
        collected[key] = val;
        count++;
      }
    }
    return count > 0 ? collected : undefined;
  }

  private mergeRedactedFields(
    callFields: Record<string, unknown> | undefined,
    reservedCorrelationKeys: Set<string>,
  ): Record<string, unknown> {
    const clsFields = this.collectClsFields();
    const hasCls = clsFields !== undefined;
    const hasPersistent = Object.keys(this.bindings).length > 0;
    const hasCall = callFields !== undefined && Object.keys(callFields).length > 0;
    if (!hasCls && !hasPersistent && !hasCall) {
      return {};
    }
    const combined: Record<string, unknown> = {
      ...(clsFields ?? {}),
      ...this.bindings,
      ...(callFields ?? {}),
    };
    const redacted = this.redactor.redact(combined);
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(redacted)) {
      if (RESERVED_FIELD_KEYS.has(key) || reservedCorrelationKeys.has(key)) {
        continue;
      }
      safe[key] = value;
    }
    return safe;
  }

  private emit(
    level: LogLevel,
    messageOrFields: unknown,
    optionalParams: unknown[],
  ): void {
    if (!this.isLevelEnabled(level)) {
      return;
    }

    let message: unknown = messageOrFields;
    let params = optionalParams;
    let callFields: Record<string, unknown> | undefined;

    // Pino-style structured-first call: logger.info({ orderId: "1" }, "order created", ...extra)
    if (
      isPlainRecord(messageOrFields) &&
      optionalParams.length >= 1 &&
      typeof optionalParams[0] === "string"
    ) {
      callFields = messageOrFields;
      message = optionalParams[0];
      params = optionalParams.slice(1);
    }

    let resolvedContext = this.context;
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

    const reservedCorrelation = new Set<string>();
    if (spanCtx?.traceId) reservedCorrelation.add("traceId");
    if (spanCtx?.spanId) reservedCorrelation.add("spanId");
    if (spanCtx?.parentSpanId) reservedCorrelation.add("parentSpanId");
    if (spanCtx?.requestId) reservedCorrelation.add("requestId");

    const structuredFields = this.mergeRedactedFields(
      callFields,
      reservedCorrelation,
    );
    const hasStructuredFields = Object.keys(structuredFields).length > 0;

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
        ...(hasStructuredFields ? structuredFields : {}),
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
    if (hasStructuredFields) {
      bodyParts.push(
        Bun.inspect(structuredFields, { colors: useColors, compact: true }),
      );
    }
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
