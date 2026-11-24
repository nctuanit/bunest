import type { ValidationOptions } from "../../interfaces/validation-options.interface";
import { buildMessage, createBuiltInDecorator } from "../core.decorators";

export const EQUALS = "equals";
export const NOT_EQUALS = "notEquals";
export const IS_EMPTY = "isEmpty";
export const IS_NOT_EMPTY = "isNotEmpty";
export const IS_IN = "isIn";
export const IS_NOT_IN = "isNotIn";
export const IS_LATLONG = "isLatLong";
export const IS_LATITUDE = "isLatitude";
export const IS_LONGITUDE = "isLongitude";

const LAT_RE = /^\(?[+-]?(?:90(?:\.0+)?|[1-8]?\d(?:\.\d+)?)$/;
const LNG_RE = /^\s*[+-]?(?:180(?:\.0+)?|1[0-7]\d(?:\.\d+)?|[1-9]?\d(?:\.\d+)?)\)?$/;

export function equals(value: unknown, comparison: unknown): boolean {
  return value === comparison;
}

export function Equals(
  comparison: unknown,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    EQUALS,
    (value) => equals(value, comparison),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be equal to $constraint1`,
      validationOptions,
    ),
    [comparison],
    validationOptions,
  );
}

export function notEquals(value: unknown, comparison: unknown): boolean {
  return value !== comparison;
}

export function NotEquals(
  comparison: unknown,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    NOT_EQUALS,
    (value) => notEquals(value, comparison),
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property should not be equal to $constraint1`,
      validationOptions,
    ),
    [comparison],
    validationOptions,
  );
}

export function isEmpty(value: unknown): boolean {
  return value === "" || value === null || value === undefined;
}

export function IsEmpty(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_EMPTY,
    isEmpty,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be empty`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isNotEmpty(value: unknown): boolean {
  return value !== "" && value !== null && value !== undefined;
}

export function IsNotEmpty(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_NOT_EMPTY,
    isNotEmpty,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property should not be empty`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isIn(
  value: unknown,
  possibleValues: readonly unknown[],
): boolean {
  return (
    !Array.isArray(possibleValues) ||
    possibleValues.some((possibleValue) => possibleValue === value)
  );
}

export function IsIn(
  values: readonly unknown[],
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_IN,
    (value) => isIn(value, values),
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must be one of the following values: $constraint1`,
      validationOptions,
    ),
    [values],
    validationOptions,
  );
}

export function isNotIn(
  value: unknown,
  possibleValues: readonly unknown[],
): boolean {
  return (
    !Array.isArray(possibleValues) ||
    !possibleValues.some((possibleValue) => possibleValue === value)
  );
}

export function IsNotIn(
  values: readonly unknown[],
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_NOT_IN,
    (value) => isNotIn(value, values),
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property should not be one of the following values: $constraint1`,
      validationOptions,
    ),
    [values],
    validationOptions,
  );
}

export function isLatLong(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const commaIdx = value.indexOf(",");
  if (commaIdx === -1 || value.indexOf(",", commaIdx + 1) !== -1) return false;
  const lat = value.slice(0, commaIdx);
  const lng = value.slice(commaIdx + 1);
  if (
    (lat.startsWith("(") && !lng.endsWith(")")) ||
    (lng.endsWith(")") && !lat.startsWith("("))
  ) {
    return false;
  }
  return LAT_RE.test(lat) && LNG_RE.test(lng);
}

export function IsLatLong(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_LATLONG,
    isLatLong,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a latitude,longitude string`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isLatitude(value: unknown): boolean {
  return (
    (typeof value === "number" || typeof value === "string") &&
    isLatLong(`${value},0`)
  );
}

export function IsLatitude(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_LATITUDE,
    isLatitude,
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must be a latitude string or number`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isLongitude(value: unknown): boolean {
  return (
    (typeof value === "number" || typeof value === "string") &&
    isLatLong(`0,${value}`)
  );
}

export function IsLongitude(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_LONGITUDE,
    isLongitude,
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must be a longitude string or number`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}
