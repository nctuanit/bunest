import { Header, SetMetadata } from "@bunest/core";
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
}: HealthCheckOptions = {}): MethodDecorator => {
  const decorators: Array<
    (
      target: object,
      key: string | symbol,
      descriptor: PropertyDescriptor,
    ) => unknown
  > = [
    SetMetadata(HEALTH_CHECK_METADATA, {
      noCache,
      swaggerDocumentation,
    }) as (
      target: object,
      key: string | symbol,
      descriptor: PropertyDescriptor,
    ) => unknown,
  ];

  if (noCache) {
    decorators.push(
      Header("Cache-Control", "no-cache, no-store, must-revalidate") as (
        target: object,
        key: string | symbol,
        descriptor: PropertyDescriptor,
      ) => unknown,
    );
  }

  return (
    target: object,
    key: string | symbol,
    descriptor: PropertyDescriptor,
  ): void => {
    for (const decorator of decorators) {
      decorator(target, key, descriptor);
    }
  };
};
