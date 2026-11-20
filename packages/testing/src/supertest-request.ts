import type {
  FetchCapable,
  QueryParamValue,
  TestClientOptions,
} from "./interfaces/testing.interface";
import { CookieJar, TestClient, TestResponse } from "./test-client";
import {
  DEFAULT_TEST_BASE_URL,
  buildRequestUrl,
  deepEqual,
} from "./utils/request-builder.util";

export type SupertestTarget = FetchCapable | string | { readonly url: URL };

export interface SupertestResponse {
  readonly status: number;
  readonly statusCode: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers: Record<string, string | string[]>;
  readonly rawHeaders: Headers;
  readonly text: string;
  readonly body: any;
  readonly bytes: Uint8Array;
  readonly raw: Response;
  readonly cookies: Record<string, string>;
  readonly setCookies: string[];
  header(name: string): string | null;
  get(name: string): string | null;
  json<T = unknown>(): T;
}

export interface AttachOptions {
  readonly filename?: string;
  readonly contentType?: string;
}

export type SupertestExpectChecker = (
  res: SupertestResponse,
) => void | Promise<void>;

type ExpectAssertion =
  | { readonly kind: "status"; readonly status: number }
  | {
      readonly kind: "status-body";
      readonly status: number;
      readonly body: unknown;
    }
  | {
      readonly kind: "header";
      readonly field: string;
      readonly value: string | RegExp;
    }
  | { readonly kind: "body"; readonly body: unknown }
  | { readonly kind: "fn"; readonly checker: SupertestExpectChecker };

interface PendingAttachment {
  readonly field: string;
  readonly data: string | Uint8Array | ArrayBuffer | Blob | File;
  readonly filename?: string;
  readonly contentType?: string;
}

const MIME_SHORTHANDS: Readonly<Record<string, string>> = {
  json: "application/json",
  form: "application/x-www-form-urlencoded",
  urlencoded: "application/x-www-form-urlencoded",
  text: "text/plain",
  txt: "text/plain",
  html: "text/html",
  xml: "application/xml",
  multipart: "multipart/form-data",
  bin: "application/octet-stream",
};

function resolveMimeAlias(value: string): string {
  return MIME_SHORTHANDS[value.toLowerCase()] ?? value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
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

function resolveDispatcher(target: SupertestTarget, options: TestClientOptions): {
  dispatcher: FetchCapable;
  baseUrl: string;
  isLiveNetwork: boolean;
} {
  if (typeof target === "string") {
    return {
      dispatcher: {
        fetch: (req: Request) =>
          globalThis.fetch(req, { redirect: "manual" }),
      },
      baseUrl: target,
      isLiveNetwork: true,
    };
  }

  // Check for live Bun.Server (`{ url: URL }`) BEFORE `FetchCapable` because
  // `Bun.Server` also exposes `.fetch()`, which bypasses `Bun.serve({ routes })`
  // and hits only the fallback handler (returning 404 for native routes).
  if (
    typeof target === "object" &&
    target !== null &&
    "url" in target &&
    target.url instanceof URL
  ) {
    return {
      dispatcher: {
        fetch: (req: Request) =>
          globalThis.fetch(req, { redirect: "manual" }),
      },
      baseUrl: target.url.toString(),
      isLiveNetwork: true,
    };
  }

  if (
    typeof target === "object" &&
    target !== null &&
    "fetch" in target &&
    typeof target.fetch === "function"
  ) {
    return {
      dispatcher: target,
      baseUrl: options.baseUrl ?? DEFAULT_TEST_BASE_URL,
      isLiveNetwork: false,
    };
  }

  throw new TypeError(
    "Invalid request(target): pass a BunestApplication / FetchCapable for zero-socket E2E testing, a live base URL string, or a listening Bun Server (after calling `await app.listen(0)`).",
  );
}

async function toSupertestResponse(
  rawResponse: Response,
): Promise<SupertestResponse> {
  const testRes = new TestResponse(rawResponse);
  const bytes = await testRes.bytes();
  const text = await testRes.text();
  const contentType = rawResponse.headers.get("content-type") ?? "";

  let body: unknown = {};
  if (/application\/(.*\+)?json|text\/json/i.test(contentType)) {
    if (text.trim().length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = {};
      }
    }
  } else if (
    /^application\/octet-stream|^image\/|^audio\/|^video\/|^application\/pdf/i.test(
      contentType,
    )
  ) {
    body = bytes;
  }

  const headersRecord: Record<string, string | string[]> = {};
  rawResponse.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower !== "set-cookie") {
      headersRecord[lower] = value;
    }
  });
  const setCookies = testRes.setCookies();
  if (setCookies.length > 0) {
    headersRecord["set-cookie"] = setCookies;
  }

  const cookies = testRes.cookies();

  return {
    status: rawResponse.status,
    statusCode: rawResponse.status,
    statusText: rawResponse.statusText,
    ok: rawResponse.ok,
    headers: headersRecord,
    rawHeaders: rawResponse.headers,
    text,
    body,
    bytes,
    raw: rawResponse,
    cookies,
    setCookies,
    header: (name: string) => rawResponse.headers.get(name),
    get: (name: string) => rawResponse.headers.get(name),
    json: <T = unknown>() => JSON.parse(text) as T,
  };
}

