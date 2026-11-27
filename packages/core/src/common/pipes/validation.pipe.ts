import { BODY_SANITIZED_SYMBOL } from "../constants/tokens";
import { Inject, Injectable, Optional } from "../decorators/core.decorators";
import { DecoratorRegistry } from "../metadata/decorator-registry";
import { HttpStatus } from "../enums/scope.enum";
import type { ValidationErrorFormat } from "../interfaces/application.interface";
import type {
  ArgumentMetadata,
  PipeTransform,
} from "../interfaces/http.interface";
import type { Type } from "../interfaces/type.interface";
import type {
  ClassTransformOptions,
  ErrorHttpStatusCode,
  TransformerPackage,
  TransformerPackageLike,
  ValidationError,
  ValidatorOptions,
  ValidatorPackage,
  ValidatorPackageLike,
} from "../interfaces/validation.interface";
import { stripProtoKeys as stripProtoKeysUtil } from "../utils/common.utils";
import {
  OMITTED_ERRORS_MESSAGE,
  resolveMaxErrorMessagesLength,
} from "./validation-errors.constants";
import {
  buildDangerousKeyValidationErrors,
  createStatusHttpException,
  createValidationHttpException,
  findDangerousKeys,
  flattenValidationErrorDetails,
  getHttpReasonPhrase,
  getValidationMetadatasForTarget,
  loadDefaultTransformerPackage,
  loadDefaultValidatorPackage,
  resolveTransformerPackageFor,
  resolveValidatorPackageFor,
  type NativeValidatorEngineLike,
} from "./validation-http.util";

export const VALIDATION_PIPE_OPTIONS = Symbol.for(
  "bunest:validation:validation_pipe_options",
);

export type {
  TransformerPackage,
  TransformerPackageLike,
  ValidatorPackage,
  ValidatorPackageLike,
};

export interface ValidationPipeOptions extends ValidatorOptions {
  /**
   * Transform plain payloads into DTO class instances using `plainToInstance`.
   * @default true
   */
  transform?: boolean;
  /**
   * Options forwarded to `class-transformer`'s `plainToInstance`.
   * `enableImplicitConversion` defaults to `false` per ADR-009.
   */
  transformOptions?: ClassTransformOptions;
  /**
   * Disable detailed field-by-field error output in the HTTP error body.
   * @default false
   */
  disableErrorMessages?: boolean;
  /**
   * When `true`, `createExceptionFactory()` skips flattening `ValidationError[]`
   * into strings/details and emits the raw `ValidationError[]` array in `message`.
   * @default false
   */
  disableFlattenErrorMessages?: boolean;
  /**
   * When `true` and a custom `exceptionFactory` is provided, passes the flattened
   * `string[]` error messages to `exceptionFactory` instead of raw `ValidationError[]`.
   * @default false
   */
  flatExceptionFactory?: boolean;
  /**
   * HTTP status code used for validation failure responses.
   * @default HttpStatus.BAD_REQUEST (400)
   */
  errorHttpStatusCode?: ErrorHttpStatusCode;
  /**
   * Custom factory turning `class-validator` `ValidationError[]` into an exception.
   */
  exceptionFactory?: (errors: ValidationError[]) => unknown;
  /**
   * Explicit DTO class constructor overriding `ArgumentMetadata.metatype`.
   */
  expectedType?: Type<unknown>;
  /**
   * Whether to validate parameters from custom parameter decorators
   * (`ArgumentMetadata.type === "custom"`).
   * @default false
   */
  validateCustomDecorators?: boolean;
  /**
   * Output format for built-in validation errors:
   * - `"bunest"` (default per ADR-009): structured `details: [{ field, constraints, messages }]`
   * - `"list"` (NestJS default): flat `message: string[]`
   * - `"grouped"` (NestJS v12): `message: Record<string, string[]>`
   * @default "bunest"
   */
  errorFormat?: ValidationErrorFormat;
  /**
   * Maximum total character length of emitted validation error messages before truncating
   * remaining errors (NestJS v12 DoS protection). Set `Infinity` to disable.
   * @default 1_000_000
   */
  maxErrorMessagesLength?: number;
  /**
   * Optional custom `class-validator`-compatible package override.
   */
  validatorPackage?: ValidatorPackageLike;
  /**
   * Optional custom `class-transformer`-compatible package override.
   */
  transformerPackage?: TransformerPackageLike;
}

