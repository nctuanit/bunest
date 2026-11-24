import { BODY_SANITIZED_SYMBOL } from "../constants/tokens";
import { Injectable } from "../decorators/core.decorators";
import { HttpStatus } from "../enums/scope.enum";
import type { ArgumentMetadata, PipeTransform } from "../interfaces/http.interface";
import {
  isStandardSchema,
  type StandardSchemaV1,
} from "../interfaces/standard-schema.interface";
import type { ValidationErrorDetail } from "../exceptions/http.exception";
import type {
  SchemaValidationErrorLike,
  SchemaValidationIssue,
  SchemaValidator,
} from "./schema-validator.interface";
import { formatStandardSchemaIssues } from "../pipes/standard-schema-validation.pipe";
import { flattenValidationErrors } from "./utils/error-formatter.util";
import { createValidationHttpException } from "./utils/http-status.util";
import {
  buildDangerousKeyValidationErrors,
  findDangerousKeys,
} from "./utils/sanitize.util";

export interface SchemaValidationPipeOptions {
  /**
   * HTTP status code used on validation failure.
   * @default HttpStatus.BAD_REQUEST (400)
   */
  errorHttpStatusCode?: number;
  /**
   * Hide detailed field errors in the HTTP response body.
   * @default false
   */
  disableErrorMessages?: boolean;
  /**
   * Whether to validate custom parameter decorators (`metadata.type === "custom"`).
   * @default false
   */
  validateCustomDecorators?: boolean;
  /**
   * Reject dangerous prototype-pollution own keys (`__proto__`, `constructor`, `prototype`)
   * before invoking the schema validator.
   * @default true
   */
  rejectPrototypePollution?: boolean;
  /**
   * Custom factory converting schema errors + normalized details into an exception.
   */
  exceptionFactory?: (
    error: unknown,
    details: ValidationErrorDetail[],
  ) => unknown;
}

function formatIssuePath(
  path: ReadonlyArray<string | number> | string | undefined,
  fallbackField: string,
): string {
  if (typeof path === "string") {
    return path.length > 0 ? path : fallbackField;
  }
  if (!Array.isArray(path) || path.length === 0) {
    return fallbackField;
  }

  let formatted = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      formatted += `[${segment}]`;
    } else if (formatted.length === 0) {
      formatted = segment;
    } else {
      formatted += `.${segment}`;
    }
  }
  return formatted;
}

function extractSchemaIssues(
  error: unknown,
): readonly SchemaValidationIssue[] | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const errLike = error as SchemaValidationErrorLike;
  if (Array.isArray(errLike.issues) && errLike.issues.length > 0) {
    return errLike.issues;
  }
  if (Array.isArray(errLike.errors) && errLike.errors.length > 0) {
    return errLike.errors;
  }
  return undefined;
}

function normalizeSchemaError(
  error: unknown,
  fallbackField: string,
): ValidationErrorDetail[] {
  const issues = extractSchemaIssues(error);
  if (!issues) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : typeof error === "string" && error.length > 0
          ? error
          : "Validation failed";
    return [
      {
        field: fallbackField,
        constraints: { schemaValidation: message },
        messages: [message],
      },
    ];
  }

  const byField = new Map<string, Record<string, string>>();

  for (const issue of issues) {
    const field = formatIssuePath(issue.path, fallbackField);
    const baseCode =
      typeof issue.code === "string" && issue.code.length > 0
        ? issue.code
        : "schemaValidation";
    const message =
      typeof issue.message === "string" && issue.message.length > 0
        ? issue.message
        : "Invalid value";

    let constraints = byField.get(field);
    if (!constraints) {
      constraints = {};
      byField.set(field, constraints);
    }

    let constraintKey = baseCode;
    let suffix = 2;
    while (Object.hasOwn(constraints, constraintKey)) {
      constraintKey = `${baseCode}_${suffix}`;
      suffix += 1;
    }
    constraints[constraintKey] = message;
  }

  const details: ValidationErrorDetail[] = [];
  for (const [field, constraints] of byField.entries()) {
    details.push({
      field,
      constraints,
      messages: Object.values(constraints),
    });
  }

  return details;
}