function assertExpectedBody(
  expected: unknown,
  res: SupertestResponse,
  label: string,
): void {
  if (typeof expected === "string") {
    if (res.text !== expected) {
      throw new Error(
        `${label}: expected body ${JSON.stringify(expected)}, got ${JSON.stringify(res.text)}.`,
      );
    }
    return;
  }

  if (expected instanceof RegExp) {
    if (!expected.test(res.text)) {
      throw new Error(
        `${label}: expected body ${JSON.stringify(res.text)} to match ${String(expected)}.`,
      );
    }
    return;
  }

  if (!deepEqual(res.body, expected)) {
    throw new Error(
      `${label}: expected JSON body ${JSON.stringify(expected)}, got ${JSON.stringify(res.body)} (raw: ${JSON.stringify(res.text)}).`,
    );
  }
}

/**
 * Supertest-compatible fluent request builder implementing `PromiseLike<SupertestResponse>`.
 * Dispatches in-memory (zero sockets) when created from a `BunestApplication`, or over
 * live HTTP when created from a base URL or listening Bun `Server`.
 */
export class SupertestRequest implements PromiseLike<SupertestResponse> {
  private readonly headersMap = new Map<string, string | string[]>();
  private readonly queryEntries: Array<[string, string]> = [];
  private readonly cookieMap = new Map<string, string>();
  private readonly formFields: Array<[string, string]> = [];
  private readonly attachments: PendingAttachment[] = [];
  private readonly assertions: ExpectAssertion[] = [];

  private rawBody?: unknown;
  private hasRawBody = false;
  private maxRedirects = 0;
  private timeoutMs?: number;
  private executionPromise?: Promise<SupertestResponse>;

  constructor(
    private readonly dispatcher: FetchCapable,
    private readonly baseUrl: string,
    private readonly method: string,
    private readonly path: string,
    defaultHeaders: Readonly<Record<string, string | string[]>>,
    defaultCookies: Readonly<Record<string, string>>,
    private readonly jar?: CookieJar,
  ) {
    for (const [key, value] of Object.entries(defaultHeaders)) {
      this.headersMap.set(key.toLowerCase(), value);
    }
    for (const [key, value] of Object.entries(defaultCookies)) {
      this.cookieMap.set(key, value);
    }
  }

  set(
    nameOrHeaders: string | Record<string, string | number | string[]>,
    value?: string | number | string[],
  ): this {
    if (typeof nameOrHeaders === "string") {
      if (value !== undefined) {
        this.headersMap.set(
          nameOrHeaders.toLowerCase(),
          Array.isArray(value) ? [...value] : String(value),
        );
      }
    } else {
      for (const [k, v] of Object.entries(nameOrHeaders)) {
        this.headersMap.set(
          k.toLowerCase(),
          Array.isArray(v) ? [...v] : String(v),
        );
      }
    }
    return this;
  }

  unset(name: string): this {
    this.headersMap.delete(name.toLowerCase());
    return this;
  }

  auth(
    userOrToken: string,
    passOrOptions?: string | { type?: "bearer" | "basic" },
    options?: { type?: "bearer" | "basic" },
  ): this {
    if (typeof passOrOptions === "object" && passOrOptions !== null) {
      if (passOrOptions.type === "bearer") {
        return this.set("Authorization", `Bearer ${userOrToken}`);
      }
      const encoded = btoa(`${userOrToken}:`);
      return this.set("Authorization", `Basic ${encoded}`);
    }

    const type = options?.type ?? "basic";
    if (type === "bearer") {
      return this.set("Authorization", `Bearer ${userOrToken}`);
    }
    const password = passOrOptions ?? "";
    const encoded = btoa(`${userOrToken}:${password}`);
    return this.set("Authorization", `Basic ${encoded}`);
  }

