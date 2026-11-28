import { MetadataRegistry } from "@bunest/core";
import {
  CRON_METADATA,
  INTERVAL_METADATA,
  OS_CRON_METADATA,
  TIMEOUT_METADATA,
} from "../constants";
import type {
  CronMetadata,
  CronOptions,
  CronTime,
  IntervalMetadata,
  IntervalOptions,
  OsCronMetadata,
  OsCronOptions,
  TimeoutMetadata,
  TimeoutOptions,
} from "../interfaces/scheduler.interface";

/**
 * Schedules a method to run on a 5-field or 6-field cron expression (or preset)
 * or once at a specific `Date`.
 * Copy-on-write: never mutates parent class metadata.
 */
export function Cron(
  cronTime: CronTime,
  options: CronOptions = {},
): MethodDecorator {
  const normalizedCronTime: CronTime =
    cronTime instanceof Date ? new Date(cronTime.getTime()) : cronTime;

  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const entry: CronMetadata = {
      expression: normalizedCronTime,
      methodName: propertyKey,
      options: { ...options },
    };
    MetadataRegistry.prependOwnArray<CronMetadata>(
      CRON_METADATA,
      [entry],
      target.constructor,
    );
    return descriptor;
  };
}

/**
 * Schedules a method to run repeatedly every `timeoutMs` milliseconds.
 */
export function Interval(
  timeoutMs: number,
  options?: Omit<IntervalOptions, "name">,
): MethodDecorator;
export function Interval(
  name: string,
  timeoutMs: number,
  options?: Omit<IntervalOptions, "name">,
): MethodDecorator;
export function Interval(
  nameOrMs: string | number,
  msOrOptions?: number | Omit<IntervalOptions, "name">,
  maybeOptions?: Omit<IntervalOptions, "name">,
): MethodDecorator {
  const isNamed = typeof nameOrMs === "string";
  const timeoutMs = isNamed ? (msOrOptions as number) : nameOrMs;
  const extraOpts = isNamed
    ? maybeOptions
    : (msOrOptions as Omit<IntervalOptions, "name"> | undefined);

  if (
    typeof timeoutMs !== "number" ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0
  ) {
    throw new Error(
      `@Interval() requires a non-negative finite millisecond interval, received ${String(timeoutMs)}.`,
    );
  }

  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const entry: IntervalMetadata = {
      timeoutMs,
      methodName: propertyKey,
      options: {
        ...extraOpts,
        ...(isNamed ? { name: nameOrMs } : {}),
      },
    };
    MetadataRegistry.prependOwnArray<IntervalMetadata>(
      INTERVAL_METADATA,
      [entry],
      target.constructor,
    );
    return descriptor;
  };
}

/**
 * Schedules a method to run once after `timeoutMs` milliseconds.
 */
export function Timeout(
  timeoutMs: number,
  options?: Omit<TimeoutOptions, "name">,
): MethodDecorator;
export function Timeout(
  name: string,
  timeoutMs: number,
  options?: Omit<TimeoutOptions, "name">,
): MethodDecorator;
export function Timeout(
  nameOrMs: string | number,
  msOrOptions?: number | Omit<TimeoutOptions, "name">,
  maybeOptions?: Omit<TimeoutOptions, "name">,
): MethodDecorator {
  const isNamed = typeof nameOrMs === "string";
  const timeoutMs = isNamed ? (msOrOptions as number) : nameOrMs;
  const extraOpts = isNamed
    ? maybeOptions
    : (msOrOptions as Omit<TimeoutOptions, "name"> | undefined);

  if (
    typeof timeoutMs !== "number" ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0
  ) {
    throw new Error(
      `@Timeout() requires a non-negative finite millisecond delay, received ${String(timeoutMs)}.`,
    );
  }

  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const entry: TimeoutMetadata = {
      timeoutMs,
      methodName: propertyKey,
      options: {
        ...extraOpts,
        ...(isNamed ? { name: nameOrMs } : {}),
      },
    };
    MetadataRegistry.prependOwnArray<TimeoutMetadata>(
      TIMEOUT_METADATA,
      [entry],
      target.constructor,
    );
    return descriptor;
  };
}

function readMergedMethodMetadata<
  T extends { readonly methodName: string | symbol },
>(key: symbol, target: Function): T[] {
  const chain = MetadataRegistry.getPrototypeChain(target);
  const orderedMethods: Array<string | symbol> = [];
  const byMethod = new Map<string | symbol, T[]>();

  for (const ctor of chain) {
    const own = MetadataRegistry.getOwn<readonly T[]>(key, ctor);
    if (!own || own.length === 0) {
      continue;
    }

    const groupedOwn = new Map<string | symbol, T[]>();
    for (const item of own) {
      let list = groupedOwn.get(item.methodName);
      if (!list) {
        list = [];
        groupedOwn.set(item.methodName, list);
      }
      list.push(item);
    }

    for (const [methodName, entries] of groupedOwn.entries()) {
      if (!byMethod.has(methodName)) {
        orderedMethods.push(methodName);
      }
      byMethod.set(methodName, entries);
    }
  }

  const out: T[] = [];
  for (const methodName of orderedMethods) {
    const entries = byMethod.get(methodName);
    if (entries) {
      out.push(...entries);
    }
  }
  return out;
}

/**
 * Declares an OS-level cron handler (`Bun.cron(path, schedule, title)`) on a
 * provider method so `OsCronService.discoverDecoratedJobs()` and
 * `bootstrapCronApplication(AppModule, { osCronTitle })` can discover and
 * invoke it cleanly.
 */
export function OsCron(
  schedule: string,
  options: OsCronOptions = {},
): MethodDecorator {
  if (
    options.title !== undefined &&
    !/^[A-Za-z0-9_-]+$/.test(options.title.trim())
  ) {
    throw new Error(
      `@OsCron() title "${options.title}" must contain only alphanumeric characters, hyphens, and underscores (/^[A-Za-z0-9_-]+$/).`,
    );
  }

  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const entry: OsCronMetadata = {
      schedule,
      methodName: propertyKey,
      options: { ...options },
    };
    MetadataRegistry.prependOwnArray<OsCronMetadata>(
      OS_CRON_METADATA,
      [entry],
      target.constructor,
    );
    return descriptor;
  };
}

export function getCronMetadata(target: Function): CronMetadata[] {
  return readMergedMethodMetadata<CronMetadata>(CRON_METADATA, target);
}

export function getIntervalMetadata(target: Function): IntervalMetadata[] {
  return readMergedMethodMetadata<IntervalMetadata>(INTERVAL_METADATA, target);
}

export function getTimeoutMetadata(target: Function): TimeoutMetadata[] {
  return readMergedMethodMetadata<TimeoutMetadata>(TIMEOUT_METADATA, target);
}

export function getOsCronMetadata(target: Function): OsCronMetadata[] {
  return readMergedMethodMetadata<OsCronMetadata>(OS_CRON_METADATA, target);
}
