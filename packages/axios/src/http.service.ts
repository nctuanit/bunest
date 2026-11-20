import { Inject, Injectable, Optional } from "@bunest/common";
import {
  HttpError,
  type FetchLike,
  type HttpErrorInterceptor,
  type HttpInterceptorManager,
  type HttpModuleOptions,
  type HttpParamsSerializerOptions,
  type HttpProgressEvent,
  type HttpProxyConfig,
  type HttpRequestConfig,
  type HttpRequestTransformer,
  type HttpResponse,
  type HttpResponseEncoding,
  type HttpResponseTransformer,
} from "./interfaces";
import { HTTP_MODULE_OPTIONS } from "./tokens";

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 21;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

interface RegisteredInterceptor<T> {
  readonly id: number;
  readonly onFulfilled?: (value: T) => T | Promise<T>;
  readonly onRejected?: HttpErrorInterceptor;
}

class InterceptorManagerImpl<T> implements HttpInterceptorManager<T> {
  private nextId = 0;
  private readonly handlers = new Map<number, RegisteredInterceptor<T>>();

  use(
    onFulfilled?: (value: T) => T | Promise<T>,
    onRejected?: HttpErrorInterceptor,
  ): number {
    const id = ++this.nextId;
    this.handlers.set(id, { id, onFulfilled, onRejected });
    return id;
  }

  eject(id: number): void {
    this.handlers.delete(id);
  }

  clear(): void {
    this.handlers.clear();
  }

  values(): IterableIterator<RegisteredInterceptor<T>> {
    return this.handlers.values();
  }
}

function isAbsoluteUrl(url: string): boolean {
  return /^([a-z][a-z\d+\-.]*:)?\/\//i.test(url);
}

function joinBaseAndPath(
  baseURL: string,
  url: string,
  allowAbsoluteUrls = true,
): string {
  if (!baseURL || (allowAbsoluteUrls && isAbsoluteUrl(url))) {
    return url;
  }
  if (!url) {
    return baseURL;
  }
  const cleanBase = baseURL.replace(/\/+$/, "");
  const cleanPath = url.replace(/^\/+/, "");
  return `${cleanBase}/${cleanPath}`;
}

function serializeParamsWithOptions(
  params: Record<string, any> | URLSearchParams,
  options: HttpParamsSerializerOptions = {},
): string {
  if (params instanceof URLSearchParams) {
    return params.toString();
  }

  const defaultEncode = (val: string) => encodeURIComponent(val);
  const encodeVal = (val: unknown): string => {
    const str = String(val);
    return options.encode ? options.encode(str, defaultEncode) : defaultEncode(str);
  };

  const parts: string[] = [];

  const pushEntry = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (value instanceof Date) {
      parts.push(`${encodeVal(key)}=${encodeVal(value.toISOString())}`);
      return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (item === undefined || item === null) continue;
        let itemKey: string;
        if (options.indexes === true) {
          itemKey = `${key}[${i}]`;
        } else if (options.indexes === false) {
          itemKey = `${key}[]`;
        } else {
          itemKey = key;
        }
        pushEntry(itemKey, item);
      }
      return;
    }
    if (typeof value === "object") {
      for (const [subKey, subVal] of Object.entries(
        value as Record<string, unknown>,
      )) {
        const nestedKey = options.dots
          ? `${key}.${subKey}`
          : `${key}[${subKey}]`;
        pushEntry(nestedKey, subVal);
      }
      return;
    }
    parts.push(`${encodeVal(key)}=${encodeVal(value)}`);
  };

  for (const [key, value] of Object.entries(params)) {
    pushEntry(key, value);
  }

  return parts.join("&");
}

function appendQueryParams(
  rawUrl: string,
  params: HttpRequestConfig["params"],
  paramsSerializer?: HttpRequestConfig["paramsSerializer"],
): string {
  if (!params) {
    return rawUrl;
  }

  let qs: string;
  if (typeof paramsSerializer === "function") {
    qs = paramsSerializer(params as Record<string, any>);
  } else if (
    paramsSerializer &&
    typeof paramsSerializer.serialize === "function"
  ) {
    qs = paramsSerializer.serialize(
      params as Record<string, any>,
      paramsSerializer,
    );
  } else if (paramsSerializer) {
    qs = serializeParamsWithOptions(params, paramsSerializer);
  } else {
    const search = new URLSearchParams();
    if (params instanceof URLSearchParams) {
      params.forEach((v, k) => search.append(k, v));
    } else {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item !== undefined && item !== null) {
              search.append(key, String(item));
            }
          }
        } else {
          search.append(key, String(value));
        }
      }
    }
    qs = search.toString();
  }

  const trimmed = qs.replace(/^\?/, "");
  if (!trimmed) {
    return rawUrl;
  }
  return rawUrl.includes("?") ? `${rawUrl}&${trimmed}` : `${rawUrl}?${trimmed}`;
}

