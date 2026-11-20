import type { LogLevel, LoggerService } from "./logger.interface";

export const ALL_LOG_LEVELS: readonly LogLevel[] = Object.freeze([
  "fatal",
  "error",
  "warn",
  "log",
  "debug",
  "verbose",
]);

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
  redactKeys?: string[];
  redactionMask?: string;
  writer?: (line: string, level: LogLevel) => void;
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
  private static globalInstance: LoggerService = new Logger();
  private static isBuffering = false;
  protected static logBuffer: LogBufferRecord[] = [];
  protected static logLevels: LogLevel[] = [...ALL_LOG_LEVELS];

  protected context?: string;
  protected options: LoggerOptions;
  protected localInstanceRef?: LoggerService;
  private levels: Set<LogLevel>;
  private readonly json: boolean;
  private readonly timestamp: boolean;
  private readonly normalizedRedactKeys: readonly string[];
  private readonly redactionMask: string;
  private readonly writer: (line: string, level: LogLevel) => void;

  constructor(context?: string, options: LoggerOptions = {}) {
    this.context = context;
    this.options = { ...options };
    this.levels = new Set(options.levels ?? ALL_LOG_LEVELS);
    this.json = options.json ?? false;
    this.timestamp = options.timestamp ?? true;
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
    return this.localInstanceRef ?? this;
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
      Logger.globalInstance = new Logger(undefined, { levels: [] });
    } else if (logger === true) {
      Logger.logLevels = [...ALL_LOG_LEVELS];
      Logger.globalInstance = new Logger();
    } else if (Array.isArray(logger)) {
      Logger.logLevels = [...logger];
      Logger.globalInstance = new Logger(undefined, { levels: logger });
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

  static log(message: unknown, context?: string): void {
    Logger.dispatchGlobal("log", [message, ...(context ? [context] : [])]);
  }

  static error(message: unknown, stackOrContext?: string, context?: string): void {
    const args: unknown[] = [message];
    if (stackOrContext !== undefined) args.push(stackOrContext);
    if (context !== undefined) args.push(context);
    Logger.dispatchGlobal("error", args);
  }

  static warn(message: unknown, context?: string): void {
    Logger.dispatchGlobal("warn", [message, ...(context ? [context] : [])]);
  }

  static debug(message: unknown, context?: string): void {
    Logger.dispatchGlobal("debug", [message, ...(context ? [context] : [])]);
  }

  static verbose(message: unknown, context?: string): void {
    Logger.dispatchGlobal("verbose", [message, ...(context ? [context] : [])]);
  }

  static fatal(message: unknown, context?: string): void {
    Logger.dispatchGlobal("fatal", [message, ...(context ? [context] : [])]);
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

    const redactedMessage = this.redact(message);
    const redactedParams = params.map((p) => this.redact(p));
    const ts = this.timestamp ? new Date().toISOString() : undefined;

    if (this.json) {
      const payload: Record<string, unknown> = {
        ...(ts ? { timestamp: ts } : {}),
        level,
        ...(resolvedContext ? { context: resolvedContext } : {}),
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
    if (ts) {
      parts.push(ts);
    }
    parts.push(level.toUpperCase());
    if (resolvedContext) {
      parts.push(`[${resolvedContext}]`);
    }

    parts.push(
      typeof redactedMessage === "string"
        ? redactedMessage
        : JSON.stringify(redactedMessage),
    );

    for (const param of redactedParams) {
      parts.push(typeof param === "string" ? param : JSON.stringify(param));
    }

    this.writer(parts.join(" "), level);
  }
}
