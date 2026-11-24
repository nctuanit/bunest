import type { ValidationArguments } from "./validation-arguments.interface";
import type { ValidationOptions } from "./validation-options.interface";
import type { ValidatorConstraintInterface } from "./validator-constraint.interface";

export interface ValidationMetadataArgs {
  type: string;
  name?: string;
  target: Function | string;
  propertyName: string;
  constraintCls?: Function;
  constraints?: unknown[];
  validationOptions?: ValidationOptions;
  validationTypeOptions?: unknown;
}

export interface ValidationMetadata {
  type: string;
  name?: string;
  target: Function | string;
  propertyName: string;
  constraints?: unknown[];
  constraintCls?: Function;
  validationTypeOptions?: unknown;
  groups?: string[];
  always?: boolean;
  each?: boolean;
  context?: Record<string, unknown>;
  message?: string | ((validationArguments: ValidationArguments) => string);
}

export interface ConstraintMetadata {
  target: Function;
  name: string;
  async: boolean;
  readonly instance: ValidatorConstraintInterface;
}

export interface ValidationDecoratorOptions {
  target: Function;
  propertyName: string;
  name?: string;
  options?: ValidationOptions;
  constraints?: unknown[];
  validator: ValidatorConstraintInterface | Function;
}

export interface ValidateByOptions {
  name: string;
  constraints?: unknown[];
  validator: ValidatorConstraintInterface | Function;
  async?: boolean;
}
