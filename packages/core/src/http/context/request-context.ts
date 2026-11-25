import { ContextStorage, type UploadedFileInfo } from "../../common/index";
import type {
  BunServerLike,
  MultipartStorageOptions,
  RequestScopeContainer,
} from "../interfaces/http-bridge.interface";
import {
  type ParsedBodyResult,
  parseRequestBody,
} from "../parsers/body-parser";
import {
  extractRequestCookies,
  extractSignedCookies,
  parseCookieHeader,
  signCookieValue,
} from "../security/cookie";
import { extractClientIp } from "../security/ip";
import {
  isDangerousKey,
  sanitizeRecord,
} from "../security/prototype-sanitizer";
import { HttpResponseContext } from "./response-context";

/**
 * Ambient per-request context storage backed by Bunest's `ContextStorage`.
 */
export const requestContextStorage = new ContextStorage<RequestContext>();

/**
 * Returns the active `RequestContext` for the current async execution chain, if any.
 */
export function getCurrentRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

export interface RequestContextOptions {
  readonly request: Request;
  readonly server?: BunServerLike;
  readonly params?: Record<string, string>;
  /**
   * Internal fast-path hint indicating `params` keys were already verified safe
   * at route compile time (avoids per-request shallow copy).
   */
  readonly paramsPreSanitized?: boolean;
  readonly hostParams?: Record<string, string>;
  readonly pathname?: string;
  readonly trustProxy?: boolean | number | string[];
  readonly maxBodyBytes?: number;
  readonly bodyParser?: boolean;
  readonly captureRawBody?: boolean;
  readonly multipart?: MultipartStorageOptions;
  readonly cookieSecrets?: readonly string[];
  readonly responseContext?: HttpResponseContext;
}

