/**
 * Pure-TypeScript RFC 3986 / RFC 4291 IP address validators
 * matching `node:net` `isIP` / `isIPv4` / `isIPv6` with zero `node:net` dependency.
 */

const HEX_GROUP_RE = /^[0-9a-fA-F]{1,4}$/;
const ZONE_ID_RE = /^[0-9a-zA-Z._-]+$/;

/**
 * Returns `true` if `input` is a valid canonical IPv4 dotted-decimal literal
 * (4 octets `0..255`, no leading zeros except `"0"` itself).
 */
export function isIpv4(input: string): boolean {
  if (typeof input !== "string" || input.length < 7 || input.length > 15) {
    return false;
  }
  const parts = input.split(".");
  if (parts.length !== 4) {
    return false;
  }
  for (let i = 0; i < 4; i++) {
    const part = parts[i]!;
    const len = part.length;
    if (len === 0 || len > 3) {
      return false;
    }
    if (len > 1 && part.charCodeAt(0) === 48) {
      return false; // Reject leading zero (e.g. "01")
    }
    let val = 0;
    for (let j = 0; j < len; j++) {
      const code = part.charCodeAt(j);
      if (code < 48 || code > 57) {
        return false;
      }
      val = val * 10 + (code - 48);
    }
    if (val > 255) {
      return false;
    }
  }
  return true;
}

/**
 * Returns `true` if `input` is a valid RFC 4291 / RFC 6874 IPv6 literal
 * (supports `::` zero compression, trailing IPv4-mapped suffix, and optional `%zone`).
 */
export function isIpv6(input: string): boolean {
  if (typeof input !== "string" || input.length < 2) {
    return false;
  }

  let addr = input;
  const zoneIdx = addr.indexOf("%");
  if (zoneIdx !== -1) {
    const zone = addr.slice(zoneIdx + 1);
    if (zone.length === 0 || !ZONE_ID_RE.test(zone)) {
      return false;
    }
    addr = addr.slice(0, zoneIdx);
    if (addr.length < 2) {
      return false;
    }
  }

  const doubleColonIdx = addr.indexOf("::");
  if (doubleColonIdx !== -1) {
    // At most one `::` compression sequence is allowed
    if (addr.indexOf("::", doubleColonIdx + 2) !== -1) {
      return false;
    }
    const leftRaw = addr.slice(0, doubleColonIdx);
    const rightRaw = addr.slice(doubleColonIdx + 2);

    if (
      leftRaw.startsWith(":") ||
      leftRaw.endsWith(":") ||
      rightRaw.startsWith(":") ||
      rightRaw.endsWith(":")
    ) {
      return false;
    }

    const leftGroups = leftRaw.length === 0 ? [] : leftRaw.split(":");
    const rightGroups = rightRaw.length === 0 ? [] : rightRaw.split(":");

    let groupCount = 0;
    for (let i = 0; i < leftGroups.length; i++) {
      if (!HEX_GROUP_RE.test(leftGroups[i]!)) {
        return false;
      }
      groupCount++;
    }

    for (let i = 0; i < rightGroups.length; i++) {
      const group = rightGroups[i]!;
      if (i === rightGroups.length - 1 && group.includes(".")) {
        if (!isIpv4(group)) {
          return false;
        }
        groupCount += 2;
      } else {
        if (!HEX_GROUP_RE.test(group)) {
          return false;
        }
        groupCount++;
      }
    }

    return groupCount < 8;
  }

  if (addr.startsWith(":") || addr.endsWith(":")) {
    return false;
  }

  const groups = addr.split(":");
  let groupCount = 0;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    if (i === groups.length - 1 && group.includes(".")) {
      if (!isIpv4(group)) {
        return false;
      }
      groupCount += 2;
    } else {
      if (!HEX_GROUP_RE.test(group)) {
        return false;
      }
      groupCount++;
    }
  }

  return groupCount === 8;
}

/**
 * Returns `4` if `input` is a valid IPv4 address, `6` if it is a valid IPv6
 * address, or `0` otherwise.
 */
export function isIp(input: string): 0 | 4 | 6 {
  if (isIpv4(input)) return 4;
  if (isIpv6(input)) return 6;
  return 0;
}
