import type { ValidationOptions } from "../../interfaces/validation-options.interface";
import { buildMessage, createBuiltInDecorator } from "../core.decorators";

export const IS_BOOLEAN = "isBoolean";
export const IS_DATE = "isDate";
export const IS_STRING = "isString";
export const IS_NUMBER = "isNumber";
export const IS_INT = "isInt";
export const IS_ARRAY = "isArray";
export const IS_ENUM = "isEnum";
export const IS_OBJECT = "isObject";
export const IS_NOT_EMPTY_OBJECT = "isNotEmptyObject";
export const IS_INSTANCE = "isInstance";

export interface IsNumberOptions {
  allowNaN?: boolean;
  allowInfinity?: boolean;
  maxDecimalPlaces?: number;
}

export interface IsNotEmptyObjectOptions {
  nullable?: boolean;
}

export function isBoolean(value: unknown): value is boolean {
  return value instanceof Boolean || typeof value === "boolean";
}

export function IsBoolean(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_BOOLEAN,
    isBoolean,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a boolean value`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export function IsDate(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_DATE,
    isDate,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a Date instance`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isString(value: unknown): value is string {
  return value instanceof String || typeof value === "string";
}

export function IsString(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_STRING,
    isString,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a string`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isNumber(
  value: unknown,
  options: IsNumberOptions = {},
): value is number {
  if (typeof value !== "number") return false;
  if (value === Infinity || value === -Infinity) {
    return Boolean(options.allowInfinity);
  }
  if (Number.isNaN(value)) return Boolean(options.allowNaN);
  if (options.maxDecimalPlaces !== undefined) {
    let decimalPlaces = 0;
    if (value % 1 !== 0) {
      const str = value.toString();
      const dotIdx = str.indexOf(".");
      if (dotIdx !== -1) {
        const expIdx = str.indexOf("e", dotIdx);
        decimalPlaces =
          expIdx === -1 ? str.length - dotIdx - 1 : expIdx - dotIdx - 1;
      }
    }
    if (decimalPlaces > options.maxDecimalPlaces) return false;
  }
  return Number.isFinite(value);
}

export function IsNumber(
  options: IsNumberOptions = {},
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_NUMBER,
    (value) => isNumber(value, options),
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must be a number conforming to the specified constraints`,
      validationOptions,
    ),
    [options],
    validationOptions,
  );
}

export function isInt(val: unknown): val is number {
  return typeof val === "number" && Number.isInteger(val);
}

export function IsInt(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_INT,
    isInt,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be an integer number`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function IsArray(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_ARRAY,
    isArray,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be an array`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

function getValidEnumValues(entity: object): unknown[] {
  const record = entity as Record<string, unknown>;
  const keys = Object.keys(record);
  const values: unknown[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const val = record[key];
    if (typeof record[String(val)] === "number") continue;
    values.push(val);
  }
  return values;
}

export function isEnum(value: unknown, entity: object): boolean {
  if (!entity || typeof entity !== "object") return false;
  return getValidEnumValues(entity).includes(value);
}

export function IsEnum(
  entity: object,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  const validValues =
    entity && typeof entity === "object" ? getValidEnumValues(entity) : [];
  const validSet = new Set<unknown>(validValues);

  return createBuiltInDecorator(
    IS_ENUM,
    (value) => validSet.has(value),
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must be one of the following values: $constraint2`,
      validationOptions,
    ),
    [entity, validValues],
    validationOptions,
  );
}

export function isObject(value: unknown): value is object {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    !Array.isArray(value)
  );
}

export function IsObject(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_OBJECT,
    isObject,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be an object`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isNotEmptyObject(
  value: unknown,
  options?: IsNotEmptyObjectOptions,
): boolean {
  if (!isObject(value)) return false;
  if (options?.nullable === true) return Object.keys(value).length > 0;
  const record = value as Record<string, unknown>;
  for (const key in record) {
    if (
      Object.prototype.hasOwnProperty.call(record, key) &&
      record[key] !== null &&
      record[key] !== undefined
    ) {
      return true;
    }
  }
  return false;
}

export function IsNotEmptyObject(
  options?: IsNotEmptyObjectOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_NOT_EMPTY_OBJECT,
    (value) => isNotEmptyObject(value, options),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a non-empty object`,
      validationOptions,
    ),
    [options],
    validationOptions,
  );
}

export function isInstance(
  object: unknown,
  targetTypeConstructor: Function,
): boolean {
  return (
    typeof targetTypeConstructor === "function" &&
    object instanceof targetTypeConstructor
  );
}

export function IsInstance(
  targetType: Function,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_INSTANCE,
    (value) => isInstance(value, targetType),
    buildMessage((eachPrefix, args) => {
      const ctor = args?.constraints[0] as Function | undefined;
      if (ctor) {
        return `${eachPrefix}$property must be an instance of ${ctor.name}`;
      }
      return `${eachPrefix}${IS_INSTANCE} decorator expects and object as value, but got falsy value.`;
    }, validationOptions),
    [targetType],
    validationOptions,
  );
}
