import type { ParsedCronExpression } from "../interfaces/scheduler.interface";

export class CronExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronExpressionError";
  }
}

const CRON_PRESETS: Readonly<Record<string, string>> = {
  "@yearly": "0 0 0 1 1 *",
  "@annually": "0 0 0 1 1 *",
  "@monthly": "0 0 0 1 * *",
  "@weekly": "0 0 0 * * 0",
  "@daily": "0 0 0 * * *",
  "@midnight": "0 0 0 * * *",
  "@hourly": "0 0 * * * *",
  "@every_minute": "0 * * * * *",
  "@every_second": "* * * * * *",
};

const MONTH_NAMES: Readonly<Record<string, number>> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const DAY_NAMES: Readonly<Record<string, number>> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

interface FieldSpec {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly names?: Readonly<Record<string, number>>;
  readonly allowSevenAsZero?: boolean;
}

function parseAtom(raw: string, spec: FieldSpec): number {
  const upper = raw.trim().toUpperCase();
  if (upper.length === 0) {
    throw new CronExpressionError(
      `Invalid cron ${spec.label} value "${raw}": empty token.`,
    );
  }

  if (spec.names && Object.hasOwn(spec.names, upper)) {
    return spec.names[upper]!;
  }

  if (!/^\d+$/.test(upper)) {
    throw new CronExpressionError(
      `Invalid cron ${spec.label} value "${raw}".`,
    );
  }

  const num = Number.parseInt(upper, 10);
  const maxAllowed = spec.allowSevenAsZero ? 7 : spec.max;
  if (num < spec.min || num > maxAllowed) {
    throw new CronExpressionError(
      `Cron ${spec.label} value ${num} is out of range (${spec.min}-${spec.max}).`,
    );
  }
  return num;
}

function parseField(rawField: string, spec: FieldSpec): {
  values: number[];
  isWildcard: boolean;
} {
  const trimmed = rawField.trim();
  if (trimmed.length === 0) {
    throw new CronExpressionError(`Empty cron ${spec.label} field.`);
  }

  const isWildcard = trimmed === "*";
  const resultSet = new Set<number>();

  const parts = trimmed.split(",");
  for (const part of parts) {
    if (part.trim().length === 0) {
      throw new CronExpressionError(
        `Invalid cron ${spec.label} field "${rawField}": empty list entry.`,
      );
    }

    const slashSegments = part.split("/");
    if (slashSegments.length > 2) {
      throw new CronExpressionError(
        `Invalid cron ${spec.label} segment "${part}": too many "/" step separators.`,
      );
    }

    const rangePart = slashSegments[0]!.trim();
    let step = 1;
    if (slashSegments.length === 2) {
      const stepStr = slashSegments[1]!.trim();
      if (!/^\d+$/.test(stepStr)) {
        throw new CronExpressionError(
          `Invalid cron ${spec.label} step "${stepStr}" in "${part}".`,
        );
      }
      step = Number.parseInt(stepStr, 10);
      if (step <= 0) {
        throw new CronExpressionError(
          `Cron ${spec.label} step must be a positive integer in "${part}".`,
        );
      }
    }

    const candidates: number[] = [];

    if (rangePart === "*") {
      for (let v = spec.min; v <= spec.max; v += 1) {
        candidates.push(v);
      }
    } else if (rangePart.includes("-")) {
      const bounds = rangePart.split("-");
      if (bounds.length !== 2) {
        throw new CronExpressionError(
          `Invalid cron ${spec.label} range "${rangePart}".`,
        );
      }
      const start = parseAtom(bounds[0]!, spec);
      const end = parseAtom(bounds[1]!, spec);

      if (start <= end) {
        for (let v = start; v <= end; v += 1) {
          candidates.push(v);
        }
      } else {
        // Wrap-around range (e.g. 22-2 for hours, FRI-MON for days of week)
        const wrapStart = spec.allowSevenAsZero && start === 7 ? 0 : start;
        const wrapEnd = spec.allowSevenAsZero && end === 7 ? 0 : end;
        for (let v = wrapStart; v <= spec.max; v += 1) {
          candidates.push(v);
        }
        for (let v = spec.min; v <= wrapEnd; v += 1) {
          candidates.push(v);
        }
      }
    } else {
      const single = parseAtom(rangePart, spec);
      if (slashSegments.length === 2) {
        const start = spec.allowSevenAsZero && single === 7 ? 0 : single;
        for (let v = start; v <= spec.max; v += 1) {
          candidates.push(v);
        }
      } else {
        candidates.push(single);
      }
    }

    for (let idx = 0; idx < candidates.length; idx += step) {
      const val = candidates[idx]!;
      resultSet.add(spec.allowSevenAsZero && val === 7 ? 0 : val);
    }
  }

  const values = [...resultSet].sort((a, b) => a - b);
  if (values.length === 0) {
    throw new CronExpressionError(
      `Cron ${spec.label} field "${rawField}" matched zero values.`,
    );
  }

  return { values, isWildcard };
}

