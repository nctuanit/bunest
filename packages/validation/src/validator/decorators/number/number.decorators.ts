import type { ValidationOptions } from "../../interfaces/validation-options.interface";
import { buildMessage, createBuiltInDecorator } from "../core.decorators";

export const IS_DIVISIBLE_BY = "isDivisibleBy";
export const IS_POSITIVE = "isPositive";
export const IS_NEGATIVE = "isNegative";
export const MIN = "min";
export const MAX = "max";

export function isDivisibleBy(value: unknown, num: number): boolean {
  if (
    typeof value !== "number" ||
    typeof num !== "number" ||
    !Number.isFinite(value) ||
    !Number.isFinite(num) ||
    num === 0
  ) {
    return false;
  }
  return value % num === 0;
}

export function IsDivisibleBy(
  num: number,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_DIVISIBLE_BY,
    (value) => isDivisibleBy(value, num),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be divisible by $constraint1`,
      validationOptions,
    ),
    [num],
    validationOptions,
  );
}

export function isPositive(value: unknown): boolean {
  return typeof value === "number" && value > 0;
}

export function IsPositive(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_POSITIVE,
    isPositive,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a positive number`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isNegative(value: unknown): boolean {
  return typeof value === "number" && value < 0;
}

export function IsNegative(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_NEGATIVE,
    isNegative,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a negative number`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function min(num: unknown, minValue: number): boolean {
  return typeof num === "number" && typeof minValue === "number" && num >= minValue;
}

export function Min(
  minValue: number,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    MIN,
    (value) => min(value, minValue),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must not be less than $constraint1`,
      validationOptions,
    ),
    [minValue],
    validationOptions,
  );
}

export function max(num: unknown, maxValue: number): boolean {
  return typeof num === "number" && typeof maxValue === "number" && num <= maxValue;
}

export function Max(
  maxValue: number,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    MAX,
    (value) => max(value, maxValue),
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must not be greater than $constraint1`,
      validationOptions,
    ),
    [maxValue],
    validationOptions,
  );
}
