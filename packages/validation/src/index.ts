import "reflect-metadata";
import "./mapped-types-transformer.hook";
import "./entity-validation.hook";

export {
  classTransformerMappedTypeHook,
  registerClassTransformerMappedTypeHook,
} from "./mapped-types-transformer.hook";

export {
  validateEntity,
  type EntityValidationOptions,
  type EntityValidationResult,
} from "./entity-validator";

export {
  DEFAULT_MAX_ERROR_MESSAGES_LENGTH,
  OMITTED_ERRORS_MESSAGE,
  resolveMaxErrorMessagesLength,
  type PlainLiteralObject,
  type ValidationError,
  type ValidationErrorFormat,
} from "@bunest/common";

export {
  VALIDATION_PIPE_OPTIONS,
  ValidationPipe,
  type ClassTransformOptions,
  type TransformerPackage,
  type TransformerPackageLike,
  type ValidationPipeOptions,
  type ValidatorOptions,
  type ValidatorPackage,
  type ValidatorPackageLike,
} from "./validation.pipe";

export {
  CLASS_SERIALIZER_OPTIONS,
  SerializeOptions,
  type ClassSerializerContextOptions,
} from "./serialize-options.decorator";

export {
  ClassSerializerInterceptor,
  type ClassSerializerInterceptorOptions,
} from "./serializer.interceptor";

export type {
  SchemaSafeParseFailure,
  SchemaSafeParseResult,
  SchemaSafeParseSuccess,
  SchemaValidationErrorLike,
  SchemaValidationIssue,
  SchemaValidator,
} from "./schema-validator.interface";

export {
  SchemaValidationPipe,
  type SchemaValidationPipeOptions,
} from "./schema-validation.pipe";

export {
  StandardSchemaValidationPipe,
  formatStandardSchemaIssues,
  formatStandardSchemaPath,
  type StandardSchemaValidationPipeOptions,
} from "./standard-schema.pipe";

export {
  STANDARD_SCHEMA_SERIALIZER_METADATA,
  StandardSchemaSerializerInterceptor,
  UseStandardSchema,
  type StandardSchemaSerializerContextOptions,
  type StandardSchemaSerializerInterceptorOptions,
  type StandardSchemaSerializerMetadata,
  type StandardSchemaSerializerOptions,
} from "./standard-schema-serializer.interceptor";

export {
  flattenValidationErrors,
  formatValidationErrorResponse,
} from "./utils/error-formatter.util";

export {
  DANGEROUS_PROTOTYPE_KEYS,
  findDangerousKeys,
  stripDangerousKeys,
  type DangerousKeyViolation,
  type DangerousPrototypeKey,
} from "./utils/sanitize.util";
