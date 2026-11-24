import type { LogLevel, LoggerService } from "@bunest/core";

export interface TestingLoggerOptions {
  readonly context?: string;
  readonly levels?: readonly LogLevel[];
}

const DEFAULT_TESTING_LEVELS: readonly LogLevel[] = ["error", "fatal"];

/**
 * NestJS-compatible `TestingLogger` used by default in `TestingModule`.
 * Silences routine `log`, `warn`, `debug`, and `verbose` output during test runs
 * while still surfacing `error` and `fatal` messages so real failures are never hidden.
 */
export class TestingLogger implements LoggerService {
  private readonly context?: string;
  private enabledLevels: Set<LogLevel>;

  constructor(contextOrOptions?: string | TestingLoggerOptions) {
    if (typeof contextOrOptions === "string") {
      this.context = contextOrOptions;
      this.enabledLevels = new Set(DEFAULT_TESTING_LEVELS);
    } else {
      this.context = contextOrOptions?.context;
      this.enabledLevels = new Set(
        contextOrOptions?.levels ?? DEFAULT_TESTING_LEVELS,
      );
    }
  }

  setLogLevels(levels: LogLevel[]): void {
    this.enabledLevels = new Set(levels);
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    if (this.enabledLevels.has("log")) {
      this.emit("log", message, optionalParams);
    }
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    if (this.enabledLevels.has("warn")) {
      this.emit("warn", message, optionalParams);
    }
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    if (this.enabledLevels.has("debug")) {
      this.emit("debug", message, optionalParams);
    }
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    if (this.enabledLevels.has("verbose")) {
      this.emit("verbose", message, optionalParams);
    }
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    if (this.enabledLevels.has("error")) {
      this.emit("error", message, optionalParams);
    }
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    if (this.enabledLevels.has("fatal")) {
      this.emit("fatal", message, optionalParams);
    }
  }

  private emit(
    level: LogLevel,
    message: unknown,
    optionalParams: readonly unknown[],
  ): void {
    const prefix = this.context
      ? `[Bunest:${this.context}] ${level.toUpperCase()}`
      : `[Bunest] ${level.toUpperCase()}`;

    if (level === "error" || level === "fatal") {
      console.error(prefix, message, ...optionalParams);
    } else if (level === "warn") {
      console.warn(prefix, message, ...optionalParams);
    } else {
      console.log(prefix, message, ...optionalParams);
    }
  }
}
