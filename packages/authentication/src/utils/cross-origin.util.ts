import { readJoinedHeader, type HeadersInput } from "./headers.util";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/**
 * Whether a request would change state from another origin.
 */
export function isCrossOriginWrite(
  request: { headers: HeadersInput; method?: string; url?: string },
  trusted: ReadonlySet<string>,
): boolean {
  const upgrade =
    readJoinedHeader(request.headers, "upgrade")?.toLowerCase() === "websocket";
  if (
    request.method !== undefined &&
    SAFE_METHODS.has(request.method) &&
    !upgrade
  ) {
    return false;
  }
  const origin = readJoinedHeader(request.headers, "origin");
  const site = readJoinedHeader(request.headers, "sec-fetch-site");
  if (site !== undefined) {
    if (site === "same-origin" || site === "none") {
      return false;
    }
    return !(origin !== undefined && trusted.has(origin));
  }
  if (origin === undefined) {
    return false;
  }
  const host =
    readJoinedHeader(request.headers, ":authority") ??
    readJoinedHeader(request.headers, "host") ??
    urlHostOf(request);
  if (host !== undefined && originMatchesHost(origin, host)) {
    return false;
  }
  return !trusted.has(origin);
}

function urlHostOf(request: { url?: string }): string | undefined {
  if (typeof request.url !== "string") {
    return undefined;
  }
  if (!request.url.startsWith("http://") && !request.url.startsWith("https://")) {
    return undefined;
  }
  try {
    return new URL(request.url).host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A trusted origin as browsers serialize `Origin`: lower-case scheme and
 * host, no default port. Fails at startup, naming `option`, for anything
 * that is not `scheme://host[:port]`.
 */
export function normalizeOrigin(origin: unknown, option: string): string {
  const fail = (): never => {
    throw new TypeError(
      `${option}: ${JSON.stringify(origin)} is not an origin. Write it as scheme://host[:port], without a path.`,
    );
  };
  if (
    typeof origin !== "string" ||
    !/^[a-z][a-z0-9+.-]*:\/\/[^/?#\\*]+$/i.test(origin)
  ) {
    return fail();
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return fail();
  }
  if (!url.host || url.username || url.password) {
    fail();
  }
  return `${url.protocol}//${url.host}`;
}

function originMatchesHost(origin: string, host: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (!url.host) {
    return false;
  }
  const authority = host.toLowerCase();
  if (url.host === authority) {
    return true;
  }
  const port = DEFAULT_PORTS[url.protocol];
  return (
    !url.port && port !== undefined && `${url.hostname}:${port}` === authority
  );
}
