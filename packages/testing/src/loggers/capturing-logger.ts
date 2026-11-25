import {
  ConsoleLogger,
  LOG_LEVELS,
  type ConsoleLoggerOptions,
  type LogLevel,
} from "@bunest/core";

/**
 * A log call recorded by `CapturingLogger` (NestJS v12 parity).
 */
export interface CapturedLog {
  level: LogLevel;
  /**
   * The message. A lazy message (a function) is evaluated, and when an
   * `Error` is logged as the message, this is the error's message.
   */
  message: unknown;
  /**
   * The context, e.g. the one passed to `new Logger('Context')`.
   */
  context?: string;
  /**
   * The plain objects passed after the message, merged.
   */
  params?: Record<string, unknown>;
  /**
   * The first `Error` passed to the call, as the message or after it.
   */
  error?: Error;
  /**
   * The stack trace passed as a string, as in `logger.error(message, stack)`.
   */
  stack?: string;
  /**
   * The arguments, as passed to the logger (including the context).
   */
  args: unknown[];
  /**
   * Backward-compatible Bunest aliases for legacy callers.
   */
  readonly optionalParams?: readonly unknown[];
  readonly timestamp?: Date;
}

/**
 * Backward-compatible Bunest alias for `CapturedLog`.
 */
export type CapturedLogEntry = CapturedLog;

/**
 * Criteria for `CapturingLogger` queries. Every criterion that is set must match.
 */
export interface CapturedLogFilter {
  level?: LogLevel | readonly LogLevel[];
  /**
   * A string matches the context exactly; a RegExp matches via `.test()`.
   */
  context?: string | RegExp;
  /**
   * A string matches when the message contains it; a RegExp matches via `.test()`.
   */
  message?: string | RegExp;
  /**
   * Matches when each of these params is deeply equal to the logged one.
   */
  params?: Record<string, unknown>;
}

/**
 * Backward-compatible Bunest alias for `CapturedLogFilter`.
 */
export type CapturingLoggerFilterOptions = CapturedLogFilter;

/**
 * NestJS v12 matcher accepted by `filter`, `find`, `assertLogged`, `assertNotLogged`.
 */
export type CapturedLogMatcher =
  CapturedLogFilter | ((entry: CapturedLog) => boolean);

/**
 * Extended matcher also accepting legacy Bunest string/RegExp shorthands.
 */
export type LogEntryMatcher = CapturedLogMatcher | string | RegExp;

/**
 * Options for `CapturingLogger` extending `ConsoleLoggerOptions` (NestJS v12 parity),
 * retaining Bunest's `levels` alias for backward compatibility.
 */
