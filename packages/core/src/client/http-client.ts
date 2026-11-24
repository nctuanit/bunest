import type { Type } from "../common/index";
import { HttpNetworkError } from "./errors/http-network.error";
import { HttpTimeoutError } from "./errors/http-timeout.error";
import type {
  HttpClientInterceptor,
  HttpClientInterceptorFn,
  HttpHandler,
} from "./interfaces/http-client-interceptor.interface";
import type {
  HttpClientOptions,
  HttpDispatcher,
} from "./interfaces/http-client-options.interface";
import type {
  HttpRequest,
  HttpRequestOptions,
} from "./interfaces/http-request.interface";
import type { HttpResponse } from "./interfaces/http-response.interface";
import { toBodyError, toClientError } from "./utils/client-error.util";
import {
  checkInterceptor,
  isInterceptorClass,
} from "./utils/client-options.util";
import { durationOption } from "./utils/duration.util";
import { mergeHeaders } from "./utils/headers.util";
import {
  fetchWithinOrigin,
  type ExtendedRequestInit,
} from "./utils/redirect.util";
import { claimStreamBody, isReplayableBody } from "./utils/request-body.util";
import { discard, finish, isResponse, settleBy } from "./utils/response.util";
import {
  backoffDelay,
  isTransient,
  mergeRetry,
  resolveRetry,
  retryDelay,
  shouldRetry,
} from "./utils/retry.util";
import { anySignal, createTimer, sleep } from "./utils/timers.util";
import {
  appendQuery,
  applyPathParams,
  assertSendableUrl,
  parseBaseUrl,
  resolveUrl,
} from "./utils/url.util";

/** Options of the verb methods, which set `method` themselves. */
type HttpVerbOptions = Omit<HttpRequestOptions, "method">;

/** Call signature shared by `request()` and the verb methods; `data` follows `responseType`. */
export interface HttpMethodCall<O extends object = HttpRequestOptions> {
  (
    url: string,
    options: O & {
      responseType: "stream";
    },
  ): Promise<HttpResponse<ReadableStream<Uint8Array>>>;
  (
    url: string,
    options: O & {
      responseType: "text";
    },
  ): Promise<HttpResponse<string>>;
  (
    url: string,
    options: O & {
      responseType: "arrayBuffer";
    },
  ): Promise<HttpResponse<ArrayBuffer>>;
  (
    url: string,
    options: O & {
      responseType: "response";
    },
  ): Promise<HttpResponse<Response>>;
  /** `T` describes the parsed JSON body; nothing validates it at runtime. */
  <T = unknown>(url: string, options?: O): Promise<HttpResponse<T>>;
}

type InterceptorResolver = (
  type: Type<HttpClientInterceptor>,
) => HttpClientInterceptor | Promise<HttpClientInterceptor>;

interface TransportOptions {
  redirect?: "follow" | "error" | "manual" | undefined;
  dispatcher?: HttpDispatcher | undefined;
}

/**
 * Promise-based HTTP client on the platform `fetch`. Injected as `HttpClient`
 * (default client) or `@InjectHttpClient(name)`; also usable with `new`.
 */
export class HttpClient {
  readonly request: HttpMethodCall;
  readonly get: HttpMethodCall<HttpVerbOptions>;
  readonly post: HttpMethodCall<HttpVerbOptions>;
  readonly put: HttpMethodCall<HttpVerbOptions>;
  readonly patch: HttpMethodCall<HttpVerbOptions>;
  readonly delete: HttpMethodCall<HttpVerbOptions>;
  readonly head: HttpMethodCall<HttpVerbOptions>;
  readonly options: HttpMethodCall<HttpVerbOptions>;

  private readonly config: HttpClientOptions;
  private readonly baseUrl: URL | undefined;
  private readonly baseHeaders: Headers;
  private readonly timeout: number | undefined;
  private readonly retry: HttpClientOptions["retry"];
  /** Outside DI, class interceptors are created with `new`. */
  private resolveInterceptor: InterceptorResolver = (type) => new type();
  private interceptorFns?: Promise<HttpClientInterceptorFn[]>;