/**
 * Validates and parses a 5-field (`min hour dom month dow`) or 6-field
 * (`sec min hour dom month dow`) cron expression, including `@` presets,
 * steps, ranges, wrap-around ranges, comma lists, and named months/weekdays.
 */
export function parseCronExpression(expression: string): ParsedCronExpression {
  const trimmed = expression.trim();
  if (trimmed.length === 0) {
    throw new CronExpressionError("Cron expression cannot be empty.");
  }

  const preset = CRON_PRESETS[trimmed.toLowerCase()];
  const normalized = preset ?? trimmed;
  const parts = normalized.split(/\s+/);

  if (parts.length !== 5 && parts.length !== 6) {
    throw new CronExpressionError(
      `Invalid cron expression "${expression}": expected 5 or 6 fields, received ${parts.length}.`,
    );
  }

  const hasSeconds = parts.length === 6;
  const [secRaw, minRaw, hourRaw, domRaw, monthRaw, dowRaw] = hasSeconds
    ? [parts[0]!, parts[1]!, parts[2]!, parts[3]!, parts[4]!, parts[5]!]
    : ["0", parts[0]!, parts[1]!, parts[2]!, parts[3]!, parts[4]!];

  const seconds = parseField(secRaw, { label: "second", min: 0, max: 59 });
  const minutes = parseField(minRaw, { label: "minute", min: 0, max: 59 });
  const hours = parseField(hourRaw, { label: "hour", min: 0, max: 23 });
  const daysOfMonth = parseField(domRaw, {
    label: "day-of-month",
    min: 1,
    max: 31,
  });
  const months = parseField(monthRaw, {
    label: "month",
    min: 1,
    max: 12,
    names: MONTH_NAMES,
  });
  const daysOfWeek = parseField(dowRaw, {
    label: "day-of-week",
    min: 0,
    max: 6,
    names: DAY_NAMES,
    allowSevenAsZero: true,
  });

  return {
    expression: trimmed,
    hasSeconds,
    seconds: seconds.values,
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: daysOfMonth.values,
    months: months.values,
    daysOfWeek: daysOfWeek.values,
    dayOfMonthWildcard: daysOfMonth.isWildcard,
    dayOfWeekWildcard: daysOfWeek.isWildcard,
  };
}

export function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new CronExpressionError(`Invalid IANA timeZone "${timeZone}".`);
  }
}

/**
 * Validates and converts a `utcOffset` value into total offset minutes.
 * Matches `cron` / Luxon convention: values with `|utcOffset| < 16` are
 * treated as hours (e.g. `-5` -> `-300` min), larger magnitudes as minutes
 * (e.g. `330` -> `+5:30`).
 */
export function validateUtcOffset(utcOffset: number): number {
  if (typeof utcOffset !== "number" || !Number.isFinite(utcOffset)) {
    throw new CronExpressionError(
      `Invalid utcOffset "${String(utcOffset)}": must be a finite number.`,
    );
  }
  const offsetMinutes = Math.abs(utcOffset) < 16 ? utcOffset * 60 : utcOffset;
  if (offsetMinutes < -14 * 60 || offsetMinutes > 14 * 60) {
    throw new CronExpressionError(
      `utcOffset ${utcOffset} is out of valid range (-14h to +14h / -840m to +840m).`,
    );
  }
  return Math.trunc(offsetMinutes);
}

interface WallClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number;
}