export interface ValidationPipeFlatExceptionOptions
  extends Omit<
    ValidationPipeOptions,
    "flatExceptionFactory" | "exceptionFactory"
  > {
  flatExceptionFactory: true;
  exceptionFactory?: (errors: string[]) => unknown;
}

const CANDIDATE_NON_DTO_METATYPES: ReadonlyArray<Function | undefined> = [
  String,
  Boolean,
  Number,
  Array,
  Object,
  Function,
  Symbol,
  BigInt,
  Date,
  RegExp,
  Map,
  Set,
  WeakMap,
  WeakSet,
  Promise,
  Error,
  ArrayBuffer,
  Uint8Array,
  typeof Buffer !== "undefined" ? Buffer : undefined,
  typeof Request !== "undefined" ? Request : undefined,
  typeof Response !== "undefined" ? Response : undefined,
  typeof Headers !== "undefined" ? Headers : undefined,
  typeof URL !== "undefined" ? URL : undefined,
  typeof URLSearchParams !== "undefined" ? URLSearchParams : undefined,
  typeof FormData !== "undefined" ? FormData : undefined,
  typeof Blob !== "undefined" ? Blob : undefined,
  typeof File !== "undefined" ? File : undefined,
  typeof ReadableStream !== "undefined" ? ReadableStream : undefined,
];

const NON_DTO_METATYPES: ReadonlySet<Function> = new Set<Function>(
  CANDIDATE_NON_DTO_METATYPES.filter(
    (ctor): ctor is Function => typeof ctor === "function",
  ),
);

function isNonDtoPayloadObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    return false;
  }

  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet ||
    value instanceof Promise ||
    value instanceof Error ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    return true;
  }

  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return true;
  }
  if (typeof URL !== "undefined" && value instanceof URL) {
    return true;
  }
  if (typeof Request !== "undefined" && value instanceof Request) {
    return true;
  }
  if (typeof Response !== "undefined" && value instanceof Response) {
    return true;
  }
  if (typeof Headers !== "undefined" && value instanceof Headers) {
    return true;
  }
  if (typeof FormData !== "undefined" && value instanceof FormData) {
    return true;
  }
  if (
    typeof ReadableStream !== "undefined" &&
    value instanceof ReadableStream
  ) {
    return true;
  }

  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function pickWhitelistedRawValues(
  raw: unknown,
  validated: unknown,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof validated !== "object" ||
    validated === null
  ) {
    return raw;
  }

  if (seen.has(raw)) {
    return seen.get(raw);
  }

  if (Array.isArray(raw) && Array.isArray(validated)) {
    const out: unknown[] = [];
    seen.set(raw, out);
    for (let i = 0; i < raw.length; i += 1) {
      out.push(pickWhitelistedRawValues(raw[i], validated[i], seen));
    }
    return out;
  }

  if (!isPlainRecord(raw)) {
    return raw;
  }

  const out: Record<string, unknown> = {};
  seen.set(raw, out);
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(validated, key)) {
      continue;
    }
    const rawChild = raw[key];
    const validatedChild = (validated as Record<string, unknown>)[key];
    out[key] = pickWhitelistedRawValues(rawChild, validatedChild, seen);
  }
  return out;
}

function closeSparseArrayGaps(
  value: unknown,
  seen?: WeakSet<object>,
): void {
  if (
    typeof value !== "object" ||
    value === null ||
    isNonDtoPayloadObject(value)
  ) {
    return;
  }
  if (!seen && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    let hasNestedObject = false;
    for (const k in rec) {
      if (!Object.hasOwn(rec, k)) continue;
      const v = rec[k];
      if (typeof v === "object" && v !== null) {
        hasNestedObject = true;
        break;
      }
    }
    if (!hasNestedObject) {
      return;
    }
  }
  const visited = seen ?? new WeakSet<object>();
  if (visited.has(value)) return;
  visited.add(value);
  if (Array.isArray(value)) {
    let writeIdx = 0;
    for (let i = 0; i < value.length; i++) {
      if (i in value) {
        const item = value[i];
        value[writeIdx++] = item;
        closeSparseArrayGaps(item, visited);
      }
    }
    if (writeIdx !== value.length) {
      value.length = writeIdx;
    }
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key in record) {
    if (Object.hasOwn(record, key)) {
      const val = record[key];
      if (typeof val === "object" && val !== null) {
        closeSparseArrayGaps(val, visited);
      }
    }
  }
}

