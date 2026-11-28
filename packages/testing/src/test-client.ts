import type { RoutePathInput } from "@bunest/core";
import { ensureSuffix } from "@bunest/core/common";
import type {
  FetchCapable,
  TestClientOptions,
  TestRequestOptions,
  TestRequestRedirect,
} from "./interfaces/testing.interface";
import {
  DEFAULT_TEST_BASE_URL,
  buildRequestUrl,
  buildTestRequest,
  deepEqual,
  mergeRequestHeaders,
} from "./utils/request-builder.util";

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getSetCookiesFromHeaders(headers: Headers): string[] {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function extractReplayableBody(
  options: TestRequestOptions,
): RequestInit["body"] | undefined {
  if (options.json !== undefined) {
    return JSON.stringify(options.json);
  }
  if (options.formData !== undefined) {
    return options.formData;
  }
  if (
    options.body !== undefined &&
    options.body !== null &&
    !(options.body instanceof ReadableStream)
  ) {
    return options.body;
  }
  return undefined;
}

interface StoredCookie {
  readonly value: string;
  readonly path: string;
  readonly expiresAt?: number;
}

/**
 * Lightweight RFC 6265 cookie jar used by `TestAgent` and `SupertestAgent`
 * to persist `Set-Cookie` headers (and honor `Max-Age=0` / `Expires` deletions)
 * across sequential E2E requests.
 */
export class CookieJar {
  private readonly store = new Map<string, StoredCookie>();

  set(name: string, value: string, path = "/"): void {
    this.store.set(name, { value, path });
  }

  delete(name: string): void {
    this.store.delete(name);
  }

  clear(): void {
    this.store.clear();
  }

  captureFromHeaders(headers: Headers): void {
    const rawCookies = getSetCookiesFromHeaders(headers);
    for (const raw of rawCookies) {
      const segments = raw.split(";").map((s) => s.trim());
      const pair = segments[0];
      if (!pair) {
        continue;
      }
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) {
        continue;
      }
      const name = safeDecodeURIComponent(pair.slice(0, eqIdx).trim());
      const value = safeDecodeURIComponent(pair.slice(eqIdx + 1).trim());
      if (!name) {
        continue;
      }

      let path = "/";
      let expiresAt: number | undefined;
      let expired = false;

      for (let i = 1; i < segments.length; i++) {
        const attr = segments[i];
        if (!attr) continue;
        const attrEq = attr.indexOf("=");
        const attrName = (attrEq === -1 ? attr : attr.slice(0, attrEq))
          .trim()
          .toLowerCase();
        const attrVal = attrEq === -1 ? "" : attr.slice(attrEq + 1).trim();

        if (attrName === "path" && attrVal) {
          path = attrVal;
        } else if (attrName === "max-age") {
          const seconds = Number(attrVal);
          if (!Number.isNaN(seconds)) {
            if (seconds <= 0) {
              expired = true;
            } else {
              expiresAt = Date.now() + seconds * 1000;
            }
          }
        } else if (attrName === "expires" && attrVal) {
          const parsed = Date.parse(attrVal);
          if (!Number.isNaN(parsed)) {
            if (parsed <= Date.now()) {
              expired = true;
            } else if (expiresAt === undefined) {
              expiresAt = parsed;
            }
          }
        }
      }

      if (expired) {
        this.store.delete(name);
      } else {
        this.store.set(name, { value, path, expiresAt });
      }
    }
  }

  getForPath(pathname = "/"): Record<string, string> {
    const now = Date.now();
    const out: Record<string, string> = {};
    for (const [name, entry] of this.store.entries()) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        this.store.delete(name);
        continue;
      }
      if (
        entry.path === "/" ||
        pathname === entry.path ||
        pathname.startsWith(ensureSuffix(entry.path, "/"))
      ) {
        out[name] = entry.value;
      }
    }
    return out;
  }

  getAll(): Record<string, string> {
    const now = Date.now();
    const out: Record<string, string> = {};
    for (const [name, entry] of this.store.entries()) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        this.store.delete(name);
        continue;
      }
      out[name] = entry.value;
    }
    return out;
  }
}

