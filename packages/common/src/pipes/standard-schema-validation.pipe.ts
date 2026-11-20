import { BODY_SANITIZED_SYMBOL } from "../constants/tokens";
import { Injectable, Optional } from "../decorators/core.decorators";
import { DecoratorRegistry } from "../metadata/decorator-registry";
import { HttpStatus } from "../enums/scope.enum";
import type { ValidationErrorDetail } from "../exceptions/http.exception";
import type {
  ArgumentMetadata,
  PipeTransform,
} from "../interfaces/http.interface";
import {
  isStandardSchema,
  type StandardSchemaV1,
  type StandardSchemaV1Issue,
  type StandardSchemaV1Options,
  type StandardSchemaV1PathSegment,
  type StandardSchemaV1Result,
} from "../interfaces/standard-schema.interface";
import type { ErrorHttpStatusCode } from "../interfaces/validation.interface";
import { stripProtoKeys as stripProtoKeysUtil } from "../utils/common.utils";
import {
  OMITTED_ERRORS_MESSAGE,
  resolveMaxErrorMessagesLength,
} from "./validation-errors.constants";
import {
  buildDangerousKeyValidationErrors,
  createValidationHttpException,
  findDangerousKeys,
  flattenValidationErrorDetails,
} from "./validation-http.util";

export interface StandardSchemaValidationPipeOptions {
  /**
   * When `true` (default), returns the value produced by the schema.
   * When `false`, returns the original input value after successful validation.
   * @default true
   */
  transform?: boolean;
  /**
   * Whether to validate custom parameter decorators (`metadata.type === "custom"`).
   * @default false
   */
  validateCustomDecorators?: boolean;
  /**
   * Options forwarded as the 2nd argument to `schema["~standard"].validate(value, opts)`.
   */
  validateOptions?: Record<string, unknown>;
  /**
   * HTTP status code used on validation failure.
   * @default HttpStatus.BAD_REQUEST (400)
   */
  errorHttpStatusCode?: ErrorHttpStatusCode;
  /**
   * Hide detailed field errors in the HTTP response body.
   * @default false
   */
  disableErrorMessages?: boolean;
  /**
   * Reject dangerous prototype-pollution own keys (`__proto__`, `constructor`, `prototype`)
   * before invoking the schema validator (skipped automatically when `BODY_SANITIZED_SYMBOL` is set).
   * @default true
   */
  rejectPrototypePollution?: boolean;
  /**
   * Maximum total length in characters of formatted error messages before truncating
   * remaining issues (NestJS v12 DoS protection). Set `Infinity` to lift the limit.
   * @default 1_000_000
   */
  maxErrorMessagesLength?: number;
  /**
   * Custom factory converting Standard Schema issues (and normalized ADR-009 details)
   * into an exception.
   */
  exceptionFactory?: (
    issues: readonly StandardSchemaV1Issue[],
    details: ValidationErrorDetail[],
  ) => any;
}

function extractSegmentKey(
  segment: PropertyKey | StandardSchemaV1PathSegment,
): string | number {
  const raw =
    typeof segment === "object" && segment !== null && "key" in segment
      ? segment.key
      : segment;
  if (typeof raw === "number") {
    return raw;
  }
  if (typeof raw === "symbol") {
    return raw.description ?? String(raw);
  }
  return String(raw);
}

/**
 * Formats Standard Schema v1 `path` segments into ADR-009 dot/bracket field paths
 * (e.g. `["address", "zipCode"]` -> `"address.zipCode"`,
 * `[{ key: "items" }, { key: 0 }, { key: "quantity" }]` -> `"items[0].quantity"`).
 */
export function formatStandardSchemaPath(
  path: ReadonlyArray<PropertyKey | StandardSchemaV1PathSegment> | undefined,
  fallbackField: string,
): string {
  if (!Array.isArray(path) || path.length === 0) {
    return fallbackField;
  }

  let formatted = "";
  for (let i = 0; i < path.length; i++) {
    const key = extractSegmentKey(path[i]!);
    if (typeof key === "number") {
      formatted += `[${key}]`;
    } else if (formatted.length === 0) {
      formatted = key;
    } else {
      formatted += `.${key}`;
    }
  }

  return formatted.length > 0 ? formatted : fallbackField;
}