/**
 * Default Bunest DTO validation pipe backed by `class-validator` and
 * `class-transformer` with conservative security defaults per ADR-005 & ADR-009,
 * and full NestJS v12 `ValidationPipe` public & protected hook parity.
 */
@Injectable()
export class ValidationPipe implements PipeTransform<unknown, unknown> {
  protected isTransformEnabled: boolean;
  protected isDetailedOutputDisabled: boolean;
  protected isFlattenErrorMessagesDisabled: boolean;
  protected isFlatExceptionFactoryEnabled: boolean;
  protected validatorOptions: ValidatorOptions;
  protected transformOptions: ClassTransformOptions;
  protected errorHttpStatusCode: ErrorHttpStatusCode;
  protected expectedType: Type<unknown> | undefined;
  protected exceptionFactory: (errors: ValidationError[]) => unknown;
  protected validateCustomDecorators: boolean;
  protected errorFormat: ValidationErrorFormat;
  protected maxErrorMessagesLength: number;

  private readonly isWhitelistEnabled: boolean;
  private readonly validatorPackageOverride?: ValidatorPackage;
  private readonly transformerPackageOverride?: TransformerPackage;
  private resolvedValidatorPkg?: ValidatorPackage;
  private resolvedTransformerPkg?: TransformerPackage;

  constructor(options: ValidationPipeFlatExceptionOptions);
  constructor(options?: ValidationPipeOptions);
  constructor(
    @Optional()
    @Inject(VALIDATION_PIPE_OPTIONS)
    options: ValidationPipeOptions | ValidationPipeFlatExceptionOptions = {},
  ) {
    const {
      transform = true,
      transformOptions,
      disableErrorMessages = false,
      disableFlattenErrorMessages = false,
      flatExceptionFactory = false,
      errorHttpStatusCode = HttpStatus.BAD_REQUEST,
      exceptionFactory,
      expectedType,
      validateCustomDecorators = false,
      errorFormat = "bunest",
      maxErrorMessagesLength,
      validatorPackage,
      transformerPackage,
      whitelist = true,
      forbidNonWhitelisted = whitelist ? true : false,
      forbidUnknownValues = true,
      stopAtFirstError = false,
      skipMissingProperties = false,
      skipNullProperties = false,
      skipUndefinedProperties = false,
      dismissDefaultMessages = false,
      validationError,
      ...restValidatorOptions
    } = options;

    this.isTransformEnabled = transform;
    this.isWhitelistEnabled = Boolean(whitelist);
    this.isDetailedOutputDisabled = disableErrorMessages;
    this.isFlattenErrorMessagesDisabled = disableFlattenErrorMessages;
    this.isFlatExceptionFactoryEnabled = flatExceptionFactory;
    this.errorHttpStatusCode = errorHttpStatusCode;
    this.expectedType = expectedType;
    this.validateCustomDecorators = validateCustomDecorators;
    this.errorFormat = errorFormat;
    this.maxErrorMessagesLength = resolveMaxErrorMessagesLength(
      maxErrorMessagesLength,
    );
    this.validatorPackageOverride = validatorPackage;
    this.transformerPackageOverride = transformerPackage;

    this.transformOptions = Object.freeze({
      enableImplicitConversion: false,
      ...transformOptions,
    });

    this.validatorOptions = Object.freeze({
      ...restValidatorOptions,
      whitelist,
      forbidNonWhitelisted,
      forbidUnknownValues,
      stopAtFirstError,
      skipMissingProperties,
      skipNullProperties,
      skipUndefinedProperties,
      dismissDefaultMessages,
      validationError: Object.freeze({
        target: validationError?.target ?? false,
        value: validationError?.value ?? false,
      }),
    });

    this.exceptionFactory = exceptionFactory
      ? flatExceptionFactory
        ? (errors: ValidationError[]) =>
            (exceptionFactory as (errors: string[]) => unknown)(
              this.flattenValidationErrors(errors),
            )
        : (exceptionFactory as (errors: ValidationError[]) => unknown)
      : this.createExceptionFactory();
  }

