import type { HttpRequestBody } from "../interfaces/http-request.interface";
import { isReplayableBody } from "./request-body.util";
import { discard } from "./response.util";
import { assertSendableUrl } from "./url.util";

/** fetch's own limit. */
const MAX_REDIRECTS = 20;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** Dropped with the body when a redirect turns the request into a GET. */
const REQUEST_BODY_HEADERS = [
  "content-encoding",
  "content-language",
  "content-location",
  "content-type",
  "content-length",
];

export type ExtendedRequestInit = Omit<RequestInit, "dispatcher"> & {
  dispatcher?: unknown;
  duplex?: "half";
  unix?: string;
  proxy?: unknown;
  tls?: Record<string, unknown>;
  decompress?: boolean;
  verbose?: boolean | "curl";
};

/**
 * Follows redirects like `redirect: 'follow'`, but only within `origin`.
 */
export async function fetchWithinOrigin(
  fetchImpl: typeof globalThis.fetch,
  url: URL,
  init: ExtendedRequestInit,
  origin: string,
): Promise<Response> {
  let current = url;
  let currentInit = init;

  for (let hop = 0; ; hop++) {
    const response = await fetchImpl(current, {
      ...currentInit,
      redirect: "manual",
    } as RequestInit);
    const location = response.headers.get("location");
    if (!REDIRECT_STATUS.has(response.status) || location === null) {
      return response;
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      discard(response);
      throw new TypeError("invalid redirect location");
    }

    if (next.origin !== origin) {
      discard(response);
      throw new TypeError(
        `redirect to another origin (${next.origin}) refused: the client only sends to ${origin}`,
      );
    }

    if (hop >= MAX_REDIRECTS) {
      discard(response);
      throw new TypeError("too many redirects");
    }

    try {
      assertSendableUrl(next);
    } catch (error) {
      discard(response);
      throw error;
    }

    const method = (currentInit.method ?? "GET").toUpperCase();
    const toGet =
      (response.status === 303 && method !== "GET" && method !== "HEAD") ||
      ((response.status === 301 || response.status === 302) &&
        method === "POST");

    if (toGet) {
      const headers = new Headers(currentInit.headers);
      for (const name of REQUEST_BODY_HEADERS) {
        headers.delete(name);
      }
      currentInit = { ...currentInit, method: "GET", body: undefined, headers };
    } else if (!isReplayableBody(currentInit.body as HttpRequestBody)) {
      discard(response);
      throw new TypeError(
        `redirect (${response.status}) would resend a stream body, which can be sent only once`,
      );
    }

    discard(response);
    current = next;
  }
}
