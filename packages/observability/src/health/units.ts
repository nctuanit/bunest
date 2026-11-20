export const DurationUnit = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const;

export const SizeUnit = {
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
} as const;

/**
 * Milliseconds, or a string such as `'300ms'`, `'2s'` or `'15m'`
 * (units: `ms`, `s`, `m`, `h`, `d`, `w`).
 */
export type Duration = number | `${number}${keyof typeof DurationUnit}`;

/**
 * Bytes, or a string such as `'512kb'`, `'150mb'` or `'2gb'`
 * (units: `kb`, `mb`, `gb`, `tb`; 1 mb is 1024 × 1024 bytes).
 */
export type ByteSize = number | `${number}${keyof typeof SizeUnit}`;

const UNIT_STRING = /^(\d+(?:\.\d+)?)([a-z]+)$/;

/**
 * Converts a `Duration` (number of ms or unit string like `'2s'`) into milliseconds.
 */
export function toMs(duration: Duration, name = "Duration"): number {
  if (typeof duration === "number") {
    return duration;
  }
  const match = UNIT_STRING.exec(duration);
  const amount = match?.[1];
  const unit = match?.[2];
  if (!unit || !Object.prototype.hasOwnProperty.call(DurationUnit, unit)) {
    throw new Error(
      `${name}: Invalid duration "${duration}". Use milliseconds or a string such as "300ms", "2s" or "15m".`,
    );
  }
  return Math.round(
    Number(amount) * DurationUnit[unit as keyof typeof DurationUnit],
  );
}

/**
 * Converts a `ByteSize` (number of bytes or unit string like `'150mb'`) into bytes.
 */
export function toBytes(size: ByteSize, name = "Size"): number {
  if (typeof size === "number") {
    return size;
  }
  const match = UNIT_STRING.exec(size);
  const amount = match?.[1];
  const unit = match?.[2];
  if (!unit || !Object.prototype.hasOwnProperty.call(SizeUnit, unit)) {
    throw new Error(
      `${name}: Invalid size "${size}". Use bytes or a string such as "512kb", "150mb" or "2gb".`,
    );
  }
  return Math.floor(Number(amount) * SizeUnit[unit as keyof typeof SizeUnit]);
}

/**
 * Thrown when a health indicator or attempt exceeds its configured timeout.
 */
export class TimeoutError extends Error {
  public readonly timeoutMs?: number;

  constructor(timeoutMsOrMessage?: number | string, options?: ErrorOptions) {
    const message =
      typeof timeoutMsOrMessage === "number"
        ? `timeout of ${timeoutMsOrMessage}ms exceeded`
        : (timeoutMsOrMessage ?? "Health check timed out");
    super(message, options);
    this.name = "TimeoutError";
    if (typeof timeoutMsOrMessage === "number") {
      this.timeoutMs = timeoutMsOrMessage;
    }
  }
}

/**
 * Error retaining HTTP response status metadata for Fetch/HTTP health indicators.
 */
export class ResponseStatusError extends Error {
  public readonly statusCode: number;
  public readonly statusText?: string;

  constructor(message: string, statusCode: number, statusText?: string) {
    super(message);
    this.name = "ResponseStatusError";
    this.statusCode = statusCode;
    this.statusText = statusText;
  }
}

/**
 * Error thrown by `GRPCHealthIndicator` when a service responds with a non-SERVING status.
 */
export class NotServingError extends Error {
  public readonly statusCode: number;
  public readonly servingStatus: string | number;

  constructor(statusCode: number, servingStatus: string | number) {
    super(`The service is not serving (status: ${String(servingStatus)})`);
    this.name = "NotServingError";
    this.statusCode = statusCode;
    this.servingStatus = servingStatus;
  }
}

/**
 * Formats an unknown error value into a concise message string.
 */
export function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}