  protected loadValidator(
    validatorPackage?: ValidatorPackage,
    target?: Function,
  ): ValidatorPackage | Promise<ValidatorPackage> {
    if (validatorPackage) {
      return validatorPackage;
    }
    if (this.validatorPackageOverride) {
      return this.validatorPackageOverride;
    }
    if (target) {
      return resolveValidatorPackageFor(target);
    }
    this.resolvedValidatorPkg ??= loadDefaultValidatorPackage();
    return this.resolvedValidatorPkg;
  }

  protected loadTransformer(
    transformerPackage?: TransformerPackage,
    target?: Function,
  ): TransformerPackage | Promise<TransformerPackage> {
    if (transformerPackage) {
      return transformerPackage;
    }
    if (this.transformerPackageOverride) {
      return this.transformerPackageOverride;
    }
    if (target) {
      return resolveTransformerPackageFor(target);
    }
    this.resolvedTransformerPkg ??= loadDefaultTransformerPackage();
    return this.resolvedTransformerPkg;
  }

  async transform(
    value: unknown,
    metadata?: ArgumentMetadata,
  ): Promise<unknown> {
    const effectiveMeta: ArgumentMetadata = metadata ?? { type: "custom" };
    if (effectiveMeta.type === "custom" && !this.validateCustomDecorators) {
      return value;
    }

    const metatype = this.expectedType ?? effectiveMeta.metatype;
    if (
      !metatype ||
      !this.toValidate({
        ...effectiveMeta,
        metatype,
      })
    ) {
      if (
        typeof value === "object" &&
        value !== null &&
        (value as Record<PropertyKey, unknown>)[BODY_SANITIZED_SYMBOL] !== true
      ) {
        this.stripProtoKeys(value);
      }
      return value;
    }

    // Guard 1: Handle null, undefined, primitives, arrays, and non-record built-ins when a DTO class is expected (ADR-009)
    if (
      value === null ||
      value === undefined ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      isNonDtoPayloadObject(value)
    ) {
      const hasRules = await this.hasValidationRules(metatype as Type<unknown>);
      if (
        !hasRules &&
        (this.isBinary(value) ||
          this.validatorOptions.forbidUnknownValues !== true)
      ) {
        return value;
      }

      if (hasRules && this.isBinary(value) && this.errorFormat !== "bunest") {
        const useDynamicTransformer =
          !this.transformerPackageOverride &&
          this.loadTransformer === ValidationPipe.prototype.loadTransformer;
        const transformerPkg = useDynamicTransformer
          ? resolveTransformerPackageFor(metatype)
          : await this.loadTransformer();
        const emptyEntity = transformerPkg.plainToInstance
          ? transformerPkg.plainToInstance(
              metatype as Type<unknown>,
              {},
              this.transformOptions,
            )
          : new (metatype as Type<unknown>)();
        const validatorPkg = this.validatorPackageOverride
          ? await this.loadValidator()
          : resolveValidatorPackageFor(metatype);
        const binaryRuleErrors = await validatorPkg.validate(
          emptyEntity,
          this.validatorOptions,
        );
        if (binaryRuleErrors.length > 0) {
          throw this.exceptionFactory(binaryRuleErrors);
        }
      }

      const fieldName = effectiveMeta.data ?? effectiveMeta.type ?? "value";
      const rootError: ValidationError = {
        property: fieldName,
        children: [],
        constraints: {
          isObject: "Validation failed (object is expected)",
        },
      };
      throw this.exceptionFactory([rootError]);
    }

    // Guard 2: Reject dangerous prototype-pollution keys before plainToInstance (ADR-009).
    // Fast path: skip redundant second-pass deep walk when `@bunest/core/http`
    // has already sanitized this JSON object and stamped the unforgeable Symbol marker.
    if (
      (value as Record<PropertyKey, unknown>)[BODY_SANITIZED_SYMBOL] !== true
    ) {
      const dangerousViolations = findDangerousKeys(value);
      if (dangerousViolations.length > 0) {
        throw this.exceptionFactory(
          buildDangerousKeyValidationErrors(dangerousViolations),
        );
      }
    }

    if (this.stripProtoKeys !== ValidationPipe.prototype.stripProtoKeys) {
      this.stripProtoKeys(value);
    }

    this.closeArrayGaps(value);

    const useDynamicTransformer =
      !this.transformerPackageOverride &&
      this.loadTransformer === ValidationPipe.prototype.loadTransformer;
    const transformerPkg = useDynamicTransformer
      ? resolveTransformerPackageFor(metatype)
      : await this.loadTransformer();
    const plainToInstanceFn = transformerPkg.plainToInstance;
    if (typeof plainToInstanceFn !== "function") {
      throw new Error(
        'Configured transformerPackage is missing "plainToInstance()".',
      );
    }

    const entity = plainToInstanceFn(
      metatype as Type<unknown>,
      value,
      this.transformOptions,
    );

    if (typeof entity !== "object" || entity === null) {
      const fieldName = effectiveMeta.data ?? effectiveMeta.type ?? "value";
      const rootError: ValidationError = {
        property: fieldName,
        children: [],
        constraints: {
          isObject: `${fieldName} must be a valid object`,
        },
      };
      throw this.exceptionFactory([rootError]);
    }

    if (!this.validatorPackageOverride) {
      const nestedBinaryErrors = this.findNestedBinaryValues(
        entity,
        new Map(),
        metatype as Type<unknown>,
      );
      if (nestedBinaryErrors.length > 0) {
        throw this.exceptionFactory(nestedBinaryErrors);
      }
    }

    let errors: ValidationError[];
    const useDynamicValidator =
      !this.validatorPackageOverride &&
      this.loadValidator === ValidationPipe.prototype.loadValidator &&
      this.validate === ValidationPipe.prototype.validate;

    if (useDynamicValidator) {
      const validatorPkg: NativeValidatorEngineLike =
        resolveValidatorPackageFor(metatype);
      // Fused zero-Promise sync fast-path when using Bunest's native compile-once engine (ADR-015)
      if (typeof validatorPkg.validateMaybeSync === "function") {
        const maybeErrors = validatorPkg.validateMaybeSync(
          entity,
          this.validatorOptions,
        );
        errors = Array.isArray(maybeErrors) ? maybeErrors : await maybeErrors;
      } else if (
        typeof validatorPkg.canValidateSynchronously === "function" &&
        typeof validatorPkg.validateSync === "function" &&
        validatorPkg.canValidateSynchronously(metatype, this.validatorOptions)
      ) {
        errors = validatorPkg.validateSync(entity, this.validatorOptions);
      } else {
        errors = await validatorPkg.validate(entity, this.validatorOptions);
      }
    } else {
      errors = await this.validate(entity, this.validatorOptions);
    }

    if (errors.length > 0) {
      throw this.exceptionFactory(errors);
    }

    if (this.isTransformEnabled) {
      return entity;
    }

    if (this.isWhitelistEnabled) {
      return pickWhitelistedRawValues(value, entity);
    }

    return value;
  }

