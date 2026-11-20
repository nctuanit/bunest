import type {
  InjectionToken,
  ModuleImport,
  Provider,
  Type,
} from "@bunest/common";

export type HttpMethodName =
  | "GET"
  | "DELETE"
  | "HEAD"
  | "OPTIONS"
  | "POST"
  | "PUT"
  | "PATCH"
  | "PURGE"
  | "LINK"
  | "UNLINK"
  | "QUERY"
  | Lowercase<
      | "GET"
      | "DELETE"
      | "HEAD"
      | "OPTIONS"
      | "POST"
      | "PUT"
      | "PATCH"
      | "PURGE"
      | "LINK"
      | "UNLINK"
      | "QUERY"
    >;

export type HttpResponseType =
  | "json"
  | "text"
  | "arraybuffer"
  | "blob"
  | "stream"
  | "formdata";

type UppercaseResponseEncoding =
  | "ASCII"
  | "ANSI"
  | "BINARY"
  | "BASE64"
  | "BASE64URL"
  | "HEX"
  | "LATIN1"
  | "UCS-2"
  | "UCS2"
  | "UTF-8"
  | "UTF8"
  | "UTF16LE";

export type HttpResponseEncoding =
  | UppercaseResponseEncoding
  | Lowercase<UppercaseResponseEncoding>
  | (string & {});

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type HttpHeaderValue =
  | string
  | string[]
  | number
  | boolean
  | null
  | undefined;

export interface HttpBasicCredentials {
  username: string;
  password: string;
}

export interface HttpProxyConfig {
  host: string;
  port: number;
  auth?: HttpBasicCredentials;
  protocol?: string;
}

export interface HttpProgressEvent {
  loaded: number;
  total?: number;
  progress?: number;
  bytes: number;
  rate?: number;
  estimated?: number;
  upload?: boolean;
  download?: boolean;
  lengthComputable: boolean;
}

export type HttpParamEncoder = (
  value: any,
  defaultEncoder: (value: string) => string,
) => string;

export type HttpParamsSerializer<P = Record<string, any>> = (
  params: P,
  options?: HttpParamsSerializerOptions<P>,
) => string;

export interface HttpParamsSerializerOptions<P = Record<string, any>> {
  encode?: HttpParamEncoder;
  serialize?: HttpParamsSerializer<P>;
  indexes?: boolean | null;
  dots?: boolean;
}

export type HttpRequestTransformer = (
  this: HttpRequestConfig,
  data: any,
  headers: Headers,
) => any;

export type HttpResponseTransformer = (
  this: HttpRequestConfig,
  data: any,
  headers: Record<string, string>,
  status?: number,
) => any;

export interface HttpBeforeRedirectResponseDetails {
  headers: Record<string, string>;
  statusCode: number;
}

export interface HttpBeforeRedirectRequestDetails {
  headers: Record<string, string>;
  url: string;
  method: string;
}

export type HttpBeforeRedirect = (
  options: Record<string, any>,
  responseDetails: HttpBeforeRedirectResponseDetails,
  requestDetails: HttpBeforeRedirectRequestDetails,
) => void;

