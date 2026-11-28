import { isPromiseLike } from "@bunest/core/common";
import {
  SCHEMA_DTO_RAW_INPUT_KEY,
  applySchemaOutputToInstance,
  getStandardSchemaFromDto,
  isStandardSchemaDto,
  standardSchemaIssuesToValidationErrors,
} from "../../schema/dto-bridge";
import { getCompiledValidationPlan } from "../compiler/validation-plan-compiler";
import type { ValidationError } from "../error/validation-error";
import type { ValidatorOptions } from "../interfaces/validation-options.interface";
import { MetadataStorage, getMetadataStorage } from "../storage/metadata-storage";
import { ValidationExecutor } from "./validation-executor";

function validateStandardSchemaDtoObject(
  object: object,
  options: ValidatorOptions | undefined,
  syncOnly: boolean,
): ValidationError[] | Promise<ValidationError[]> | undefined {
  if (!object || typeof object !== "object") {
    return undefined;
  }
  const ctor = object.constructor;
  const schema = getStandardSchemaFromDto(ctor);
  if (!schema) {
    return undefined;
  }

  const record = object as Record<PropertyKey, unknown>;
  const hasRaw = Object.prototype.hasOwnProperty.call(
    record,
    SCHEMA_DTO_RAW_INPUT_KEY,
  );
  const rawInput = hasRaw ? record[SCHEMA_DTO_RAW_INPUT_KEY] : object;
  if (hasRaw) {
    delete record[SCHEMA_DTO_RAW_INPUT_KEY];
  }

  const finalize = (result: {
    readonly value?: unknown;
    readonly issues?: readonly {
      readonly message: string;
      readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
    }[];
  }): ValidationError[] => {
    if (result.issues) {
      const errors = standardSchemaIssuesToValidationErrors(result.issues, {
        stopAtFirstError: options?.stopAtFirstError,
      });
      if (options?.validationError?.target === true) {
        for (const err of errors) {
          err.target = object;
        }
      }
      return errors;
    }
    applySchemaOutputToInstance(object, result.value);
    return [];
  };

  const resultOrPromise = schema["~standard"].validate(rawInput);
  if (isPromiseLike(resultOrPromise)) {
    if (syncOnly) {
      return [];
    }
    return Promise.resolve(resultOrPromise).then(finalize);
  }

  return finalize(
    resultOrPromise as {
      readonly value?: unknown;
      readonly issues?: readonly {
        readonly message: string;
        readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
      }[];
    },
  );
}

export class Validator {
  private readonly storage: MetadataStorage;

  constructor(storage: MetadataStorage = getMetadataStorage()) {
    this.storage = storage;
  }

  validate(
    object: object,
    options?: ValidatorOptions,
  ): Promise<ValidationError[]>;
  validate(
    schemaName: string,
    object: object,
    options?: ValidatorOptions,
  ): Promise<ValidationError[]>;
  validate(
    objectOrSchemaName: object | string,
    objectOrValidationOptions?: object | ValidatorOptions,
    maybeValidatorOptions?: ValidatorOptions,
  ): Promise<ValidationError[]> {
    return this.coreValidate(
      objectOrSchemaName,
      objectOrValidationOptions,
      maybeValidatorOptions,
    );
  }

  validateOrReject(
    object: object,
    options?: ValidatorOptions,
  ): Promise<void>;
  validateOrReject(
    schemaName: string,
    object: object,
    options?: ValidatorOptions,
  ): Promise<void>;
  async validateOrReject(
    objectOrSchemaName: object | string,
    objectOrValidationOptions?: object | ValidatorOptions,
    maybeValidatorOptions?: ValidatorOptions,
  ): Promise<void> {
    const errors = await this.coreValidate(
      objectOrSchemaName,
      objectOrValidationOptions,
      maybeValidatorOptions,
    );
    if (errors.length > 0) {
      return Promise.reject(errors);
    }
  }

  validateSync(
    object: object,
    options?: ValidatorOptions,
  ): ValidationError[];
  validateSync(
    schemaName: string,
    object: object,
    options?: ValidatorOptions,
  ): ValidationError[];
  validateSync(
    objectOrSchemaName: object | string,
    objectOrValidationOptions?: object | ValidatorOptions,
    maybeValidatorOptions?: ValidatorOptions,
  ): ValidationError[] {
    const object =
      typeof objectOrSchemaName === "string"
        ? (objectOrValidationOptions as object)
        : objectOrSchemaName;
    const options =
      typeof objectOrSchemaName === "string"
        ? maybeValidatorOptions
        : (objectOrValidationOptions as ValidatorOptions | undefined);
    const schema =
      typeof objectOrSchemaName === "string" ? objectOrSchemaName : "";

    if (!schema) {
      const schemaResult = validateStandardSchemaDtoObject(object, options, true);
      if (schemaResult !== undefined) {
        return Array.isArray(schemaResult) ? schemaResult : [];
      }
    }

    const executor = new ValidationExecutor(options, this.storage);
    executor.ignoreAsyncValidations = true;
    const validationErrors: ValidationError[] = [];
    executor.execute(object, schema, validationErrors);
    return executor.finalizeErrors(validationErrors);
  }