  public createExceptionFactory(): (
    validationErrors?: ValidationError[],
  ) => unknown {
    return (validationErrors: ValidationError[] = []) => {
      if (this.isDetailedOutputDisabled) {
        return createValidationHttpException(
          [],
          this.errorHttpStatusCode,
          true,
        );
      }

      if (this.isFlattenErrorMessagesDisabled) {
        const budget = {
          remaining: this.maxErrorMessagesLength,
          isExceeded: false,
        };
        const limitedErrors = this.limitValidationErrors(
          validationErrors,
          budget,
        );
        return createStatusHttpException(
          {
            statusCode: this.errorHttpStatusCode,
            error: getHttpReasonPhrase(this.errorHttpStatusCode),
            message: limitedErrors,
          },
          this.errorHttpStatusCode,
        );
      }

      if (this.errorFormat === "bunest") {
        const details = flattenValidationErrorDetails(validationErrors);
        const limitedDetails = this.limitDetailsByCharBudget(details);
        return createValidationHttpException(
          limitedDetails,
          this.errorHttpStatusCode,
          false,
        );
      }

      const budget = {
        remaining: this.maxErrorMessagesLength,
        isExceeded: false,
      };
      const limitedErrors = this.limitValidationErrors(
        validationErrors,
        budget,
      );

      if (this.errorFormat === "grouped") {
        const grouped = this.groupValidationErrors(limitedErrors);
        const finalGrouped = budget.isExceeded
          ? { ...grouped, "...": [OMITTED_ERRORS_MESSAGE] }
          : grouped;
        return createStatusHttpException(
          {
            statusCode: this.errorHttpStatusCode,
            error: getHttpReasonPhrase(this.errorHttpStatusCode),
            message: finalGrouped,
          },
          this.errorHttpStatusCode,
        );
      }

      // NestJS "list" format: flat string[]
      const list = this.flattenValidationErrors(limitedErrors);
      const finalList = budget.isExceeded
        ? [...list, OMITTED_ERRORS_MESSAGE]
        : list;
      return createStatusHttpException(
        {
          statusCode: this.errorHttpStatusCode,
          error: getHttpReasonPhrase(this.errorHttpStatusCode),
          message: finalList,
        },
        this.errorHttpStatusCode,
      );
    };
  }