  query(params: string | Record<string, QueryParamValue>): this {
    if (typeof params === "string") {
      const parsed = new URLSearchParams(
        params.startsWith("?") ? params.slice(1) : params,
      );
      for (const [k, v] of parsed.entries()) {
        this.queryEntries.push([k, v]);
      }
      return this;
    }

    for (const [key, rawValue] of Object.entries(params)) {
      if (rawValue === undefined) {
        continue;
      }
      if (Array.isArray(rawValue)) {
        for (const item of rawValue) {
          this.queryEntries.push([key, String(item)]);
        }
      } else {
        this.queryEntries.push([key, String(rawValue)]);
      }
    }
    return this;
  }

  cookies(cookies: Record<string, string>): this {
    for (const [k, v] of Object.entries(cookies)) {
      this.cookieMap.set(k, v);
    }
    return this;
  }

  type(mime: string): this {
    return this.set("Content-Type", resolveMimeAlias(mime));
  }

  accept(mime: string): this {
    return this.set("Accept", resolveMimeAlias(mime));
  }

  send(body: unknown): this {
    if (
      this.hasRawBody &&
      isPlainRecord(this.rawBody) &&
      isPlainRecord(body)
    ) {
      this.rawBody = { ...this.rawBody, ...body };
    } else {
      this.rawBody = body;
      this.hasRawBody = true;
    }
    return this;
  }

  field(
    name: string,
    value:
      | string
      | number
      | boolean
      | ReadonlyArray<string | number | boolean>,
  ): this {
    if (Array.isArray(value)) {
      for (const item of value) {
        this.formFields.push([name, String(item)]);
      }
    } else {
      this.formFields.push([name, String(value)]);
    }
    return this;
  }

  attach(
    field: string,
    data: string | Uint8Array | ArrayBuffer | Blob | File,
    filenameOrOptions?: string | AttachOptions,
    contentType?: string,
  ): this {
    let filename: string | undefined;
    let resolvedContentType = contentType;

    if (typeof filenameOrOptions === "string") {
      filename = filenameOrOptions;
    } else if (filenameOrOptions) {
      filename = filenameOrOptions.filename;
      resolvedContentType = filenameOrOptions.contentType ?? contentType;
    }

    this.attachments.push({
      field,
      data,
      filename,
      contentType: resolvedContentType,
    });
    return this;
  }

  redirects(count: number): this {
    this.maxRedirects = Math.max(0, count);
    return this;
  }

  timeout(ms: number): this {
    this.timeoutMs = ms;
    return this;
  }

  expect(status: number): this;
  expect(
    status: number,
    body: string | RegExp | Record<string, unknown> | unknown[],
  ): this;
  expect(field: string, value: string | RegExp): this;
  expect(body: string | RegExp | Record<string, unknown> | unknown[]): this;
  expect(checker: SupertestExpectChecker): this;
  expect(
    first:
      | number
      | string
      | RegExp
      | Record<string, unknown>
      | unknown[]
      | SupertestExpectChecker,
    second?: string | RegExp | Record<string, unknown> | unknown[],
  ): this {
    if (typeof first === "function") {
      this.assertions.push({ kind: "fn", checker: first });
      return this;
    }

    if (typeof first === "number") {
      if (second !== undefined) {
        this.assertions.push({
          kind: "status-body",
          status: first,
          body: second,
        });
      } else {
        this.assertions.push({ kind: "status", status: first });
      }
      return this;
    }

    if (
      typeof first === "string" &&
      (typeof second === "string" || second instanceof RegExp)
    ) {
      this.assertions.push({ kind: "header", field: first, value: second });
      return this;
    }

    this.assertions.push({ kind: "body", body: first });
    return this;
  }

