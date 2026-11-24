import type { Type } from "../../common/index";
import type {
  HttpClientInterceptor,
  HttpClientInterceptorLike,
} from "../interfaces/http-client-interceptor.interface";
import type { HttpClientOptions } from "../interfaces/http-client-options.interface";
import { mergeHeaders } from "./headers.util";
import { mergeRetry } from "./retry.util";

/**
 * `forRoot()` defaults under a client's own options: the client's values win,
 * headers and retry settings merge, and global interceptors run first.
 */
export function mergeClientOptions(
  defaults: HttpClientOptions | undefined,
  options: HttpClientOptions,
): HttpClientOptions {
  if (!defaults) {
    return options;
  }
  return {
    ...(definedOnly(defaults) as HttpClientOptions),
    ...(definedOnly(options) as HttpClientOptions),
    headers: mergeHeaders(new Headers(), defaults.headers, options.headers),
    retry: mergeRetry(defaults.retry, options.retry),
    interceptors: [
      ...(defaults.interceptors ?? []),
      ...(options.interceptors ?? []),
    ],
  };
}

function definedOnly(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  );
}

/** A class to instantiate, as opposed to a function or an object with `intercept()`. */
export function isInterceptorClass(
  entry: unknown,
): entry is Type<HttpClientInterceptor> {
  if (typeof entry !== "function") {
    return false;
  }
  const proto = (entry as { prototype?: { intercept?: unknown } }).prototype;
  return (
    typeof proto?.intercept === "function" ||
    /^class\b/.test(Function.prototype.toString.call(entry))
  );
}

export function checkInterceptor(
  entry: HttpClientInterceptorLike,
  index: number,
): void {
  if (typeof entry === "function") {
    return;
  }
  if (
    entry !== null &&
    typeof entry === "object" &&
    typeof entry.intercept === "function"
  ) {
    return;
  }
  throw new TypeError(
    `HttpClient \`interceptors[${index}]\` is ${entry === null ? "null" : typeof entry}: expected a ` +
      "function, an object with intercept(), or a class that implements HttpClientInterceptor. " +
      "An undefined entry usually means a circular import.",
  );
}