  /**
   * Internal sync-or-async fast path used by `ValidationPipe`: returns
   * `ValidationError[]` synchronously with ZERO Promise allocation when all
   * rules are synchronous, or a `Promise<ValidationError[]>` when async rules exist.
   */
  validateMaybeSync(
    object: object,
    options?: ValidatorOptions,
  ): ValidationError[] | Promise<ValidationError[]> {
    const schemaResult = validateStandardSchemaDtoObject(object, options, false);
    if (schemaResult !== undefined) {
      return schemaResult;
    }
    const executor = new ValidationExecutor(options, this.storage);
    const validationErrors: ValidationError[] = [];
    executor.execute(object, "", validationErrors);
    if (executor.awaitingPromises.length === 0) {
      return executor.finalizeErrors(validationErrors);
    }
    return Promise.all(executor.awaitingPromises).then(() =>
      executor.finalizeErrors(validationErrors),
    );
  }

  private coreValidate(
    objectOrSchemaName: object | string,
    objectOrValidationOptions?: object | ValidatorOptions,
    maybeValidatorOptions?: ValidatorOptions,
  ): Promise<ValidationError[]> {
    const object =
      typeof objectOrSchemaName === "string"
        ? (objectOrValidationOptions as object)
        : objectOrSchemaName;
    const options =
      typeof objectOrSchemaName === "string"
        ? maybeValidatorOptions
        : (objectOrValidationOptions as ValidatorOptions | undefined);
    const schema =
      typeof objectOrSchemaName === "string" ? objectOrSchemaName : "";

    if (!schema) {
      const schemaResult = validateStandardSchemaDtoObject(
        object,
        options,
        false,
      );
      if (schemaResult !== undefined) {
        return Promise.resolve(schemaResult);
      }
    }

    const executor = new ValidationExecutor(options, this.storage);
    const validationErrors: ValidationError[] = [];
    executor.execute(object, schema, validationErrors);

    if (executor.awaitingPromises.length === 0) {
      return Promise.resolve(executor.finalizeErrors(validationErrors));
    }

    return Promise.all(executor.awaitingPromises).then(() =>
      executor.finalizeErrors(validationErrors),
    );
  }
}

const defaultValidator = new Validator();

export function validate(
  object: object,
  validatorOptions?: ValidatorOptions,
): Promise<ValidationError[]>;
export function validate(
  schemaName: string,
  object: object,
  validatorOptions?: ValidatorOptions,
): Promise<ValidationError[]>;
export function validate(
  objectOrSchemaName: object | string,
  objectOrValidationOptions?: object | ValidatorOptions,
  maybeValidatorOptions?: ValidatorOptions,
): Promise<ValidationError[]> {
  return defaultValidator.validate(
    objectOrSchemaName as string,
    objectOrValidationOptions as object,
    maybeValidatorOptions,
  );
}

export function validateOrReject(
  object: object,
  validatorOptions?: ValidatorOptions,
): Promise<void>;
export function validateOrReject(
  schemaName: string,
  object: object,
  validatorOptions?: ValidatorOptions,
): Promise<void>;
export function validateOrReject(
  objectOrSchemaName: object | string,
  objectOrValidationOptions?: object | ValidatorOptions,
  maybeValidatorOptions?: ValidatorOptions,
): Promise<void> {
  return defaultValidator.validateOrReject(
    objectOrSchemaName as string,
    objectOrValidationOptions as object,
    maybeValidatorOptions,
  );
}

export function validateSync(
  object: object,
  validatorOptions?: ValidatorOptions,
): ValidationError[];
export function validateSync(
  schemaName: string,
  object: object,
  validatorOptions?: ValidatorOptions,
): ValidationError[];
export function validateSync(
  objectOrSchemaName: object | string,
  objectOrValidationOptions?: object | ValidatorOptions,
  maybeValidatorOptions?: ValidatorOptions,
): ValidationError[] {
  return defaultValidator.validateSync(
    objectOrSchemaName as string,
    objectOrValidationOptions as object,
    maybeValidatorOptions,
  );
}

export function validateMaybeSync(
  object: object,
  validatorOptions?: ValidatorOptions,
): ValidationError[] | Promise<ValidationError[]> {
  return defaultValidator.validateMaybeSync(object, validatorOptions);
}

/**
 * Checks if a DTO class is statically guaranteed to execute 100% synchronously
 * without async constraints, `@ValidatePromise`, or nested sub-DTO validation.
 */
export function canValidateSynchronously(
  targetConstructor: Function,
  options: ValidatorOptions = {},
): boolean {
  if (isStandardSchemaDto(targetConstructor)) {
    return false;
  }
  const storage = getMetadataStorage();
  const plan = getCompiledValidationPlan(
    targetConstructor,
    "",
    options.always === true,
    options.strictGroups === true,
    options.groups,
    storage,
  );
  return plan.canRunSync;
}