  protected limitValidationErrors(
    validationErrors: ValidationError[],
    budget: { remaining: number; isExceeded: boolean },
    parentPathLength = 0,
  ): ValidationError[] {
    if (!Number.isFinite(budget.remaining)) {
      return validationErrors;
    }

    const result: ValidationError[] = [];
    for (const error of validationErrors) {
      if (budget.isExceeded) {
        break;
      }

      const propLen = typeof error.property === "string" ? error.property.length : 0;
      const propPathLen =
        parentPathLength > 0 ? parentPathLength + 1 + propLen : propLen;

      let keptConstraints: Record<string, string> | undefined;
      if (error.constraints) {
        for (const [key, msg] of Object.entries(error.constraints)) {
          const cost = propPathLen + String(msg).length;
          if (
            budget.remaining - cost < 0 &&
            (result.length > 0 || keptConstraints)
          ) {
            budget.isExceeded = true;
            break;
          }
          budget.remaining -= cost;
          keptConstraints ??= {};
          keptConstraints[key] = msg;
          if (budget.remaining <= 0) {
            budget.isExceeded = true;
            break;
          }
        }
      }

      let keptChildren: ValidationError[] | undefined;
      if (!budget.isExceeded && error.children && error.children.length > 0) {
        keptChildren = this.limitValidationErrors(
          error.children,
          budget,
          propPathLen,
        );
      }

      if (keptConstraints || (keptChildren && keptChildren.length > 0)) {
        result.push({
          ...error,
          ...(keptConstraints ? { constraints: keptConstraints } : {}),
          ...(keptChildren ? { children: keptChildren } : {}),
        });
      }
    }

    return result;
  }

  protected stripParentErrorValues(validationErrors: ValidationError[]): void {
    for (const error of validationErrors) {
      if (error.children && error.children.length > 0) {
        delete error.value;
        this.stripParentErrorValues(error.children);
      }
    }
  }

  protected toValidate(metadata: ArgumentMetadata): boolean {
    const { metatype, type } = metadata;
    if (type === "custom" && !this.validateCustomDecorators) {
      return false;
    }
    if (!metatype || typeof metatype !== "function") {
      return false;
    }
    return !NON_DTO_METATYPES.has(metatype);
  }

  protected transformPrimitive(
    value: unknown,
    metadata: ArgumentMetadata,
  ): unknown {
    if (!metadata.data) {
      return value;
    }
    const { type, metatype } = metadata;
    if (type !== "param" && type !== "query") {
      return value;
    }
    if (metatype === Boolean) {
      if (value === true || value === "true") return true;
      if (value === false || value === "false") return false;
      return value;
    }
    if (metatype === Number && typeof value === "string" && value !== "") {
      return +value;
    }
    return value;
  }

  protected toEmptyIfNil<T = unknown, R = T>(
    value: unknown,
    metatype: Type<unknown> | object,
  ): R | object | string {
    if (value !== undefined && value !== null) {
      return value as R;
    }
    if (
      typeof metatype === "function" ||
      (metatype != null && "prototype" in metatype)
    ) {
      return {} as object;
    }
    return "";
  }

  protected closeArrayGaps(value: unknown): void {
    closeSparseArrayGaps(value);
  }

  protected isPrimitive(value: unknown): boolean {
    return ["number", "boolean", "string"].includes(typeof value);
  }

  protected isBinary(value: unknown): boolean {
    return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
  }

  protected stripProtoKeys(value: unknown): void {
    stripProtoKeysUtil(value);
  }

