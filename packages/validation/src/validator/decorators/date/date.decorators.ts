import type { ValidationOptions } from "../../interfaces/validation-options.interface";
import { buildMessage, createBuiltInDecorator } from "../core.decorators";

export const MIN_DATE = "minDate";
export const MAX_DATE = "maxDate";

export type MinMaxDateInput = Date | (() => Date);

export function minDate(date: unknown, minDateValue: Date): boolean {
  return (
    date instanceof Date &&
    minDateValue instanceof Date &&
    date.getTime() >= minDateValue.getTime()
  );
}

export function MinDate(
  date: MinMaxDateInput,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  const resolveBound = typeof date === "function" ? date : () => date;
  return createBuiltInDecorator(
    MIN_DATE,
    (value) => minDate(value, resolveBound()),
    buildMessage((eachPrefix, args) => {
      const raw = args?.constraints[0] as MinMaxDateInput | undefined;
      const resolved = typeof raw === "function" ? raw() : raw;
      return `minimal allowed date for ${eachPrefix}$property is ${resolved instanceof Date ? resolved.toString() : "$constraint1"}`;
    }, validationOptions),
    [date],
    validationOptions,
  );
}

export function maxDate(date: unknown, maxDateValue: Date): boolean {
  return (
    date instanceof Date &&
    maxDateValue instanceof Date &&
    date.getTime() <= maxDateValue.getTime()
  );
}

export function MaxDate(
  date: MinMaxDateInput,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  const resolveBound = typeof date === "function" ? date : () => date;
  return createBuiltInDecorator(
    MAX_DATE,
    (value) => maxDate(value, resolveBound()),
    buildMessage((eachPrefix, args) => {
      const raw = args?.constraints[0] as MinMaxDateInput | undefined;
      const resolved = typeof raw === "function" ? raw() : raw;
      return `maximal allowed date for ${eachPrefix}$property is ${resolved instanceof Date ? resolved.toString() : "$constraint1"}`;
    }, validationOptions),
    [date],
    validationOptions,
  );
}
