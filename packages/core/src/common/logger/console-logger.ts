import { createRedactor, type Redactor } from "./redactor";
import {
  LOG_LEVEL_COLORS,
  clc,
  formatNestTimestamp,
  isColorAllowed,
} from "./cli-colors";
import type { LogLevel, LoggerService } from "./logger.interface";
import {
  getActiveLogContext,
  type LogContextProvider,
} from "./log-context";
import { isPlainObject } from "../utils/type-guards.util";

export interface ConsoleInspectOptions {
  colors?: boolean;
  compact?: boolean | number;
  breakLength?: number;
  depth?: number | null;
  sorted?: boolean | ((a: string, b: string) => number);
  showHidden?: boolean;
  maxArrayLength?: number;
  maxStringLength?: number;
}

type InspectOptions = ConsoleInspectOptions;

const IDENTIFIER_KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function quoteSingleString(str: string): string {
  const escaped = str
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `'${escaped}'`;
}

function formatStringValue(
  str: string,
  options: ConsoleInspectOptions,
): string {
  const maxLen =
    options.maxStringLength === undefined ? 10_000 : options.maxStringLength;
  const color = (s: string) => (options.colors ? `\x1b[32m${s}\x1b[39m` : s);
  if (maxLen !== null && maxLen >= 0 && str.length > maxLen) {
    const remaining = str.length - maxLen;
    const suffix =
      remaining === 1
        ? "... 1 more character"
        : `... ${remaining} more characters`;
    return `${color(quoteSingleString(str.slice(0, maxLen)))}${suffix}`;
  }
  return color(quoteSingleString(str));
}

function formatPropertyKey(key: string): string {
  return IDENTIFIER_KEY_RE.test(key) ? key : quoteSingleString(key);
}

