import type { StandardSchemaV1 } from "../../common/interfaces/standard-schema.interface";
import type { Duration } from "../types/duration.type";
import type { HttpRetryOptions } from "./http-retry-options.interface";

/** What the global `fetch` accepts as a body, without depending on the DOM lib. */
type FetchBody = NonNullable<RequestInit["body"]>;

/** Anything `fetch` accepts as a body, plus Web streams / async iterables. */
export type HttpRequestBody =
  | FetchBody
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array | string>
  | null
  | undefined;

export type HeaderValue =
  string | number | readonly string[] | null | undefined;

/**
 * Header input. `null` removes a header set at a lower level
 * (`forRoot()` -> client -> request), e.g. `{ authorization: null }`.
 */
export type HttpHeadersInit = Headers | Record<string, HeaderValue>;

export type QueryValue = string | number | boolean | Date | null | undefined;

/** Arrays repeat the key (`?tag=a&tag=b`); `null`/`undefined` are skipped. */
export type HttpQuery =
  URLSearchParams | Record<string, QueryValue | readonly QueryValue[]>;

/**
 * - `auto` (default): JSON when the content type says so, otherwise text;
 *   `undefined` for empty bodies, 204/205 and HEAD, and for 304 with
 *   `throwOnHttpError: false` (by default a 304 throws, like any non-2xx).
 * - `json` / `text` / `arrayBuffer`: read the body as that.
 * - Invalid JSON rejects with `HttpParseError`.
 * - `stream`: a Web `ReadableStream<Uint8Array>` (body left unread; the timeout stops at headers).
 * - `response`: the raw web `Response` (body left unread).
 */
export type HttpResponseType =
  "auto" | "json" | "text" | "arrayBuffer" | "stream" | "response";

/**
 * An undici-style dispatcher (`Agent`, `ProxyAgent`, `MockAgent`, ...).
 * Typed by shape so the package needs no undici types.
 */
export interface HttpDispatcher {
  dispatch(options: object, handler: object): boolean;
}

/** Bun-native `fetch` proxy configuration (`string`, `false`, or `{ url, headers, respectNoProxy }`). */
export type HttpFetchProxyOption =
  | string
  | false
  | {
      readonly url: string;
      readonly headers?: Record<string, string>;
      readonly respectNoProxy?: boolean;
    };

/** Structural subset of Bun's `Bun.FetchSession` holding an isolated keep-alive pool and TLS/proxy/unix settings. */
export interface BunFetchSessionLike {
  fetch: typeof globalThis.fetch;
  close(): void;
}

/** Configuration passed to `new Bun.FetchSession(options)`. */
export interface HttpFetchSessionOptions {
  readonly tls?: Record<string, unknown>;
  readonly proxy?: HttpFetchProxyOption;
  readonly keepAlive?:
    | boolean
    | {
        readonly idleTimeout?: number;
        readonly maxIdleSockets?: number;
      };
  readonly unix?: string;
}

/** Settings that `forRoot()`, a client and a single request can each set; the most specific wins. */
export interface HttpSharedOptions {
  headers?: HttpHeadersInit | undefined;
  /**
   * Per-attempt limit, e.g. `'5s'` or `5_000`: until the body is read, or
   * until the headers arrive for `stream`/`response`. `0` means none. Default none.
   */
  timeout?: Duration | undefined;
  /** A number is shorthand for `{ attempts }`; `false` makes a single attempt. */
  retry?: number | false | HttpRetryOptions | undefined;
  /** Throw `HttpResponseError` for non-2xx. Default `true`. */
  throwOnHttpError?: boolean | undefined;
  /**
   * How 3xx responses are handled. Default: with a `baseUrl`, redirects are
   * followed on the client's origin only, and one to another origin fails
   * with `HttpNetworkError`; without one, fetch's `follow`.
   */
  redirect?: "follow" | "error" | "manual" | undefined;
  /** Connection pool, proxy or TLS settings (an undici `Agent` or `ProxyAgent`). */
  dispatcher?: HttpDispatcher | undefined;
  /** Bun-native Unix domain socket path for `fetch(..., { unix })`. */
  unix?: string | undefined;
  /** Bun-native proxy URL, `false` to bypass env proxies, or `{ url, headers, respectNoProxy }`. */
  proxy?: HttpFetchProxyOption | undefined;
  /** Bun-native TLS options (`ca`, `cert`, `key`, `rejectUnauthorized`, `serverName`, `checkServerIdentity`). */
  tls?: Record<string, unknown> | undefined;
  /** Bun-native automatic response decompression toggle (`fetch(..., { decompress })`). */
  decompress?: boolean | undefined;
  /** Bun-native verbose request logging (`true` or `"curl"`). */
  verbose?: boolean | "curl" | undefined;
  /**
   * Automatically propagate active `ClsService` context keys as outgoing HTTP
   * headers (`x-request-id`, `x-tenant-id`, `x-user-id`, `x-correlation-id` when
   * `true`, or custom CLS keys when passing a `string[]`). Explicit headers on
   * the client or request always take precedence.
   */
  propagateClsHeaders?: boolean | readonly string[] | undefined;
}

/** Request as seen by interceptors. Mutable; or pass a modified copy to `next`. */
export interface HttpRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: HttpRequestBody;
  /** Combined user signal + per-attempt timeout. */
  signal: AbortSignal;
  /** 1-based attempt number (interceptors run once per attempt). */
  attempt: number;
  /** Free-form bag carried from the request's `context` option, for interceptors. */
  context: Record<string, unknown>;
}

export interface HttpRequestOptions extends HttpSharedOptions {
  /** Only used by `request()`; the verb methods set it. Default GET. */
  method?: string | undefined;
  query?: HttpQuery | undefined;
  /**
   * Fills `/:name` segments of the URL, URI-encoded. Every key must match a
   * segment, and a value can't be empty, `.` or `..`.
   */
  params?: Record<string, string | number> | undefined;
  /** Serialized with `JSON.stringify`; sets `content-type: application/json`. */
  json?: unknown;
  /** Raw body, passed to fetch as is. Mutually exclusive with `json`. */
  body?: HttpRequestBody | undefined;
  responseType?: HttpResponseType | undefined;
  /**
   * Optional Standard Schema v1 validator applied to the parsed response body.
   * When provided, validates (and transforms) `data` and throws
   * `HttpClientValidationError` if validation produces issues.
   */
  responseSchema?: StandardSchemaV1<unknown, unknown> | undefined;
  signal?: AbortSignal | undefined;
  context?: Record<string, unknown> | undefined;
}
