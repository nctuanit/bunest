import type { HttpClientInterceptorLike } from "./http-client-interceptor.interface";
import type {
  HttpDispatcher,
  HttpSharedOptions,
} from "./http-request.interface";

export type { HttpDispatcher, HttpSharedOptions };

export interface HttpClientOptions extends HttpSharedOptions {
  /**
   * Prefix for relative URLs, joined with exactly one `/`: an absolute http(s)
   * URL without credentials, query or fragment. An absolute request URL must
   * be on its origin.
   */
  baseUrl?: string | URL | undefined;
  /** Run in order, first = outermost. `forRoot()` interceptors run before these. */
  interceptors?: HttpClientInterceptorLike[] | undefined;
  /** `fetch` implementation. Default `globalThis.fetch`, looked up on every request. */
  fetch?: typeof globalThis.fetch | undefined;
}

/** `HttpClientModule.forRoot()`: defaults for every client in the app. */
export interface HttpClientModuleOptions extends Omit<
  HttpClientOptions,
  "baseUrl"
> {}