function parseQueryString(search: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (!search || search === "?") {
    return out;
  }
  const params = new URLSearchParams(search);
  for (const [key, value] of params.entries()) {
    if (isDangerousKey(key)) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      const existing = out[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else if (existing !== undefined) {
        out[key] = [existing, value];
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

function extractFastPathname(rawUrl: string): string {
  const schemeIdx = rawUrl.indexOf("://");
  const pathStart =
    schemeIdx === -1 ? rawUrl.indexOf("/") : rawUrl.indexOf("/", schemeIdx + 3);
  if (pathStart === -1) {
    return "/";
  }
  let endIdx = rawUrl.length;
  const queryIdx = rawUrl.indexOf("?", pathStart);
  if (queryIdx !== -1 && queryIdx < endIdx) {
    endIdx = queryIdx;
  }
  const hashIdx = rawUrl.indexOf("#", pathStart);
  if (hashIdx !== -1 && hashIdx < endIdx) {
    endIdx = hashIdx;
  }
  return rawUrl.slice(pathStart, endIdx);
}

/**
 * Per-request HTTP state container carrying raw Request, lazy ResponseContext,
 * route params, lazy query/cookies/ip/pathname/signal/CORS caches, optional
 * `RequestScopeContainer`, optional `rawBody` capture, and single-read body parsing cache.
 */
export class RequestContext {
  public readonly request: Request;
  public container?: RequestScopeContainer;
  public session?: Record<string, unknown>;
  /** Current HTTP pipeline stage (populated when dev diagnostics tracing is enabled). */
  public traceStage?: string;
  /** Optional correlation ID attached to error responses when dev diagnostics tracing is enabled. */
  public requestId?: string;

  private readonly server?: BunServerLike;
  private readonly trustProxy?: boolean | number | string[];
  private readonly captureRawBody: boolean;
  private readonly bodyParserEnabled: boolean;
  private readonly multipart?: MultipartStorageOptions;
  private readonly cookieSecrets?: readonly string[];
  private maxBodyBytes?: number;

  private _responseContext?: HttpResponseContext;
  private _sseAbortController?: AbortController;
  private _sseSignalEnabled = false;
  private _corsHeaders?: Headers;
  private _pathname?: string;
  private _params?: Record<string, string>;
  private readonly _rawParams?: Record<string, string>;
  private readonly _paramsPreSanitized: boolean;
  private _hostParams?: Record<string, string>;
  private readonly _rawHostParams?: Record<string, string>;

  private cachedUrl?: URL;
  private cachedQuery?: Record<string, string | string[]>;
  private cachedCookies?: Record<string, string>;
  private cachedSignedCookies?: Record<string, string>;
  private cachedIp?: string;
  private _rawBody?: Uint8Array;
  private bodyPromise?: Promise<ParsedBodyResult>;

  constructor(options: RequestContextOptions) {
    this.request = options.request;
    this._responseContext = options.responseContext;
    this._rawParams = options.params;
    this._paramsPreSanitized = options.paramsPreSanitized === true;
    this._rawHostParams = options.hostParams;
    this._pathname = options.pathname;
    this.server = options.server;
    this.trustProxy = options.trustProxy;
    this.maxBodyBytes = options.maxBodyBytes;
    this.bodyParserEnabled = options.bodyParser !== false;
    this.captureRawBody = options.captureRawBody === true;
    this.multipart = options.multipart;
    this.cookieSecrets = options.cookieSecrets;
  }

  get responseContext(): HttpResponseContext {
    if (!this._responseContext) {
      const secrets = this.cookieSecrets;
      const signer =
        secrets && secrets.length > 0 && secrets[0]
          ? (val: string) => signCookieValue(val, secrets[0]!)
          : undefined;
      this._responseContext = new HttpResponseContext(signer);
    }
    return this._responseContext;
  }

  hasResponseContext(): boolean {
    return this._responseContext !== undefined;
  }

  get corsHeaders(): Headers {
    if (!this._corsHeaders) {
      this._corsHeaders = new Headers();
    }
    return this._corsHeaders;
  }

  hasCorsHeaders(): boolean {
    return this._corsHeaders !== undefined;
  }

  get pathname(): string {
    if (this._pathname === undefined) {
      this._pathname = extractFastPathname(this.request.url);
    }
    return this._pathname;
  }

  get signal(): AbortSignal {
    return this.request.signal;
  }

  enableSseSignal(): void {
    this._sseSignalEnabled = true;
  }

  getSseSignal(): AbortSignal {
    if (!this._sseSignalEnabled && !this._sseAbortController) {
      return this.request.signal;
    }
    if (!this._sseAbortController) {
      const ac = new AbortController();
      this._sseAbortController = ac;
      const reqSignal = this.request.signal;
      if (reqSignal.aborted) {
        ac.abort(reqSignal.reason);
      } else {
        reqSignal.addEventListener("abort", () => ac.abort(reqSignal.reason), {
          once: true,
        });
      }
    }
    return this._sseAbortController.signal;
  }

  abortSseSignal(): void {
    if (this._sseAbortController && !this._sseAbortController.signal.aborted) {
      this._sseAbortController.abort();
    }
  }

  get params(): Record<string, string> {
    if (!this._params) {
      if (!this._rawParams) {
        this._params = {};
      } else if (this._paramsPreSanitized) {
        this._params = this._rawParams;
      } else {
        this._params = sanitizeRecord(this._rawParams);
      }
    }
    return this._params;
  }

  get hostParams(): Record<string, string> {
    if (!this._hostParams) {
      this._hostParams = this._rawHostParams
        ? sanitizeRecord(this._rawHostParams)
        : {};
    }
    return this._hostParams;
  }

  get url(): URL {
    if (!this.cachedUrl) {
      this.cachedUrl = new URL(this.request.url);
    }
    return this.cachedUrl;
  }

  get query(): Record<string, string | string[]> {
    if (!this.cachedQuery) {
      const rawUrl = this.request.url;
      const hashIdx = rawUrl.indexOf("#");
      const urlWithoutHash = hashIdx === -1 ? rawUrl : rawUrl.slice(0, hashIdx);
      const qIdx = urlWithoutHash.indexOf("?");
      const search = qIdx === -1 ? "" : urlWithoutHash.slice(qIdx);
      this.cachedQuery = parseQueryString(search);
    }
    return this.cachedQuery;
  }

  get cookies(): Record<string, string> {
    if (!this.cachedCookies) {
      this.cachedCookies = extractRequestCookies(this.request);
    }
    return this.cachedCookies;
  }

  get signedCookies(): Record<string, string> {
    if (!this.cookieSecrets || this.cookieSecrets.length === 0) {
      throw new Error(
        "Cookie secret is required to read signed cookies. Configure { cookies: { secret } } when creating the application.",
      );
    }
    if (!this.cachedSignedCookies) {
      const rawCookies = parseCookieHeader(this.request.headers.get("cookie"));
      this.cachedSignedCookies = extractSignedCookies(
        rawCookies,
        this.cookieSecrets,
      );
    }
    return this.cachedSignedCookies;
  }

  get ip(): string {
    if (this.cachedIp === undefined) {
      this.cachedIp = extractClientIp(
        this.request,
        this.server,
        this.trustProxy,
      );
    }
    return this.cachedIp;
  }

  /**
   * Exact raw request body bytes captured before parsing when `rawBody: true` is enabled.
   * Populated once body parsing (`getBody()`, `getRawBody()`, or `getUploadedFiles()`) runs.
   */
  get rawBody(): Uint8Array | undefined {
    return this._rawBody;
  }

  setBodyLimit(bytes: number | undefined): void {
    this.maxBodyBytes = bytes;
  }

  hasParsedBody(): boolean {
    return this.bodyPromise !== undefined;
  }

  private ensureBodyParsed(): Promise<ParsedBodyResult> {
    if (!this.bodyPromise) {
      const promise = parseRequestBody(this.request, {
        maxBodyBytes: this.maxBodyBytes,
        rawBody: this.captureRawBody,
        multipart: this.multipart,
      });
      if (this.captureRawBody) {
        this.bodyPromise = promise.then((parsed) => {
          this._rawBody = parsed.rawBody;
          return parsed;
        });
      } else {
        this.bodyPromise = promise;
      }
    }
    return this.bodyPromise;
  }

  async getBody(): Promise<unknown> {
    if (!this.bodyParserEnabled) {
      return undefined;
    }
    const parsed = await this.ensureBodyParsed();
    return parsed.body;
  }

  async getRawBody(): Promise<Uint8Array | undefined> {
    if (!this.captureRawBody) {
      return undefined;
    }
    const parsed = await this.ensureBodyParsed();
    this._rawBody = parsed.rawBody;
    return parsed.rawBody;
  }

  async getUploadedFiles(): Promise<readonly UploadedFileInfo[]> {
    const parsed = await this.ensureBodyParsed();
    return parsed.files;
  }

  async cleanupUploadedDiskFiles(): Promise<void> {
    if (!this.bodyPromise) {
      return;
    }
    try {
      const parsed = await this.bodyPromise;
      for (let i = 0; i < parsed.files.length; i++) {
        const file = parsed.files[i] as UploadedFileInfo & { path?: string };
        if (file?.path) {
          await Bun.file(file.path)
            .delete()
            .catch(() => {});
        }
      }
    } catch {
      // Body parsing itself already failed and cleaned up its own partial files
    }
  }
}