  then<TResult1 = SupertestResponse, TResult2 = never>(
    onfulfilled?:
      | ((value: SupertestResponse) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?:
      | ((reason: unknown) => TResult | PromiseLike<TResult>)
      | null,
  ): Promise<SupertestResponse | TResult> {
    return this.execute().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<SupertestResponse> {
    return this.execute().finally(onfinally);
  }

  private execute(): Promise<SupertestResponse> {
    if (!this.executionPromise) {
      this.executionPromise = this.run();
    }
    return this.executionPromise;
  }

  private async buildBodyAndHeaders(
    headers: Headers,
  ): Promise<RequestInit["body"] | undefined> {
    const upperMethod = this.method.toUpperCase();
    if (upperMethod === "GET" || upperMethod === "HEAD") {
      return undefined;
    }

    // Multipart via .field() / .attach()
    if (this.formFields.length > 0 || this.attachments.length > 0) {
      const form = new FormData();
      for (const [name, value] of this.formFields) {
        form.append(name, value);
      }
      for (const att of this.attachments) {
        if (att.data instanceof File) {
          const file =
            att.filename || att.contentType
              ? new File([att.data], att.filename ?? att.data.name, {
                  type: att.contentType ?? att.data.type,
                })
              : att.data;
          form.append(att.field, file);
        } else if (att.data instanceof Blob) {
          form.append(
            att.field,
            new File([att.data], att.filename ?? "blob", {
              type: att.contentType ?? att.data.type,
            }),
          );
        } else if (typeof att.data === "string") {
          if (att.filename === undefined) {
            const candidate = Bun.file(att.data);
            if (await candidate.exists()) {
              const name = att.data.split(/[\\/]/).pop() ?? "file";
              const bytes = await candidate.arrayBuffer();
              form.append(
                att.field,
                new File([bytes], name, {
                  type: att.contentType ?? candidate.type,
                }),
              );
              continue;
            }
          }
          form.append(
            att.field,
            new File([att.data], att.filename ?? "file.txt", {
              type: att.contentType ?? "text/plain",
            }),
          );
        } else {
          // Uint8Array or ArrayBuffer
          const payload =
            att.data instanceof Uint8Array
              ? new Uint8Array(
                  att.data.buffer,
                  att.data.byteOffset,
                  att.data.byteLength,
                )
              : new Uint8Array(att.data);
          form.append(
            att.field,
            new File([payload], att.filename ?? "upload.bin", {
              type: att.contentType ?? "application/octet-stream",
            }),
          );
        }
      }
      // Let Request generate the multipart boundary automatically
      headers.delete("content-type");
      return form;
    }

    if (!this.hasRawBody || this.rawBody === undefined) {
      return undefined;
    }

    const contentType = headers.get("content-type") ?? "";
    const payload = this.rawBody;

    if (
      payload instanceof FormData ||
      payload instanceof URLSearchParams ||
      payload instanceof Blob ||
      payload instanceof ReadableStream ||
      payload instanceof Uint8Array ||
      payload instanceof ArrayBuffer
    ) {
      return payload as RequestInit["body"];
    }

    if (typeof payload === "string") {
      if (!headers.has("content-type")) {
        headers.set("content-type", "text/plain; charset=utf-8");
      }
      return payload;
    }

    // URL-encoded form serialization when .type("form") is set
    if (/application\/x-www-form-urlencoded/i.test(contentType) && isPlainRecord(payload)) {
      const formParams = new URLSearchParams();
      for (const [k, v] of Object.entries(payload)) {
        if (v !== undefined) {
          formParams.append(k, String(v));
        }
      }
      return formParams.toString();
    }

    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return JSON.stringify(payload);
  }

  private buildHeadersForPath(pathname: string): Headers {
    const headers = new Headers();
    for (const [key, value] of this.headersMap.entries()) {
      if (Array.isArray(value)) {
        for (const item of value) {
          headers.append(key, item);
        }
      } else {
        headers.set(key, value);
      }
    }

    const mergedCookies: Record<string, string> = {
      ...(this.jar ? this.jar.getForPath(pathname) : {}),
    };
    for (const [name, value] of this.cookieMap.entries()) {
      mergedCookies[name] = value;
    }

    const cookiePairs = Object.entries(mergedCookies).map(
      ([name, val]) => `${encodeURIComponent(name)}=${encodeURIComponent(val)}`,
    );
    if (cookiePairs.length > 0) {
      const existing = headers.get("cookie");
      headers.set(
        "cookie",
        existing ? `${existing}; ${cookiePairs.join("; ")}` : cookiePairs.join("; "),
      );
    }

    return headers;
  }

  private async run(): Promise<SupertestResponse> {
    const urlStr = buildRequestUrl(this.baseUrl, this.path);
    const url = new URL(urlStr);
    for (const [key, value] of this.queryEntries) {
      url.searchParams.append(key, value);
    }

    const headers = this.buildHeadersForPath(url.pathname);
    const body = await this.buildBodyAndHeaders(headers);

    const controller =
      this.timeoutMs !== undefined ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeoutPromise: Promise<never> | undefined;
    if (controller && this.timeoutMs !== undefined) {
      const ms = this.timeoutMs;
      timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`Request timed out after ${ms}ms`);
          controller.abort(err);
          reject(err);
        }, ms);
      });
    }

    const dispatchOnce = (req: Request): Promise<Response> =>
      timeoutPromise
        ? Promise.race([this.dispatcher.fetch(req), timeoutPromise])
        : this.dispatcher.fetch(req);

    try {
      let currentReq = new Request(url.toString(), {
        method: this.method.toUpperCase(),
        headers,
        body,
        redirect: "manual",
        signal: controller?.signal,
      });

      let rawRes = await dispatchOnce(currentReq);
      this.jar?.captureFromHeaders(rawRes.headers);

      let hops = 0;
      while (isRedirectStatus(rawRes.status) && hops < this.maxRedirects) {
        const location = rawRes.headers.get("location");
        if (!location) {
          break;
        }
        hops += 1;

        const prevUrl = new URL(currentReq.url);
        const nextUrl = new URL(location, prevUrl);
        const nextHeaders = this.buildHeadersForPath(nextUrl.pathname);

        if (nextUrl.origin !== prevUrl.origin) {
          nextHeaders.delete("authorization");
        }

        const nextMethod =
          rawRes.status === 303 ||
          ((rawRes.status === 301 || rawRes.status === 302) &&
            currentReq.method === "POST")
            ? "GET"
            : currentReq.method;

        if (nextMethod === "GET") {
          nextHeaders.delete("content-type");
          nextHeaders.delete("content-length");
        }

        currentReq = new Request(nextUrl.toString(), {
          method: nextMethod,
          headers: nextHeaders,
          ...(nextMethod !== "GET" &&
          nextMethod !== "HEAD" &&
          body !== undefined &&
          !(body instanceof ReadableStream)
            ? { body }
            : {}),
          redirect: "manual",
          signal: controller?.signal,
        });

        rawRes = await dispatchOnce(currentReq);
        this.jar?.captureFromHeaders(rawRes.headers);
      }

      const response = await toSupertestResponse(rawRes);
      await this.runAssertions(response);
      return response;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private async runAssertions(res: SupertestResponse): Promise<void> {
    const label = `${this.method.toUpperCase()} ${this.path}`;

    for (const assertion of this.assertions) {
      switch (assertion.kind) {
        case "status": {
          if (res.status !== assertion.status) {
            throw new Error(
              `${label}: expected status ${assertion.status}, got ${res.status} (${res.statusText}). Body: ${res.text}`,
            );
          }
          break;
        }
        case "status-body": {
          if (res.status !== assertion.status) {
            throw new Error(
              `${label}: expected status ${assertion.status}, got ${res.status} (${res.statusText}). Body: ${res.text}`,
            );
          }
          assertExpectedBody(assertion.body, res, label);
          break;
        }
        case "header": {
          const actual = res.header(assertion.field);
          if (actual === null) {
            throw new Error(
              `${label}: expected response header "${assertion.field}" to be present.`,
            );
          }
          if (typeof assertion.value === "string") {
            if (actual !== assertion.value) {
              throw new Error(
                `${label}: expected header "${assertion.field}" to equal ${JSON.stringify(assertion.value)}, got ${JSON.stringify(actual)}.`,
              );
            }
          } else if (!assertion.value.test(actual)) {
            throw new Error(
              `${label}: expected header "${assertion.field}" (${JSON.stringify(actual)}) to match ${String(assertion.value)}.`,
            );
          }
          break;
        }
        case "body": {
          assertExpectedBody(assertion.body, res, label);
          break;
        }
        case "fn": {
          await assertion.checker(res);
          break;
        }
      }
    }
  }
}