function inspect(value: unknown, options: ConsoleInspectOptions): string {
  const maxDepth = options.depth === null ? Infinity : (options.depth ?? 5);
  const maxArrayLen = options.maxArrayLength ?? 100;
  const compact = options.compact;
  const breakLength = options.breakLength ?? 80;
  const ancestors = new Set<object>();

  const format = (val: unknown, depth: number, indent: string): string => {
    if (val === null) return options.colors ? "\x1b[1mnull\x1b[22m" : "null";
    if (val === undefined) {
      return options.colors ? "\x1b[90mundefined\x1b[39m" : "undefined";
    }
    const t = typeof val;
    if (t === "string") {
      return formatStringValue(val as string, options);
    }
    if (t === "number" || t === "boolean" || t === "bigint") {
      const rendered = t === "bigint" ? `${val}n` : String(val);
      return options.colors ? `\x1b[33m${rendered}\x1b[39m` : rendered;
    }
    if (t === "symbol") {
      const rendered = String(val);
      return options.colors ? `\x1b[32m${rendered}\x1b[39m` : rendered;
    }
    if (t === "function") {
      const fn = val as Function;
      const label = fn.name ? `[Function: ${fn.name}]` : "[Function (anonymous)]";
      return options.colors ? `\x1b[36m${label}\x1b[39m` : label;
    }

    const obj = val as object;
    if (obj instanceof Date || obj instanceof RegExp) {
      return Bun.inspect(obj, { colors: options.colors });
    }
    if (obj instanceof Error) {
      const header = `${obj.name}: ${obj.message}`;
      const base = obj.stack
        ? obj.stack.startsWith(header)
          ? obj.stack
          : `${header}\n${obj.stack}`
        : header;
      const extraKeys = Object.keys(obj);
      if (extraKeys.length === 0) {
        return base;
      }
      if (ancestors.has(obj)) {
        return `${base} [Circular]`;
      }
      ancestors.add(obj);
      try {
        const nextIndent = `${indent}  `;
        const entries = extraKeys.map((k) => {
          const v = (obj as unknown as Record<string, unknown>)[k];
          return `${formatPropertyKey(k)}: ${format(v, depth + 1, nextIndent)}`;
        });
        const singleLine = `{ ${entries.join(", ")} }`;
        if (
          compact !== false &&
          !singleLine.includes("\n") &&
          (compact === true || singleLine.length <= breakLength)
        ) {
          return `${base} ${singleLine}`;
        }
        return `${base} {\n${entries.map((e) => `${nextIndent}${e}`).join(",\n")}\n${indent}}`;
      } finally {
        ancestors.delete(obj);
      }
    }
    if (obj instanceof Map) {
      if (ancestors.has(obj)) {
        return options.colors ? "\x1b[36m[Circular]\x1b[39m" : "[Circular]";
      }
      if (obj.size === 0) {
        return "Map(0) {}";
      }
      if (depth > maxDepth) {
        return options.colors ? "\x1b[36m[Map]\x1b[39m" : "[Map]";
      }
      ancestors.add(obj);
      try {
        const nextIndent = `${indent}  `;
        const entries: string[] = [];
        for (const [k, v] of obj.entries()) {
          entries.push(
            `${format(k, depth + 1, nextIndent)} => ${format(v, depth + 1, nextIndent)}`,
          );
        }
        const singleLine = `Map(${obj.size}) { ${entries.join(", ")} }`;
        if (
          compact !== false &&
          !singleLine.includes("\n") &&
          (compact === true || singleLine.length <= breakLength)
        ) {
          return singleLine;
        }
        return `Map(${obj.size}) {\n${entries.map((e) => `${nextIndent}${e}`).join(",\n")}\n${indent}}`;
      } finally {
        ancestors.delete(obj);
      }
    }
    if (obj instanceof Set) {
      if (ancestors.has(obj)) {
        return options.colors ? "\x1b[36m[Circular]\x1b[39m" : "[Circular]";
      }
      if (obj.size === 0) {
        return "Set(0) {}";
      }
      if (depth > maxDepth) {
        return options.colors ? "\x1b[36m[Set]\x1b[39m" : "[Set]";
      }
      ancestors.add(obj);
      try {
        const nextIndent = `${indent}  `;
        const entries: string[] = [];
        for (const v of obj.values()) {
          entries.push(format(v, depth + 1, nextIndent));
        }
        const singleLine = `Set(${obj.size}) { ${entries.join(", ")} }`;
        if (
          compact !== false &&
          !singleLine.includes("\n") &&
          (compact === true || singleLine.length <= breakLength)
        ) {
          return singleLine;
        }
        return `Set(${obj.size}) {\n${entries.map((e) => `${nextIndent}${e}`).join(",\n")}\n${indent}}`;
      } finally {
        ancestors.delete(obj);
      }
    }
    if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
      return Bun.inspect(obj, {
        colors: options.colors,
        depth: maxDepth === Infinity ? Infinity : Math.max(0, maxDepth - depth),
        sorted: Boolean(options.sorted),
        compact: compact === true,
      } as Parameters<typeof Bun.inspect>[1]);
    }

    if (ancestors.has(obj)) {
      return options.colors ? "\x1b[36m[Circular]\x1b[39m" : "[Circular]";
    }

    if (Array.isArray(obj)) {
      if (depth > maxDepth) {
        return options.colors ? "\x1b[36m[Array]\x1b[39m" : "[Array]";
      }
      if (obj.length === 0) {
        return "[]";
      }
      ancestors.add(obj);
      try {
        const limit = maxArrayLen < 0 ? 0 : maxArrayLen;
        const shown = Math.min(obj.length, limit);
        const items: string[] = [];
        for (let i = 0; i < shown; i++) {
          items.push(format(obj[i], depth + 1, `${indent}  `));
        }
        const remaining = obj.length - shown;
        if (remaining > 0) {
          items.push(
            remaining === 1
              ? "... 1 more item"
              : `... ${remaining} more items`,
          );
        }
        const singleLine = `[ ${items.join(", ")} ]`;
        if (
          compact !== false &&
          !singleLine.includes("\n") &&
          (compact === true || singleLine.length <= breakLength)
        ) {
          return singleLine;
        }
        const nextIndent = `${indent}  `;
        return `[\n${items.map((item) => `${nextIndent}${item}`).join(",\n")}\n${indent}]`;
      } finally {
        ancestors.delete(obj);
      }
    }

    // Plain / class object
    if (depth > maxDepth) {
      const ctorName =
        obj.constructor &&
        obj.constructor !== Object &&
        typeof obj.constructor.name === "string" &&
        obj.constructor.name.length > 0
          ? `[${obj.constructor.name}]`
          : "[Object]";
      return options.colors ? `\x1b[36m${ctorName}\x1b[39m` : ctorName;
    }

    const keys = options.showHidden
      ? Object.getOwnPropertyNames(obj)
      : Object.keys(obj);
    if (options.sorted === true) {
      keys.sort();
    } else if (typeof options.sorted === "function") {
      keys.sort(options.sorted);
    }

    const ctorPrefix =
      obj.constructor &&
      obj.constructor !== Object &&
      typeof obj.constructor.name === "string" &&
      obj.constructor.name.length > 0
        ? `${obj.constructor.name} `
        : "";

    if (keys.length === 0) {
      return `${ctorPrefix}{}`;
    }

    ancestors.add(obj);
    try {
      const nextIndent = `${indent}  `;
      const entries = keys.map((k) => {
        const v = (obj as Record<string, unknown>)[k];
        return `${formatPropertyKey(k)}: ${format(v, depth + 1, nextIndent)}`;
      });
      const singleLine = `${ctorPrefix}{ ${entries.join(", ")} }`;
      if (
        compact !== false &&
        !singleLine.includes("\n") &&
        (compact === true || singleLine.length <= breakLength)
      ) {
        return singleLine;
      }
      return `${ctorPrefix}{\n${entries.map((e) => `${nextIndent}${e}`).join(",\n")}\n${indent}}`;
    } finally {
      ancestors.delete(obj);
    }
  };

  return format(value, 0, "");
}

