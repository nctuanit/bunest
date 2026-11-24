import type { Type } from "./type.interface";

/**
 * HTTP status code used for validation & pipe error responses.
 */
export type ErrorHttpStatusCode = number;

/**
 * Validation error description structurally compatible with `class-validator`'s
 * `ValidationError` class and `@nestjs/common`'s `ValidationError` interface.
 */
export interface ValidationError {
  target?: object;
  property: string;
  value?: unknown;
  constraints?: {
    [type: string]: string;
  };
  children?: ValidationError[];
  contexts?: {
    [type: string]: unknown;
  };
}

/**
 * Options passed to `class-validator` during validation (zero-dependency
 * structural interface matching `@nestjs/common` & `class-validator`).
 */
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

/**
 * Options passed to `class-transformer` during transformation (zero-dependency
 * structural interface matching `@nestjs/common` & `class-transformer`).
 */
export interface ClassTransformOptions {
  strategy?: "excludeAll" | "exposeAll";
  groups?: string[];
  version?: number;
  excludePrefixes?: string[];
  ignoreDecorators?: boolean;
  targetMaps?: unknown[];
  enableCircularCheck?: boolean;
  enableImplicitConversion?: boolean;
  excludeExtraneousValues?: boolean;
  exposeDefaultValues?: boolean;
  exposeUnsetFields?: boolean;
}

/**
 * Structural contract for a `class-validator`-compatible package override.
 */
export interface ValidatorPackage {
  validate(
    object: any,
    validatorOptions?: ValidatorOptions,
  ): ValidationError[] | Promise<ValidationError[]>;
}

/**
 * Bunest alias for `ValidatorPackage`.
 */
export type ValidatorPackageLike = ValidatorPackage;

/**
 * Structural contract for a `class-transformer`-compatible package override.
 * Supports `plainToInstance` (for `ValidationPipe` / `@SerializeOptions({ type })`),
 * plus `instanceToPlain` and legacy `classToPlain` (for `ClassSerializerInterceptor`).
 */
export interface TransformerPackage {
  plainToInstance?: <T = any>(
    cls: Type<T>,
    plain: any,
    options?: ClassTransformOptions,
  ) => any;
  instanceToPlain?: (object: any, options?: ClassTransformOptions) => any;
  classToPlain?: (object: any, options?: ClassTransformOptions) => any;
}

/**
 * Bunest alias for `TransformerPackage`.
 */
export type TransformerPackageLike = TransformerPackage;