  /** Throws a `TypeError` naming the option for an invalid `baseUrl`, duration, retry option or interceptor. */
  constructor(options: HttpClientOptions = {}) {
    this.request = ((url: string, reqOptions?: HttpRequestOptions) =>
      this.send(url, reqOptions)) as HttpMethodCall;
    this.get = this.verb("GET");
    this.post = this.verb("POST");
    this.put = this.verb("PUT");
    this.patch = this.verb("PATCH");
    this.delete = this.verb("DELETE");
    this.head = this.verb("HEAD");
    this.options = this.verb("OPTIONS");

    this.config = options;
    this.baseUrl = parseBaseUrl(options.baseUrl);
    this.baseHeaders = mergeHeaders(new Headers(), options.headers);
    this.timeout =
      options.timeout === undefined
        ? undefined
        : durationOption(options.timeout, "timeout");
    this.retry = options.retry;
    resolveRetry(options.retry);
    (options.interceptors ?? []).forEach(checkInterceptor);
  }

  private verb(method: string): HttpMethodCall<HttpVerbOptions> {
    return ((url: string, options?: HttpVerbOptions) =>
      this.send(url, {
        ...options,
        method,
      })) as HttpMethodCall<HttpVerbOptions>;
  }

  private async send(
    path: string,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponse<unknown>> {
    const config = this.config;
    const method = (options.method ?? "GET").toUpperCase();
    const url = appendQuery(
      resolveUrl(this.baseUrl, applyPathParams(path, options.params)),
      options.query,
    );
    const headers = mergeHeaders(
      new Headers(this.baseHeaders),
      options.headers,
    );

    let body = options.body;
    if (options.json !== undefined) {
      if (body !== undefined) {
        throw new TypeError("Pass either `json` or `body`, not both");
      }
      body = JSON.stringify(options.json);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    }

    if (body != null && (method === "GET" || method === "HEAD")) {
      throw new TypeError(
        `A ${method} request can't have a body. Send the values in \`query\`.`,
      );
    }

    const responseType = options.responseType ?? "auto";
    const timeout =
      options.timeout === undefined
        ? this.timeout
        : durationOption(options.timeout, "timeout");
    const throwOnHttpError =
      options.throwOnHttpError ?? config.throwOnHttpError ?? true;
    const transport: TransportOptions = {
      redirect: options.redirect ?? config.redirect,
      dispatcher: options.dispatcher ?? config.dispatcher,
    };
    const retry = resolveRetry(mergeRetry(this.retry, options.retry));
    const retryable =
      Boolean(retry) &&
      retry!.methods.includes(method) &&
      isReplayableBody(body);
    const signal = options.signal;
    const interceptors = await this.resolveInterceptors();

    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      const canRetry = retryable && attempt < retry!.attempts;
      const timer = createTimer(timeout);
      const request: HttpRequest = {
        method,
        url: new URL(url),
        headers: new Headers(headers),
        body,
        signal: anySignal(signal, timer?.signal),
        attempt,
        context: { ...options.context },
      };

      let sent = request;
      const ownFailures = new WeakSet<object>();
      const received: Response[] = [];

      const terminal: HttpHandler = async (req) => {
        sent = req;
        assertSendableUrl(req.url);
        claimStreamBody(req.body);
        try {
          const response = await this.fetch(req, transport);
          received.push(response);
          return response;
        } catch (error) {
          const failure = toClientError(error, req, timer, timeout, signal);
          if (
            isTransient(failure) &&
            typeof failure === "object" &&
            failure !== null
          ) {
            ownFailures.add(failure);
          }
          throw failure;
        }
      };

      const handler = interceptors.reduceRight<HttpHandler>(
        (next, intercept) => (req) => intercept(req, next),
        terminal,
      );

      let response: Response;
      try {
        response = await settleBy(
          Promise.resolve(handler(request)),
          request.signal,
        );
      } catch (error) {
        timer?.clear();
        received.forEach(discard);
        const failure = toClientError(error, sent, timer, timeout, signal);
        const own =
          (typeof failure === "object" &&
            failure !== null &&
            ownFailures.has(failure)) ||
          (failure !== error && failure instanceof HttpTimeoutError);
        if (
          canRetry &&
          own &&
          isTransient(failure) &&
          shouldRetry(retry!, failure, attempt)
        ) {
          await sleep(backoffDelay(retry!, attempt, failure), signal);
          continue;
        }
        throw failure;
      }

      received
        .filter((other) => other !== response && other.body !== response?.body)
        .forEach(discard);

      if (!isResponse(response)) {
        timer?.clear();
        throw new TypeError(
          `The request resolved to ${response === null ? "null" : typeof response} instead of a ` +
            "Response. An interceptor must return what next() resolves to (`return next(request)`), " +
            "and a custom `fetch` must resolve to a Response.",
        );
      }

      if (
        !response.ok &&
        canRetry &&
        retry!.statusCodes.includes(response.status)
      ) {
        let delay: number | undefined;
        try {
          delay = await retryDelay(retry!, response, sent, attempt, signal);
        } catch (error) {
          timer?.clear();
          discard(response);
          throw error;
        }
        if (delay !== undefined) {
          timer?.clear();
          discard(response);
          await sleep(delay, signal);
          continue;
        }
      }

      const leavesBodyUnread =
        responseType === "stream" || responseType === "response";
      if (leavesBodyUnread && (response.ok || !throwOnHttpError)) {
        timer?.clear();
      }

      try {
        return await finish(
          response,
          sent,
          responseType,
          throwOnHttpError,
          signal,
        );
      } catch (error) {
        const failure = toBodyError(error, sent, timer, timeout, signal);
        discard(response);
        if (
          canRetry &&
          isTransient(failure) &&
          shouldRetry(retry!, failure, attempt)
        ) {
          timer?.clear();
          await sleep(backoffDelay(retry!, attempt, failure), signal);
          continue;
        }
        throw failure;
      } finally {
        timer?.clear();
      }
    }
  }

