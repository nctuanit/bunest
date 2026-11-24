import { HttpStatus } from "../../enums/scope.enum";
import type {
  ValidationErrorDetail,
  ValidationErrorResponse,
} from "../../exceptions/http.exception";
import type { ValidationError } from "../../interfaces/validation.interface";
import {
  DEFAULT_MAX_ERROR_MESSAGES_LENGTH,
  OMITTED_ERRORS_MESSAGE,
  resolveMaxErrorMessagesLength,
} from "../../pipes/validation-errors.constants";
import { getHttpReasonPhrase } from "./http-status.util";

export {
  DEFAULT_MAX_ERROR_MESSAGES_LENGTH,
  OMITTED_ERRORS_MESSAGE,
  resolveMaxErrorMessagesLength,
};

const ARRAY_INDEX_REGEX = /^\d+$/;

function buildFieldPath(
  parentPath: string,
  property: string | undefined,
  parentIsDefinitelyNonArray: boolean,
): string {
  const prop = typeof property === "string" ? property : "";
  if (prop.length === 0) {
    return parentPath;
  }
  if (parentPath.length === 0) {
    return prop;
  }
  if (!parentIsDefinitelyNonArray && ARRAY_INDEX_REGEX.test(prop)) {
    return `${parentPath}[${prop}]`;
  }
  return `${parentPath}.${prop}`;
}

/**
 * Recursively flattens `class-validator`'s nested `ValidationError[]` tree into
 * ADR-009's deterministic `ValidationErrorDetail[]` list using dot/bracket paths
 * (e.g. `"email"`, `"address.zipCode"`, `"items[0].quantity"`).
 */
export function flattenValidationErrors(
  errors: readonly ValidationError[],
  parentPath = "",
  parentIsDefinitelyNonArray = false,
): ValidationErrorDetail[] {
  const details: ValidationErrorDetail[] = [];

  for (const error of errors) {
    const fieldPath = buildFieldPath(
      parentPath,
      error.property,
      parentIsDefinitelyNonArray,
    );

    if (error.constraints && Object.keys(error.constraints).length > 0) {
      const normalizedConstraints: Record<string, string> = {};
      for (const [constraintKey, message] of Object.entries(
        error.constraints,
      )) {
        normalizedConstraints[constraintKey] =
          typeof message === "string" ? message : String(message ?? "");
      }
      details.push({
        field: fieldPath,
        constraints: normalizedConstraints,
        messages: Object.values(normalizedConstraints),
      });
    }

    if (error.children && error.children.length > 0) {
      const childParentNonArray =
        error.value !== undefined && !Array.isArray(error.value);
      details.push(
        ...flattenValidationErrors(
          error.children,
          fieldPath,
          childParentNonArray,
        ),
      );
    }
  }

  return details;
}

/**
 * Formats flattened validation errors into the canonical ADR-009
 * `ValidationErrorResponse` JSON payload.
 */
export function formatValidationErrorResponse(
  errors: readonly ValidationError[],
  statusCode: number = HttpStatus.BAD_REQUEST,
): ValidationErrorResponse {
  return {
    statusCode,
    error: getHttpReasonPhrase(statusCode),
    message: "Validation failed",
    details: flattenValidationErrors(errors),
  };
}
