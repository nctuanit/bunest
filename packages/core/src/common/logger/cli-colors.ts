import type { LogLevel } from "./logger.interface";

export type ColorTextFn = (text: string) => string;

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  day: "2-digit",
  month: "2-digit",
});

/**
 * Formats a timestamp identically to NestJS `ConsoleLogger`
 * (e.g. `11/23/2026, 11:02:10 AM`).
 */
export function formatNestTimestamp(date: Date | number = Date.now()): string {
  return dateTimeFormatter.format(date);
}

/**
 * Checks whether ANSI terminal colors are allowed by environment variables
 * (`NO_COLOR` and `FORCE_COLOR`), matching NestJS's `isColorAllowed()` convention.
 */
export function isColorAllowed(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    return false;
  }
  if (process.env.FORCE_COLOR === "0") {
    return false;
  }
  return true;
}

/**
 * Zero-dependency NestJS-compatible ANSI terminal color helpers.
 */
export const clc = {
  bold: (text: string): string => `\x1b[1m${text}\x1b[0m`,
  green: (text: string): string => `\x1b[32m${text}\x1b[39m`,
  yellow: (text: string): string => `\x1b[33m${text}\x1b[39m`,
  red: (text: string): string => `\x1b[31m${text}\x1b[39m`,
  boldRed: (text: string): string => `\x1b[1m\x1b[31m${text}\x1b[0m`,
  magentaBright: (text: string): string => `\x1b[95m${text}\x1b[39m`,
  cyanBright: (text: string): string => `\x1b[96m${text}\x1b[39m`,
} as const;

/**
 * NestJS log level color mapping:
 * - `fatal`   -> bold red
 * - `error`   -> red
 * - `warn`    -> yellow
 * - `log`     -> green
 * - `debug`   -> bright magenta
 * - `verbose` -> bright cyan
 */
export const LOG_LEVEL_COLORS: Readonly<Record<LogLevel, ColorTextFn>> = {
  fatal: clc.boldRed,
  error: clc.red,
  warn: clc.yellow,
  log: clc.green,
  debug: clc.magentaBright,
  verbose: clc.cyanBright,
};