  private async fetch(
    req: HttpRequest,
    transport: TransportOptions,
  ): Promise<Response> {
    const fetchImpl = this.config.fetch ?? globalThis.fetch;
    const init: ExtendedRequestInit = {
      method: req.method,
      headers: req.headers,
      body: req.body as RequestInit["body"],
      signal: req.signal,
    };
    if (transport.redirect) {
      init.redirect = transport.redirect;
    }
    if (transport.dispatcher) {
      init.dispatcher = transport.dispatcher;
    }
    if (!isReplayableBody(req.body)) {
      init.duplex = "half";
    }

    try {
      return this.baseUrl && !transport.redirect
        ? await fetchWithinOrigin(fetchImpl, req.url, init, this.baseUrl.origin)
        : await fetchImpl(req.url, init as RequestInit);
    } catch (error) {
      if (req.signal.aborted) {
        throw error;
      }
      throw new HttpNetworkError({
        method: req.method,
        url: req.url.href,
        cause:
          (error as { cause?: unknown } | null | undefined)?.cause ?? error,
      });
    }
  }

  private resolveInterceptors(): Promise<HttpClientInterceptorFn[]> {
    this.interceptorFns ??= Promise.all(
      (this.config.interceptors ?? []).map(async (entry) => {
        if (isInterceptorClass(entry)) {
          const instance = await this.resolveInterceptor(entry);
          return instance.intercept.bind(instance);
        }
        if (typeof entry === "function") {
          return entry;
        }
        return entry.intercept.bind(entry);
      }),
    ).catch((error) => {
      this.interceptorFns = undefined;
      throw error;
    });
    return this.interceptorFns;
  }
}

/** Used by `HttpClientModule`: class interceptors come from the DI container. */
export function createHttpClient(
  options: HttpClientOptions,
  resolveInterceptor: InterceptorResolver,
): HttpClient {
  const client = new HttpClient(options);
  (
    client as unknown as { resolveInterceptor: InterceptorResolver }
  ).resolveInterceptor = resolveInterceptor;
  return client;
}

/**
 * Resolves the client's interceptors now instead of on the first request.
 * `HttpClientModule` calls it from `onModuleInit`, so a class interceptor
 * whose dependencies can't be resolved fails the bootstrap.
 */
export async function initHttpClient(client: HttpClient): Promise<void> {
  await (
    client as unknown as {
      resolveInterceptors(): Promise<HttpClientInterceptorFn[]>;
    }
  ).resolveInterceptors();
}
