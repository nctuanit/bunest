import {
  LOG_LEVEL_COLORS,
  clc,
  formatNestTimestamp,
  isColorAllowed,
} from "./cli-colors";
import {
  ConsoleLogger,
  LOG_LEVELS,
  isLogLevelEnabled,
} from "./console-logger";
import type { LogLevel, LoggerService } from "./logger.interface";
import {
  getActiveLogContext,
  type LogContextProvider,
} from "./log-context";

export const ALL_LOG_LEVELS: readonly LogLevel[] = LOG_LEVELS;

export const DEFAULT_REDACT_KEYS: readonly string[] = Object.freeze([
  "password",
  "passwd",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "authorization",
  "cookie",
  "setcookie",
  "privatekey",
  "clientsecret",
  "creditcard",
  "ssn",
  "jwt",
  "bearer",
  "sessionid",
]);

export interface LogBufferRecord {
  methodRef: Function;
  arguments: unknown[];
}

export interface LoggerOptions {
  levels?: LogLevel[];
  json?: boolean;
  timestamp?: boolean;
  /**
   * Enable or disable NestJS-style ANSI colors in text mode.
   * Defaults to `true` unless `json: true` or `NO_COLOR` / `FORCE_COLOR=0` is set.
   */
  colors?: boolean;
  /**
   * Application prefix shown in brackets (defaults to `"Bunest"`).
   */
  prefix?: string;
  /**
   * Whether to show the process ID (`[Bunest] <pid>  - `) in text mode.
   * Defaults to `true`.
   */
  pid?: boolean;
  /**
   * Whether to append elapsed `+Nms` timestamp diff in yellow between log lines.
   * Defaults to `true` when `timestamp` is not `false`.
   */
  timestampDiff?: boolean;
  redactKeys?: string[];
  redactionMask?: string;
  /**
   * Automatically enrich JSON log entries with active ambient context
   * (e.g. HTTP `requestId` and `ClsService` fields).
   * Defaults to `true` when `json: true`. Pass `false` to disable or a custom
   * `LogContextProvider` function.
   */
  enrichContext?: boolean | LogContextProvider;
  writer?: (line: string, level: LogLevel) => void;
}