/**
 * Supertest-style HTTP client/agent entrypoint returned by `request(target)`
 * and `request.agent(target)`.
 */
export class SupertestAgent {
  private readonly defaultHeaders: Record<string, string | string[]>;
  private readonly defaultCookies: Record<string, string>;

  constructor(
    private readonly dispatcher: FetchCapable,
    private readonly baseUrl: string,
    options: TestClientOptions = {},
    private readonly jar?: CookieJar,
  ) {
    this.defaultHeaders = {};
    if (options.defaultHeaders) {
      for (const [key, value] of Object.entries(options.defaultHeaders)) {
        this.defaultHeaders[key.toLowerCase()] = value;
      }
    }
    this.defaultCookies = { ...(options.defaultCookies ?? {}) };
  }

  set(
    nameOrHeaders: string | Record<string, string | number | string[]>,
    value?: string | number | string[],
  ): this {
    if (typeof nameOrHeaders === "string") {
      if (value !== undefined) {
        this.defaultHeaders[nameOrHeaders.toLowerCase()] = Array.isArray(value)
          ? [...value]
          : String(value);
      }
    } else {
      for (const [k, v] of Object.entries(nameOrHeaders)) {
        this.defaultHeaders[k.toLowerCase()] = Array.isArray(v)
          ? [...v]
          : String(v);
      }
    }
    return this;
  }