function mergeHeaders(
  base?: HttpRequestConfig["headers"],
  override?: HttpRequestConfig["headers"],
): Headers {
  const result = new Headers();
  const apply = (src?: HttpRequestConfig["headers"]) => {
    if (!src) return;
    if (src instanceof Headers) {
      src.forEach((value, key) => result.set(key, value));
      return;
    }
    for (const [key, value] of Object.entries(src)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        result.delete(key);
        for (const item of value) {
          result.append(key, String(item));
        }
      } else {
        result.set(key, String(value));
      }
    }
  };
  apply(base);
  apply(override);
  return result;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function isBodyPassthrough(data: unknown): boolean {
  return (
    typeof data === "string" ||
    data instanceof Uint8Array ||
    data instanceof ArrayBuffer ||
    ArrayBuffer.isView(data) ||
    data instanceof Blob ||
    data instanceof FormData ||
    data instanceof URLSearchParams ||
    data instanceof ReadableStream
  );
}

function toFormData(data: unknown): FormData {
  if (data instanceof FormData) {
    return data;
  }
  const form = new FormData();
  if (data && typeof data === "object") {
    for (const [key, value] of Object.entries(
      data as Record<string, unknown>,
    )) {
      if (value === undefined || value === null) continue;
      if (value instanceof Blob) {
        form.append(key, value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          form.append(key, item instanceof Blob ? item : String(item));
        }
      } else {
        form.append(key, String(value));
      }
    }
  }
  return form;
}

function defaultValidateStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function combineSignals(
  signal?: AbortSignal,
  timeoutMs?: number,
): { signal?: AbortSignal; timeoutSignal?: AbortSignal } {
  const timeoutSignal =
    timeoutMs !== undefined && timeoutMs > 0
      ? AbortSignal.timeout(timeoutMs)
      : undefined;

  if (signal && timeoutSignal) {
    return { signal: AbortSignal.any([signal, timeoutSignal]), timeoutSignal };
  }
  return { signal: signal ?? timeoutSignal, timeoutSignal };
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  });
}

function formatProxyUrl(proxy: string | HttpProxyConfig): string {
  if (typeof proxy === "string") {
    return proxy;
  }
  const protocol = (proxy.protocol ?? "http").replace(/:$/, "");
  const authPart = proxy.auth
    ? `${encodeURIComponent(proxy.auth.username)}:${encodeURIComponent(proxy.auth.password)}@`
    : "";
  return `${protocol}://${authPart}${proxy.host}:${proxy.port}`;
}

function readCookieValue(
  cookieHeader: string | null,
  cookieName: string,
): string | undefined {
  const sources: string[] = [];
  if (cookieHeader) {
    sources.push(cookieHeader);
  }
  const doc = (globalThis as { document?: { cookie?: string } }).document;
  if (doc && typeof doc.cookie === "string" && doc.cookie.length > 0) {
    sources.push(doc.cookie);
  }

  for (const source of sources) {
    const pairs = source.split(";");
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      if (name === cookieName) {
        const rawVal = pair.slice(eq + 1).trim();
        try {
          return decodeURIComponent(rawVal);
        } catch {
          return rawVal;
        }
      }
    }
  }
  return undefined;
}

function measureKnownBodyLength(body: RequestInit["body"]): number | undefined {
  if (body === undefined || body === null) return 0;
  if (typeof body === "string") {
    return Buffer.byteLength(body, "utf8");
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }
  if (ArrayBuffer.isView(body)) {
    return body.byteLength;
  }
  if (body instanceof Blob) {
    return body.size;
  }
  if (body instanceof URLSearchParams) {
    return Buffer.byteLength(body.toString(), "utf8");
  }
  return undefined;
}

function wrapByteStream(
  source: ReadableStream<Uint8Array>,
  options: {
    direction: "upload" | "download";
    total?: number;
    maxBytes?: number;
    maxBytesError?: () => HttpError;
    onProgress?: (event: HttpProgressEvent) => void;
  },
): ReadableStream<Uint8Array> {
  const startTime = performance.now();
  let loaded = 0;
  let reader:
    | {
        read(): Promise<{ done: boolean; value?: Uint8Array }>;
        cancel(reason?: any): Promise<void>;
      }
    | undefined;

  return new ReadableStream<Uint8Array>({
    start() {
      reader = source.getReader();
    },
    async pull(controller) {
      if (!reader) {
        controller.close();
        return;
      }
      const { done, value } = await reader.read();
      if (done || !value) {
        controller.close();
        return;
      }
      const chunkBytes = value.byteLength;
      loaded += chunkBytes;

      if (
        options.maxBytes !== undefined &&
        options.maxBytes >= 0 &&
        loaded > options.maxBytes
      ) {
        await reader.cancel().catch(() => {});
        controller.error(
          options.maxBytesError
            ? options.maxBytesError()
            : new Error(`Stream exceeded max byte limit (${options.maxBytes})`),
        );
        return;
      }

      if (options.onProgress) {
        const elapsedSec = Math.max((performance.now() - startTime) / 1000, 0.001);
        const rate = loaded / elapsedSec;
        const total = options.total;
        const progress = total !== undefined && total > 0 ? loaded / total : undefined;
        const estimated =
          total !== undefined && rate > 0
            ? Math.max(0, (total - loaded) / rate)
            : undefined;
        options.onProgress({
          loaded,
          total,
          progress,
          bytes: chunkBytes,
          rate,
          estimated,
          ...(options.direction === "upload"
            ? { upload: true }
            : { download: true }),
          lengthComputable: total !== undefined,
        });
      }

      controller.enqueue(value);
    },
    async cancel(reason) {
      if (reader) {
        await reader.cancel(reason).catch(() => {});
      }
    },
  });
}

function concatChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function decodeBytes(
  bytes: Uint8Array,
  responseEncoding?: HttpResponseEncoding,
): string {
  if (!responseEncoding) {
    return new TextDecoder("utf-8").decode(bytes);
  }

  const normalized = responseEncoding.toLowerCase();
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  switch (normalized) {
    case "utf8":
    case "utf-8":
      return buf.toString("utf8");
    case "ascii":
      return buf.toString("ascii");
    case "latin1":
    case "binary":
    case "ansi":
      return buf.toString("latin1");
    case "base64":
      return buf.toString("base64");
    case "base64url":
      return buf.toString("base64url");
    case "hex":
      return buf.toString("hex");
    case "utf16le":
    case "ucs2":
    case "ucs-2":
      return buf.toString("utf16le");
    default:
      try {
        return new TextDecoder(
          responseEncoding as ConstructorParameters<typeof TextDecoder>[0],
        ).decode(bytes);
      } catch {
        return buf.toString("utf8");
      }
  }
}

function redactDotPath(target: Record<string, any>, path: string): void {
  const segments = path.split(".");
  if (segments.length === 0) return;
  for (const seg of segments) {
    if (!seg || DANGEROUS_KEYS.has(seg)) return;
  }

  let current: any = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (current === null || typeof current !== "object") {
      return;
    }
    if (current instanceof Headers) {
      // e.g. headers.x.custom -> join from current segment index `i`
      const headerName = segments.slice(i).join(".");
      if (current.has(headerName)) {
        current.set(headerName, "[REDACTED]");
      }
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(current, seg)) {
      return;
    }
    const nextVal = current[seg];
    if (nextVal && typeof nextVal === "object" && !(nextVal instanceof Headers)) {
      current[seg] = Array.isArray(nextVal) ? [...nextVal] : { ...nextVal };
    }
    current = current[seg];
  }

  const leaf = segments[segments.length - 1]!;
  if (current instanceof Headers) {
    if (current.has(leaf)) {
      current.set(leaf, "[REDACTED]");
    }
  } else if (
    current !== null &&
    typeof current === "object" &&
    Object.prototype.hasOwnProperty.call(current, leaf)
  ) {
    current[leaf] = "[REDACTED]";
  }
}

function sanitizeConfigForError<TData>(
  config: HttpRequestConfig<TData>,
): HttpRequestConfig<TData> {
  const hasRedact = Boolean(config.redact && config.redact.length > 0);
  const hasSensitive = Boolean(
    config.sensitiveHeaders && config.sensitiveHeaders.length > 0,
  );
  if (!hasRedact && !hasSensitive) {
    return config;
  }

  const clone: HttpRequestConfig<TData> = { ...config };
  const sensitiveSet = new Set(
    (config.sensitiveHeaders ?? []).map((h) => h.toLowerCase()),
  );

  if (clone.headers instanceof Headers) {
    const nextHeaders = new Headers(clone.headers);
    if (sensitiveSet.size > 0) {
      nextHeaders.forEach((_v, k) => {
        if (sensitiveSet.has(k.toLowerCase())) {
          nextHeaders.set(k, "[REDACTED]");
        }
      });
    }
    clone.headers = nextHeaders;
  } else if (clone.headers && typeof clone.headers === "object") {
    const nextHeaders: Record<string, any> = { ...clone.headers };
    if (sensitiveSet.size > 0) {
      for (const k of Object.keys(nextHeaders)) {
        if (sensitiveSet.has(k.toLowerCase())) {
          nextHeaders[k] = "[REDACTED]";
        }
      }
    }
    clone.headers = nextHeaders;
  }

  if (clone.auth && typeof clone.auth === "object") {
    clone.auth = { ...clone.auth };
  }
  if (clone.params && typeof clone.params === "object" && !(clone.params instanceof URLSearchParams)) {
    clone.params = { ...clone.params };
  }

  if (config.redact) {
    for (const path of config.redact) {
      redactDotPath(clone as Record<string, any>, path);
    }
  }

  return clone;
}

