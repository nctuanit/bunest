import type { ValidationArguments } from "./validation-arguments.interface";

export interface ValidationOptions {
  each?: boolean;
  message?: string | ((validationArguments: ValidationArguments) => string);
  groups?: string[];
  always?: boolean;
  context?: Record<string, unknown>;
}

export interface ValidatorOptions {
  enableDebugMessages?: boolean;
  skipUndefinedProperties?: boolean;
  skipNullProperties?: boolean;
  skipMissingProperties?: boolean;
  whitelist?: boolean;
  forbidNonWhitelisted?: boolean;
  groups?: string[];
  always?: boolean;
  strictGroups?: boolean;
  dismissDefaultMessages?: boolean;
  validationError?: {
    target?: boolean;
    value?: boolean;
  };
  forbidUnknownValues?: boolean;
  stopAtFirstError?: boolean;
}

export function isValidationOptions(val: unknown): val is ValidationOptions {
  if (typeof val !== "object" || val === null) return false;
  const obj = val as Record<string, unknown>;
  return (
    "message" in obj ||
    "groups" in obj ||
    "always" in obj ||
    "each" in obj ||
    "context" in obj
  );
}