/**
 * Drop-in pipe adapting any `SchemaValidator<T>` (Zod, Valibot, TypeBox, or
 * custom schema validator) to Bunest's standard `PipeTransform` lifecycle and
 * ADR-009 normalized HTTP 400 error format.
 */
@Injectable()
export class SchemaValidationPipe<T = unknown> implements PipeTransform<
  unknown,
  T
> {
  private readonly isStandard: boolean;
  private readonly errorHttpStatusCode: number;
  private readonly disableErrorMessages: boolean;
  private readonly validateCustomDecorators: boolean;
  private readonly rejectPrototypePollution: boolean;
  private readonly exceptionFactory?: (
    error: unknown,
    details: ValidationErrorDetail[],
  ) => unknown;

  constructor(
    private readonly schema: SchemaValidator<T> | StandardSchemaV1<unknown, T>,
    options: SchemaValidationPipeOptions = {},
  ) {
    this.isStandard = isStandardSchema(schema);
    if (
      !this.isStandard &&
      (!schema ||
        (typeof (schema as SchemaValidator<T>).safeParseAsync !== "function" &&
          typeof (schema as SchemaValidator<T>).safeParse !== "function" &&
          typeof (schema as SchemaValidator<T>).parseAsync !== "function" &&
          typeof (schema as SchemaValidator<T>).parse !== "function"))
    ) {
      throw new TypeError(
        "SchemaValidationPipe requires a SchemaValidator (parse/safeParse) or Standard Schema v1 (`~standard`).",
      );
    }

    this.errorHttpStatusCode =
      options.errorHttpStatusCode ?? HttpStatus.BAD_REQUEST;
    this.disableErrorMessages = options.disableErrorMessages ?? false;
    this.validateCustomDecorators = options.validateCustomDecorators ?? false;
    this.rejectPrototypePollution = options.rejectPrototypePollution ?? true;
    this.exceptionFactory = options.exceptionFactory;
  }

  async transform(
    value: unknown,
    metadata: ArgumentMetadata = { type: "body" },
  ): Promise<T> {
    if (metadata.type === "custom" && !this.validateCustomDecorators) {
      return value as T;
    }

    const fallbackField = metadata.data ?? metadata.type ?? "";

    if (
      this.rejectPrototypePollution &&
      typeof value === "object" &&
      value !== null &&
      (value as Record<PropertyKey, unknown>)[BODY_SANITIZED_SYMBOL] !== true
    ) {
      const dangerousViolations = findDangerousKeys(value);
      if (dangerousViolations.length > 0) {
        const validationErrors =
          buildDangerousKeyValidationErrors(dangerousViolations);
        const details = flattenValidationErrors(validationErrors);
        throw this.buildException(validationErrors, details);
      }
    }

    if (this.isStandard) {
      const stdSchema = this.schema as StandardSchemaV1<unknown, T>;
      const result = await stdSchema["~standard"].validate(value);
      if (result.issues) {
        const details = formatStandardSchemaIssues(
          result.issues,
          fallbackField,
        );
        throw this.buildException({ issues: result.issues }, details);
      }
      return result.value;
    }

    const validator = this.schema as SchemaValidator<T>;

    if (typeof validator.safeParseAsync === "function") {
      const result = await validator.safeParseAsync(value);
      if (result.success) {
        return result.data;
      }
      throw this.buildException(
        result.error,
        normalizeSchemaError(result.error, fallbackField),
      );
    }

    if (typeof validator.safeParse === "function") {
      const result = await validator.safeParse(value);
      if (result.success) {
        return result.data;
      }
      throw this.buildException(
        result.error,
        normalizeSchemaError(result.error, fallbackField),
      );
    }

    try {
      if (typeof validator.parseAsync === "function") {
        return await validator.parseAsync(value);
      }
      if (typeof validator.parse === "function") {
        return await validator.parse(value);
      }
    } catch (error) {
      throw this.buildException(
        error,
        normalizeSchemaError(error, fallbackField),
      );
    }

    throw new TypeError("SchemaValidator has no callable parse method.");
  }

  private buildException(
    error: unknown,
    details: ValidationErrorDetail[],
  ): unknown {
    if (this.exceptionFactory) {
      return this.exceptionFactory(error, details);
    }
    return createValidationHttpException(
      details,
      this.errorHttpStatusCode,
      this.disableErrorMessages,
    );
  }
}
