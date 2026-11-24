import { SetMetadata } from "../decorators/core.decorators";
import type { ValidationErrorDetail } from "../exceptions/http.exception";
import type {
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1Options,
} from "../interfaces/standard-schema.interface";
import type { Type } from "../interfaces/type.interface";
import type { ClassTransformOptions } from "../interfaces/validation.interface";
import type { CustomDecorator } from "../metadata/reflector";

export const CLASS_SERIALIZER_OPTIONS = Symbol.for(
  "bunest:validation:class_serializer_options",
);

export interface ClassSerializerContextOptions extends ClassTransformOptions {
  /**
   * Optional DTO/entity class constructor used to instantiate plain objects
   * with `plainToInstance` before serializing with `instanceToPlain`.
   */
  type?: Type<unknown>;
}

export interface StandardSchemaSerializerOptions {
  /**
   * HTTP status code thrown when an outgoing response violates the output schema.
   * @default HttpStatus.INTERNAL_SERVER_ERROR (500)
   */
  errorHttpStatusCode?: number;
  /**
   * Hide detailed field issues in the thrown HTTP error body.
   * @default false
   */
  disableErrorMessages?: boolean;
  /**
   * Custom exception factory for outgoing schema validation failures.
   */
  exceptionFactory?: (
    issues: readonly StandardSchemaV1Issue[],
    details: ValidationErrorDetail[],
  ) => unknown;
}

/**
 * Options for `StandardSchemaSerializerInterceptor`, passed via
 * `@SerializeOptions({ schema, validateOptions })` (NestJS v12 parity).
 */
export interface StandardSchemaSerializerContextOptions extends StandardSchemaSerializerOptions {
  /**
   * Standard Schema v1 instance used to validate/transform the outgoing response.
   */
  schema?: StandardSchemaV1<unknown, unknown>;
  /**
   * Optional options forwarded to `schema["~standard"].validate()`.
   */
  validateOptions?: StandardSchemaV1Options;
}

/**
 * Configures `ClassSerializerInterceptor` or `StandardSchemaSerializerInterceptor`
 * options at the controller class or route handler method level.
 */
export function SerializeOptions(
  options:
    ClassSerializerContextOptions | StandardSchemaSerializerContextOptions,
): CustomDecorator<typeof CLASS_SERIALIZER_OPTIONS> {
  return SetMetadata(CLASS_SERIALIZER_OPTIONS, options);
}
