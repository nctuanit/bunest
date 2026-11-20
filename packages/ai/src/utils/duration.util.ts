import type { Duration } from '@bunest/resilience';
import { AiConfigurationError } from '../errors/ai.errors';

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** A duration in milliseconds. */
export function toMilliseconds(value: Duration | string, option: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new AiConfigurationError(
        `Invalid duration for \`${option}\`: ${String(value)}`,
      );
    }
    return value;
  }
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i.exec(String(value).trim());
  if (!match) {
    throw new AiConfigurationError(
      `Invalid duration for \`${option}\`: ${String(value)}`,
    );
  }
  const num = Number.parseFloat(match[1]!);
  const unit = match[2]!.toLowerCase();
  return num * (UNIT_MS[unit] ?? 1_000);
}