/**
 * Flattens Standard Schema v1 issues into Bunest's ADR-009 `ValidationErrorDetail[]`.
 */
export function formatStandardSchemaIssues(
  issues: readonly StandardSchemaV1Issue[],
  fallbackField: string,
): ValidationErrorDetail[] {
  if (issues.length === 0) {
    return [
      {
        field: fallbackField,
        constraints: { standardSchema: "Validation failed" },
        messages: ["Validation failed"],
      },
    ];
  }

  const byField = new Map<string, Record<string, string>>();

  for (const issue of issues) {
    const field = formatStandardSchemaPath(issue.path, fallbackField);
    const message =
      typeof issue.message === "string" && issue.message.length > 0
        ? issue.message
        : "Invalid value";

    let constraints = byField.get(field);
    if (!constraints) {
      constraints = {};
      byField.set(field, constraints);
    }

    let constraintKey = "standardSchema";
    let suffix = 2;
    while (Object.hasOwn(constraints, constraintKey)) {
      constraintKey = `standardSchema_${suffix}`;
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
 * First-class Standard Schema v1 (`@standard-schema/spec`) validation pipe
 * supporting BOTH:
 * - NestJS v12 global mode: `new StandardSchemaValidationPipe(options?)` reading `metadata.schema`
 *   attached by `@Body(schema)` / `@Query(schema)` / `@Param(schema)` / `@Headers(schema)`
 * - Explicit schema mode: `new StandardSchemaValidationPipe(schema, options?)`
 */
@Injectable()
export class StandardSchemaValidationPipe<TInput = unknown, TOutput = TInput>
  implements PipeTransform<unknown, TOutput>
{
  protected readonly options?: StandardSchemaValidationPipeOptions | undefined;
  protected isTransformEnabled: boolean;
  protected validateCustomDecorators: boolean;
  protected validateOptions: Record<string, unknown> | undefined;
  protected maxErrorMessagesLength: number;
  protected exceptionFactory: (
    issues: readonly StandardSchemaV1Issue[],
    details?: ValidationErrorDetail[],
  ) => any;

  private readonly schema?: StandardSchemaV1<TInput, TOutput>;
  private readonly errorHttpStatusCode: number;
  private readonly disableErrorMessages: boolean;
  private readonly rejectPrototypePollution: boolean;
  private readonly customExceptionFactory?: (
    issues: readonly StandardSchemaV1Issue[],
    details: ValidationErrorDetail[],
  ) => any;

  constructor(options?: StandardSchemaValidationPipeOptions | undefined);
  constructor(
    schema: StandardSchemaV1<TInput, TOutput>,
    options?: StandardSchemaValidationPipeOptions,
  );
  constructor(
    @Optional()
    schemaOrOptions?:
      | StandardSchemaV1<TInput, TOutput>
      | StandardSchemaValidationPipeOptions,
    maybeOptions?: StandardSchemaValidationPipeOptions,
  ) {
    let resolvedOptions: StandardSchemaValidationPipeOptions | undefined;

    if (isStandardSchema<TInput, TOutput>(schemaOrOptions)) {
      this.schema = schemaOrOptions;
      resolvedOptions = maybeOptions ?? {};
    } else if (
      schemaOrOptions !== undefined &&
      (typeof schemaOrOptions !== "object" ||
        schemaOrOptions === null ||
        "~standard" in schemaOrOptions ||
        maybeOptions !== undefined)
    ) {
      throw new TypeError(
        "StandardSchemaValidationPipe requires a valid Standard Schema v1 object (`~standard.version === 1`) or options object.",
      );
    } else {
      resolvedOptions = schemaOrOptions;
    }

    this.options = resolvedOptions;
    const opts = resolvedOptions ?? {};

    this.isTransformEnabled = opts.transform ?? true;
    this.validateCustomDecorators = opts.validateCustomDecorators ?? false;
    this.validateOptions = opts.validateOptions;
    this.errorHttpStatusCode = opts.errorHttpStatusCode ?? HttpStatus.BAD_REQUEST;
    this.disableErrorMessages = opts.disableErrorMessages ?? false;
    this.rejectPrototypePollution = opts.rejectPrototypePollution ?? true;
    this.maxErrorMessagesLength = resolveMaxErrorMessagesLength(
      opts.maxErrorMessagesLength,
    );
    this.customExceptionFactory = opts.exceptionFactory;
    this.exceptionFactory = opts.exceptionFactory
      ? (
          issues: readonly StandardSchemaV1Issue[],
          details?: ValidationErrorDetail[],
        ) =>
          opts.exceptionFactory!(
            issues,
            details ?? formatStandardSchemaIssues(issues, ""),
          )
      : (
          issues: readonly StandardSchemaV1Issue[],
          details?: ValidationErrorDetail[],
        ) => {
          const resolvedDetails =
            details ??
            this.limitIssueDetails(formatStandardSchemaIssues(issues, ""));
          return createValidationHttpException(
            resolvedDetails,
            this.errorHttpStatusCode,
            this.disableErrorMessages,
          );
        };
  }

  protected formatIssueMessages(
    issues: readonly StandardSchemaV1Issue[],
  ): string[] {
    const messages: string[] = [];
    let remainingLength = this.maxErrorMessagesLength;

    for (const issue of issues) {
      if (remainingLength <= 0) {
        messages.push(OMITTED_ERRORS_MESSAGE);
        break;
      }

      let message = issue.message;
      if (issue.path?.length) {
        const stringPath = issue.path
          .map((segment) =>
            String(
              typeof segment === "object" &&
                segment !== null &&
                "key" in segment
                ? segment.key
                : segment,
            ),
          )
          .join(".");
        message = `${stringPath}: ${issue.message}`;
      }
      remainingLength -= String(message).length;
      messages.push(message);
    }

    return messages;
  }

  async transform<T = TOutput>(
    value: unknown,
    metadata: ArgumentMetadata = { type: "body" },
  ): Promise<T> {
    const schema = this.schema ?? metadata?.schema;
    if (!schema || !this.toValidate(metadata)) {
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
        const details = flattenValidationErrorDetails(validationErrors);
        const issues: StandardSchemaV1Issue[] = dangerousViolations.map(
          (v) => ({
            message: `property ${v.key} is not allowed`,
            path: v.segments,
          }),
        );
        throw this.buildException(issues, details);
      }
    }

    this.stripProtoKeys(value);

    const result = await this.validate(value, schema, this.validateOptions);
    if (result.issues) {
      const details = this.customExceptionFactory
        ? formatStandardSchemaIssues(result.issues, fallbackField)
        : this.limitIssueDetails(
            formatStandardSchemaIssues(result.issues, fallbackField),
          );
      throw this.buildException(result.issues, details);
    }

    return (this.isTransformEnabled ? result.value : value) as T;
  }

  protected toValidate(metadata: ArgumentMetadata): boolean {
    if (metadata.type === "custom" && !this.validateCustomDecorators) {
      return false;
    }
    return true;
  }

  protected validate<T = unknown>(
    value: unknown,
    schema: StandardSchemaV1,
    options?: Record<string, unknown>,
  ): Promise<StandardSchemaV1Result<T>> | StandardSchemaV1Result<T> {
    return schema["~standard"].validate(
      value,
      options as StandardSchemaV1Options | undefined,
    ) as Promise<StandardSchemaV1Result<T>> | StandardSchemaV1Result<T>;
  }

  protected stripProtoKeys(value: any): void {
    stripProtoKeysUtil(value);
  }

  private buildException(
    issues: readonly StandardSchemaV1Issue[],
    details: ValidationErrorDetail[],
  ): unknown {
    if (this.customExceptionFactory) {
      return this.customExceptionFactory(issues, details);
    }
    return this.exceptionFactory(issues, details);
  }

  private limitIssueDetails(
    details: ValidationErrorDetail[],
  ): ValidationErrorDetail[] {
    if (!Number.isFinite(this.maxErrorMessagesLength)) {
      return details;
    }
    let remaining = this.maxErrorMessagesLength;
    const out: ValidationErrorDetail[] = [];
    for (const item of details) {
      if (remaining <= 0) {
        out.push({
          field: "...",
          constraints: { omitted: OMITTED_ERRORS_MESSAGE },
          messages: [OMITTED_ERRORS_MESSAGE],
        });
        break;
      }
      const cost =
        item.field.length +
        item.messages.reduce((sum, m) => sum + m.length, 0);
      remaining -= cost;
      out.push(item);
    }
    return out;
  }
}

DecoratorRegistry.markInternal(StandardSchemaValidationPipe);
