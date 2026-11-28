import { Injectable } from "./core.decorators";
import { UseInterceptors } from "./enhancers.decorators";
import type {
  BunestInterceptor,
  CallHandler,
  ExecutionContext,
  ResponseContext,
} from "../interfaces/pipeline.interface";
import { MetadataRegistry } from "../metadata/metadata-registry";

export const DEPRECATED_ROUTE_METADATA = Symbol.for(
  "bunest:http:deprecated_route",
);

export interface DeprecatedRouteOptions {
  /**
   * RFC 8594 `Sunset` date (Date instance or ISO/HTTP date string) indicating
   * when the endpoint is scheduled for removal.
   */
  readonly sunset?: Date | string;
  /**
   * Optional successor endpoint URL emitted as `Link: <url>; rel="successor-version"`.
   */
  readonly link?: string;
  /**
   * RFC 9745 `Deprecation` header value:
   * - `true` (default): `Deprecation: true`
   * - `Date`: `Deprecation: @<unix-timestamp>`
   * - `string`: custom value
   * @default true
   */
  readonly deprecation?: boolean | Date | string;
  /**
   * Optional human-readable notice emitted via `X-Deprecation-Notice`.
   */
  readonly message?: string;
}

function assertSafeHeaderValue(name: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `@DeprecatedRoute(): invalid CR/LF characters in "${name}" header value.`,
    );
  }
  return value;
}

function formatSunsetHeader(sunset: Date | string): string {
  if (sunset instanceof Date) {
    if (Number.isNaN(sunset.getTime())) {
      throw new Error("@DeprecatedRoute(): invalid sunset Date.");
    }
    return sunset.toUTCString();
  }
  const parsed = new Date(sunset);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toUTCString();
  }
  return assertSafeHeaderValue("Sunset", sunset);
}

function formatDeprecationHeader(
  deprecation: boolean | Date | string | undefined,
): string {
  if (deprecation === undefined || deprecation === true) {
    return "true";
  }
  if (deprecation === false) {
    return "false";
  }
  if (deprecation instanceof Date) {
    if (Number.isNaN(deprecation.getTime())) {
      throw new Error("@DeprecatedRoute(): invalid deprecation Date.");
    }
    return `@${Math.floor(deprecation.getTime() / 1000)}`;
  }
  return assertSafeHeaderValue("Deprecation", deprecation);
}

/**
 * Marks a controller or route handler as deprecated and automatically attaches
 * RFC 8594 (`Sunset`, `Link`) and RFC 9745 (`Deprecation`) HTTP response headers.
 */
export function DeprecatedRoute(
  options: DeprecatedRouteOptions = {},
): ClassDecorator & MethodDecorator {
  const deprecationHeader = formatDeprecationHeader(options.deprecation);
  const sunsetHeader =
    options.sunset !== undefined
      ? formatSunsetHeader(options.sunset)
      : undefined;
  const linkHeader =
    options.link !== undefined
      ? `<${assertSafeHeaderValue("Link", options.link)}>; rel="successor-version"`
      : undefined;
  const noticeHeader =
    options.message !== undefined
      ? assertSafeHeaderValue("X-Deprecation-Notice", options.message)
      : undefined;

  @Injectable()
  class MixinDeprecatedRouteInterceptor implements BunestInterceptor {
    async intercept(
      context: ExecutionContext,
      next: CallHandler,
    ): Promise<unknown> {
      if (context.getType() !== "http") {
        return next.handle();
      }

      const res = context.switchToHttp().getResponse<ResponseContext>();
      if (res && typeof res.header === "function") {
        res.header("Deprecation", deprecationHeader);
        if (sunsetHeader) res.header("Sunset", sunsetHeader);
        if (linkHeader) res.header("Link", linkHeader);
        if (noticeHeader) res.header("X-Deprecation-Notice", noticeHeader);
      }

      const result = await next.handle();
      if (result instanceof Response) {
        const headers = new Headers(result.headers);
        headers.set("Deprecation", deprecationHeader);
        if (sunsetHeader) headers.set("Sunset", sunsetHeader);
        if (linkHeader) headers.set("Link", linkHeader);
        if (noticeHeader) headers.set("X-Deprecation-Notice", noticeHeader);
        return new Response(result.body, {
          status: result.status,
          statusText: result.statusText,
          headers,
        });
      }

      return result;
    }
  }

  const interceptorDecorator = UseInterceptors(MixinDeprecatedRouteInterceptor);

  return (
    target: object,
    propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): void => {
    const metaTarget =
      descriptor && descriptor.value !== undefined ? descriptor.value : target;
    MetadataRegistry.define(DEPRECATED_ROUTE_METADATA, options, metaTarget);
    if (descriptor && propertyKey !== undefined) {
      (interceptorDecorator as MethodDecorator)(target, propertyKey, descriptor);
    } else {
      (interceptorDecorator as ClassDecorator)(target as Function);
    }
  };
}
