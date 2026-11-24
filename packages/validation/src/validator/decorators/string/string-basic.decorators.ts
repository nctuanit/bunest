import {
  isValidationOptions,
  type ValidationOptions,
} from "../../interfaces/validation-options.interface";
import { buildMessage, createBuiltInDecorator } from "../core.decorators";

export const CONTAINS = "contains";
export const NOT_CONTAINS = "notContains";
export const IS_LENGTH = "isLength";
export const MIN_LENGTH = "minLength";
export const MAX_LENGTH = "maxLength";
export const MATCHES = "matches";
export const IS_ALPHA = "isAlpha";
export const IS_ALPHANUMERIC = "isAlphanumeric";
export const IS_ASCII = "isAscii";
export const IS_LOWERCASE = "isLowercase";
export const IS_UPPERCASE = "isUppercase";
export const IS_FULL_WIDTH = "isFullWidth";
export const IS_HALF_WIDTH = "isHalfWidth";
export const IS_VARIABLE_WIDTH = "isVariableWidth";
export const IS_MULTIBYTE = "isMultibyte";
export const IS_SURROGATE_PAIR = "isSurrogatePair";
export const IS_BYTE_LENGTH = "isByteLength";

const ASCII_ALPHA_RE = /^[A-Za-z]+$/;
const ASCII_ALNUM_RE = /^[A-Za-z0-9]+$/;
const UNICODE_ALPHA_RE = /^\p{L}+$/u;
const UNICODE_ALNUM_RE = /^[\p{L}\p{N}]+$/u;
const FULL_WIDTH_RE =
  /[^\u0020-\u007E\uFF61-\uFF9F\uFFA0-\uFFDC\uFFE8-\uFFEE0-9a-zA-Z]/;
const HALF_WIDTH_RE =
  /[\u0020-\u007E\uFF61-\uFF9F\uFFA0-\uFFDC\uFFE8-\uFFEE0-9a-zA-Z]/;
const MULTIBYTE_RE = /[^\x00-\x7F]/;
const SURROGATE_PAIR_RE = /[\uD800-\uDBFF][\uDC00-\uDFFF]/;

const utf8Encoder = new TextEncoder();

export function contains(value: unknown, seed: string): boolean {
  return typeof value === "string" && value.includes(seed);
}

export function Contains(
  seed: string,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    CONTAINS,
    (value) => contains(value, seed),
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must contain a $constraint1 string`,
      validationOptions,
    ),
    [seed],
    validationOptions,
  );
}

export function notContains(value: unknown, seed: string): boolean {
  return typeof value === "string" && !value.includes(seed);
}

export function NotContains(
  seed: string,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    NOT_CONTAINS,
    (value) => notContains(value, seed),
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property should not contain a $constraint1 string`,
      validationOptions,
    ),
    [seed],
    validationOptions,
  );
}

export function length(value: unknown, min: number, max?: number): boolean {
  if (typeof value !== "string") return false;
  const len = value.length;
  if (len < min) return false;
  if (max !== undefined && len > max) return false;
  return true;
}

export function Length(
  min: number,
  max?: number,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_LENGTH,
    (value) => length(value, min, max),
    buildMessage((eachPrefix, args) => {
      const cMin = args?.constraints[0] as number | undefined;
      const cMax = args?.constraints[1] as number | undefined;
      const isMin = cMin !== null && cMin !== undefined;
      const isMax = cMax !== null && cMax !== undefined;
      const val = args?.value as string | undefined;
      if (isMin && (!val || val.length < cMin)) {
        return `${eachPrefix}$property must be longer than or equal to $constraint1 characters`;
      }
      if (isMax && val && val.length > cMax) {
        return `${eachPrefix}$property must be shorter than or equal to $constraint2 characters`;
      }
      return `${eachPrefix}$property must be longer than or equal to $constraint1 and shorter than or equal to $constraint2 characters`;
    }, validationOptions),
    [min, max],
    validationOptions,
  );
}

export function minLength(value: unknown, min: number): boolean {
  return typeof value === "string" && value.length >= min;
}

export function MinLength(
  min: number,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    MIN_LENGTH,
    (value) => minLength(value, min),
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must be longer than or equal to $constraint1 characters`,
      validationOptions,
    ),
    [min],
    validationOptions,
  );
}

export function maxLength(value: unknown, max: number): boolean {
  return typeof value === "string" && value.length <= max;
}

export function MaxLength(
  max: number,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    MAX_LENGTH,
    (value) => maxLength(value, max),
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must be shorter than or equal to $constraint1 characters`,
      validationOptions,
    ),
    [max],
    validationOptions,
  );
}

function buildSafeRegex(pattern: RegExp | string, modifiers?: string): RegExp {
  if (pattern instanceof RegExp) {
    if (pattern.global || pattern.sticky) {
      return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
    }
    return pattern;
  }
  const cleanFlags = modifiers ? modifiers.replace(/[gy]/g, "") : undefined;
  return new RegExp(pattern, cleanFlags);
}

