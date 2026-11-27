import type {
  GroupConcurrencyOptions,
  QueueRateLimiterOptions,
} from "./interfaces";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface NormalizedGroupConcurrency {
  readonly maxPerGroup: number;
  readonly overrides: Readonly<Record<string, number>>;
}

export interface NormalizedRateLimiter {
  readonly max: number;
  readonly durationMs: number;
}

/**
 * Validates and normalizes `groupConcurrency` (`number` or `{ maxPerGroup, overrides }`).
 */
export function normalizeGroupConcurrency(
  input: GroupConcurrencyOptions | undefined,
): NormalizedGroupConcurrency | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 1) {
      throw new RangeError(
        `Queue groupConcurrency must be a positive finite number >= 1, received ${String(input)}.`,
      );
    }
    return {
      maxPerGroup: Math.floor(input),
      overrides: Object.freeze({}),
    };
  }

  if (
    typeof input !== "object" ||
    input === null ||
    !Number.isFinite(input.maxPerGroup) ||
    input.maxPerGroup < 1
  ) {
    throw new RangeError(
      `Queue groupConcurrency.maxPerGroup must be a positive finite number >= 1, received ${String((input as { maxPerGroup?: unknown } | null)?.maxPerGroup)}.`,
    );
  }

  const overrides: Record<string, number> = Object.create(null);
  if (input.overrides) {
    for (const [group, limit] of Object.entries(input.overrides)) {
      if (!group || DANGEROUS_KEYS.has(group)) {
        continue;
      }
      if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
        throw new RangeError(
          `Queue groupConcurrency.overrides["${group}"] must be a positive finite number >= 1, received ${String(limit)}.`,
        );
      }
      overrides[group] = Math.floor(limit);
    }
  }

  return {
    maxPerGroup: Math.floor(input.maxPerGroup),
    overrides: Object.freeze(overrides),
  };
}

/**
 * Resolves the active job cap for `groupId` using prototype-safe lookup.
 */
export function resolveGroupCap(
  policy: NormalizedGroupConcurrency,
  groupId: string,
): number {
  if (
    !DANGEROUS_KEYS.has(groupId) &&
    Object.prototype.hasOwnProperty.call(policy.overrides, groupId)
  ) {
    return policy.overrides[groupId]!;
  }
  return policy.maxPerGroup;
}

/**
 * Validates and normalizes `limiter` (`{ max, durationMs }` or BullMQ `{ max, duration }`).
 */
export function normalizeRateLimiter(
  input: QueueRateLimiterOptions | undefined,
): NormalizedRateLimiter | undefined {
  if (input === undefined) {
    return undefined;
  }

  const max = input.max;
  const durationMs = input.durationMs ?? input.duration;

  if (typeof max !== "number" || !Number.isFinite(max) || max < 1) {
    throw new RangeError(
      `Queue limiter.max must be a positive finite number >= 1, received ${String(max)}.`,
    );
  }
  if (
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  ) {
    throw new RangeError(
      `Queue limiter.durationMs (or duration) must be a positive finite number > 0, received ${String(durationMs)}.`,
    );
  }

  return {
    max: Math.floor(max),
    durationMs: Math.floor(durationMs),
  };
}
