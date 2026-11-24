import type { ValidationArguments } from "./validation-arguments.interface";

export interface ValidatorConstraintInterface {
  validate(
    value: unknown,
    validationArguments?: ValidationArguments,
  ): Promise<boolean> | boolean;
  defaultMessage?(validationArguments?: ValidationArguments): string;
}

export interface ValidatorConstraintOptions {
  name?: string;
  async?: boolean;
}