  unset(name: string): this {
    delete this.defaultHeaders[name.toLowerCase()];
    return this;
  }

  auth(
    userOrToken: string,
    passOrOptions?: string | { type?: "bearer" | "basic" },
    options?: { type?: "bearer" | "basic" },
  ): this {
    if (typeof passOrOptions === "object" && passOrOptions !== null) {
      if (passOrOptions.type === "bearer") {
        return this.set("Authorization", `Bearer ${userOrToken}`);
      }
      return this.set("Authorization", `Basic ${btoa(`${userOrToken}:`)}`);
    }
    const type = options?.type ?? "basic";
    if (type === "bearer") {
      return this.set("Authorization", `Bearer ${userOrToken}`);
    }
    return this.set(
      "Authorization",
      `Basic ${btoa(`${userOrToken}:${passOrOptions ?? ""}`)}`,
    );
  }

  withCookies(cookies: Record<string, string>): this {
    Object.assign(this.defaultCookies, cookies);
    return this;
  }

  getCookies(): Record<string, string> {
    return this.jar ? this.jar.getAll() : { ...this.defaultCookies };
  }

  setCookie(name: string, value: string, path = "/"): this {
    if (this.jar) {
      this.jar.set(name, value, path);
    } else {
      this.defaultCookies[name] = value;
    }
    return this;
  }

  clearCookies(): this {
    this.jar?.clear();
    for (const key of Object.keys(this.defaultCookies)) {
      delete this.defaultCookies[key];
    }
    return this;
  }

  request(method: string, path: string): SupertestRequest {
    return new SupertestRequest(
      this.dispatcher,
      this.baseUrl,
      method,
      path,
      this.defaultHeaders,
      this.defaultCookies,
      this.jar,
    );
  }

  get(path: string): SupertestRequest {
    return this.request("GET", path);
  }

  post(path: string): SupertestRequest {
    return this.request("POST", path);
  }

  put(path: string): SupertestRequest {
    return this.request("PUT", path);
  }

  patch(path: string): SupertestRequest {
    return this.request("PATCH", path);
  }

  delete(path: string): SupertestRequest {
    return this.request("DELETE", path);
  }

  head(path: string): SupertestRequest {
    return this.request("HEAD", path);
  }

  options(path: string): SupertestRequest {
    return this.request("OPTIONS", path);
  }
}

export interface SupertestFactory {
  (target: SupertestTarget, options?: TestClientOptions): SupertestAgent;
  agent(target: SupertestTarget, options?: TestClientOptions): SupertestAgent;
}

function createSupertestAgent(
  target: SupertestTarget,
  options: TestClientOptions = {},
  stateful = false,
): SupertestAgent {
  if (target instanceof TestClient) {
    return new SupertestAgent(
      target,
      options.baseUrl ?? target.getBaseUrl(),
      options,
      stateful ? new CookieJar() : undefined,
    );
  }

  const { dispatcher, baseUrl } = resolveDispatcher(target, options);
  return new SupertestAgent(
    dispatcher,
    baseUrl,
    options,
    stateful ? new CookieJar() : undefined,
  );
}

/**
 * Supertest-compatible fluent E2E HTTP client for Bunest.
 * Runs zero-socket in-memory when passed a `BunestApplication`, or over live HTTP
 * when passed a base URL string or listening Bun `Server` (`app.getHttpServer()`).
 *
 * @example
 * ```ts
 * await request(app)
 *   .post("/users")
 *   .set("Authorization", "Bearer token")
 *   .send({ email: "alice@example.com" })
 *   .expect(201)
 *   .expect("content-type", /json/);
 * ```
 */
export const request: SupertestFactory = Object.assign(
  (target: SupertestTarget, options?: TestClientOptions): SupertestAgent =>
    createSupertestAgent(target, options, false),
  {
    agent: (
      target: SupertestTarget,
      options?: TestClientOptions,
    ): SupertestAgent => createSupertestAgent(target, options, true),
  },
);