function applyTransformers<T>(
  transformers: T | T[] | undefined,
): T[] {
  if (!transformers) return [];
  return Array.isArray(transformers) ? transformers : [transformers];
}

function getOriginSafe(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Zero-dependency NestJS `@nestjs/axios`-compatible `HttpService` built natively
 * on Bun's `fetch()` API. Returns native Promises (no RxJS required).
 */
@Injectable()
export class HttpService {
  readonly defaults: HttpRequestConfig;
  readonly interceptors: {
    readonly request: HttpInterceptorManager<HttpRequestConfig>;
    readonly response: HttpInterceptorManager<HttpResponse<any>>;
  };

  private readonly requestInterceptors =
    new InterceptorManagerImpl<HttpRequestConfig>();
  private readonly responseInterceptors =
    new InterceptorManagerImpl<HttpResponse<any>>();

  constructor(
    @Optional()
    @Inject(HTTP_MODULE_OPTIONS)
    options: HttpModuleOptions = {},
  ) {
    this.defaults = { ...options };
    this.interceptors = {
      request: this.requestInterceptors,
      response: this.responseInterceptors,
    };
  }

  /**
   * NestJS `@nestjs/axios` compatibility getter returning this client instance.
   */
  get axiosRef(): this {
    return this;
  }

  async request<T = any, TData = any>(
    config: HttpRequestConfig<TData>,
  ): Promise<HttpResponse<T, TData>> {
    const mergedFetchOptions =
      this.defaults.fetchOptions || config.fetchOptions
        ? { ...this.defaults.fetchOptions, ...config.fetchOptions }
        : undefined;

    let mergedConfig: HttpRequestConfig<TData> = {
      ...this.defaults,
      ...config,
      headers: mergeHeaders(this.defaults.headers, config.headers),
      ...(mergedFetchOptions !== undefined
        ? { fetchOptions: mergedFetchOptions }
        : {}),
    };

    // Run request interceptors in registration order
    for (const handler of this.requestInterceptors.values()) {
      try {
        if (handler.onFulfilled) {
          mergedConfig = (await handler.onFulfilled(
            mergedConfig,
          )) as HttpRequestConfig<TData>;
        }
      } catch (err) {
        if (handler.onRejected) {
          const recovered = await handler.onRejected(err);
          mergedConfig = recovered as HttpRequestConfig<TData>;
        } else {
          throw err;
        }
      }
    }

    const executeRequest = async (): Promise<HttpResponse<T, TData>> => {
      const fetchFn: FetchLike =
        mergedConfig.fetch ??
        this.defaults.fetch ??
        (globalThis.fetch as FetchLike);

      const method = (mergedConfig.method ?? "GET").toUpperCase();
      const joinedUrl = joinBaseAndPath(
        mergedConfig.baseURL ?? "",
        mergedConfig.url ?? "",
        mergedConfig.allowAbsoluteUrls ?? true,
      );
      const finalUrl = appendQueryParams(
        joinedUrl,
        mergedConfig.params,
        mergedConfig.paramsSerializer,
      );
      const headers = mergeHeaders(undefined, mergedConfig.headers);

      // Basic auth (`Authorization: Basic <base64>`)
      if (mergedConfig.auth && !headers.has("authorization")) {
        const { username = "", password = "" } = mergedConfig.auth;
        const encoded = Buffer.from(`${username}:${password}`, "utf8").toString(
          "base64",
        );
        headers.set("authorization", `Basic ${encoded}`);
      }

      // XSRF cookie -> header forwarding
      if (mergedConfig.xsrfCookieName && mergedConfig.xsrfHeaderName) {
        const xsrfSetting =
          typeof mergedConfig.withXSRFToken === "function"
            ? mergedConfig.withXSRFToken(mergedConfig)
            : mergedConfig.withXSRFToken;
        const shouldAttachXsrf =
          xsrfSetting === true ||
          (xsrfSetting !== false &&
            (mergedConfig.withCredentials === true || headers.has("cookie")));

        if (shouldAttachXsrf && !headers.has(mergedConfig.xsrfHeaderName)) {
          const xsrfToken = readCookieValue(
            headers.get("cookie"),
            mergedConfig.xsrfCookieName,
          );
          if (xsrfToken !== undefined) {
            headers.set(mergedConfig.xsrfHeaderName, xsrfToken);
          }
        }
      }

      // Apply `transformRequest` pipeline before body serialization
      let requestData: unknown = mergedConfig.data;
      const reqTransformers = applyTransformers<HttpRequestTransformer>(
        mergedConfig.transformRequest,
      );
      for (let i = 0; i < reqTransformers.length; i++) {
        requestData = reqTransformers[i]!.call(
          mergedConfig,
          requestData,
          headers,
        );
      }

      let body: RequestInit["body"] | undefined;
      if (
        requestData !== undefined &&
        method !== "GET" &&
        method !== "HEAD"
      ) {
        if (isBodyPassthrough(requestData)) {
          body = requestData as RequestInit["body"];
        } else {
          if (!headers.has("content-type")) {
            headers.set("content-type", "application/json");
          }
          body = JSON.stringify(requestData);
        }
      }

      // Enforce `maxBodyLength` and wire `onUploadProgress`
      const maxBodyLength = mergedConfig.maxBodyLength;
      const knownBodyLen = measureKnownBodyLength(body);
      if (
        maxBodyLength !== undefined &&
        maxBodyLength >= 0 &&
        knownBodyLen !== undefined &&
        knownBodyLen > maxBodyLength
      ) {
        throw new HttpError<T, TData>(
          `Request body larger than maxBodyLength limit (${maxBodyLength})`,
          sanitizeConfigForError(mergedConfig),
          "ERR_FR_MAX_BODY_LENGTH_EXCEEDED",
        );
      }

      if (body instanceof ReadableStream) {
        if (
          (maxBodyLength !== undefined && maxBodyLength >= 0) ||
          mergedConfig.onUploadProgress
        ) {
          body = wrapByteStream(body as ReadableStream<Uint8Array>, {
            direction: "upload",
            maxBytes: maxBodyLength,
            maxBytesError: () =>
              new HttpError<T, TData>(
                `Request body larger than maxBodyLength limit (${maxBodyLength})`,
                sanitizeConfigForError(mergedConfig),
                "ERR_FR_MAX_BODY_LENGTH_EXCEEDED",
              ),
            onProgress: mergedConfig.onUploadProgress,
          });
        }
      } else if (
        body !== undefined &&
        mergedConfig.onUploadProgress &&
        knownBodyLen !== undefined
      ) {
        mergedConfig.onUploadProgress({
          loaded: knownBodyLen,
          total: knownBodyLen,
          progress: knownBodyLen > 0 ? 1 : 0,
          bytes: knownBodyLen,
          estimated: 0,
          upload: true,
          lengthComputable: true,
        });
      }

      // Resolve credentials (`credentials` takes precedence over `withCredentials`)
      const resolvedCredentials: RequestInit["credentials"] | undefined =
        mergedConfig.credentials !== undefined
          ? mergedConfig.credentials
          : mergedConfig.withCredentials === true
            ? "include"
            : mergedConfig.withCredentials === false
              ? "omit"
              : undefined;

      // Resolve Bun-native proxy option
      const resolvedProxy = mergedConfig.proxy
        ? formatProxyUrl(mergedConfig.proxy)
        : undefined;

      // Redirect strategy
      const manualRedirectLoop =
        mergedConfig.maxRedirects !== 0 &&
        ((mergedConfig.maxRedirects !== undefined &&
          mergedConfig.maxRedirects > 0) ||
          mergedConfig.beforeRedirect !== undefined);
      const effectiveRedirect: RequestInit["redirect"] | undefined =
        mergedConfig.maxRedirects === 0 || manualRedirectLoop
          ? "manual"
          : mergedConfig.redirect;

      const retries = Math.max(0, Math.floor(mergedConfig.retries ?? 0));
      const retryDelayMs = Math.max(0, mergedConfig.retryDelayMs ?? 100);
      const validateStatus =
        mergedConfig.validateStatus === null
          ? () => true
          : (mergedConfig.validateStatus ?? defaultValidateStatus);

      let lastError: unknown;

      for (let attempt = 0; attempt <= retries; attempt++) {
        const { signal, timeoutSignal } = combineSignals(
          mergedConfig.signal,
          mergedConfig.timeout,
        );

        try {
          let currentUrl = finalUrl;
          let currentMethod = method;
          let currentHeaders = new Headers(headers);
          let currentBody = body;
          let redirectCount = 0;
          const redirectLimit =
            mergedConfig.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

          let rawResponse: Response;
          while (true) {
            const fetchInit: Record<string, any> = {
              ...(mergedConfig.fetchOptions ?? {}),
              method: currentMethod,
              headers: currentHeaders,
              body: currentBody,
              signal,
            };

            if (effectiveRedirect !== undefined) {
              fetchInit.redirect = effectiveRedirect;
            }
            if (resolvedCredentials !== undefined) {
              fetchInit.credentials = resolvedCredentials;
            }
            if (mergedConfig.decompress !== undefined) {
              fetchInit.decompress = mergedConfig.decompress;
            }
            if (resolvedProxy !== undefined) {
              fetchInit.proxy = resolvedProxy;
            }

            rawResponse = await fetchFn(currentUrl, fetchInit as RequestInit);

            if (!manualRedirectLoop) {
              break;
            }

            const location = rawResponse.headers.get("location");
            if (
              !REDIRECT_STATUS_CODES.has(rawResponse.status) ||
              !location
            ) {
              break;
            }

            if (redirectCount >= redirectLimit) {
              await rawResponse.body?.cancel().catch(() => {});
              throw new HttpError<T, TData>(
                `Maximum number of redirects exceeded (${redirectLimit})`,
                sanitizeConfigForError(mergedConfig),
                "ERR_FR_TOO_MANY_REDIRECTS",
              );
            }

            const previousUrl = currentUrl;
            const previousMethod = currentMethod;
            const previousHeadersRecord = headersToRecord(currentHeaders);
            let nextUrl: string;
            try {
              nextUrl = new URL(location, currentUrl).toString();
            } catch {
              nextUrl = location;
            }

            let nextMethod = currentMethod;
            let nextBody = currentBody;
            if (
              rawResponse.status === 303 ||
              ((rawResponse.status === 301 || rawResponse.status === 302) &&
                currentMethod === "POST")
            ) {
              nextMethod = "GET";
              nextBody = undefined;
              currentHeaders.delete("content-type");
              currentHeaders.delete("content-length");
            }

            // Strip sensitive headers across origins
            const prevOrigin = getOriginSafe(previousUrl);
            const nextOrigin = getOriginSafe(nextUrl);
            if (prevOrigin && nextOrigin && prevOrigin !== nextOrigin) {
              currentHeaders.delete("authorization");
              currentHeaders.delete("cookie");
              currentHeaders.delete("proxy-authorization");
              if (mergedConfig.xsrfHeaderName) {
                currentHeaders.delete(mergedConfig.xsrfHeaderName);
              }
            }

            const redirectOptions: Record<string, any> = {
              url: nextUrl,
              method: nextMethod,
              headers: headersToRecord(currentHeaders),
            };

            if (mergedConfig.beforeRedirect) {
              mergedConfig.beforeRedirect(
                redirectOptions,
                {
                  headers: headersToRecord(rawResponse.headers),
                  statusCode: rawResponse.status,
                },
                {
                  headers: previousHeadersRecord,
                  url: previousUrl,
                  method: previousMethod,
                },
              );
            }

            await rawResponse.body?.cancel().catch(() => {});

            currentUrl = String(redirectOptions.url ?? nextUrl);
            currentMethod = String(redirectOptions.method ?? nextMethod).toUpperCase();
            currentHeaders = mergeHeaders(undefined, redirectOptions.headers);
            currentBody =
              currentMethod === "GET" || currentMethod === "HEAD"
                ? undefined
                : nextBody;
            redirectCount++;
          }

          let parsedData: T = (await this.parseResponseBody<T>(
            rawResponse,
            mergedConfig,
          )) as T;

          const responseHeadersRecord = headersToRecord(rawResponse.headers);

          // Apply `transformResponse` pipeline
          const resTransformers = applyTransformers<HttpResponseTransformer>(
            mergedConfig.transformResponse,
          );
          for (let i = 0; i < resTransformers.length; i++) {
            parsedData = resTransformers[i]!.call(
              mergedConfig,
              parsedData,
              responseHeadersRecord,
              rawResponse.status,
            ) as T;
          }

          const response: HttpResponse<T, TData> = {
            data: parsedData,
            status: rawResponse.status,
            statusText: rawResponse.statusText,
            headers: responseHeadersRecord,
            rawHeaders: rawResponse.headers,
            config: mergedConfig,
            rawResponse,
          };

          if (!validateStatus(rawResponse.status)) {
            const safeConfig = sanitizeConfigForError(mergedConfig);
            const safeResponse: HttpResponse<T, TData> =
              safeConfig === mergedConfig
                ? response
                : { ...response, config: safeConfig };
            const err = new HttpError<T, TData>(
              `Request failed with status code ${rawResponse.status}`,
              safeConfig,
              rawResponse.status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST",
              safeResponse,
            );
            if (rawResponse.status >= 500 && attempt < retries) {
              lastError = err;
              await sleep(retryDelayMs);
              continue;
            }
            throw err;
          }

          return response;
        } catch (err) {
          if (err instanceof HttpError) {
            throw err;
          }
          const isTimedOut =
            timeoutSignal?.aborted === true && !mergedConfig.signal?.aborted;
          const isAbortOrTimeout =
            isTimedOut ||
            (err instanceof Error &&
              (err.name === "TimeoutError" || err.name === "AbortError"));

          const errorMessage = isTimedOut
            ? (mergedConfig.timeoutErrorMessage ??
              (mergedConfig.timeout !== undefined
                ? `timeout of ${mergedConfig.timeout}ms exceeded`
                : err instanceof Error
                  ? err.message
                  : String(err)))
            : err instanceof Error
              ? err.message
              : String(err);

          const wrapped = new HttpError<T, TData>(
            errorMessage,
            sanitizeConfigForError(mergedConfig),
            isAbortOrTimeout ? "ECONNABORTED" : "ERR_NETWORK",
            undefined,
            err,
          );
          if (attempt < retries && !mergedConfig.signal?.aborted) {
            lastError = wrapped;
            await sleep(retryDelayMs);
            continue;
          }
          throw wrapped;
        }
      }

      throw lastError;
    };

    try {
      let response = await executeRequest();
      for (const handler of this.responseInterceptors.values()) {
        if (handler.onFulfilled) {
          response = (await handler.onFulfilled(response)) as HttpResponse<
            T,
            TData
          >;
        }
      }
      return response;
    } catch (err) {
      let currentError: unknown = err;
      for (const handler of this.responseInterceptors.values()) {
        if (handler.onRejected) {
          try {
            const recovered = await handler.onRejected(currentError);
            return recovered as HttpResponse<T, TData>;
          } catch (nextErr) {
            currentError = nextErr;
          }
        }
      }
      throw currentError;
    }
  }

  get<T = any>(
    url: string,
    config?: HttpRequestConfig,
  ): Promise<HttpResponse<T>> {
    return this.request<T>({ ...config, url, method: "GET" });
  }

  delete<T = any>(
    url: string,
    config?: HttpRequestConfig,
  ): Promise<HttpResponse<T>> {
    return this.request<T>({ ...config, url, method: "DELETE" });
  }

  head<T = any>(
    url: string,
    config?: HttpRequestConfig,
  ): Promise<HttpResponse<T>> {
    return this.request<T>({ ...config, url, method: "HEAD" });
  }

  post<T = any, TData = any>(
    url: string,
    data?: TData,
    config?: HttpRequestConfig<TData>,
  ): Promise<HttpResponse<T, TData>> {
    return this.request<T, TData>({ ...config, url, data, method: "POST" });
  }

  put<T = any, TData = any>(
    url: string,
    data?: TData,
    config?: HttpRequestConfig<TData>,
  ): Promise<HttpResponse<T, TData>> {
    return this.request<T, TData>({ ...config, url, data, method: "PUT" });
  }

  patch<T = any, TData = any>(
    url: string,
    data?: TData,
    config?: HttpRequestConfig<TData>,
  ): Promise<HttpResponse<T, TData>> {
    return this.request<T, TData>({ ...config, url, data, method: "PATCH" });
  }

  postForm<T = any, TData = any>(
    url: string,
    data?: TData,
    config?: HttpRequestConfig<FormData>,
  ): Promise<HttpResponse<T, FormData>> {
    return this.request<T, FormData>({
      ...config,
      url,
      data: toFormData(data),
      method: "POST",
    });
  }

  putForm<T = any, TData = any>(
    url: string,
    data?: TData,
    config?: HttpRequestConfig<FormData>,
  ): Promise<HttpResponse<T, FormData>> {
    return this.request<T, FormData>({
      ...config,
      url,
      data: toFormData(data),
      method: "PUT",
    });
  }

  patchForm<T = any, TData = any>(
    url: string,
    data?: TData,
    config?: HttpRequestConfig<FormData>,
  ): Promise<HttpResponse<T, FormData>> {
    return this.request<T, FormData>({
      ...config,
      url,
      data: toFormData(data),
      method: "PATCH",
    });
  }

  /**
   * Sends an RFC HTTP `QUERY` request with an optional request body.
   */
  query<T = any, TData = any>(
    url: string,
    data?: TData,
    config?: HttpRequestConfig<TData>,
  ): Promise<HttpResponse<T, TData>> {
    return this.request<T, TData>({ ...config, url, data, method: "QUERY" });
  }

  private async parseResponseBody<T, TData = any>(
    response: Response,
    config: HttpRequestConfig<TData>,
  ): Promise<T> {
    if (response.status === 204 || response.status === 304) {
      return undefined as T;
    }

    const {
      responseType,
      responseEncoding,
      parseReviver,
      maxContentLength,
      onDownloadProgress,
    } = config;

    const clHeader = response.headers.get("content-length");
    const declaredTotal =
      clHeader !== null && clHeader !== "" && Number.isFinite(Number(clHeader))
        ? Number(clHeader)
        : undefined;

    if (
      maxContentLength !== undefined &&
      maxContentLength >= 0 &&
      declaredTotal !== undefined &&
      declaredTotal > maxContentLength
    ) {
      await response.body?.cancel().catch(() => {});
      throw new HttpError<T, TData>(
        `maxContentLength size of ${maxContentLength} exceeded`,
        sanitizeConfigForError(config),
        "ERR_BAD_RESPONSE",
      );
    }

    if (responseType === "stream") {
      if (
        response.body &&
        (onDownloadProgress ||
          (maxContentLength !== undefined && maxContentLength >= 0))
      ) {
        return wrapByteStream(response.body, {
          direction: "download",
          total: declaredTotal,
          maxBytes: maxContentLength,
          maxBytesError: () =>
            new HttpError<T, TData>(
              `maxContentLength size of ${maxContentLength} exceeded`,
              sanitizeConfigForError(config),
              "ERR_BAD_RESPONSE",
            ),
          onProgress: onDownloadProgress,
        }) as T;
      }
      return response.body as T;
    }

    if (responseType === "formdata") {
      return (await response.formData()) as T;
    }

    const needsStreamedRead =
      Boolean(onDownloadProgress) ||
      (maxContentLength !== undefined && maxContentLength >= 0) ||
      (responseEncoding !== undefined &&
        responseEncoding.toLowerCase() !== "utf8" &&
        responseEncoding.toLowerCase() !== "utf-8");

    if (needsStreamedRead) {
      const bytes = await this.readResponseBytes(
        response,
        config,
        declaredTotal,
      );

      if (responseType === "arraybuffer") {
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as T;
      }
      if (responseType === "blob") {
        return new Blob([bytes], {
          type: response.headers.get("content-type") ?? "",
        }) as T;
      }

      const text = decodeBytes(bytes, responseEncoding);
      if (responseType === "text") {
        return text as T;
      }
      return this.parseTextOrJson<T>(
        text,
        response.headers.get("content-type") ?? "",
        responseType,
        parseReviver,
      );
    }

    if (responseType === "arraybuffer") {
      return (await response.arrayBuffer()) as T;
    }
    if (responseType === "blob") {
      return (await response.blob()) as T;
    }
    if (responseType === "text") {
      return (await response.text()) as T;
    }

    const text = await response.text();
    return this.parseTextOrJson<T>(
      text,
      response.headers.get("content-type") ?? "",
      responseType,
      parseReviver,
    );
  }

  private async readResponseBytes<TData>(
    response: Response,
    config: HttpRequestConfig<TData>,
    declaredTotal?: number,
  ): Promise<Uint8Array> {
    const { maxContentLength, onDownloadProgress } = config;

    if (!response.body) {
      const buf = new Uint8Array(await response.arrayBuffer());
      if (
        maxContentLength !== undefined &&
        maxContentLength >= 0 &&
        buf.byteLength > maxContentLength
      ) {
        throw new HttpError<any, TData>(
          `maxContentLength size of ${maxContentLength} exceeded`,
          sanitizeConfigForError(config),
          "ERR_BAD_RESPONSE",
        );
      }
      if (onDownloadProgress && buf.byteLength > 0) {
        onDownloadProgress({
          loaded: buf.byteLength,
          total: declaredTotal ?? buf.byteLength,
          progress: 1,
          bytes: buf.byteLength,
          estimated: 0,
          download: true,
          lengthComputable: true,
        });
      }
      return buf;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    const startTime = performance.now();
    let loaded = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunkBytes = value.byteLength;
        loaded += chunkBytes;

        if (
          maxContentLength !== undefined &&
          maxContentLength >= 0 &&
          loaded > maxContentLength
        ) {
          await reader.cancel().catch(() => {});
          throw new HttpError<any, TData>(
            `maxContentLength size of ${maxContentLength} exceeded`,
            sanitizeConfigForError(config),
            "ERR_BAD_RESPONSE",
          );
        }

        chunks.push(value);

        if (onDownloadProgress) {
          const elapsedSec = Math.max(
            (performance.now() - startTime) / 1000,
            0.001,
          );
          const rate = loaded / elapsedSec;
          const progress =
            declaredTotal !== undefined && declaredTotal > 0
              ? loaded / declaredTotal
              : undefined;
          const estimated =
            declaredTotal !== undefined && rate > 0
              ? Math.max(0, (declaredTotal - loaded) / rate)
              : undefined;
          onDownloadProgress({
            loaded,
            total: declaredTotal,
            progress,
            bytes: chunkBytes,
            rate,
            estimated,
            download: true,
            lengthComputable: declaredTotal !== undefined,
          });
        }
      }
    } finally {
      reader.releaseLock();
    }

    return concatChunks(chunks, loaded);
  }

  private parseTextOrJson<T>(
    text: string,
    contentType: string,
    responseType?: HttpRequestConfig["responseType"],
    parseReviver?: HttpRequestConfig["parseReviver"],
  ): T {
    if (text.length === 0) {
      return "" as T;
    }

    if (
      responseType === "json" ||
      contentType.includes("application/json") ||
      contentType.includes("+json")
    ) {
      try {
        return JSON.parse(text, parseReviver) as T;
      } catch {
        if (responseType === "json") {
          throw new SyntaxError("Invalid JSON response body");
        }
        return text as T;
      }
    }

    return text as T;
  }
}