export interface CapturingLoggerOptions extends ConsoleLoggerOptions {
  /**
   * If enabled, logs are also printed, as a `ConsoleLogger` with the same
   * options would print them.
   * @default false
   */
  print?: boolean;
  /**
   * Backward-compatible Bunest alias for `logLevels`.
   */
  levels?: readonly LogLevel[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function looksLikeStackTrace(value: string): boolean {
  return /\n\s+at\s+/.test(value) || value.startsWith("Error:");
}

function formatMessageForSummary(message: unknown): string {
  if (typeof message === "string") {
    return message;
  }
  if (message instanceof Error) {
    return message.message;
  }
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

function matchesMessage(actual: unknown, expected: string | RegExp): boolean {
  if (typeof actual !== "string") {
    return false;
  }
  if (typeof expected === "string") {
    return actual.includes(expected);
  }
  return expected.test(actual);
}

function matchesContext(
  actual: string | undefined,
  expected: string | RegExp,
): boolean {
  if (actual === undefined) {
    return false;
  }
  if (typeof expected === "string") {
    return actual === expected;
  }
  return expected.test(actual);
}

function matchesParams(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown>,
): boolean {
  if (!actual || typeof actual !== "object") {
    return false;
  }
  for (const [key, expectedVal] of Object.entries(expected)) {
    if (!Object.prototype.hasOwnProperty.call(actual, key)) {
      return false;
    }
    if (!Bun.deepEquals(actual[key], expectedVal, true)) {
      return false;
    }
  }
  return true;
}

function matchesFilter(entry: CapturedLog, filter: CapturedLogFilter): boolean {
  if (filter.level !== undefined) {
    if (Array.isArray(filter.level)) {
      if (!filter.level.includes(entry.level)) {
        return false;
      }
    } else if (entry.level !== filter.level) {
      return false;
    }
  }

  if (
    filter.context !== undefined &&
    !matchesContext(entry.context, filter.context)
  ) {
    return false;
  }

  if (
    filter.message !== undefined &&
    !matchesMessage(entry.message, filter.message)
  ) {
    return false;
  }

  if (
    filter.params !== undefined &&
    !matchesParams(entry.params, filter.params)
  ) {
    return false;
  }

  return true;
}

function describeMatcher(matcher: LogEntryMatcher, level?: LogLevel): string {
  const levelDesc = level ? ` at level "${level}"` : "";
  if (typeof matcher === "function") {
    return `<predicate>${levelDesc}`;
  }
  if (typeof matcher === "string" || matcher instanceof RegExp) {
    return `${String(matcher)}${levelDesc}`;
  }
  try {
    return `${JSON.stringify(matcher, (_k, v) => (v instanceof RegExp ? v.toString() : v))}${levelDesc}`;
  } catch {
    return `<filter>${levelDesc}`;
  }
}

/**
 * In-memory capturing logger extending `ConsoleLogger` (NestJS v12 parity) that
 * records every log call with structured `message`, `context`, `params`, `error`,
 * `stack`, and `args` for assertions in unit and E2E tests.
 *
 * Every level is captured unless `logLevels` (or `levels`) is set;
 * `NEST_LOG_LEVEL` / `BUNEST_LOG_LEVEL` environment variables are ignored.
 */
export class CapturingLogger extends ConsoleLogger {
  private readonly captured: CapturedLog[] = [];
  private readonly shouldPrint: boolean;

  constructor(options: CapturingLoggerOptions = {}) {
    const resolvedLevels: LogLevel[] = options.logLevels
      ? [...options.logLevels]
      : options.levels
        ? [...options.levels]
        : [...LOG_LEVELS];
    super({
      ...options,
      logLevels: resolvedLevels,
    });
    this.shouldPrint = options.print ?? false;
  }

  /**
   * The recorded entries, oldest first.
   */
  get entries(): CapturedLog[] {
    return [...this.captured];
  }

  override log(message: unknown, ...optionalParams: unknown[]): void {
    if (!this.isLevelEnabled("log")) return;
    const resolved = typeof message === "function" ? (message as () => unknown)() : message;
    this.capture("log", resolved, optionalParams);
    if (this.shouldPrint) {
      super.log(resolved, ...optionalParams);
    }
  }

  override error(message: unknown, ...optionalParams: unknown[]): void {
    if (!this.isLevelEnabled("error")) return;
    const resolved = typeof message === "function" ? (message as () => unknown)() : message;
    this.capture("error", resolved, optionalParams);
    if (this.shouldPrint) {
      super.error(resolved, ...optionalParams);
    }
  }

  override warn(message: unknown, ...optionalParams: unknown[]): void {
    if (!this.isLevelEnabled("warn")) return;
    const resolved = typeof message === "function" ? (message as () => unknown)() : message;
    this.capture("warn", resolved, optionalParams);
    if (this.shouldPrint) {
      super.warn(resolved, ...optionalParams);
    }
  }

  override debug(message: unknown, ...optionalParams: unknown[]): void {
    if (!this.isLevelEnabled("debug")) return;
    const resolved = typeof message === "function" ? (message as () => unknown)() : message;
    this.capture("debug", resolved, optionalParams);
    if (this.shouldPrint) {
      super.debug(resolved, ...optionalParams);
    }
  }

  override verbose(message: unknown, ...optionalParams: unknown[]): void {
    if (!this.isLevelEnabled("verbose")) return;
    const resolved = typeof message === "function" ? (message as () => unknown)() : message;
    this.capture("verbose", resolved, optionalParams);
    if (this.shouldPrint) {
      super.verbose(resolved, ...optionalParams);
    }
  }

  override fatal(message: unknown, ...optionalParams: unknown[]): void {
    if (!this.isLevelEnabled("fatal")) return;
    const resolved = typeof message === "function" ? (message as () => unknown)() : message;
    this.capture("fatal", resolved, optionalParams);
    if (this.shouldPrint) {
      super.fatal(resolved, ...optionalParams);
    }
  }

  /**
   * Returns the entries that match.
   */
  filter(matcher?: CapturedLogMatcher): CapturedLog[] {
    if (matcher === undefined) {
      return [...this.captured];
    }
    if (typeof matcher === "function") {
      return this.captured.filter(matcher);
    }
    return this.captured.filter((entry) => matchesFilter(entry, matcher));
  }

  /**
   * Returns the first entry that matches.
   */
  find(matcher: CapturedLogMatcher = {}): CapturedLog | undefined {
    if (typeof matcher === "function") {
      return this.captured.find(matcher);
    }
    return this.captured.find((entry) => matchesFilter(entry, matcher));
  }

  /**
   * Throws an error listing the captured entries if no entry matches.
   * Accepts NestJS `CapturedLogMatcher` (`CapturedLogFilter | predicate`) as well
   * as Bunest shorthand `(string | RegExp, level?)`.
   */
  assertLogged(matcher: LogEntryMatcher, level?: LogLevel): CapturedLog {
    const found = this.captured.find((entry) => {
      if (level !== undefined && entry.level !== level) {
        return false;
      }
      return this.matchesEntry(entry, matcher);
    });

    if (!found) {
      const desc = describeMatcher(matcher, level);
      const summary =
        this.captured.length === 0
          ? "(no logs captured)"
          : this.captured
              .map(
                (e) =>
                  `  - [${e.level}${e.context ? `:${e.context}` : ""}] ${formatMessageForSummary(e.message)}`,
              )
              .join("\n");
      throw new Error(
        `Expected a log entry matching ${desc}, but none was found.\nCaptured logs:\n${summary}`,
      );
    }

    return found;
  }

  /**
   * Throws an error listing the matching entries if any entry matches.
   * Accepts NestJS `CapturedLogMatcher` (`CapturedLogFilter | predicate`) as well
   * as Bunest shorthand `(string | RegExp, level?)`.
   */
  assertNotLogged(matcher: LogEntryMatcher, level?: LogLevel): void {
    const found = this.captured.find((entry) => {
      if (level !== undefined && entry.level !== level) {
        return false;
      }
      return this.matchesEntry(entry, matcher);
    });

    if (found) {
      const desc = describeMatcher(matcher, level);
      throw new Error(
        `Expected no log entry matching ${desc}, but found [${found.level}] "${formatMessageForSummary(found.message)}".`,
      );
    }
  }

  /**
   * Removes the recorded entries.
   */
  clear(): void {
    this.captured.length = 0;
  }

  private matchesEntry(entry: CapturedLog, match: LogEntryMatcher): boolean {
    if (typeof match === "function") {
      return match(entry);
    }
    if (typeof match === "string" || match instanceof RegExp) {
      const msgStr =
        typeof entry.message === "string"
          ? entry.message
          : formatMessageForSummary(entry.message);
      return matchesMessage(msgStr, match);
    }
    return matchesFilter(entry, match);
  }

  private capture(
    level: LogLevel,
    rawMessage: unknown,
    optionalParams: unknown[],
  ): void {
    if (!this.isLevelEnabled(level)) {
      return;
    }

    const rawArgs: unknown[] = [rawMessage, ...optionalParams];
    const resolvedRawMessage = this.resolveMessage(rawMessage);
    const isErrorLevel = level === "error" || level === "fatal";

    // Extract context and optional stack from trailing string arguments
    const rest = [...optionalParams];
    let context: string | undefined = this.context;
    let stack: string | undefined;

    if (rest.length > 0) {
      const last = rest[rest.length - 1];
      if (typeof last === "string") {
        if (
          isErrorLevel &&
          (this.isStackFormat(last) || looksLikeStackTrace(last))
        ) {
          stack = last;
          rest.pop();
        } else {
          context = last;
          rest.pop();
          if (
            isErrorLevel &&
            rest.length > 0 &&
            typeof rest[rest.length - 1] === "string"
          ) {
            const prev = rest[rest.length - 1] as string;
            if (
              this.isStackFormat(prev) ||
              looksLikeStackTrace(prev) ||
              rest.length === 1
            ) {
              stack = prev;
              rest.pop();
            }
          }
        }
      }
    }

    // Extract first Error (as message or among remaining params)
    let error: Error | undefined;
    let message: unknown = resolvedRawMessage;
    if (resolvedRawMessage instanceof Error) {
      error = resolvedRawMessage;
      message = resolvedRawMessage.message;
    }

    // Merge plain object params passed after the message
    let mergedParams: Record<string, unknown> | undefined;
    for (let i = 0; i < rest.length; i++) {
      const item = rest[i];
      if (item instanceof Error) {
        if (!error) {
          error = item;
        }
      } else if (isPlainObject(item)) {
        if (!mergedParams) {
          mergedParams = {};
        }
        Object.assign(mergedParams, item);
      }
    }

    const entry: CapturedLog = {
      level,
      message,
      ...(context !== undefined ? { context } : {}),
      ...(mergedParams !== undefined ? { params: mergedParams } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(stack !== undefined ? { stack } : {}),
      args: rawArgs,
      optionalParams: [...optionalParams],
      timestamp: new Date(),
    };
    this.captured.push(entry);
  }
}
