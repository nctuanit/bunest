import type { ValidationOptions } from "./validation-options.interface";

export interface ValidationSchemaPropertyRule {
  type: string;
  constraints?: unknown[];
  message?: ValidationOptions["message"];
  groups?: string[];
  always?: boolean;
  each?: boolean;
  options?: unknown;
  context?: Record<string, unknown>;
}

export interface ValidationSchema {
  name: string;
  properties: Record<string, ValidationSchemaPropertyRule[]>;
}
