import {
  LOG_LEVEL_COLORS,
  clc,
  formatNestTimestamp,
  isColorAllowed,
} from "./cli-colors";
import type { LogLevel, LoggerService } from "./logger.interface";

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
  const maxDepth =
    options.depth === null
      ? Infinity
      : options.depth === undefined
        ? 5
        : options.depth;
  const maxArrayLen =
    options.maxArrayLength === undefined ? 100 : options.maxArrayLength;
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
      if (obj.stack) {
        return obj.stack.startsWith(header)
          ? obj.stack
          : `${header}\n${obj.stack}`;
      }
      return header;
    }
    if (
      obj instanceof Map ||
      obj instanceof Set ||
      ArrayBuffer.isView(obj) ||
      obj instanceof ArrayBuffer
    ) {
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
 * Canonical log levels ordered from least verbose (`fatal`) to most verbose (`verbose`),
 * matching NestJS `LOG_LEVELS`.
 */
export const LOG_LEVELS: readonly LogLevel[] = Object.freeze([
  "fatal",
  "error",
  "warn",
  "log",
  "debug",
  "verbose",
]);

const LOG_LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  fatal: 0,
  error: 1,
  warn: 2,
  log: 3,
  debug: 4,
  verbose: 5,
};

/**
 * Parses NestJS-style log level filter strings (`"warn"`, `">=debug"`, `"warn,error"`)
 * into an enabled `LogLevel[]` list (matching NestJS v12 `filterLogLevels()`).
 */
export function filterLogLevels(parseableString = ""): LogLevel[] {
  const sanitized = parseableString.trim().toLowerCase();
  if (!sanitized) {
    return [...LOG_LEVELS];
  }

  if (sanitized.startsWith(">=")) {
    const threshold = sanitized.slice(2).trim() as LogLevel;
    const maxPriority = LOG_LEVEL_PRIORITY[threshold];
    if (maxPriority === undefined) {
      return [...LOG_LEVELS];
    }
    return LOG_LEVELS.filter(
      (level) => LOG_LEVEL_PRIORITY[level] <= maxPriority,
    );
  }

  if (sanitized.includes(",")) {
    const parts = sanitized
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const valid = parts.filter((p): p is LogLevel => p in LOG_LEVEL_PRIORITY);
    return valid.length > 0 ? valid : [...LOG_LEVELS];
  }

  if (sanitized in LOG_LEVEL_PRIORITY) {
    const maxPriority = LOG_LEVEL_PRIORITY[sanitized as LogLevel];
    return LOG_LEVELS.filter(
      (level) => LOG_LEVEL_PRIORITY[level] <= maxPriority,
    );
  }

  return [...LOG_LEVELS];
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
  redact?:
    | string[]
    | {
        paths: string[];
        censor?: string;
      };
}