/**
 * Canonical log levels ordered from most verbose (`verbose`) to most severe (`fatal`),
 * matching NestJS `LOG_LEVELS`.
 */
export const LOG_LEVELS: readonly LogLevel[] = Object.freeze([
  "verbose",
  "debug",
  "log",
  "warn",
  "error",
  "fatal",
]);

const LOG_LEVEL_VALUES: Readonly<Record<LogLevel, number>> = {
  verbose: 0,
  debug: 1,
  log: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

export function isLogLevelEnabled(
  targetLevel: LogLevel,
  logLevels: readonly LogLevel[] | undefined,
): boolean {
  if (!logLevels || logLevels.length === 0) {
    return false;
  }
  if (logLevels.includes(targetLevel)) {
    return true;
  }
  let highestLogLevelValue = -1;
  for (const level of logLevels) {
    const val = LOG_LEVEL_VALUES[level];
    if (val !== undefined && val > highestLogLevelValue) {
      highestLogLevelValue = val;
    }
  }
  if (highestLogLevelValue < 0) {
    return false;
  }
  return LOG_LEVEL_VALUES[targetLevel] >= highestLogLevelValue;
}

function parseLogLevelsStrict(parseableString: string): {
  levels: LogLevel[];
  valid: boolean;
} {
  const sanitized = parseableString.trim().toLowerCase();
  if (!sanitized) {
    return { levels: [...LOG_LEVELS], valid: true };
  }

  if (sanitized.startsWith(">=")) {
    const threshold = sanitized.slice(2).trim();
    const idx = LOG_LEVELS.indexOf(threshold as LogLevel);
    if (idx === -1) {
      return { levels: [...LOG_LEVELS], valid: false };
    }
    return { levels: LOG_LEVELS.slice(idx), valid: true };
  }

  if (sanitized.startsWith(">")) {
    const threshold = sanitized.slice(1).trim();
    const idx = LOG_LEVELS.indexOf(threshold as LogLevel);
    if (idx === -1) {
      return { levels: [...LOG_LEVELS], valid: false };
    }
    return { levels: LOG_LEVELS.slice(idx + 1), valid: true };
  }

  if (sanitized.includes(",")) {
    const rawParts = sanitized.split(",");
    const levels: LogLevel[] = [];
    for (const part of rawParts) {
      const token = part.trim();
      if (!token || !(token in LOG_LEVEL_VALUES)) {
        return { levels: [...LOG_LEVELS], valid: false };
      }
      levels.push(token as LogLevel);
    }
    return { levels, valid: levels.length > 0 };
  }

  if (sanitized in LOG_LEVEL_VALUES) {
    return { levels: [sanitized as LogLevel], valid: true };
  }

  return { levels: [...LOG_LEVELS], valid: false };
}

/**
 * Parses NestJS-style log level filter strings (`"warn"`, `">=debug"`, `">warn"`, `"warn,error"`)
 * into an enabled `LogLevel[]` list (matching NestJS v12 `filterLogLevels()`).
 */
export function filterLogLevels(parseableString = ""): LogLevel[] {
  return parseLogLevelsStrict(parseableString).levels;
}

export interface ConsoleLoggerOptions {
  logLevels?: LogLevel[];
  timestamp?: boolean;
  prefix?: string;
  json?: boolean;
  colors?: boolean;
  context?: string;
  forceConsole?: boolean;
  compact?: boolean | number;
  maxArrayLength?: number;
  maxStringLength?: number;
  sorted?: boolean | ((a: string, b: string) => number);
  depth?: number | null;
  showHidden?: boolean;
  breakLength?: number;
  structuredParams?: boolean;
  flattenParams?: boolean;
  /**
   * Automatically enrich JSON log entries with active ambient context
   * (e.g. HTTP `requestId` and `ClsService` fields).
   * Defaults to `true` when `json: true`. Pass `false` to disable or a custom
   * `LogContextProvider` function to supply custom fields.
   */
  enrichContext?: boolean | LogContextProvider;
  redact?:
    | string[]
    | {
        paths: string[];
        censor?: string;
      };
}

const MAX_JSON_LENGTH = 1_000_000;

/**
 * Extensible console logger matching NestJS v12 `ConsoleLogger` (`json`, `colors`,
 * `prefix`, `timestamp`, `structuredParams`, `flattenParams`, `redact`, `forceConsole`,
 * and `NEST_LOG_LEVEL` / `BUNEST_LOG_LEVEL` support).
 */
export class ConsoleLogger implements LoggerService {
  protected options: ConsoleLoggerOptions;
  protected context?: string;
  protected originalContext?: string;
  protected inspectOptions: InspectOptions;
  protected static lastTimestampAt?: number;
  private static warnedInvalidEnvValues = new Set<string>();

  private readonly redactPaths?: readonly string[][];
  private readonly redactCensor: string = "[REDACTED]";
  private redactor?: Redactor;
  private resolvedDefaultLevels?: LogLevel[];

  constructor();
  constructor(context: string);
  constructor(options: ConsoleLoggerOptions);
  constructor(context: string, options: ConsoleLoggerOptions);
  constructor(
    contextOrOptions?: string | ConsoleLoggerOptions,
    maybeOptions?: ConsoleLoggerOptions,
  ) {
    if (typeof contextOrOptions === "string") {
      this.context = contextOrOptions;
      this.originalContext = contextOrOptions;
      this.options = { ...(maybeOptions ?? {}) };
    } else {
      this.options = { ...(contextOrOptions ?? {}) };
      this.context = this.options.context;
      this.originalContext = this.options.context;
    }

    if (this.options.prefix === undefined) {
      this.options.prefix = "Nest";
    }

    if (this.options.redact) {
      const rawPaths = Array.isArray(this.options.redact)
        ? this.options.redact
        : this.options.redact.paths;
      this.redactCensor = Array.isArray(this.options.redact)
        ? "[REDACTED]"
        : (this.options.redact.censor ?? "[REDACTED]");
      this.redactPaths = rawPaths
        .map((p) =>
          p
            .split(".")
            .map((seg) => seg.trim().toLowerCase())
            .filter(Boolean),
        )
        .filter((segs) => segs.length > 0);
    }

    this.inspectOptions = this.getInspectOptions();
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    if (!this.isLevelEnabled("log")) return;
    const { messages, context, params } = this.getContextAndMessagesToPrint([
      message,
      ...optionalParams,
    ]);
    this.printMessages(messages, context, "log", "stdout", undefined, params);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    if (!this.isLevelEnabled("error")) return;
    const { messages, context, stack, params } =
      this.getContextAndStackAndMessagesToPrint([message, ...optionalParams]);
    this.printMessages(messages, context, "error", "stderr", stack, params);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    if (!this.isLevelEnabled("warn")) return;
    const { messages, context, params } = this.getContextAndMessagesToPrint([
      message,
      ...optionalParams,
    ]);
    this.printMessages(messages, context, "warn", "stdout", undefined, params);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    if (!this.isLevelEnabled("debug")) return;
    const { messages, context, params } = this.getContextAndMessagesToPrint([
      message,
      ...optionalParams,
    ]);
    this.printMessages(messages, context, "debug", "stdout", undefined, params);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    if (!this.isLevelEnabled("verbose")) return;
    const { messages, context, params } = this.getContextAndMessagesToPrint([
      message,
      ...optionalParams,
    ]);
    this.printMessages(
      messages,
      context,
      "verbose",
      "stdout",
      undefined,
      params,
    );
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    if (!this.isLevelEnabled("fatal")) return;
    const { messages, context, stack, params } =
      this.getContextAndStackAndMessagesToPrint([message, ...optionalParams]);
    this.printMessages(messages, context, "fatal", "stderr", stack, params);
  }

  setLogLevels(levels: LogLevel[]): void {
    this.options.logLevels = [...levels];
  }

  setContext(context: string): void {
    this.context = context;
  }

  resetContext(): void {
    this.context = this.originalContext;
  }

  isLevelEnabled(level: LogLevel): boolean {
    const levels = this.options.logLevels ?? this.getDefaultLogLevels();
    return isLogLevelEnabled(level, levels);
  }

  protected getDefaultLogLevels(): LogLevel[] {
    const envLevels =
      process.env.BUNEST_LOG_LEVEL ?? process.env.NEST_LOG_LEVEL;
    if (envLevels !== undefined && envLevels.trim().length > 0) {
      const parsed = parseLogLevelsStrict(envLevels);
      if (!parsed.valid && !ConsoleLogger.warnedInvalidEnvValues.has(envLevels)) {
        ConsoleLogger.warnedInvalidEnvValues.add(envLevels);
        this.printMessages(
          [
            `Invalid NEST_LOG_LEVEL value "${envLevels}". Falling back to all log levels.`,
          ],
          "ConsoleLogger",
          "warn",
          "stdout",
        );
      }
      return parsed.levels;
    }
    return [...LOG_LEVELS];
  }

  protected getTimestamp(): string {
    return formatNestTimestamp();
  }

  protected isColorsEnabled(): boolean {
    if (this.options.colors !== undefined) {
      return this.options.colors;
    }
    return !this.options.json && isColorAllowed();
  }

  protected getInspectOptions(): InspectOptions {
    const jsonMode = this.options.json === true;
    const colors = this.isColorsEnabled();
    const compact = this.options.compact ?? jsonMode;
    const breakLength =
      this.options.breakLength ??
      (compact === true || (!colors && this.options.compact !== false)
        ? Infinity
        : 80);
    return {
      colors,
      compact,
      breakLength,
      depth: this.options.depth === undefined ? 5 : this.options.depth,
      sorted: this.options.sorted ?? false,
      showHidden: this.options.showHidden ?? false,
      maxArrayLength: this.options.maxArrayLength ?? 100,
      maxStringLength: this.options.maxStringLength ?? 10_000,
    };
  }

  protected formatPid(pid: number): string {
    const prefix = this.options.prefix ?? "Bunest";
    return `[${prefix}] ${pid}  - `;
  }

  protected formatContext(context: string): string {
    if (!context) return "";
    const formatted = `[${context}] `;
    return this.isColorsEnabled() ? clc.yellow(formatted) : formatted;
  }

  protected getColorByLogLevel(level: LogLevel): (text: string) => string {
    return LOG_LEVEL_COLORS[level] ?? ((s) => s);
  }

  protected colorize(message: string, logLevel: LogLevel): string {
    if (!this.isColorsEnabled()) return message;
    return this.getColorByLogLevel(logLevel)(message);
  }

  protected updateAndGetTimestampDiff(): string {
    if (!this.options.timestamp) {
      return "";
    }
    const now = Date.now();
    const result =
      ConsoleLogger.lastTimestampAt !== undefined
        ? this.formatTimestampDiff(now - ConsoleLogger.lastTimestampAt)
        : "";
    ConsoleLogger.lastTimestampAt = now;
    return result;
  }

  protected formatTimestampDiff(timestampDiff: number): string {
    const formatted = ` +${timestampDiff}ms`;
    return this.isColorsEnabled() ? clc.yellow(formatted) : formatted;
  }

  protected resolveMessage(message: unknown): unknown {
    if (typeof message === "function") {
      // Class constructors have prototype with constructor === message
      if (
        message.prototype &&
        Object.prototype.hasOwnProperty.call(
          message.prototype,
          "constructor",
        ) &&
        message.name
      ) {
        return message.name;
      }
      try {
        return this.resolveMessage((message as () => unknown)());
      } catch {
        return message.name || "[Function]";
      }
    }
    return message;
  }

  protected redact(value: unknown): unknown {
    if (!this.redactPaths || this.redactPaths.length === 0) {
      return value;
    }
    this.redactor ??= createRedactor(
      this.redactPaths.map((segs) => segs.join(".")),
      this.redactCensor,
    );
    return this.redactor(value);
  }

  protected serializeError(
    error: Error,
    depth = 0,
    ancestors = new Set<Error>(),
  ): Record<string, unknown> | string {
    if (ancestors.has(error)) {
      return "[Circular]";
    }
    if (depth > 5) {
      return "[Truncated]";
    }
    const source = depth === 0 ? (this.redact(error) as Error) : error;
    if (!(source instanceof Error)) {
      return source as unknown as string;
    }
    ancestors.add(error);
    if (source !== error) {
      ancestors.add(source);
    }
    const out: Record<string, unknown> = {
      name: source.name,
      message: source.message,
      ...(source.stack ? { stack: source.stack } : {}),
    };
    for (const [key, val] of Object.entries(source)) {
      if (key === "cause" || key === "errors") continue;
      if (
        typeof val === "string" ||
        typeof val === "number" ||
        typeof val === "boolean"
      ) {
        out[key] = val;
      }
    }
    if ("cause" in source && source.cause !== undefined) {
      out.cause =
        source.cause instanceof Error
          ? this.serializeError(source.cause, depth + 1, ancestors)
          : this.redact(source.cause);
    }
    if (source instanceof AggregateError && Array.isArray(source.errors)) {
      out.errors = source.errors.map((e) =>
        e instanceof Error
          ? this.serializeError(e, depth + 1, ancestors)
          : this.redact(e),
      );
    }
    ancestors.delete(error);
    if (source !== error) {
      ancestors.delete(source);
    }
    return out;
  }

  protected stringifyMessage(message: unknown, logLevel: LogLevel): string {
    const resolved = this.resolveMessage(message);
    if (typeof resolved === "string") {
      return this.colorize(resolved, logLevel);
    }
    const redacted = this.redact(resolved);
    if (Array.isArray(redacted)) {
      const formatted = inspect(redacted, {
        ...this.inspectOptions,
        compact: false,
      });
      return `Array(${redacted.length}) ${formatted}`;
    }
    if (isPlainObject(redacted)) {
      const formatted = inspect(redacted, {
        ...this.inspectOptions,
        compact: false,
      });
      return `Object(${Object.keys(redacted).length}) ${formatted}`;
    }
    return inspect(redacted, this.inspectOptions);
  }

  protected stringifyParams(params: Record<string, unknown>): string {
    const paramInspectOptions: InspectOptions = {
      ...this.inspectOptions,
      compact: this.options.compact ?? true,
    };
    return inspect(this.redact(params), paramInspectOptions);
  }

  protected formatMessage(
    logLevel: LogLevel,
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
    params?: Record<string, unknown>,
  ): string {
    const output = this.stringifyMessage(message, logLevel);
    const paramsStr = params ? ` ${this.stringifyParams(params)}` : "";
    return `${pidMessage}${this.getTimestamp()} ${formattedLogLevel} ${contextMessage}${output}${paramsStr}${timestampDiff}\n`;
  }

  protected stringifyReplacer(_key: string, value: unknown): unknown {
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (typeof value === "symbol") {
      return value.toString();
    }
    if (value instanceof Map || value instanceof Set) {
      return inspect(value, {
        ...this.inspectOptions,
        colors: false,
        compact: true,
      });
    }
    return value;
  }

  protected stringifyJsonLogObject(logObject: Record<string, unknown>): string {
    const ancestors = new Set<object>();
    const seen = new Set<object>();
    let repeatedBytes = 0;

    const serializeValue = (key: string, raw: unknown): string | undefined => {
      if (raw !== null && typeof raw === "object") {
        if (ancestors.has(raw)) {
          return '"[Circular]"';
        }
        if (repeatedBytes >= MAX_JSON_LENGTH) {
          return '"[Truncated]"';
        }
      }

      const isRepeat =
        raw !== null && typeof raw === "object" && seen.has(raw);
      if (raw !== null && typeof raw === "object") {
        seen.add(raw);
      }

      let current = raw;
      if (
        current !== null &&
        typeof current === "object" &&
        typeof (current as { toJSON?: unknown }).toJSON === "function"
      ) {
        current = (current as { toJSON: (k: string) => unknown }).toJSON(key);
      }

      const replaced = this.stringifyReplacer(key, current);

      if (replaced === undefined || typeof replaced === "function") {
        return undefined;
      }
      if (
        replaced === null ||
        typeof replaced === "boolean" ||
        typeof replaced === "number" ||
        typeof replaced === "string"
      ) {
        const encoded = JSON.stringify(replaced);
        if (isRepeat && encoded) {
          repeatedBytes += encoded.length;
        }
        return encoded;
      }
      if (typeof replaced === "bigint" || typeof replaced === "symbol") {
        const encoded = JSON.stringify(replaced.toString());
        if (isRepeat) {
          repeatedBytes += encoded.length;
        }
        return encoded;
      }

      const obj = replaced as object;
      if (ancestors.has(obj)) {
        return '"[Circular]"';
      }
      if (obj !== raw && seen.has(obj) && repeatedBytes >= MAX_JSON_LENGTH) {
        return '"[Truncated]"';
      }

      const objIsRepeat = isRepeat || (obj !== raw && seen.has(obj));
      seen.add(obj);
      ancestors.add(obj);
      if (raw !== null && typeof raw === "object" && raw !== obj) {
        ancestors.add(raw);
      }

      try {
        let encoded: string;
        if (Array.isArray(obj)) {
          const parts: string[] = [];
          for (let i = 0; i < obj.length; i++) {
            const itemStr = serializeValue(String(i), obj[i]);
            parts.push(itemStr === undefined ? "null" : itemStr);
          }
          encoded = `[${parts.join(",")}]`;
        } else {
          const parts: string[] = [];
          for (const prop of Object.keys(obj)) {
            const valStr = serializeValue(
              prop,
              (obj as Record<string, unknown>)[prop],
            );
            if (valStr !== undefined) {
              parts.push(`${JSON.stringify(prop)}:${valStr}`);
            }
          }
          encoded = `{${parts.join(",")}}`;
        }
        if (objIsRepeat) {
          repeatedBytes += encoded.length;
        }
        return encoded;
      } finally {
        ancestors.delete(obj);
        if (raw !== null && typeof raw === "object" && raw !== obj) {
          ancestors.delete(raw);
        }
      }
    };

    try {
      return serializeValue("", logObject) ?? "{}";
    } catch {
      return inspect(logObject, this.inspectOptions);
    }
  }

  protected extractJsonError(messages: unknown[]): {
    messages: unknown[];
    error?: Error;
  } {
    if (messages.length > 1) {
      const last = messages[messages.length - 1];
      if (last instanceof Error) {
        return {
          messages: messages.slice(0, -1),
          error: last,
        };
      }
    }
    return { messages };
  }

  protected getJsonLogObject(
    message: unknown,
    options: {
      context: string;
      logLevel: LogLevel;
      writeStreamType?: "stdout" | "stderr";
      errorStack?: unknown;
      params?: Record<string, unknown>;
      error?: Error;
    },
  ): {
    [key: string]: unknown;
    level: LogLevel;
    pid: number;
    timestamp: number;
    message: unknown;
  } {
    const errorObj =
      options.error ?? (message instanceof Error ? message : undefined);
    const payload: {
      [key: string]: unknown;
      level: LogLevel;
      pid: number;
      timestamp: number;
      message: unknown;
    } = {
      level: options.logLevel,
      pid: process.pid,
      timestamp: Date.now(),
      message:
        message instanceof Error
          ? message.message
          : this.redact(this.resolveMessage(message)),
      ...(options.context ? { context: options.context } : {}),
      ...(options.errorStack !== undefined
        ? { stack: options.errorStack }
        : {}),
      ...(errorObj ? { error: this.serializeError(errorObj) } : {}),
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
      if (ambient && isPlainObject(ambient)) {
        const redactedAmbient = this.redact(ambient);
        if (isPlainObject(redactedAmbient)) {
          for (const [k, v] of Object.entries(redactedAmbient)) {
            if (v !== undefined && !(k in payload)) {
              payload[k] = v;
            }
          }
        }
      }
    }
    if (options.params) {
      const redactedParams = this.redact(options.params);
      if (this.options.flattenParams && isPlainObject(redactedParams)) {
        Object.assign(payload, redactedParams);
      } else {
        payload.params = redactedParams;
      }
    }
    return payload;
  }

  protected printAsJson(
    message: unknown,
    options: {
      context: string;
      logLevel: LogLevel;
      writeStreamType?: "stdout" | "stderr";
      errorStack?: unknown;
      params?: Record<string, unknown>;
      error?: Error;
    },
  ): void {
    const payload = this.getJsonLogObject(message, options);
    const formatted =
      this.options.compact === false
        ? inspect(payload, this.inspectOptions)
        : this.stringifyJsonLogObject(payload);
    this.writeLine(`${formatted}\n`, options.writeStreamType ?? "stdout");
  }

  protected printMessages(
    messages: unknown[],
    context = "",
    logLevel: LogLevel = "log",
    writeStreamType: "stdout" | "stderr" = "stdout",
    errorStack?: unknown,
    params?: Record<string, unknown>,
  ): void {
    if (this.options.json) {
      const { messages: jsonMessages, error } = this.extractJsonError(messages);
      for (const msg of jsonMessages) {
        this.printAsJson(msg, {
          context,
          logLevel,
          writeStreamType,
          errorStack,
          params,
          error,
        });
      }
      return;
    }

    const pidMessage = this.colorize(this.formatPid(process.pid), logLevel);
    const formattedLogLevel = this.colorize(
      logLevel.toUpperCase().padStart(7, " "),
      logLevel,
    );
    const contextMessage = this.formatContext(context);

    for (const msg of messages) {
      const timestampDiff = this.updateAndGetTimestampDiff();
      const formatted = this.formatMessage(
        logLevel,
        msg,
        pidMessage,
        formattedLogLevel,
        contextMessage,
        timestampDiff,
        params,
      );
      this.writeLine(formatted, writeStreamType);
    }

    if (typeof errorStack === "string" && errorStack.length > 0) {
      this.printStackTrace(errorStack);
    }
  }

  protected printStackTrace(stack: string): void {
    this.writeLine(`${stack}\n`, "stderr");
  }

  protected isStackFormat(stack: unknown): boolean {
    if (typeof stack !== "string") return false;
    return /^[\s\S]+\n\s+at .+:\d+:\d+/.test(stack);
  }

  private extractStructuredParams(rest: unknown[]): {
    messages: unknown[];
    params?: Record<string, unknown>;
  } {
    if (this.options.structuredParams === false || rest.length <= 1) {
      return { messages: rest };
    }
    const messages: unknown[] = [rest[0]];
    const paramObjects: Record<string, unknown>[] = [];
    for (let i = 1; i < rest.length; i++) {
      const arg = rest[i];
      if (isPlainObject(arg)) {
        paramObjects.push(arg);
      } else {
        messages.push(arg);
      }
    }
    if (paramObjects.length === 0) {
      return { messages };
    }
    const merged: Record<string, unknown> = {};
    for (const obj of paramObjects) {
      Object.assign(merged, obj);
    }
    return { messages, params: merged };
  }

  protected getContextAndMessagesToPrint(args: unknown[]): {
    messages: unknown[];
    context: string | undefined;
    params?: Record<string, unknown>;
  } {
    if (args.length <= 1) {
      return { messages: args, context: this.context };
    }
    const rest = [...args];
    let context = this.context;
    const last = rest[rest.length - 1];
    if (typeof last === "string") {
      context = last;
      rest.pop();
    }
    const { messages, params } = this.extractStructuredParams(rest);
    return { messages, context, ...(params ? { params } : {}) };
  }

  protected getContextAndStackAndMessagesToPrint(args: unknown[]): {
    messages: unknown[];
    context: string | undefined;
    stack?: string;
    params?: Record<string, unknown>;
  } {
    if (args.length <= 1) {
      return { messages: args, context: this.context };
    }
    const rest = [...args];
    let context = this.context;
    let stack: string | undefined;

    const last = rest[rest.length - 1];
    if (last === undefined) {
      rest.pop();
    } else if (typeof last === "string") {
      if (this.isStackFormat(last)) {
        stack = last;
        rest.pop();
      } else {
        context = last;
        rest.pop();
        if (rest.length > 1) {
          const maybeStack = rest[rest.length - 1];
          if (maybeStack === undefined) {
            rest.pop();
          } else if (typeof maybeStack === "string") {
            stack = maybeStack;
            rest.pop();
          }
        }
      }
    }

    const { messages, params } = this.extractStructuredParams(rest);

    return {
      messages,
      context,
      ...(stack !== undefined ? { stack } : {}),
      ...(params ? { params } : {}),
    };
  }

  private writeLine(line: string, stream: "stdout" | "stderr"): void {
    if (this.options.forceConsole) {
      const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
      if (stream === "stderr") {
        console.error(trimmed);
      } else {
        console.log(trimmed);
      }
      return;
    }
    if (stream === "stderr") {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }
}