  protected async validate(
    object: object,
    validatorOptions?: ValidatorOptions,
  ): Promise<ValidationError[]> {
    const targetCtor =
      object && typeof object === "object" && object.constructor !== Object
        ? object.constructor
        : undefined;
    const validatorPkg = await this.loadValidator(undefined, targetCtor);
    return validatorPkg.validate(object, validatorOptions);
  }

  protected findNestedBinaryValues(
    object: unknown,
    metadataCache = new Map<unknown, unknown[]>(),
    explicitTarget?: Type<unknown>,
    activePath: Set<object> = new Set(),
  ): ValidationError[] {
    if (typeof object !== "object" || object === null) {
      return [];
    }
    if (activePath.has(object)) {
      return [];
    }

    const targetCtor =
      explicitTarget ??
      (object.constructor && object.constructor !== Object
        ? (object.constructor as Type<unknown>)
        : undefined);
    if (!targetCtor) {
      // Plain object (e.g. direct call from subclass hook): inspect own enumerable properties
      const plainErrors: ValidationError[] = [];
      for (const propKey of Object.keys(object)) {
        const val = (object as Record<string, unknown>)[propKey];
        if (this.isBinary(val)) {
          const binErr = this.toNestedBinaryError(
            propKey,
            val,
            `${propKey} must be a valid object`,
            metadataCache,
          );
          if (binErr) {
            plainErrors.push(binErr);
          }
        }
      }
      return plainErrors;
    }

    let metas = metadataCache.get(targetCtor) as
      | ReadonlyArray<{
          type: string;
          propertyName: string;
          constraints?: unknown[];
          message?: string | ((args: { property: string; value: unknown }) => string);
        }>
      | undefined;
    if (!metas) {
      metas = getValidationMetadatasForTarget(
        targetCtor,
        false,
        false,
      ) as unknown as NonNullable<typeof metas>;
      metadataCache.set(targetCtor, [...metas]);
    }
    if (!metas || metas.length === 0) {
      return [];
    }

    const nestedMetas = metas.filter((m) => m.type === "nestedValidation");
    if (nestedMetas.length === 0) {
      return [];
    }

    const condMetasByProp = new Map<string, Array<(obj: unknown, val: unknown) => boolean>>();
    for (const m of metas) {
      if (m.type === "conditionalValidation" && typeof m.constraints?.[0] === "function") {
        const list = condMetasByProp.get(m.propertyName) ?? [];
        list.push(m.constraints[0] as (obj: unknown, val: unknown) => boolean);
        condMetasByProp.set(m.propertyName, list);
      }
    }

    activePath.add(object);
    const errors: ValidationError[] = [];
    const seenProps = new Set<string>();

    const checkValue = (
      val: unknown,
      propKey: string,
      message: string,
    ): ValidationError | undefined => {
      if (val === undefined || val === null) {
        return undefined;
      }
      if (this.isBinary(val)) {
        return this.toNestedBinaryError(propKey, val, message, metadataCache);
      }
      if (typeof val !== "object") {
        return undefined;
      }
      if (activePath.has(val)) {
        return undefined;
      }
      if (Array.isArray(val) || val instanceof Set || val instanceof Map) {
        activePath.add(val);
        const childErrors: ValidationError[] = [];
        try {
          if (val instanceof Map) {
            for (const [k, item] of val.entries()) {
              const childErr = checkValue(item, String(k), message);
              if (childErr) childErrors.push(childErr);
            }
          } else {
            const arr = val instanceof Set ? Array.from(val) : val;
            for (let idx = 0; idx < arr.length; idx++) {
              const childErr = checkValue(arr[idx], String(idx), message);
              if (childErr) childErrors.push(childErr);
            }
          }
        } finally {
          activePath.delete(val);
        }
        if (childErrors.length > 0) {
          return {
            property: propKey,
            children: childErrors,
          };
        }
        return undefined;
      }

      const childErrors = this.findNestedBinaryValues(
        val,
        metadataCache,
        undefined,
        activePath,
      );
      if (childErrors.length > 0) {
        return {
          property: propKey,
          children: childErrors,
        };
      }
      return undefined;
    };

    try {
      const record = object as Record<string, unknown>;
      for (const meta of nestedMetas) {
        const prop = meta.propertyName;
        if (seenProps.has(prop)) continue;
        seenProps.add(prop);
        if (!Object.prototype.hasOwnProperty.call(object, prop)) continue;

        const val = record[prop];
        const conds = condMetasByProp.get(prop);
        if (conds && conds.some((fn) => !fn(object, val))) {
          continue;
        }

        const message =
          typeof meta.message === "string"
            ? meta.message.replace(/\$property/g, prop)
            : typeof meta.message === "function"
              ? meta.message({ property: prop, value: val })
              : `nested property ${prop} must be either object or array`;

        const err = checkValue(val, prop, message);
        if (err) {
          errors.push(err);
        }
      }
    } finally {
      activePath.delete(object);
    }

    return errors;
  }

