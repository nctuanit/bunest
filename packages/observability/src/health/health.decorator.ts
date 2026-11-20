import { Header, SetMetadata } from "@bunest/common";
import type { HealthCheckOptions } from "./health.interface";

export const HEALTH_CHECK_METADATA = Symbol.for(
  "bunest:observability:health_check",
);

/**
 * Marks a controller endpoint as a Terminus Health Check endpoint.
 * - Sets `Cache-Control: no-cache, no-store, must-revalidate` unless `noCache: false`.
 * - Records health check metadata (for Swagger/introspection tooling).
 */
export const HealthCheck = ({
  noCache = true,
  swaggerDocumentation = true,
}: HealthCheckOptions = {}): ((
  target: any,
  key: any,
  descriptor: PropertyDescriptor,
) => void) => {
  const decorators: Array<
    (target: any, key: any, descriptor: PropertyDescriptor) => unknown
  > = [
    SetMetadata(HEALTH_CHECK_METADATA, {
      noCache,
      swaggerDocumentation,
    }) as (target: any, key: any, descriptor: PropertyDescriptor) => unknown,
  ];

  if (noCache) {
    decorators.push(
      Header(
        "Cache-Control",
        "no-cache, no-store, must-revalidate",
      ) as (target: any, key: any, descriptor: PropertyDescriptor) => unknown,
    );
  }

  return (target: any, key: any, descriptor: PropertyDescriptor): void => {
    for (const decorator of decorators) {
      decorator(target, key, descriptor);
    }
  };
};