const WEEKDAY_MAP: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getTimeZoneParts(
  date: Date,
  formatter: Intl.DateTimeFormat,
): WallClockParts {
  const parts = formatter.formatToParts(date);
  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let dayOfWeek = 0;

  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = Number.parseInt(part.value, 10);
        break;
      case "month":
        month = Number.parseInt(part.value, 10);
        break;
      case "day":
        day = Number.parseInt(part.value, 10);
        break;
      case "hour":
        hour = Number.parseInt(part.value, 10) % 24;
        break;
      case "minute":
        minute = Number.parseInt(part.value, 10);
        break;
      case "second":
        second = Number.parseInt(part.value, 10);
        break;
      case "weekday":
        dayOfWeek = WEEKDAY_MAP[part.value] ?? 0;
        break;
    }
  }

  return { year, month, day, hour, minute, second, dayOfWeek };
}

function matchesDay(
  parsed: ParsedCronExpression,
  dayOfMonth: number,
  dayOfWeek: number,
): boolean {
  const domMatch = parsed.daysOfMonth.includes(dayOfMonth);
  const dowMatch = parsed.daysOfWeek.includes(dayOfWeek);

  if (!parsed.dayOfMonthWildcard && !parsed.dayOfWeekWildcard) {
    // Standard Vixie cron OR semantics when both day-of-month and day-of-week are restricted
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

function findNextInSorted(values: readonly number[], current: number): number | undefined {
  for (const v of values) {
    if (v >= current) {
      return v;
    }
  }
  return undefined;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Computes the next `Date` strictly after `fromDate` that matches the given
 * cron expression (optionally evaluated in an IANA `timeZone` or fixed `utcOffset`).
 */
export function getNextCronDate(
  expressionOrParsed: string | ParsedCronExpression,
  fromDate: Date = new Date(),
  timeZone?: string,
  utcOffset?: number,
): Date {
  const parsed =
    typeof expressionOrParsed === "string"
      ? parseCronExpression(expressionOrParsed)
      : expressionOrParsed;

  if (timeZone !== undefined && utcOffset !== undefined) {
    throw new CronExpressionError(
      'Cannot specify both "timeZone" and "utcOffset" when computing next cron date.',
    );
  }

  if (utcOffset !== undefined) {
    const offsetMinutes = validateUtcOffset(utcOffset);
    return getNextCronDateWithUtcOffset(parsed, fromDate, offsetMinutes);
  }

  if (timeZone !== undefined) {
    validateTimeZone(timeZone);
    return getNextCronDateInTimeZone(parsed, fromDate, timeZone);
  }

  const maxYear = fromDate.getFullYear() + 8;
  const cursor = new Date(fromDate.getTime());
  cursor.setMilliseconds(0);
  cursor.setSeconds(cursor.getSeconds() + 1);

  while (cursor.getFullYear() <= maxYear) {
    const month = cursor.getMonth() + 1;
    if (!parsed.months.includes(month)) {
      const nextMonth = findNextInSorted(parsed.months, month + 1);
      if (nextMonth !== undefined) {
        cursor.setMonth(nextMonth - 1, 1);
      } else {
        cursor.setFullYear(cursor.getFullYear() + 1, parsed.months[0]! - 1, 1);
      }
      cursor.setHours(0, 0, 0, 0);
      continue;
    }

    const dom = cursor.getDate();
    const dow = cursor.getDay();
    if (!matchesDay(parsed, dom, dow)) {
      cursor.setDate(dom + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }

    const hour = cursor.getHours();
    if (!parsed.hours.includes(hour)) {
      const nextHour = findNextInSorted(parsed.hours, hour + 1);
      if (nextHour !== undefined) {
        cursor.setHours(nextHour, 0, 0, 0);
      } else {
        cursor.setDate(dom + 1);
        cursor.setHours(0, 0, 0, 0);
      }
      continue;
    }

    const minute = cursor.getMinutes();
    if (!parsed.minutes.includes(minute)) {
      const nextMinute = findNextInSorted(parsed.minutes, minute + 1);
      if (nextMinute !== undefined) {
        cursor.setMinutes(nextMinute, 0, 0);
      } else {
        cursor.setHours(hour + 1, 0, 0, 0);
      }
      continue;
    }

    const second = cursor.getSeconds();
    if (!parsed.seconds.includes(second)) {
      const nextSecond = findNextInSorted(parsed.seconds, second + 1);
      if (nextSecond !== undefined) {
        cursor.setSeconds(nextSecond, 0);
      } else {
        cursor.setMinutes(minute + 1, 0, 0);
      }
      continue;
    }

    return cursor;
  }

  throw new CronExpressionError(
    `Cron expression "${parsed.expression}" has no matching date within 8 years.`,
  );
}

function getNextCronDateWithUtcOffset(
  parsed: ParsedCronExpression,
  fromDate: Date,
  offsetMinutes: number,
): Date {
  const offsetMs = offsetMinutes * 60_000;
  const shifted = new Date(fromDate.getTime() + offsetMs);
  const maxYear = shifted.getUTCFullYear() + 8;

  const cursor = new Date(shifted.getTime());
  cursor.setUTCMilliseconds(0);
  cursor.setUTCSeconds(cursor.getUTCSeconds() + 1);

  while (cursor.getUTCFullYear() <= maxYear) {
    const month = cursor.getUTCMonth() + 1;
    if (!parsed.months.includes(month)) {
      const nextMonth = findNextInSorted(parsed.months, month + 1);
      if (nextMonth !== undefined) {
        cursor.setUTCMonth(nextMonth - 1, 1);
      } else {
        cursor.setUTCFullYear(
          cursor.getUTCFullYear() + 1,
          parsed.months[0]! - 1,
          1,
        );
      }
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }

    const dom = cursor.getUTCDate();
    const dow = cursor.getUTCDay();
    if (!matchesDay(parsed, dom, dow)) {
      cursor.setUTCDate(dom + 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }

    const hour = cursor.getUTCHours();
    if (!parsed.hours.includes(hour)) {
      const nextHour = findNextInSorted(parsed.hours, hour + 1);
      if (nextHour !== undefined) {
        cursor.setUTCHours(nextHour, 0, 0, 0);
      } else {
        cursor.setUTCDate(dom + 1);
        cursor.setUTCHours(0, 0, 0, 0);
      }
      continue;
    }

    const minute = cursor.getUTCMinutes();
    if (!parsed.minutes.includes(minute)) {
      const nextMinute = findNextInSorted(parsed.minutes, minute + 1);
      if (nextMinute !== undefined) {
        cursor.setUTCMinutes(nextMinute, 0, 0);
      } else {
        cursor.setUTCHours(hour + 1, 0, 0, 0);
      }
      continue;
    }

    const second = cursor.getUTCSeconds();
    if (!parsed.seconds.includes(second)) {
      const nextSecond = findNextInSorted(parsed.seconds, second + 1);
      if (nextSecond !== undefined) {
        cursor.setUTCSeconds(nextSecond, 0);
      } else {
        cursor.setUTCMinutes(minute + 1, 0, 0);
      }
      continue;
    }

    return new Date(cursor.getTime() - offsetMs);
  }

  throw new CronExpressionError(
    `Cron expression "${parsed.expression}" has no matching date within 8 years at utcOffset ${offsetMinutes}m.`,
  );
}

function advanceToNextDayMidnight(
  epochMs: number,
  parts: WallClockParts,
  formatter: Intl.DateTimeFormat,
): number {
  const deltaSec =
    86400 - parts.hour * 3600 - parts.minute * 60 - parts.second;
  let nextMs = epochMs + Math.max(deltaSec, 3600) * 1000;
  let check = getTimeZoneParts(new Date(nextMs), formatter);

  // Guard against 25-hour DST fall-back days where +86400s lands at 23:00 of the same day
  while (check.day === parts.day && check.month === parts.month) {
    const remainSec =
      (24 - check.hour) * 3600 - check.minute * 60 - check.second;
    nextMs += Math.max(remainSec, 3600) * 1000;
    check = getTimeZoneParts(new Date(nextMs), formatter);
  }

  // Align back to 00:00 on 23-hour DST spring-forward days only if it stays on the new day
  if (check.hour > 0 && check.hour <= 3) {
    const candidate =
      nextMs - (check.hour * 3600 + check.minute * 60 + check.second) * 1000;
    const backCheck = getTimeZoneParts(new Date(candidate), formatter);
    if (backCheck.day === check.day && backCheck.month === check.month) {
      nextMs = candidate;
    }
  }

  return nextMs;
}

function getNextCronDateInTimeZone(
  parsed: ParsedCronExpression,
  fromDate: Date,
  timeZone: string,
): Date {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });

  // Start strictly 1 second after fromDate
  let epochMs = Math.floor(fromDate.getTime() / 1000) * 1000 + 1000;
  const maxEpochMs = epochMs + 8 * 366 * 24 * 60 * 60 * 1000;
  const maxIterations = 250_000;

  for (let i = 0; i < maxIterations && epochMs <= maxEpochMs; i += 1) {
    const parts = getTimeZoneParts(new Date(epochMs), formatter);

    if (!parsed.months.includes(parts.month)) {
      const remDays = daysInMonth(parts.year, parts.month) - parts.day + 1;
      const prevMonth = parts.month;
      epochMs +=
        (remDays * 86400 -
          parts.hour * 3600 -
          parts.minute * 60 -
          parts.second) *
        1000;
      let check = getTimeZoneParts(new Date(epochMs), formatter);
      while (check.month === prevMonth) {
        epochMs += 3600 * 1000;
        check = getTimeZoneParts(new Date(epochMs), formatter);
      }
      if (check.hour > 0 && check.hour <= 3) {
        const candidate =
          epochMs - (check.hour * 3600 + check.minute * 60 + check.second) * 1000;
        const backCheck = getTimeZoneParts(new Date(candidate), formatter);
        if (backCheck.month === check.month && backCheck.day === check.day) {
          epochMs = candidate;
        }
      }
      continue;
    }

    if (!matchesDay(parsed, parts.day, parts.dayOfWeek)) {
      epochMs = advanceToNextDayMidnight(epochMs, parts, formatter);
      continue;
    }

    if (!parsed.hours.includes(parts.hour)) {
      const nextHour = findNextInSorted(parsed.hours, parts.hour + 1);
      if (nextHour === undefined) {
        epochMs = advanceToNextDayMidnight(epochMs, parts, formatter);
        continue;
      }

      const deltaSec =
        (nextHour - parts.hour) * 3600 - parts.minute * 60 - parts.second;
      let targetMs = epochMs + Math.max(deltaSec, 60) * 1000;
      const after = getTimeZoneParts(new Date(targetMs), formatter);

      // Guard against DST spring-forward overshoot (e.g., jumping across 02:00->03:00 overshoots 04:00 to 05:00)
      const sameDay = after.day === parts.day && after.month === parts.month;
      if (
        !sameDay ||
        after.hour > nextHour ||
        (after.hour === nextHour && (after.minute > 0 || after.second > 0))
      ) {
        const effectiveAfterHour = sameDay ? after.hour : after.hour + 24;
        const overshootSec =
          (effectiveAfterHour - nextHour) * 3600 +
          after.minute * 60 +
          after.second;
        const candidate = targetMs - overshootSec * 1000;
        if (candidate > epochMs) {
          const backParts = getTimeZoneParts(new Date(candidate), formatter);
          const backSameDay =
            backParts.day === parts.day && backParts.month === parts.month;
          if (backSameDay && backParts.hour >= nextHour) {
            targetMs = candidate;
          }
        }
      }

      epochMs = targetMs;
      continue;
    }

    if (!parsed.minutes.includes(parts.minute)) {
      const nextMin = findNextInSorted(parsed.minutes, parts.minute + 1);
      const deltaSec =
        nextMin !== undefined
          ? (nextMin - parts.minute) * 60 - parts.second
          : (60 - parts.minute) * 60 - parts.second;
      epochMs += Math.max(deltaSec, 1) * 1000;
      continue;
    }

    if (!parsed.seconds.includes(parts.second)) {
      const nextSec = findNextInSorted(parsed.seconds, parts.second + 1);
      const deltaSec =
        nextSec !== undefined ? nextSec - parts.second : 60 - parts.second;
      epochMs += Math.max(deltaSec, 1) * 1000;
      continue;
    }

    return new Date(epochMs);
  }

  throw new CronExpressionError(
    `Cron expression "${parsed.expression}" has no matching date within 8 years in timeZone "${timeZone}".`,
  );
}