/**
 * Ergonomic test wrapper around a native Web `Response` with lazy body caching
 * (safe to call `.text()`, `.json()`, or `.bytes()` multiple times) and fluent
 * assertion helpers.
 */
export class TestResponse {
  private cachedBytes?: Uint8Array;
  private cachedText?: string;

  constructor(public readonly raw: Response) {}

  get status(): number {
    return this.raw.status;
  }

  get statusText(): string {
    return this.raw.statusText;
  }

  get ok(): boolean {
    return this.raw.ok;
  }

  get headers(): Headers {
    return this.raw.headers;
  }

  header(name: string): string | null {
    return this.raw.headers.get(name);
  }

  /**
   * Returns all raw `Set-Cookie` header values emitted by the response.
   */
  setCookies(): string[] {
    return getSetCookiesFromHeaders(this.raw.headers);
  }

  /**
   * Parses `Set-Cookie` headers into a simple `name -> value` map.
   */
  cookies(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const header of this.setCookies()) {
      const firstPart = header.split(";")[0]?.trim();
      if (!firstPart) {
        continue;
      }
      const eqIdx = firstPart.indexOf("=");
      if (eqIdx === -1) {
        continue;
      }
      const name = safeDecodeURIComponent(firstPart.slice(0, eqIdx).trim());
      const value = safeDecodeURIComponent(firstPart.slice(eqIdx + 1).trim());
      out[name] = value;
    }
    return out;
  }

  async bytes(): Promise<Uint8Array> {
    if (this.cachedBytes === undefined) {
      this.cachedBytes = await this.raw.bytes();
    }
    return this.cachedBytes;
  }

  async text(): Promise<string> {
    if (this.cachedText === undefined) {
      const bytes = await this.bytes();
      this.cachedText = new TextDecoder().decode(bytes);
    }
    return this.cachedText;
  }

  async json<T = unknown>(): Promise<T> {
    const text = await this.text();
    return JSON.parse(text) as T;
  }

  expectStatus(expected: number | ((status: number) => boolean | void)): this {
    if (typeof expected === "function") {
      const result = expected(this.status);
      if (result === false) {
        throw new Error(
          `Expected HTTP status predicate to pass, but received ${this.status} (${this.statusText}).`,
        );
      }
      return this;
    }
    if (this.status !== expected) {
      throw new Error(
        `Expected HTTP status ${expected}, but received ${this.status} (${this.statusText}).`,
      );
    }
    return this;
  }

  expectHeader(name: string, expected: string | RegExp): this {
    const actual = this.header(name);
    if (actual === null) {
      throw new Error(`Expected response header "${name}" to be present.`);
    }
    if (typeof expected === "string") {
      if (actual !== expected) {
        throw new Error(
          `Expected header "${name}" to equal "${expected}", but received "${actual}".`,
        );
      }
    } else if (!expected.test(actual)) {
      throw new Error(
        `Expected header "${name}" ("${actual}") to match ${String(expected)}.`,
      );
    }
    return this;
  }

  expectNoHeader(name: string): this {
    const actual = this.header(name);
    if (actual !== null) {
      throw new Error(
        `Expected response header "${name}" to be absent, but received "${actual}".`,
      );
    }
    return this;
  }

  expectCookie(name: string, expected?: string | RegExp): this {
    const cookies = this.cookies();
    if (!Object.prototype.hasOwnProperty.call(cookies, name)) {
      throw new Error(`Expected response cookie "${name}" to be set.`);
    }
    const actual = cookies[name]!;
    if (typeof expected === "string") {
      if (actual !== expected) {
        throw new Error(
          `Expected cookie "${name}" to equal "${expected}", but received "${actual}".`,
        );
      }
    } else if (expected instanceof RegExp && !expected.test(actual)) {
      throw new Error(
        `Expected cookie "${name}" ("${actual}") to match ${String(expected)}.`,
      );
    }
    return this;
  }

  async expectJson<T = unknown>(
    expected: T | ((body: T) => boolean | void),
  ): Promise<this> {
    const actual = await this.json<T>();
    if (typeof expected === "function") {
      const result = (expected as (body: T) => boolean | void)(actual);
      if (result === false) {
        throw new Error(
          `Expected JSON body predicate to pass, but received ${JSON.stringify(actual)}.`,
        );
      }
      return this;
    }
    if (!deepEqual(actual, expected)) {
      throw new Error(
        `Expected JSON body to equal ${JSON.stringify(expected)}, but received ${JSON.stringify(actual)}.`,
      );
    }
    return this;
  }

  async expectText(
    expected: string | RegExp | ((text: string) => boolean | void),
  ): Promise<this> {
    const actual = await this.text();
    if (typeof expected === "function") {
      const result = expected(actual);
      if (result === false) {
        throw new Error(
          `Expected text body predicate to pass, but received "${actual}".`,
        );
      }
      return this;
    }
    if (typeof expected === "string") {
      if (actual !== expected) {
        throw new Error(
          `Expected text body to equal "${expected}", but received "${actual}".`,
        );
      }
    } else if (!expected.test(actual)) {
      throw new Error(
        `Expected text body ("${actual}") to match ${String(expected)}.`,
      );
    }
    return this;
  }

  async expectBody(
    expected:
      | string
      | RegExp
      | Record<string, unknown>
      | unknown[]
      | ((body: unknown) => boolean | void),
  ): Promise<this> {
    if (typeof expected === "string" || expected instanceof RegExp) {
      return this.expectText(expected);
    }
    if (typeof expected === "function") {
      const contentType = this.header("content-type") ?? "";
      const text = await this.text();
      const parsed =
        /json/i.test(contentType) && text.trim().length > 0
          ? JSON.parse(text)
          : text;
      const result = expected(parsed);
      if (result === false) {
        throw new Error(
          `Expected body predicate to pass, but received ${JSON.stringify(parsed)}.`,
        );
      }
      return this;
    }
    return this.expectJson(expected);
  }
}

