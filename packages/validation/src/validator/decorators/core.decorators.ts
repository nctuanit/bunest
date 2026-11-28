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
import { readDesignType } from "../../transformer/engine/builtins.util";
import { defaultMetadataStorage as defaultTransformMetadataStorage } from "../../transformer/storage/metadata-storage";

const NON_DTO_DESIGN_TYPES = new Set<Function>(
  (
    [
      Object,
      Array,
      String,
      Number,
      Boolean,
      Date,
      RegExp,
      Function,
      Map,
      Set,
      WeakMap,
      WeakSet,
      Promise,
      Symbol,
      BigInt,
      Error,
      ArrayBuffer,
      DataView,
      Int8Array,
      Uint8Array,
      Uint8ClampedArray,
      Int16Array,
      Uint16Array,
      Int32Array,
      Uint32Array,
      Float32Array,
      Float64Array,
      BigInt64Array,
      BigUint64Array,
      typeof SharedArrayBuffer === "function" ? SharedArrayBuffer : undefined,
      typeof Buffer === "function" ? Buffer : undefined,
      typeof URL === "function" ? URL : undefined,
      typeof URLSearchParams === "function" ? URLSearchParams : undefined,
      typeof Blob === "function" ? Blob : undefined,
      typeof File === "function" ? File : undefined,
      typeof FormData === "function" ? FormData : undefined,
      typeof Headers === "function" ? Headers : undefined,
      typeof Request === "function" ? Request : undefined,
      typeof Response === "function" ? Response : undefined,
      typeof ReadableStream === "function" ? ReadableStream : undefined,
    ] as Array<Function | undefined>
  ).filter((ctor): ctor is Function => typeof ctor === "function"),
);

export interface ValidateNestedOptions extends ValidationOptions {
  /**
   * Optional nested DTO constructor resolver (e.g. `() => ItemDto`).
   * Automatically registers transformer `@Type(type)` metadata so you do not
   * need to stack `@ValidateNested({ each: true })` with `@Type(() => ItemDto)`.
   */
  readonly type?: () => Function;
}

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
  validationOptions?: ValidateNestedOptions,
): PropertyDecorator {
  const { type: nestedTypeFn, ...restOpts } = validationOptions ?? {};
  const opts: ValidationOptions = { ...restOpts };
  const eachPrefix = opts.each ? "each value in " : "";
  opts.message =
    opts.message ??
    `${eachPrefix}nested property $property must be either object or array`;

  return (object: object, propertyName: string | symbol): void => {
    const prop = String(propertyName);
    getMetadataStorage().addValidationMetadata(
      createValidationMetadata({
        type: ValidationTypes.NESTED_VALIDATION,
        target: object.constructor,
        propertyName: prop,
        validationOptions: opts,
      }),
    );

    const reflectedType = readDesignType(object, prop);
    if (typeof nestedTypeFn === "function") {
      defaultTransformMetadataStorage.addTypeMetadata({
        target: object.constructor,
        propertyName: prop,
        reflectedType,
        typeFunction: nestedTypeFn,
        options: {},
      });
    } else if (
      !opts.each &&
      typeof reflectedType === "function" &&
      !NON_DTO_DESIGN_TYPES.has(reflectedType) &&
      !defaultTransformMetadataStorage
        .getOwnTypeMap(object.constructor)
        ?.has(prop)
    ) {
      defaultTransformMetadataStorage.addTypeMetadata({
        target: object.constructor,
        propertyName: prop,
        reflectedType,
        typeFunction: () => reflectedType,
        options: {},
      });
    }
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