  protected toNestedBinaryError(
    property: string,
    _value: unknown,
    message: string,
    _metadataCache: Map<unknown, unknown[]>,
  ): ValidationError | undefined {
    return {
      property,
      children: [],
      constraints: {
        nestedValidation: message,
      },
    };
  }

  protected async hasValidationRules(
    metatype: Type<unknown>,
  ): Promise<boolean> {
    return getValidationMetadatasForTarget(metatype, false, false).length > 0;
  }

  protected flattenValidationErrors(
    validationErrors: ValidationError[],
  ): string[] {
    const messages: string[] = [];
    for (const error of validationErrors) {
      const mapped = this.mapChildrenToValidationErrors(error);
      for (const item of mapped) {
        if (item.constraints) {
          messages.push(...Object.values(item.constraints));
        }
      }
    }
    return messages;
  }

  protected groupValidationErrors(
    validationErrors: ValidationError[],
    parentPath = "",
    result: Record<string, string[]> = {},
  ): Record<string, string[]> {
    for (const error of validationErrors) {
      const propPath = parentPath
        ? `${parentPath}.${error.property}`
        : error.property;
      if (error.constraints && Object.keys(error.constraints).length > 0) {
        const existing = result[propPath] ?? [];
        existing.push(...Object.values(error.constraints));
        result[propPath] = existing;
      }
      if (error.children && error.children.length > 0) {
        const childResult = this.groupValidationErrors(
          error.children,
          propPath,
          result,
        );
        if (childResult !== result) {
          for (const [k, v] of Object.entries(childResult)) {
            const existing = result[k] ?? [];
            existing.push(...v);
            result[k] = existing;
          }
        }
      }
    }
    return result;
  }

  protected mapChildrenToValidationErrors(
    error: ValidationError,
    parentPath?: string,
    validationErrors: ValidationError[] = [],
  ): ValidationError[] {
    if (!error.children || error.children.length === 0) {
      validationErrors.push(
        parentPath
          ? this.prependConstraintsWithParentProp(parentPath, error)
          : error,
      );
      return validationErrors;
    }
    const nextPath = parentPath
      ? `${parentPath}.${error.property}`
      : error.property;
    if (error.constraints && Object.keys(error.constraints).length > 0) {
      validationErrors.push(
        parentPath
          ? this.prependConstraintsWithParentProp(parentPath, error)
          : error,
      );
    }
    for (const child of error.children) {
      const childResult = this.mapChildrenToValidationErrors(
        child,
        nextPath,
        validationErrors,
      );
      if (childResult !== validationErrors) {
        validationErrors.push(...childResult);
      }
    }
    return validationErrors;
  }

  protected prependConstraintsWithParentProp(
    parentPath: string,
    error: ValidationError,
  ): ValidationError {
    const constraints: Record<string, string> = {};
    if (error.constraints) {
      for (const [key, msg] of Object.entries(error.constraints)) {
        constraints[key] = `${parentPath}.${msg}`;
      }
    }
    return {
      ...error,
      constraints,
    };
  }

  private limitDetailsByCharBudget<
    T extends {
      field: string;
      constraints: Record<string, string>;
      messages: string[];
    },
  >(details: T[]): T[] {
    if (!Number.isFinite(this.maxErrorMessagesLength)) {
      return details;
    }
    let remaining = this.maxErrorMessagesLength;
    const out: T[] = [];
    for (const item of details) {
      const cost =
        item.field.length + item.messages.reduce((sum, m) => sum + m.length, 0);
      if (remaining - cost < 0 && out.length > 0) {
        break;
      }
      remaining -= cost;
      out.push(item);
    }
    return out;
  }
}

DecoratorRegistry.markInternal(ValidationPipe);
