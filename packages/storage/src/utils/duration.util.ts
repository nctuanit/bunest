import type { Duration } from "../interfaces/storage-types";

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/;

export function toMs(duration: Duration): number {
  if (typeof duration === "number") {
    if (!Number.isFinite(duration) || duration < 0) {
      throw new RangeError(`Invalid duration: ${duration}`);
    }
    return duration;
  }
  if (typeof duration === "string") {
    const match = DURATION_RE.exec(duration.trim());
    if (!match) {
      throw new RangeError(`Invalid duration string: "${duration}"`);
    }
    const value = Number(match[1]);
    const unit = match[2]!;
    const mult = UNIT_MS[unit]!;
    const ms = value * mult;
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`Invalid duration string: "${duration}"`);
    }
    return ms;
  }
  throw new TypeError(`Duration must be a number or duration string`);
}