export function matches(value: string, pattern: RegExp): boolean;
export function matches(
  value: string,
  pattern: string,
  modifiers?: string,
): boolean;
export function matches(
  value: unknown,
  pattern: RegExp | string,
  modifiers?: string,
): boolean;
export function matches(
  value: unknown,
  pattern: RegExp | string,
  modifiers?: string,
): boolean {
  if (typeof value !== "string") return false;
  return buildSafeRegex(pattern, modifiers).test(value);
}

export function Matches(
  pattern: RegExp,
  validationOptions?: ValidationOptions,
): PropertyDecorator;
export function Matches(
  pattern: string,
  modifiers?: string,
  validationOptions?: ValidationOptions,
): PropertyDecorator;
export function Matches(
  pattern: RegExp | string,
  modifiersOrOptions?: string | ValidationOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  let modifiers: string | undefined;
  let opts: ValidationOptions | undefined;
  if (
    modifiersOrOptions &&
    typeof modifiersOrOptions === "object" &&
    isValidationOptions(modifiersOrOptions)
  ) {
    opts = modifiersOrOptions;
  } else if (typeof modifiersOrOptions === "string") {
    modifiers = modifiersOrOptions;
    opts = validationOptions;
  } else {
    opts =
      (modifiersOrOptions as ValidationOptions | undefined) ??
      validationOptions;
  }

  const compiled = buildSafeRegex(pattern, modifiers);

  return createBuiltInDecorator(
    MATCHES,
    (value) => typeof value === "string" && compiled.test(value),
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must match $constraint1 regular expression`,
      opts,
    ),
    [pattern, modifiers],
    opts,
  );
}

export function isAlpha(value: unknown, locale?: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (
    !locale ||
    locale === "en-US" ||
    locale === "en-GB" ||
    locale === "en-AU"
  ) {
    return ASCII_ALPHA_RE.test(value);
  }
  return UNICODE_ALPHA_RE.test(value);
}

export function IsAlpha(
  locale?: string,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_ALPHA,
    (value) => isAlpha(value, locale),
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must contain only letters (a-zA-Z)`,
      validationOptions,
    ),
    [locale],
    validationOptions,
  );
}

export function isAlphanumeric(value: unknown, locale?: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (
    !locale ||
    locale === "en-US" ||
    locale === "en-GB" ||
    locale === "en-AU"
  ) {
    return ASCII_ALNUM_RE.test(value);
  }
  return UNICODE_ALNUM_RE.test(value);
}

export function IsAlphanumeric(
  locale?: string,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_ALPHANUMERIC,
    (value) => isAlphanumeric(value, locale),
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must contain only letters and numbers`,
      validationOptions,
    ),
    [locale],
    validationOptions,
  );
}

export function isAscii(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

export function IsAscii(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_ASCII,
    isAscii,
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must contain only ASCII characters`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isLowercase(value: unknown): boolean {
  return typeof value === "string" && value === value.toLowerCase();
}

export function IsLowercase(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_LOWERCASE,
    isLowercase,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a lowercase string`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isUppercase(value: unknown): boolean {
  return typeof value === "string" && value === value.toUpperCase();
}

export function IsUppercase(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_UPPERCASE,
    isUppercase,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be uppercase`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isFullWidth(value: unknown): boolean {
  return typeof value === "string" && FULL_WIDTH_RE.test(value);
}

export function IsFullWidth(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_FULL_WIDTH,
    isFullWidth,
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must contain a full-width characters`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isHalfWidth(value: unknown): boolean {
  return typeof value === "string" && HALF_WIDTH_RE.test(value);
}

export function IsHalfWidth(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_HALF_WIDTH,
    isHalfWidth,
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must contain a half-width characters`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isVariableWidth(value: unknown): boolean {
  return (
    typeof value === "string" &&
    FULL_WIDTH_RE.test(value) &&
    HALF_WIDTH_RE.test(value)
  );
}

export function IsVariableWidth(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_VARIABLE_WIDTH,
    isVariableWidth,
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must contain a full-width and half-width characters`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isMultibyte(value: unknown): boolean {
  return typeof value === "string" && MULTIBYTE_RE.test(value);
}

export function IsMultibyte(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_MULTIBYTE,
    isMultibyte,
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must contain one or more multibyte chars`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isSurrogatePair(value: unknown): boolean {
  return typeof value === "string" && SURROGATE_PAIR_RE.test(value);
}

export function IsSurrogatePair(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_SURROGATE_PAIR,
    isSurrogatePair,
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must contain any surrogate pairs chars`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isByteLength(
  value: unknown,
  min: number,
  max?: number,
): boolean {
  if (typeof value !== "string") return false;
  const len = utf8Encoder.encode(value).byteLength;
  return len >= min && (max === undefined || len <= max);
}

export function IsByteLength(
  min: number,
  max?: number,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_BYTE_LENGTH,
    (value) => isByteLength(value, min, max),
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property's byte length must fall into ($constraint1, $constraint2) range`,
      validationOptions,
    ),
    [min, max],
    validationOptions,
  );
}
