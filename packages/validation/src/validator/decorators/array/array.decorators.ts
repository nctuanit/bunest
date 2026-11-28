import {
  isValidationOptions,
  type ValidationOptions,
} from "../../interfaces/validation-options.interface";
import { buildMessage, createBuiltInDecorator } from "../core.decorators";

export const ARRAY_CONTAINS = "arrayContains";
export const ARRAY_NOT_CONTAINS = "arrayNotContains";
export const ARRAY_NOT_EMPTY = "arrayNotEmpty";
export const ARRAY_MIN_SIZE = "arrayMinSize";
export const ARRAY_MAX_SIZE = "arrayMaxSize";
export const ARRAY_UNIQUE = "arrayUnique";

export type ArrayUniqueIdentifier<T = unknown> = (o: T) => unknown;

export function arrayContains(
  array: unknown,
  values: readonly unknown[],
): boolean {
  if (!Array.isArray(array)) return false;
  return values.every((value) => array.indexOf(value) !== -1);
}

export function ArrayContains(
  values: readonly unknown[],
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    ARRAY_CONTAINS,
    (value) => arrayContains(value, values),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must contain $constraint1 values`,
      validationOptions,
    ),
    [values],
    validationOptions,
  );
}

export function arrayNotContains(
  array: unknown,
  values: readonly unknown[],
): boolean {
  if (!Array.isArray(array)) return false;
  return values.every((value) => array.indexOf(value) === -1);
}

export function ArrayNotContains(
  values: readonly unknown[],
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    ARRAY_NOT_CONTAINS,
    (value) => arrayNotContains(value, values),
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property should not contain $constraint1 values`,
      validationOptions,
    ),
    [values],
    validationOptions,
  );
}

export function arrayNotEmpty(array: unknown): boolean {
  return Array.isArray(array) && array.length > 0;
}

export function ArrayNotEmpty(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    ARRAY_NOT_EMPTY,
    arrayNotEmpty,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property should not be empty`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function arrayMinSize(array: unknown, min: number): boolean {
  return Array.isArray(array) && array.length >= min;
}

export function ArrayMinSize(
  min: number,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    ARRAY_MIN_SIZE,
    (value) => arrayMinSize(value, min),
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must contain at least $constraint1 elements`,
      validationOptions,
    ),
    [min],
    validationOptions,
  );
}

export function arrayMaxSize(array: unknown, max: number): boolean {
  return Array.isArray(array) && array.length <= max;
}

export function ArrayMaxSize(
  max: number,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    ARRAY_MAX_SIZE,
    (value) => arrayMaxSize(value, max),
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must contain no more than $constraint1 elements`,
      validationOptions,
    ),
    [max],
    validationOptions,
  );
}

export function arrayUnique<T = unknown>(
  array: unknown,
  identifier?: ArrayUniqueIdentifier<T>,
): boolean {
  if (!Array.isArray(array)) return false;
  const seen = new Set<unknown>();
  for (let i = 0; i < array.length; i++) {
    const key = identifier ? identifier(array[i] as T) : array[i];
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

export function ArrayUnique<T = unknown>(
  identifierOrOptions?: ArrayUniqueIdentifier<T> | ValidationOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  const isIdentifier = typeof identifierOrOptions === "function";
  const identifier = isIdentifier ? identifierOrOptions : undefined;
  const opts =
    !isIdentifier && isValidationOptions(identifierOrOptions)
      ? identifierOrOptions
      : validationOptions;

  return createBuiltInDecorator(
    ARRAY_UNIQUE,
    (value) => arrayUnique(value, identifier),
    buildMessage(
      (eachPrefix) => `${eachPrefix}All $property's elements must be unique`,
      opts,
    ),
    identifier ? [identifier] : undefined,
    opts,
  );
}
