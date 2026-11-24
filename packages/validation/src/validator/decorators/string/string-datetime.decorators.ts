import type { ValidationOptions } from "../../interfaces/validation-options.interface";
import { buildMessage, createBuiltInDecorator } from "../core.decorators";

export const IS_ISO8601 = "isIso8601";
export const IS_DATE_STRING = "isDateString";
export const IS_RFC_3339 = "isRFC3339";
export const IS_RFC3339 = IS_RFC_3339;
export const IS_MILITARY_TIME = "isMilitaryTime";

export interface IsISO8601Options {
  strict?: boolean;
  strictSeparator?: boolean;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]!;
  return day <= maxDay;
}

const ISO8601_RE =
  /^([+-]?\d{4})(?:-?(\d{2})(?:-?(\d{2}))?)?(?:([T ])(\d{2}):?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

const ISO8601_STRICT_SEP_RE =
  /^([+-]?\d{4})(?:-?(\d{2})(?:-?(\d{2}))?)?(?:(T)(\d{2}):?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

export function isISO8601(
  value: unknown,
  options: IsISO8601Options = {},
): boolean {
  if (typeof value !== "string" || value.length < 4 || value.length > 64) {
    return false;
  }
  const re = options.strictSeparator ? ISO8601_STRICT_SEP_RE : ISO8601_RE;
  const match = re.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const monthStr = match[2];
  const dayStr = match[3];

  if (monthStr !== undefined) {
    const month = Number(monthStr);
    if (month < 1 || month > 12) return false;
    if (dayStr !== undefined) {
      const day = Number(dayStr);
      if (options.strict) {
        if (!isValidCalendarDate(year, month, day)) return false;
      } else if (day < 1 || day > 31) {
        return false;
      }
    }
  }

  if (match[5] !== undefined) {
    if (dayStr === undefined) return false;
    const hour = Number(match[5]);
    const min = Number(match[6]);
    const sec = match[7] !== undefined ? Number(match[7]) : 0;
    if (hour > 23 || min > 59 || sec > 60) return false;
    const tz = match[9];
    if (tz && tz !== "Z") {
      const tzH = Number(tz.slice(1, 3));
      const tzM = tz.length >= 5 ? Number(tz.slice(tz.length - 2)) : 0;
      if (tzH > 23 || tzM > 59) return false;
    }
  }

  return true;
}

export function IsISO8601(
  options?: IsISO8601Options,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_ISO8601,
    (value) => isISO8601(value, options),
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must be a valid ISO 8601 date string`,
      validationOptions,
    ),
    [options],
    validationOptions,
  );
}

export function isDateString(
  value: unknown,
  options?: IsISO8601Options,
): boolean {
  return isISO8601(value, options);
}

export function IsDateString(
  options?: IsISO8601Options,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_DATE_STRING,
    (value) => isDateString(value, options),
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must be a valid ISO 8601 date string`,
      validationOptions,
    ),
    [options],
    validationOptions,
  );
}

const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T t](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

export function isRFC3339(value: unknown): boolean {
  if (typeof value !== "string" || value.length < 20 || value.length > 64) {
    return false;
  }
  const m = RFC3339_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const min = Number(m[5]);
  const sec = Number(m[6]);
  if (!isValidCalendarDate(year, month, day)) return false;
  if (hour > 23 || min > 59 || sec > 60) return false;
  if (m[7] !== undefined) {
    const tzH = Number(m[7]);
    const tzM = Number(m[8]);
    if (tzH > 23 || tzM > 59) return false;
  }
  return true;
}

export function IsRFC3339(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_RFC_3339,
    isRFC3339,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be RFC 3339 date`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

const MILITARY_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function isMilitaryTime(value: unknown): boolean {
  return typeof value === "string" && MILITARY_TIME_RE.test(value);
}

export function IsMilitaryTime(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_MILITARY_TIME,
    isMilitaryTime,
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must be a valid representation of military time in the format HH:MM`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}