export interface HttpRequestConfig<TData = any> {
  url?: string;
  method?: HttpMethodName | string;
  baseURL?: string;
  /**
   * When `false`, absolute URLs in `url` are still joined against `baseURL`
   * (prevents SSRF via user-supplied absolute URLs). Defaults to `true`.
   */
  allowAbsoluteUrls?: boolean;
  headers?: Record<string, HttpHeaderValue> | Headers;
  params?: Record<string, any> | URLSearchParams;
  /**
   * Custom query string serializer function or serializer options (`indexes`, `dots`, `encode`, `serialize`).
   */
  paramsSerializer?: HttpParamsSerializer | HttpParamsSerializerOptions;
  data?: TData;
  /**
   * Transform outgoing request `data` (and optionally mutate `headers`) before sending.
   */
  transformRequest?: HttpRequestTransformer | HttpRequestTransformer[];
  /**
   * Transform parsed response `data` before resolving (and before response interceptors).
   */
  transformResponse?: HttpResponseTransformer | HttpResponseTransformer[];
  /**
   * HTTP Basic authentication credentials (`Authorization: Basic <base64>`).
   */
  auth?: HttpBasicCredentials;
  /**
   * Request timeout in milliseconds (backed by native `AbortSignal.timeout`).
   */
  timeout?: number;
  /**
   * Custom error message used when a request times out (`ECONNABORTED`).
   */
  timeoutErrorMessage?: string;
  signal?: AbortSignal;
  responseType?: HttpResponseType;
  /**
   * Character/binary encoding used when decoding text/JSON responses (e.g. `"utf8"`, `"latin1"`, `"base64"`, `"hex"`).
   */
  responseEncoding?: HttpResponseEncoding;
  /**
   * Reviver function passed as the 2nd argument to `JSON.parse()` for JSON responses.
   */
  parseReviver?: (
    this: any,
    key: string,
    value: any,
    context?: { source?: string },
  ) => any;
  /**
   * Determines whether a status code resolves or throws `HttpError`.
   * Defaults to `(status) => status >= 200 && status < 300`.
   */
  validateStatus?: ((status: number) => boolean) | null;
  /**
   * Redirect behavior passed to native `fetch()`.
   */
  redirect?: RequestInit["redirect"];
  /**
   * Maximum number of HTTP redirects to follow.
   * `0` disables automatic redirect following (`redirect: "manual"`).
   * Values `> 0` run a Bun-native redirect loop invoking `beforeRedirect`.
   */
  maxRedirects?: number;
  /**
   * Callback invoked before following each HTTP redirect when redirect tracking is active.
   */
  beforeRedirect?: HttpBeforeRedirect;
  /**
   * Maximum allowed response content length in bytes. Rejects with `HttpError` if exceeded.
   */
  maxContentLength?: number;
  /**
   * Maximum allowed request body length in bytes. Rejects with `HttpError` before/during send if exceeded.
   */
  maxBodyLength?: number;
  /**
   * Progress callback invoked as response bytes are streamed.
   */
  onDownloadProgress?: (progressEvent: HttpProgressEvent) => void;
  /**
   * Progress callback invoked for outgoing request body upload progress.
   */
  onUploadProgress?: (progressEvent: HttpProgressEvent) => void;
  /**
   * Controls automatic response decompression in Bun's native `fetch()`.
   */
  decompress?: boolean;
  /**
   * Credentials mode passed to native `fetch()`.
   */
  credentials?: RequestInit["credentials"];
  /**
   * Axios-compatible shorthand mapping `true` -> `credentials: "include"` and `false` -> `credentials: "omit"`.
   */
  withCredentials?: boolean;
  /**
   * Proxy configuration forwarded natively to Bun's `fetch(..., { proxy })`.
   * Pass `false` to disable proxy forwarding.
   */
  proxy?: false | string | HttpProxyConfig;
  /**
   * Cookie name containing the XSRF token (e.g. `"XSRF-TOKEN"`).
   */
  xsrfCookieName?: string;
  /**
   * Request header name used to send the extracted XSRF token (e.g. `"X-XSRF-TOKEN"`).
   */
  xsrfHeaderName?: string;
  /**
   * Controls whether the XSRF token header is attached from cookies (`Cookie` header or `document.cookie`).
   */
  withXSRFToken?:
    | boolean
    | ((config: HttpRequestConfig<TData>) => boolean | undefined);
  /**
   * Additional Bun/Fetch `RequestInit` options forwarded directly to `fetch()`
   * (e.g. `cache`, `mode`, `keepalive`, `tls`, `verbose`, `unix`).
   */
  fetchOptions?: Omit<RequestInit, "headers" | "body" | "method" | "signal"> &
    Record<string, any>;
  /**
   * Config property paths to mask with `"[REDACTED]"` when attached to `HttpError.config`
   * (e.g. `["auth.password", "params.apiKey"]`).
   */
  redact?: string[];
  /**
   * Header names to mask with `"[REDACTED]"` when attached to `HttpError.config`
   * (e.g. `["authorization", "x-api-key"]`).
   */
  sensitiveHeaders?: string[];
  /**
   * Number of automatic retry attempts on network / 5xx errors (default `0`).
   */
  retries?: number;
  /**
   * Delay between retries in milliseconds (default `100`).
   */
  retryDelayMs?: number;
  /**
   * Optional custom `fetch` implementation (ideal for zero-socket unit tests).
   */
  fetch?: FetchLike;
}

export interface HttpResponse<T = any, TData = any> {
  readonly data: T;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly rawHeaders: Headers;
  readonly config: HttpRequestConfig<TData>;
  readonly rawResponse: Response;
}

export class HttpError<T = any, TData = any> extends Error {
  readonly isAxiosError = true;
  readonly isHttpError = true;

  constructor(
    message: string,
    public readonly config: HttpRequestConfig<TData>,
    public readonly code?: string,
    public readonly response?: HttpResponse<T, TData>,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "HttpError";
    Object.setPrototypeOf(this, new.target.prototype);
  }

  get status(): number | undefined {
    return this.response?.status;
  }
}

export type HttpRequestInterceptor = (
  config: HttpRequestConfig,
) => HttpRequestConfig | Promise<HttpRequestConfig>;

export type HttpErrorInterceptor = (error: unknown) => unknown;

export type HttpResponseInterceptor<T = any> = (
  response: HttpResponse<T>,
) => HttpResponse<T> | Promise<HttpResponse<T>>;

export interface HttpInterceptorManager<TValue> {
  use(
    onFulfilled?: (value: TValue) => TValue | Promise<TValue>,
    onRejected?: HttpErrorInterceptor,
  ): number;
  eject(id: number): void;
  clear(): void;
}

export interface HttpModuleOptions extends HttpRequestConfig {
  /**
   * Register `HttpModule` globally across all modules (default `false`).
   */
  global?: boolean;
}

export interface HttpModuleOptionsFactory {
  createHttpOptions(): Promise<HttpModuleOptions> | HttpModuleOptions;
}

export interface HttpModuleAsyncOptions {
  imports?: ModuleImport[];
  useExisting?: Type<HttpModuleOptionsFactory> | InjectionToken;
  useClass?: Type<HttpModuleOptionsFactory>;
  useFactory?: (
    ...args: any[]
  ) => Promise<HttpModuleOptions> | HttpModuleOptions;
  inject?: InjectionToken[];
  extraProviders?: Provider[];
  global?: boolean;
}
