export const seconds = (howMany: number): number => howMany * 1000;
export const minutes = (howMany: number): number => 60 * howMany * seconds(1);
export const hours = (howMany: number): number => 60 * howMany * minutes(1);
export const days = (howMany: number): number => 24 * howMany * hours(1);
export const weeks = (howMany: number): number => 7 * howMany * days(1);

export const DEFAULT_IPV6_SUBNET_PREFIX = 64;

const IPV4_OCTET_REGEX = /^(?:0|[1-9]\d{0,2})$/;
const HEX_GROUP_REGEX = /^[0-9a-f]{1,4}$/i;

function parseIpv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!IPV4_OCTET_REGEX.test(part)) {
      return null;
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      return null;
    }
    octets.push(n);
  }
  return octets;
}

function toHextets(address: string): number[] | null {
  if (!address.includes(":")) {
    return null;
  }

  let head = address;
  const lastColon = head.lastIndexOf(":");
  const tail = head.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = parseIpv4Octets(tail);
    if (!octets) {
      return null;
    }
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    head = `${head.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const sides = head.split("::");
  if (sides.length > 2) {
    return null;
  }

  const left = sides[0] ? sides[0].split(":") : [];
  const right = sides.length === 2 && sides[1] ? sides[1].split(":") : [];

  if (sides.length === 2) {
    const fill = 8 - left.length - right.length;
    if (fill < 1) {
      return null;
    }
    const groups = [...left, ...new Array<string>(fill).fill("0"), ...right];
    return parseHexGroups(groups);
  }

  if (left.length !== 8) {
    return null;
  }
  return parseHexGroups(left);
}

function parseHexGroups(groups: string[]): number[] | null {
  const hextets: number[] = [];
  for (const group of groups) {
    if (!HEX_GROUP_REGEX.test(group)) {
      return null;
    }
    const val = Number.parseInt(group, 16);
    if (!Number.isInteger(val) || val < 0 || val > 0xffff) {
      return null;
    }
    hextets.push(val);
  }
  return hextets;
}

function maskHextets(hextets: number[], prefix: number): number[] {
  return hextets.map((hextet, index) => {
    const bitsBefore = index * 16;
    if (prefix >= bitsBefore + 16) {
      return hextet;
    }
    if (prefix <= bitsBefore) {
      return 0;
    }
    const keep = prefix - bitsBefore;
    return hextet & ((0xffff << (16 - keep)) & 0xffff);
  });
}

function formatIpv6(hextets: number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  let runLength = 0;

  for (let index = 0; index < hextets.length; index++) {
    if (hextets[index] !== 0) {
      runStart = -1;
      runLength = 0;
      continue;
    }
    if (runStart === -1) {
      runStart = index;
    }
    runLength++;
    if (runLength > bestLength) {
      bestStart = runStart;
      bestLength = runLength;
    }
  }

  const groups = hextets.map((h) => h.toString(16));
  if (bestLength < 2) {
    return groups.join(":");
  }
  return `${groups.slice(0, bestStart).join(":")}::${groups.slice(bestStart + bestLength).join(":")}`;
}

function embedsIpv4(hextets: number[]): boolean {
  const [a, b, c, d, e, f] = hextets;
  if (c !== 0 || d !== 0 || e !== 0) {
    return false;
  }
  // NAT64 well-known prefix 64:ff9b::/96
  if (a === 0x64 && b === 0xff9b) {
    return f === 0;
  }
  // IPv4-mapped IPv6 ::ffff:0:0/96
  return a === 0 && b === 0 && f === 0xffff;
}

/**
 * Normalizes an IP address for rate-limiting:
 * - IPv4 addresses are returned as-is.
 * - IPv6 loopback (`::1` / `0:0:0:0:0:0:0:1`) is normalized to `"::1"`.
 * - IPv4-mapped IPv6 (`::ffff:x.x.x.x`) and NAT64 (`64:ff9b::x.x.x.x`) unwrap to IPv4.
 * - Other IPv6 addresses are masked to the configured subnet prefix (default `/64`)
 *   to prevent IPv6 address-rotation rate-limit bypasses.
 * - Non-IP strings (e.g., custom tracker IDs) are returned unchanged.
 */
export function normalizeIp(
  ip: string,
  ipv6SubnetPrefix: number = DEFAULT_IPV6_SUBNET_PREFIX,
): string {
  if (typeof ip !== "string" || ip.length === 0) {
    return ip;
  }

  const zoneIndex = ip.indexOf("%");
  const bare = zoneIndex === -1 ? ip : ip.slice(0, zoneIndex);

  if (parseIpv4Octets(bare) !== null) {
    return bare;
  }

  const hextets = toHextets(bare.toLowerCase());
  if (!hextets) {
    return ip;
  }

  const isLoopback =
    hextets[7] === 1 && hextets.slice(0, 7).every((h) => h === 0);
  if (isLoopback) {
    return "::1";
  }

  if (embedsIpv4(hextets)) {
    const h6 = hextets[6]!;
    const h7 = hextets[7]!;
    return [h6 >> 8, h6 & 0xff, h7 >> 8, h7 & 0xff].join(".");
  }

  const prefix = Number.isFinite(ipv6SubnetPrefix)
    ? Math.min(Math.max(Math.trunc(ipv6SubnetPrefix), 0), 128)
    : DEFAULT_IPV6_SUBNET_PREFIX;

  return `${formatIpv6(maskHextets(hextets, prefix))}/${prefix}`;
}