function isStackFormat(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^[\s\S]+\n\s+at\s+.+:\d+:\d+/.test(value);
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
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
 * Structured logger supporting log levels, context labels, JSON output mode,
 * and deep immutable secret-key redaction.
 */
export class Logger implements LoggerService {
  private static globalInstance: LoggerService = new ConsoleLogger();
  private static isBuffering = false;
  protected static logBuffer: LogBufferRecord[] = [];
  protected static logLevels: LogLevel[] = [...ALL_LOG_LEVELS];
  protected static lastTimestampAt?: number;

  protected context?: string;
  protected options: LoggerOptions;
  protected localInstanceRef?: LoggerService;
  private readonly useLocalEmitter: boolean;
  private levels: Set<LogLevel>;
  private readonly json: boolean;
  private readonly timestamp: boolean;
  private readonly colors?: boolean;
  private readonly prefix: string;
  private readonly showPid: boolean;
  private readonly showTimestampDiff: boolean;
  private readonly normalizedRedactKeys: readonly string[];
  private readonly redactionMask: string;
  private readonly writer: (line: string, level: LogLevel) => void;

  constructor(context?: string, options: LoggerOptions = {}) {
    this.context = context;
    this.options = { ...options };
    this.useLocalEmitter = Boolean(
      options.writer !== undefined ||
        options.json !== undefined ||
        options.levels !== undefined ||
        options.redactKeys !== undefined ||
        options.redactionMask !== undefined ||
        options.prefix !== undefined ||
        options.pid !== undefined ||
        options.colors !== undefined ||
        options.timestampDiff !== undefined ||
        options.enrichContext !== undefined,
    );
    this.levels = new Set(options.levels ?? ALL_LOG_LEVELS);
    this.json = options.json ?? false;
    this.timestamp = options.timestamp ?? true;
    this.colors = options.colors;
    this.prefix = options.prefix ?? "Bunest";
    this.showPid = options.pid ?? true;
    this.showTimestampDiff = options.timestampDiff ?? this.timestamp;
    this.redactionMask = options.redactionMask ?? "[REDACTED]";
    this.writer = options.writer ?? defaultWriter;

    const mergedKeys = new Set<string>(
      DEFAULT_REDACT_KEYS.map((k) => normalizeKey(k)),
    );
    if (options.redactKeys) {
      for (const key of options.redactKeys) {
        mergedKeys.add(normalizeKey(key));
      }
    }
    this.normalizedRedactKeys = [...mergedKeys];
  }

  get localInstance(): LoggerService {
    if (this.localInstanceRef) {
      return this.localInstanceRef;
    }
    if (this.useLocalEmitter) {
      return this;
    }
    return Logger.globalInstance;
  }

  static get staticInstanceRef(): LoggerService {
    return Logger.globalInstance;
  }

  static attachBuffer(): void {
    Logger.isBuffering = true;
  }

  static detachBuffer(): void {
    Logger.isBuffering = false;
  }

  static isBufferAttached(): boolean {
    return Logger.isBuffering;
  }

  static flush(): void {
    Logger.isBuffering = false;
    if (Logger.logBuffer.length === 0) return;
    const entries = Logger.logBuffer.splice(0, Logger.logBuffer.length);
    for (const entry of entries) {
      entry.methodRef.apply(Logger.globalInstance, entry.arguments);
    }
  }

  static getTimestamp(): string {
    return new Date().toISOString();
  }

  static isLevelEnabled(level: LogLevel): boolean {
    const inst = Logger.globalInstance as unknown as {
      isLevelEnabled?: (l: LogLevel) => boolean;
    };
    if (typeof inst.isLevelEnabled === "function") {
      return inst.isLevelEnabled(level);
    }
    return true;
  }

  static overrideLogger(logger: LoggerService | LogLevel[] | boolean): void {
    if (logger === false) {
      Logger.logLevels = [];
      Logger.globalInstance = new ConsoleLogger({ logLevels: [] });
    } else if (logger === true) {
      Logger.logLevels = [...ALL_LOG_LEVELS];
      Logger.globalInstance = new ConsoleLogger();
    } else if (Array.isArray(logger)) {
      Logger.logLevels = [...logger];
      Logger.globalInstance = new ConsoleLogger({ logLevels: logger });
    } else {
      Logger.globalInstance = logger;
    }
  }

  private static dispatchGlobal(
    method: "log" | "error" | "warn" | "debug" | "verbose" | "fatal",
    args: unknown[],
  ): void {
    const fn = Logger.globalInstance[method];
    if (typeof fn !== "function") return;
    if (Logger.isBuffering) {
      Logger.logBuffer.push({ methodRef: fn, arguments: args });
      return;
    }
    (fn as (...a: unknown[]) => void).apply(Logger.globalInstance, args);
  }

  static log(message: unknown, ...optionalParams: unknown[]): void {
    Logger.dispatchGlobal("log", [message, ...optionalParams]);
  }

  static error(message: unknown, ...optionalParams: unknown[]): void {
    Logger.dispatchGlobal("error", [message, ...optionalParams]);
  }

  static warn(message: unknown, ...optionalParams: unknown[]): void {
    Logger.dispatchGlobal("warn", [message, ...optionalParams]);
  }

  static debug(message: unknown, ...optionalParams: unknown[]): void {
    Logger.dispatchGlobal("debug", [message, ...optionalParams]);
  }

  static verbose(message: unknown, ...optionalParams: unknown[]): void {
    Logger.dispatchGlobal("verbose", [message, ...optionalParams]);
  }

  static fatal(message: unknown, ...optionalParams: unknown[]): void {
    Logger.dispatchGlobal("fatal", [message, ...optionalParams]);
  }

  setContext(context: string): void {
    this.context = context;
  }

  setLogLevels(levels: LogLevel[]): void {
    this.levels = new Set(levels);
  }

  isLevelEnabled(level: LogLevel): boolean {
    if (!this.useLocalEmitter) {
      const target = this.localInstance as unknown as {
        isLevelEnabled?: (l: LogLevel) => boolean;
      };
      if (target !== (this as unknown) && typeof target.isLevelEnabled === "function") {
        return target.isLevelEnabled(level);
      }
    }
    return isLogLevelEnabled(level, [...this.levels]);
  }

  private addContext(
    method: "log" | "error" | "warn" | "debug" | "verbose" | "fatal",
    args: unknown[],
  ): unknown[] {
    if (!this.context) {
      return args;
    }
    if ((method === "error" || method === "fatal") && args.length === 1) {
      return [args[0], undefined, this.context];
    }
    return [...args, this.context];
  }

  private dispatchInstance(
    method: "log" | "error" | "warn" | "debug" | "verbose" | "fatal",
    message: unknown,
    optionalParams: unknown[],
  ): void {
    if (this.useLocalEmitter) {
      this.emit(method, message, optionalParams);
      return;
    }
    const target = this.localInstance;
    const fn = target[method];
    if (typeof fn !== "function") return;
    const args = this.addContext(method, [message, ...optionalParams]);
    if (Logger.isBuffering && target === Logger.globalInstance) {
      Logger.logBuffer.push({ methodRef: fn, arguments: args });
      return;
    }
    if (
      this.options.timestamp === true &&
      target instanceof ConsoleLogger
    ) {
      const opts = (target as unknown as { options: { timestamp?: boolean } })
        .options;
      const prevTimestamp = opts.timestamp;
      opts.timestamp = true;
      try {
        (fn as (...a: unknown[]) => void).apply(target, args);
      } finally {
        opts.timestamp = prevTimestamp;
      }
      return;
    }
    (fn as (...a: unknown[]) => void).apply(target, args);
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.dispatchInstance("log", message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.dispatchInstance("error", message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.dispatchInstance("warn", message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.dispatchInstance("debug", message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.dispatchInstance("verbose", message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.dispatchInstance("fatal", message, optionalParams);
  }

  /**
   * Produces a deep-cloned redacted copy of any value without mutating the input.
   */
  redact<T>(value: T): T {
    return this.redactInternal(value, new WeakSet()) as T;
  }

  private isSecretKey(key: string): boolean {
    const normalized = normalizeKey(key);
    for (const secret of this.normalizedRedactKeys) {
      if (normalized === secret || normalized.includes(secret)) {
        return true;
      }
    }
    return false;
  }

  private redactInternal(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === "bigint") {
      return value.toString();
    }

    if (value === null || typeof value !== "object") {
      return value;
    }

    if (seen.has(value)) {
      return "[Circular]";
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (value instanceof RegExp) {
      return value.toString();
    }

    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => this.redactInternal(item, seen));
      }

      if (value instanceof Headers) {
        const obj: Record<string, unknown> = {};
        value.forEach((v, k) => {
          obj[k] = this.isSecretKey(k) ? this.redactionMask : v;
        });
        return obj;
      }

      if (value instanceof Map) {
        const obj: Record<string, unknown> = {};
        for (const [k, v] of value.entries()) {
          const keyStr = String(k);
          obj[keyStr] = this.isSecretKey(keyStr)
            ? this.redactionMask
            : this.redactInternal(v, seen);
        }
        return obj;
      }

      if (value instanceof Error) {
        const out: Record<string, unknown> = {
          name: value.name,
          message: value.message,
        };
        if (value.stack) {
          out.stack = value.stack;
        }
        for (const [k, v] of Object.entries(value)) {
          out[k] = this.isSecretKey(k)
            ? this.redactionMask
            : this.redactInternal(v, seen);
        }
        return out;
      }

      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = this.isSecretKey(k)
          ? this.redactionMask
          : this.redactInternal(v, seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }

  protected isColorsEnabled(): boolean {
    if (this.colors !== undefined) {
      return this.colors;
    }
    return !this.json && isColorAllowed();
  }

  protected colorize(text: string, level: LogLevel): string {
    if (!this.isColorsEnabled()) {
      return text;
    }
    return LOG_LEVEL_COLORS[level](text);
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
      typeof params[params.length - 1] === "string" &&
      !isStackFormat(params[params.length - 1])
    ) {
      resolvedContext = params[params.length - 1] as string;
      params = params.slice(0, -1);
    }

    const redactedMessage = this.redact(message);
    const redactedParams = params.map((p) => this.redact(p));

    if (this.json) {
      const ts = this.timestamp ? new Date().toISOString() : undefined;
      const payload: Record<string, unknown> = {
        ...(ts ? { timestamp: ts } : {}),
        level,
        ...(resolvedContext ? { context: resolvedContext } : {}),
        message: redactedMessage,
      };

      if (this.options.enrichContext !== false) {
        let ambient: Record<string, unknown> | undefined;
        if (typeof this.options.enrichContext === "function") {
          try {
            ambient = this.options.enrichContext();
          } catch {
            ambient = undefined;
          }
        } else {
          ambient = getActiveLogContext();
        }
        if (ambient && typeof ambient === "object" && !Array.isArray(ambient)) {
          const redactedAmbient = this.redact(ambient) as Record<
            string,
            unknown
          >;
          for (const [k, v] of Object.entries(redactedAmbient)) {
            if (v !== undefined && !(k in payload)) {
              payload[k] = v;
            }
          }
        }
      }

      if (redactedParams.length === 1) {
        payload.meta = redactedParams[0];
      } else if (redactedParams.length > 1) {
        payload.meta = redactedParams;
      }

      this.writer(JSON.stringify(payload), level);
      return;
    }

    const useColors = this.isColorsEnabled();
    const colorYellow = (s: string): string => (useColors ? clc.yellow(s) : s);

    const pidPrefix = this.showPid
      ? `[${this.prefix}] ${process.pid}  - `
      : `[${this.prefix}] `;
    const pidMessage = this.colorize(pidPrefix, level);
    const tsPart = this.timestamp ? `${formatNestTimestamp()} ` : "";
    const formattedLogLevel = this.colorize(
      level.toUpperCase().padStart(7, " "),
      level,
    );
    const contextPart = resolvedContext
      ? colorYellow(`[${resolvedContext}] `)
      : "";

    const inlineParts: string[] = [];
    const stackTraces: string[] = [];

    if (typeof redactedMessage === "string") {
      inlineParts.push(this.colorize(redactedMessage, level));
    } else {
      inlineParts.push(
        Bun.inspect(redactedMessage, { colors: useColors, compact: true }),
      );
    }

    for (const param of redactedParams) {
      if ((level === "error" || level === "fatal") && isStackFormat(param)) {
        stackTraces.push(param);
      } else if (typeof param === "string") {
        inlineParts.push(this.colorize(param, level));
      } else {
        inlineParts.push(
          Bun.inspect(param, { colors: useColors, compact: true }),
        );
      }
    }

    let timestampDiff = "";
    if (this.showTimestampDiff) {
      const now = Date.now();
      if (Logger.lastTimestampAt !== undefined) {
        timestampDiff = colorYellow(` +${now - Logger.lastTimestampAt}ms`);
      }
      Logger.lastTimestampAt = now;
    }

    const headerLine = `${pidMessage}${tsPart}${formattedLogLevel} ${contextPart}${inlineParts.join(" ")}${timestampDiff}`;
    const fullLine =
      stackTraces.length > 0
        ? `${headerLine}\n${stackTraces.join("\n")}`
        : headerLine;

    this.writer(fullLine, level);
  }
}
