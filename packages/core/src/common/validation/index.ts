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
