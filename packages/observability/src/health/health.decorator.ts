import { Header, MetadataRegistry, SetMetadata } from "@bunest/core";
import type { HealthCheckOptions } from "./health.interface";

export const HEALTH_CHECK_METADATA = Symbol.for(
  "bunest:observability:health_check",
);

const SWAGGER_API_RESPONSES = Symbol.for("bunest:swagger:api_responses");
const SWAGGER_API_EXTRA_MODELS = Symbol.for("bunest:swagger:api_extra_models");
const SWAGGER_API_SCHEMA = Symbol.for("bunest:swagger:api_schema");
const SWAGGER_API_PROPERTIES = Symbol.for("bunest:swagger:api_properties");

class TerminusHealthIndicatorResult {}
class TerminusHealthCheckResult {}

MetadataRegistry.define(
  SWAGGER_API_SCHEMA,
  { name: "TerminusHealthIndicatorResult" },
  TerminusHealthIndicatorResult,
);
MetadataRegistry.define(
  SWAGGER_API_PROPERTIES,
  [
    {
      propertyKey: "status",
      name: "status",
      type: String,
      enum: ["up", "down", "degraded"],
      required: true,
    },
  ],
  TerminusHealthIndicatorResult,
);

const INDICATOR_MAP_ADDITIONAL_PROPERTIES = {
  allOf: [
    { $ref: "#/components/schemas/TerminusHealthIndicatorResult" },
    { type: "object", additionalProperties: true },
  ],
};

MetadataRegistry.define(
  SWAGGER_API_SCHEMA,
  { name: "TerminusHealthCheckResult" },
  TerminusHealthCheckResult,
);
MetadataRegistry.define(
  SWAGGER_API_PROPERTIES,
  [
    {
      propertyKey: "status",
      name: "status",
      type: String,
      enum: ["ok", "error", "shutting_down", "degraded"],
      required: true,
    },
    {
      propertyKey: "info",
      name: "info",
      type: Object,
      nullable: true,
      required: false,
      additionalProperties: INDICATOR_MAP_ADDITIONAL_PROPERTIES,
    },
    {
      propertyKey: "error",
      name: "error",
      type: Object,
      nullable: true,
      required: false,
      additionalProperties: INDICATOR_MAP_ADDITIONAL_PROPERTIES,
    },
    {
      propertyKey: "details",
      name: "details",
      type: Object,
      required: true,
      additionalProperties: INDICATOR_MAP_ADDITIONAL_PROPERTIES,
    },
  ],
  TerminusHealthCheckResult,
);

/**
 * Marks a controller endpoint as a Terminus Health Check endpoint.
 * - Sets `Cache-Control: no-cache, no-store, must-revalidate` unless `noCache: false`.
 * - Records health check metadata and OpenAPI/Swagger 200/503 response schemas unless `swaggerDocumentation: false`.
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

  if (swaggerDocumentation) {
    decorators.push((_target, _key, descriptor) => {
      if (typeof descriptor?.value !== "function") {
        return;
      }
      const existingModels =
        MetadataRegistry.getOwn<readonly Function[]>(
          SWAGGER_API_EXTRA_MODELS,
          descriptor.value,
        ) ?? [];
      MetadataRegistry.define(
        SWAGGER_API_EXTRA_MODELS,
        [
          ...existingModels,
          TerminusHealthCheckResult,
          TerminusHealthIndicatorResult,
        ],
        descriptor.value,
      );

      const existingResponses =
        MetadataRegistry.getOwn<readonly Record<string, unknown>[]>(
          SWAGGER_API_RESPONSES,
          descriptor.value,
        ) ?? [];
      MetadataRegistry.define(
        SWAGGER_API_RESPONSES,
        [
          ...existingResponses,
          {
            status: 200,
            description: "The Health Check is successful",
            schema: {
              allOf: [{ $ref: "#/components/schemas/TerminusHealthCheckResult" }],
              properties: {
                status: {
                  type: "string",
                  enum: ["ok", "degraded"],
                  example: "ok",
                },
              },
            },
          },
          {
            status: 503,
            description: "The Health Check is not successful",
            schema: {
              allOf: [{ $ref: "#/components/schemas/TerminusHealthCheckResult" }],
              properties: {
                status: {
                  type: "string",
                  enum: ["error", "shutting_down"],
                  example: "error",
                },
              },
            },
          },
        ],
        descriptor.value,
      );
    });
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