/**
 * Native Web `Request`/`Response` HTTP test client for Bunest.
 * Supports zero-socket in-memory testing via `BunestApplication.fetch()` as well
 * as live network requests via `TestClient.fromUrl(...)`.
 *
 * Redirects default to `"manual"` on both in-memory and live clients so
 * `@Redirect()` routes can be asserted consistently.
 */
export class TestClient {
  protected readonly baseUrl: string;
  protected readonly defaultHeaders: Readonly<Record<string, string>>;
  protected readonly defaultCookies: Readonly<Record<string, string>>;
  protected readonly isLiveNetwork: boolean;

  constructor(
    protected readonly dispatcher: FetchCapable,
    options: TestClientOptions = {},
    isLiveNetwork = false,
  ) {
    this.baseUrl = options.baseUrl ?? DEFAULT_TEST_BASE_URL;
    this.defaultHeaders = { ...(options.defaultHeaders ?? {}) };
    this.defaultCookies = { ...(options.defaultCookies ?? {}) };
    this.isLiveNetwork = isLiveNetwork;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Closes the underlying application dispatcher if it exposes a `close()` method.
   * No-op for live-URL or stateless fetch dispatchers.
   */
  async close(): Promise<void> {
    const closable = this.dispatcher as FetchCapable & {
      close?: () => Promise<void> | void;
    };
    if (typeof closable.close === "function") {
      await closable.close();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * Creates an in-memory `TestClient` backed directly by `app.fetch(req)`.
   */
  static fromApp(
    app: FetchCapable,
    options: TestClientOptions = {},
  ): TestClient {
    return new TestClient(app, options, false);
  }

  /**
   * Creates a network `TestClient` dispatching real `fetch()` calls to a live server URL.
   * Respects `redirect` (default `"manual"`) so 3xx redirects are inspectable just like `fromApp()`.
   */
  static fromUrl(
    baseUrl: string,
    options: Omit<TestClientOptions, "baseUrl"> = {},
  ): TestClient {
    return new TestClient(
      {
        fetch: (req: Request) =>
          globalThis.fetch(req, {
            redirect: req.redirect ?? "manual",
          }),
      },
      { ...options, baseUrl },
      true,
    );
  }

  /**
   * Creates a stateful `TestAgent` that persists cookies across requests.
   */
  static agent(
    target: FetchCapable | string,
    options: TestClientOptions = {},
  ): TestAgent {
    if (typeof target === "string") {
      return TestClient.fromUrl(target, options).agent();
    }
    return TestClient.fromApp(target, options).agent();
  }

  /**
   * Spawns a stateful `TestAgent` sharing this client's target, baseUrl, default headers, and cookies.
   */
  agent(options: TestClientOptions = {}): TestAgent {
    return new TestAgent(
      this.dispatcher,
      {
        baseUrl: options.baseUrl ?? this.baseUrl,
        defaultHeaders: {
          ...this.defaultHeaders,
          ...(options.defaultHeaders ?? {}),
        },
        defaultCookies: {
          ...this.defaultCookies,
          ...(options.defaultCookies ?? {}),
        },
      },
      new CookieJar(),
      this.isLiveNetwork,
    );
  }

  /**
   * Returns a new `TestClient` with additional default headers merged on top of existing defaults.
   */
  withHeaders(headers: Record<string, string>): TestClient {
    return new TestClient(
      this.dispatcher,
      {
        baseUrl: this.baseUrl,
        defaultHeaders: {
          ...this.defaultHeaders,
          ...headers,
        },
        defaultCookies: this.defaultCookies,
      },
      this.isLiveNetwork,
    );
  }

  /**
   * Returns a new `TestClient` sending `Authorization: Bearer <token>` on every request.
   */
  withBearerToken(token: string): TestClient {
    return this.withHeaders({ Authorization: `Bearer ${token}` });
  }

  /**
   * Returns a new `TestClient` with additional default cookies merged on top of existing defaults.
   */
  withCookies(cookies: Record<string, string>): TestClient {
    return new TestClient(
      this.dispatcher,
      {
        baseUrl: this.baseUrl,
        defaultHeaders: this.defaultHeaders,
        defaultCookies: {
          ...this.defaultCookies,
          ...cookies,
        },
      },
      this.isLiveNetwork,
    );
  }

  /**
   * Raw Web `fetch`-style dispatch through the underlying application or server.
   */
  fetch(input: Request | string, init?: RequestInit): Promise<Response> {
    if (input instanceof Request) {
      const defaultEntries = Object.entries(this.defaultHeaders);
      const cookieEntries = Object.entries(this.defaultCookies);
      if (defaultEntries.length === 0 && cookieEntries.length === 0) {
        return this.dispatcher.fetch(input);
      }
      const headers = new Headers(input.headers);
      for (const [key, value] of defaultEntries) {
        if (!headers.has(key)) {
          headers.set(key, value);
        }
      }
      if (cookieEntries.length > 0) {
        const serialized = cookieEntries
          .map(
            ([name, val]) =>
              `${encodeURIComponent(name)}=${encodeURIComponent(val)}`,
          )
          .join("; ");
        const existing = headers.get("cookie");
        headers.set(
          "cookie",
          existing ? `${existing}; ${serialized}` : serialized,
        );
      }
      return this.dispatcher.fetch(new Request(input, { headers }));
    }

    const url = buildRequestUrl(this.baseUrl, input);
    const initHeaders = Array.isArray(init?.headers)
      ? new Headers(init.headers)
      : (init?.headers as Headers | Record<string, string> | undefined);
    const headers = mergeRequestHeaders(
      this.defaultHeaders,
      initHeaders,
      Object.keys(this.defaultCookies).length > 0
        ? this.defaultCookies
        : undefined,
    );
    return this.dispatcher.fetch(
      new Request(url, {
        ...init,
        headers,
        redirect: init?.redirect ?? "manual",
      }),
    );
  }

  async request(
    method: string,
    path: string,
    options: TestRequestOptions = {},
  ): Promise<TestResponse> {
    const mergedCookies =
      Object.keys(this.defaultCookies).length > 0 || options.cookies
        ? {
            ...this.defaultCookies,
            ...(options.cookies ?? {}),
          }
        : undefined;

    const redirectPolicy = options.redirect ?? "manual";
    const effectiveOptions: TestRequestOptions = {
      ...options,
      cookies: mergedCookies,
      // Always dispatch single hops with "manual" so dispatchWithRedirectPolicy
      // handles "follow" / "error" uniformly across in-memory and live clients.
      redirect: "manual",
    };

    const req = buildTestRequest(
      method,
      this.baseUrl,
      path,
      this.defaultHeaders,
      effectiveOptions,
    );

    const res = await this.dispatchWithRedirectPolicy(
      req,
      redirectPolicy,
      undefined,
      undefined,
      extractReplayableBody(options),
      options.signal,
    );
    return new TestResponse(res);
  }

  get(
    path: RoutePathInput<"GET">,
    options?: Omit<TestRequestOptions, "json" | "body" | "formData">,
  ): Promise<TestResponse> {
    return this.request("GET", path, options);
  }

  post(
    path: RoutePathInput<"POST">,
    options?: TestRequestOptions,
  ): Promise<TestResponse> {
    return this.request("POST", path, options);
  }

  put(
    path: RoutePathInput<"PUT">,
    options?: TestRequestOptions,
  ): Promise<TestResponse> {
    return this.request("PUT", path, options);
  }

  patch(
    path: RoutePathInput<"PATCH">,
    options?: TestRequestOptions,
  ): Promise<TestResponse> {
    return this.request("PATCH", path, options);
  }

  delete(
    path: RoutePathInput<"DELETE">,
    options?: TestRequestOptions,
  ): Promise<TestResponse> {
    return this.request("DELETE", path, options);
  }

  head(
    path: RoutePathInput<"HEAD">,
    options?: Omit<TestRequestOptions, "json" | "body" | "formData">,
  ): Promise<TestResponse> {
    return this.request("HEAD", path, options);
  }

  options(
    path: RoutePathInput<"OPTIONS">,
    options?: Omit<TestRequestOptions, "json" | "body" | "formData">,
  ): Promise<TestResponse> {
    return this.request("OPTIONS", path, options);
  }

  protected async dispatchWithRedirectPolicy(
    initialRequest: Request,
    redirectPolicy: TestRequestRedirect,
    onResponse?: (res: Response) => void,
    buildRedirectCookies?: (
      pathname: string,
    ) => Record<string, string> | undefined,
    replayBody?: RequestInit["body"],
    signal?: AbortSignal,
  ): Promise<Response> {
    let currentReq = initialRequest;
    let res = await this.dispatcher.fetch(currentReq);
    onResponse?.(res);

    if (redirectPolicy === "manual") {
      return res;
    }

    if (redirectPolicy === "error" && isRedirectStatus(res.status)) {
      throw new TypeError(
        `Unexpected redirect (${res.status}) while redirect mode is "error".`,
      );
    }

    let hops = 0;
    const maxHops = 20;
    while (isRedirectStatus(res.status) && hops < maxHops) {
      const location = res.headers.get("location");
      if (!location) {
        break;
      }
      hops += 1;

      const prevUrl = new URL(currentReq.url);
      const nextUrl = new URL(location, prevUrl);
      const sameOrigin = nextUrl.origin === prevUrl.origin;
      const nextHeaders = new Headers(currentReq.headers);
      if (!sameOrigin) {
        nextHeaders.delete("authorization");
        nextHeaders.delete("cookie");
      }

      if (buildRedirectCookies) {
        // Always clear previous hop's Cookie header so path-scoped cookies
        // (e.g. Path=/admin) never leak onto redirected paths (e.g. /public).
        nextHeaders.delete("cookie");
        if (sameOrigin) {
          const jarCookies = buildRedirectCookies(nextUrl.pathname);
          if (jarCookies && Object.keys(jarCookies).length > 0) {
            nextHeaders.set(
              "cookie",
              Object.entries(jarCookies)
                .map(
                  ([name, val]) =>
                    `${encodeURIComponent(name)}=${encodeURIComponent(val)}`,
                )
                .join("; "),
            );
          }
        }
      }

      const nextMethod =
        res.status === 303 ||
        ((res.status === 301 || res.status === 302) &&
          currentReq.method === "POST")
          ? "GET"
          : currentReq.method;

      if (nextMethod === "GET") {
        nextHeaders.delete("content-type");
        nextHeaders.delete("content-length");
      }

      const hopInit: RequestInit = {
        method: nextMethod,
        headers: nextHeaders,
        redirect: "manual",
        signal,
      };

      if (
        nextMethod !== "GET" &&
        nextMethod !== "HEAD" &&
        replayBody !== undefined
      ) {
        hopInit.body = replayBody;
      }

      currentReq = new Request(nextUrl.toString(), hopInit);

      res = await this.dispatcher.fetch(currentReq);
      onResponse?.(res);
    }

    return res;
  }
}

/**
 * Stateful cookie-persisting `TestClient` (equivalent to `supertest.agent(app)`).
 * Automatically captures `Set-Cookie` headers from every response and sends
 * matching cookies on subsequent requests.
 */
export class TestAgent extends TestClient {
  constructor(
    dispatcher: FetchCapable,
    options: TestClientOptions = {},
    private readonly jar: CookieJar = new CookieJar(),
    isLiveNetwork = false,
  ) {
    super(dispatcher, options, isLiveNetwork);
  }

  getCookies(): Record<string, string> {
    return this.jar.getAll();
  }

  setCookie(name: string, value: string, path = "/"): this {
    this.jar.set(name, value, path);
    return this;
  }

  clearCookies(): this {
    this.jar.clear();
    return this;
  }

  override withHeaders(headers: Record<string, string>): TestAgent {
    return new TestAgent(
      this.dispatcher,
      {
        baseUrl: this.baseUrl,
        defaultHeaders: {
          ...this.defaultHeaders,
          ...headers,
        },
        defaultCookies: this.defaultCookies,
      },
      this.jar,
      this.isLiveNetwork,
    );
  }

  override withBearerToken(token: string): TestAgent {
    return this.withHeaders({ Authorization: `Bearer ${token}` });
  }

  override withCookies(cookies: Record<string, string>): TestAgent {
    return new TestAgent(
      this.dispatcher,
      {
        baseUrl: this.baseUrl,
        defaultHeaders: this.defaultHeaders,
        defaultCookies: {
          ...this.defaultCookies,
          ...cookies,
        },
      },
      this.jar,
      this.isLiveNetwork,
    );
  }

  override async fetch(
    input: Request | string,
    init?: RequestInit,
  ): Promise<Response> {
    const targetUrl =
      input instanceof Request
        ? new URL(input.url)
        : new URL(buildRequestUrl(this.baseUrl, input));
    const jarCookies = this.jar.getForPath(targetUrl.pathname);

    if (Object.keys(jarCookies).length > 0) {
      const merged = { ...jarCookies, ...this.defaultCookies };
      const tempClient = new TestClient(
        this.dispatcher,
        {
          baseUrl: this.baseUrl,
          defaultHeaders: this.defaultHeaders,
          defaultCookies: merged,
        },
        this.isLiveNetwork,
      );
      const res = await tempClient.fetch(input, init);
      this.jar.captureFromHeaders(res.headers);
      return res;
    }

    const res = await super.fetch(input, init);
    this.jar.captureFromHeaders(res.headers);
    return res;
  }

  override async request(
    method: string,
    path: string,
    options: TestRequestOptions = {},
  ): Promise<TestResponse> {
    const resolvedUrl = new URL(
      buildRequestUrl(this.baseUrl, path, options.query),
    );
    const jarCookies = this.jar.getForPath(resolvedUrl.pathname);
    const mergedCookies: Record<string, string> = {
      ...jarCookies,
      ...this.defaultCookies,
      ...(options.cookies ?? {}),
    };

    const redirectPolicy = options.redirect ?? "manual";
    const effectiveOptions: TestRequestOptions = {
      ...options,
      cookies:
        Object.keys(mergedCookies).length > 0 ? mergedCookies : undefined,
      redirect: "manual",
    };

    const req = buildTestRequest(
      method,
      this.baseUrl,
      path,
      this.defaultHeaders,
      effectiveOptions,
    );

    const res = await this.dispatchWithRedirectPolicy(
      req,
      redirectPolicy,
      (response) => this.jar.captureFromHeaders(response.headers),
      (pathname) => ({
        ...this.jar.getForPath(pathname),
        ...this.defaultCookies,
      }),
      extractReplayableBody(options),
      options.signal,
    );

    return new TestResponse(res);
  }
}