const MAX_JSON_LENGTH = 1_000_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

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

  private readonly redactPaths?: readonly string[][];
  private readonly redactCensor: string = "[REDACTED]";
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
    return levels.includes(level);
  }

  protected getDefaultLogLevels(): LogLevel[] {
    if (!this.resolvedDefaultLevels) {
      const envLevels =
        process.env.BUNEST_LOG_LEVEL ?? process.env.NEST_LOG_LEVEL;
      this.resolvedDefaultLevels = envLevels
        ? filterLogLevels(envLevels)
        : [...LOG_LEVELS];
    }
    return this.resolvedDefaultLevels;
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
    const seen = new WeakSet<object>();
    const matchesPath = (trail: readonly string[]): boolean => {
      for (const pattern of this.redactPaths!) {
        if (pattern.length > trail.length) continue;
        let matched = true;
        for (let i = 0; i < pattern.length; i++) {
          if (trail[trail.length - pattern.length + i] !== pattern[i]) {
            matched = false;
            break;
          }
        }
        if (matched) return true;
      }
      return false;
    };

    const walk = (node: unknown, trail: string[]): unknown => {
      if (node === null || typeof node !== "object") return node;
      if (seen.has(node)) return "[Circular]";
      if (node instanceof Date || node instanceof RegExp) return node;
      seen.add(node);
      try {
        if (Array.isArray(node)) {
          return node.map((item) => walk(item, trail));
        }
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node)) {
          const nextTrail = [...trail, k.toLowerCase()];
          out[k] = matchesPath(nextTrail)
            ? this.redactCensor
            : walk(v, nextTrail);
        }
        return out;
      } finally {
        seen.delete(node);
      }
    };

    return walk(value, []);
  }

  protected serializeError(
    error: Error,
    depth = 0,
    ancestors = new Set<Error>(),
  ): Record<string, unknown> {
    if (ancestors.has(error) || depth > 5) {
      return { name: error.name, message: error.message };
    }
    ancestors.add(error);
    const out: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
    for (const [key, val] of Object.entries(error)) {
      if (
        typeof val === "string" ||
        typeof val === "number" ||
        typeof val === "boolean"
      ) {
        out[key] = val;
      }
    }
    if ("cause" in error && error.cause instanceof Error) {
      out.cause = this.serializeError(error.cause, depth + 1, ancestors);
    }
    if (error instanceof AggregateError && Array.isArray(error.errors)) {
      out.errors = error.errors.map((e) =>
        e instanceof Error ? this.serializeError(e, depth + 1, ancestors) : e,
      );
    }
    ancestors.delete(error);
    return out;
  }

  protected stringifyMessage(message: unknown, logLevel: LogLevel): string {
    const resolved = this.resolveMessage(message);
    if (typeof resolved === "string") {
      return this.colorize(resolved, logLevel);
    }
    return inspect(this.redact(resolved), this.inspectOptions);
  }

  protected stringifyParams(params: Record<string, unknown>): string {
    return inspect(this.redact(params), this.inspectOptions);
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
    return value;
  }

  protected stringifyJsonLogObject(logObject: Record<string, unknown>): string {
    const seen = new WeakSet<object>();
    try {
      const json = JSON.stringify(logObject, (k, v) => {
        const replaced = this.stringifyReplacer(k, v);
        if (replaced !== null && typeof replaced === "object") {
          if (seen.has(replaced)) return "[Circular]";
          seen.add(replaced);
        }
        return replaced;
      });
      if (json.length > MAX_JSON_LENGTH) {
        return `${json.slice(0, MAX_JSON_LENGTH)}[Truncated]`;
      }
      return json;
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
    if (options.params) {
      const redactedParams = this.redact(options.params) as Record<
        string,
        unknown
      >;
      if (this.options.flattenParams) {
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
    const line = `${this.stringifyJsonLogObject(payload)}\n`;
    this.writeLine(line, options.writeStreamType ?? "stdout");
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
    const timestampDiff = this.updateAndGetTimestampDiff();

    for (const msg of messages) {
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
    return /^(.)+\n\s+at .+:\d+:\d+/.test(stack);
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
    let params: Record<string, unknown> | undefined;
    if (
      this.options.structuredParams !== false &&
      rest.length > 1 &&
      isPlainObject(rest[rest.length - 1])
    ) {
      params = rest.pop() as Record<string, unknown>;
    }
    return { messages: rest, context, ...(params ? { params } : {}) };
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
    if (typeof last === "string") {
      if (this.isStackFormat(last)) {
        stack = last;
        rest.pop();
      } else {
        context = last;
        rest.pop();
        if (rest.length > 1 && typeof rest[rest.length - 1] === "string") {
          const maybeStack = rest[rest.length - 1] as string;
          if (this.isStackFormat(maybeStack) || rest.length === 2) {
            stack = maybeStack;
            rest.pop();
          }
        }
      }
    }

    let params: Record<string, unknown> | undefined;
    if (
      this.options.structuredParams !== false &&
      rest.length > 1 &&
      isPlainObject(rest[rest.length - 1])
    ) {
      params = rest.pop() as Record<string, unknown>;
    }

    return {
      messages: rest,
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
