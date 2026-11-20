import type { CookieOptions, ResponseContext } from "@bunest/common";
import { serializeCookie } from "../security/cookie";

const EMPTY_COOKIES: readonly string[] = Object.freeze([]);

/**
 * Mutable per-request response metadata builder injected via `@Res()`
 * and passed into middleware (ADR-008 & ADR-010).
 *
 * Allocates internal `Headers` and cookie arrays lazily so hot-path routes
 * that never mutate response headers pay zero `Headers` allocation cost.
 */
export class HttpResponseContext implements ResponseContext {
  private statusCode: number | undefined;
  private headers?: Headers;
  private setCookies?: string[];
  private readonly cookieSigner?: (value: string) => string;
  private headersSent = false;
  private sentResponse?: Response;

  constructor(cookieSigner?: (value: string) => string) {
    this.cookieSigner = cookieSigner;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  getStatus(): number | undefined {
    return this.statusCode;
  }

  getHeader(name: string): string | undefined {
    return this.headers?.get(name) ?? undefined;
  }

  isHeadersSent(): boolean {
    return this.headersSent;
  }

  markHeadersSent(response?: Response): void {
    this.headersSent = true;
    if (response !== undefined) {
      this.sentResponse = response;
    }
  }

  getSentResponse(): Response | undefined {
    return this.sentResponse;
  }

  hasHeaderMutations(): boolean {
    return (
      this.headers !== undefined ||
      (this.setCookies !== undefined && this.setCookies.length > 0)
    );
  }

  hasMutations(): boolean {
    return this.statusCode !== undefined || this.hasHeaderMutations();
  }

  header(name: string, value: string): this {
    if (!this.headers) {
      this.headers = new Headers();
    }
    if (name.toLowerCase() === "set-cookie") {
      if (!this.setCookies) {
        this.setCookies = [];
      }
      this.setCookies.push(value);
      this.headers.append("Set-Cookie", value);
      return this;
    }
    this.headers.set(name, value);
    return this;
  }

  appendHeader(name: string, value: string): this {
    if (!this.headers) {
      this.headers = new Headers();
    }
    if (name.toLowerCase() === "set-cookie") {
      if (!this.setCookies) {
        this.setCookies = [];
      }
      this.setCookies.push(value);
    }
    this.headers.append(name, value);
    return this;
  }

  removeHeader(name: string): this {
    if (name.toLowerCase() === "set-cookie" && this.setCookies) {
      this.setCookies.length = 0;
    }
    if (this.headers) {
      this.headers.delete(name);
    }
    return this;
  }

  getHeaders(): Headers {
    if (!this.headers) {
      this.headers = new Headers();
    }
    return this.headers;
  }

  getHeadersIfInitialized(): Headers | undefined {
    return this.headers;
  }

  getSetCookies(): readonly string[] {
    return this.setCookies ?? EMPTY_COOKIES;
  }

  cookie(name: string, value: string, options?: CookieOptions): this {
    let finalValue = value;
    if (options?.signed) {
      if (!this.cookieSigner) {
        throw new Error(
          `Cannot sign cookie "${name}" because no cookies.secret is configured on the application.`,
        );
      }
      finalValue = this.cookieSigner(value);
    }
    const serialized = serializeCookie(name, finalValue, options);
    if (!this.headers) {
      this.headers = new Headers();
    }
    if (!this.setCookies) {
      this.setCookies = [];
    }
    this.setCookies.push(serialized);
    this.headers.append("Set-Cookie", serialized);
    return this;
  }

  clearCookie(name: string, options: CookieOptions = {}): this {
    const clearOptions: CookieOptions = {
      path: "/",
      ...options,
      expires: new Date(0),
      maxAge: 0,
    };
    return this.cookie(name, "", clearOptions);
  }
}
