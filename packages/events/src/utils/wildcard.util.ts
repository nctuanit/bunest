import type { EventName } from "../interfaces/event-emitter.interface";

/**
 * Deterministic segment-based wildcard matcher (O(P * E), zero ReDoS risk):
 * - `*` matches any single segment (e.g. `order.*` matches `order.created`, not `order.a.b`)
 * - `**` matches one or more segments at the end (e.g. `order.**` matches `order.a` and `order.a.b`, not `order`),
 *   or zero or more segments in the middle (e.g. `order.**.paid` matches `order.paid` and `order.a.b.paid`).
 * - A standalone `**` matches any string event.
 * - Symbols match only by strict reference equality.
 */
export function matchEventName(
  pattern: EventName,
  event: EventName,
  wildcard: boolean,
  delimiter: string,
): boolean {
  if (typeof pattern === "symbol" || typeof event === "symbol") {
    return pattern === event;
  }

  if (!wildcard) {
    return pattern === event;
  }

  if (pattern === "**") {
    return true;
  }

  if (!pattern.includes("*")) {
    return pattern === event;
  }

  const sep = delimiter.length > 0 ? delimiter : ".";
  const pParts = pattern.split(sep);
  const eParts = event.split(sep);

  const pLen = pParts.length;
  const eLen = eParts.length;
  const dp: boolean[][] = Array.from({ length: pLen + 1 }, () =>
    Array<boolean>(eLen + 1).fill(false),
  );
  dp[0]![0] = true;

  for (let i = 1; i <= pLen; i += 1) {
    if (pParts[i - 1] === "**") {
      dp[i]![0] = dp[i - 1]![0]!;
    }
  }

  for (let i = 1; i <= pLen; i += 1) {
    const pSeg = pParts[i - 1]!;
    for (let j = 1; j <= eLen; j += 1) {
      const eSeg = eParts[j - 1]!;
      if (pSeg === "**") {
        dp[i]![j] = dp[i - 1]![j]! || dp[i]![j - 1]!;
      } else if (pSeg === "*" || pSeg === eSeg) {
        dp[i]![j] = dp[i - 1]![j - 1]!;
      }
    }
  }

  // Trailing `.<**>` requires the final `**` to consume at least one event segment
  // (while still allowing earlier `**` segments in multi-`**` patterns like `a.**.b.**` to match 0 segments).
  if (pLen >= 2 && pParts[pLen - 1] === "**") {
    return eLen >= 1 && dp[pLen]![eLen - 1]!;
  }

  return dp[pLen]![eLen]!;
}
