import { ValidationTypes } from "../constants/validation-types";
import { buildMessage } from "../error/message-formatter";
import type {
  ValidateByOptions,
  ValidationDecoratorOptions,
} from "../interfaces/metadata.interface";
import type { ValidationArguments } from "../interfaces/validation-arguments.interface";
import type { ValidationOptions } from "../interfaces/validation-options.interface";
import type { ValidatorConstraintOptions } from "../interfaces/validator-constraint.interface";
import type { FastConstraintInstance } from "../compiler/validation-plan-compiler";
import {
  createConstraintMetadata,
  createValidationMetadata,
  getMetadataStorage,
} from "../storage/metadata-storage";

export const IS_OPTIONAL = "isOptional";
export const IS_DEFINED = ValidationTypes.IS_DEFINED;

export function ValidatorConstraint(
  options?: ValidatorConstraintOptions,
): ClassDecorator {
  return (target: Function): void => {
    const isAsync = options?.async === true;
    const name = options?.name ?? target.name ?? "";
    const metadata = createConstraintMetadata(target, name, isAsync);
    getMetadataStorage().addConstraintMetadata(metadata);
  };
}

export function registerDecorator(options: ValidationDecoratorOptions): void {
  const storage = getMetadataStorage();
  let constraintCls: Function;

  if (typeof options.validator === "function") {
    constraintCls = options.validator;
  } else {
    constraintCls = function InlineValidatorConstraint() {};
    const constraintMeta = createConstraintMetadata(
      constraintCls,
      options.name ?? "",
      false,
      options.validator,
    );
    storage.addConstraintMetadata(constraintMeta);
  }

  const type =
    options.name === ValidationTypes.IS_DEFINED
      ? ValidationTypes.IS_DEFINED
      : ValidationTypes.CUSTOM_VALIDATION;

  storage.addValidationMetadata(
    createValidationMetadata({
      type,
      name: options.name,
      target: options.target,
      propertyName: options.propertyName,
      constraintCls,
      constraints: options.constraints,
      validationOptions: options.options,
    }),
  );
}

export function ValidateBy(
  options: ValidateByOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: options.name,
      target: object.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      constraints: options.constraints,
      validator: options.validator,
    });
  };
}

export function createBuiltInDecorator(
  name: string,
  fastValidate: (value: unknown) => boolean,
  defaultMessage: (args?: ValidationArguments) => string,
  constraints: unknown[] | undefined,
  validationOptions: ValidationOptions | undefined,
): PropertyDecorator {
  const validatorInstance: FastConstraintInstance = {
    validate: (value: unknown) => fastValidate(value),
    defaultMessage,
    __fastValidate: fastValidate,
  };
  return ValidateBy(
    {
      name,
      constraints,
      validator: validatorInstance,
    },
    validationOptions,
  );
}

export function Validate(
  constraintClass: Function,
  validationOptions?: ValidationOptions,
): PropertyDecorator;
export function Validate(
  constraintClass: Function,
  constraints?: unknown[],
  validationOptions?: ValidationOptions,
): PropertyDecorator;
export function Validate(
  constraintClass: Function,
  constraintsOrValidationOptions?: unknown[] | ValidationOptions,
  maybeValidationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    const isConstraintsArray = Array.isArray(constraintsOrValidationOptions);
    getMetadataStorage().addValidationMetadata(
      createValidationMetadata({
        type: ValidationTypes.CUSTOM_VALIDATION,
        target: object.constructor,
        propertyName: String(propertyName),
        constraintCls: constraintClass,
        constraints: isConstraintsArray
          ? constraintsOrValidationOptions
          : undefined,
        validationOptions: isConstraintsArray
          ? maybeValidationOptions
          : constraintsOrValidationOptions,
      }),
    );
  };
}

export function ValidateIf<
  TObject = Record<string, unknown>,
  TValue = unknown,
>(
  condition: (object: TObject, value: TValue) => boolean,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    getMetadataStorage().addValidationMetadata(
      createValidationMetadata({
        type: ValidationTypes.CONDITIONAL_VALIDATION,
        target: object.constructor,
        propertyName: String(propertyName),
        constraints: [condition],
        validationOptions,
      }),
    );
  };
}

export function ValidateNested(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  const opts: ValidationOptions = { ...validationOptions };
  const eachPrefix = opts.each ? "each value in " : "";
  opts.message =
    opts.message ??
    `${eachPrefix}nested property $property must be either object or array`;

  return (object: object, propertyName: string | symbol): void => {
    getMetadataStorage().addValidationMetadata(
      createValidationMetadata({
        type: ValidationTypes.NESTED_VALIDATION,
        target: object.constructor,
        propertyName: String(propertyName),
        validationOptions: opts,
      }),
    );
  };
}

export function ValidatePromise(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    getMetadataStorage().addValidationMetadata(
      createValidationMetadata({
        type: ValidationTypes.PROMISE_VALIDATION,
        target: object.constructor,
        propertyName: String(propertyName),
        validationOptions,
      }),
    );
  };
}

export function Allow(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    getMetadataStorage().addValidationMetadata(
      createValidationMetadata({
        type: ValidationTypes.WHITELIST,
        target: object.constructor,
        propertyName: String(propertyName),
        validationOptions,
      }),
    );
  };
}

export function IsOptional(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    const prop = String(propertyName);
    getMetadataStorage().addValidationMetadata(
      createValidationMetadata({
        type: ValidationTypes.CONDITIONAL_VALIDATION,
        name: IS_OPTIONAL,
        target: object.constructor,
        propertyName: prop,
        constraints: [
          (obj: Record<string, unknown>, _value: unknown) =>
            obj[prop] !== null && obj[prop] !== undefined,
        ],
        validationOptions,
      }),
    );
  };
}

export function isDefined(value: unknown): boolean {
  return value !== undefined && value !== null;
}

export function IsDefined(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_DEFINED,
    isDefined,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property should not be null or undefined`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export { buildMessage };
