export type LogLevel = "fatal" | "error" | "warn" | "log" | "debug" | "verbose";

export interface LoggerService {
  log(message: unknown, ...optionalParams: unknown[]): void;
  error(message: unknown, ...optionalParams: unknown[]): void;
  warn(message: unknown, ...optionalParams: unknown[]): void;
  debug?(message: unknown, ...optionalParams: unknown[]): void;
  verbose?(message: unknown, ...optionalParams: unknown[]): void;
  fatal?(message: unknown, ...optionalParams: unknown[]): void;
  setLogLevels?(levels: LogLevel[]): void;
}
