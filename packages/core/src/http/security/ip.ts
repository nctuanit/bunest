import type { BunServerLike } from "../interfaces/http-bridge.interface";

const LOOPBACK_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "localhost",
]);

function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice(7);
  }
  return trimmed;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (part === undefined || !/^\d+$/.test(part)) return null;
    const num = Number(part);
    if (num < 0 || num > 255) return null;
    value = ((value << 8) | num) >>> 0;
  }
  return value;
}

function matchesCidr(ip: string, cidr: string): boolean {
  const slashIdx = cidr.indexOf("/");
  if (slashIdx === -1) return false;
  const network = cidr.slice(0, slashIdx);
  const prefixBits = Number(cidr.slice(slashIdx + 1));
  if (!Number.isInteger(prefixBits) || prefixBits < 0 || prefixBits > 32) {
    return false;
  }
  const ipInt = ipv4ToInt(normalizeIp(ip));
  const netInt = ipv4ToInt(normalizeIp(network));
  if (ipInt === null || netInt === null) return false;
  if (prefixBits === 0) return true;
  const mask = (~0 << (32 - prefixBits)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

function isTrustedProxyIp(
  peerIp: string,
  trustedList: readonly string[],
): boolean {
  const normalizedPeer = normalizeIp(peerIp);
  for (const entry of trustedList) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed === "loopback") {
      if (
        LOOPBACK_ADDRESSES.has(peerIp) ||
        LOOPBACK_ADDRESSES.has(normalizedPeer) ||
        normalizedPeer.startsWith("127.")
      ) {
        return true;
      }
      continue;
    }
    if (trimmed.includes("/")) {
      if (matchesCidr(peerIp, trimmed)) {
        return true;
      }
      continue;
    }
    if (peerIp === trimmed || normalizedPeer === normalizeIp(trimmed)) {
      return true;
    }
  }
  return false;
}

function parseForwardedFor(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Extracts the client IP address using `server.requestIP(req)` with
 * optional configurable `trustProxy` forwarding header support.
 */
export function extractClientIp(
  req: Request,
  server?: BunServerLike,
  trustProxy?: boolean | number | string[],
): string {
  const socketIp = server?.requestIP?.(req)?.address ?? "";

  if (!trustProxy || trustProxy === 0) {
    return socketIp;
  }

  const xff = parseForwardedFor(req.headers.get("x-forwarded-for"));
  const xRealIp = req.headers.get("x-real-ip")?.trim();

  if (trustProxy === true) {
    if (xff.length > 0) {
      return xff[0] ?? socketIp;
    }
    return xRealIp || socketIp;
  }

  if (typeof trustProxy === "number") {
    const hops = Math.floor(trustProxy);
    if (hops <= 0) {
      return socketIp;
    }
    if (xff.length > 0) {
      // X-Forwarded-For lists [client, proxy1, proxy2, ...].
      // With N trusted proxy hops (including the immediate peer), pick chain[chain.length - hops].
      const idx = Math.max(0, xff.length - hops);
      return xff[idx] ?? socketIp;
    }
    return xRealIp || socketIp;
  }

  if (Array.isArray(trustProxy)) {
    // Only trust forwarding headers if the direct peer is in the trusted list
    // (or when running in-memory without a socket peer, check if trustedList is non-empty).
    if (socketIp && !isTrustedProxyIp(socketIp, trustProxy)) {
      return socketIp;
    }
    if (xff.length > 0) {
      // Walk right-to-left skipping trusted proxies to find the first untrusted client IP.
      for (let i = xff.length - 1; i >= 0; i--) {
        const candidate = xff[i];
        if (candidate && !isTrustedProxyIp(candidate, trustProxy)) {
          return candidate;
        }
      }
      return xff[0] ?? socketIp;
    }
    return xRealIp || socketIp;
  }

  return socketIp;
}
