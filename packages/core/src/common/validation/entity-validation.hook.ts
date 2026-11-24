import { BODY_SANITIZED_SYMBOL } from "../constants/tokens";
import { getEntitySchema, hasEntitySchema } from "../decorators/entity-schema.decorators";
import { ValidationPipe } from "../pipes/validation.pipe";
import type { ArgumentMetadata } from "../interfaces/http.interface";
import type { Type } from "../interfaces/type.interface";
import type {
  ClassTransformOptions,
  TransformerPackage,
  ValidationError,
  ValidatorOptions,
} from "../interfaces/validation.interface";

import { getValidationMetadatasForTarget } from "../pipes/validation-http.util";
import {
  mergeValidationErrors,
  validateEntity,
  validateEntityDetailed,
} from "./entity-validator";
import {
  buildDangerousKeyValidationErrors,
  findDangerousKeys,
} from "./utils/sanitize.util";

const ENTITY_PIPE_HOOK_SYMBOL = Symbol.for(
  "bunest:validation:entity_validation_pipe_hook",
);

interface ValidationPipeInternal {
  isTransformEnabled: boolean;
  isDetailedOutputDisabled: boolean;
  validatorOptions: ValidatorOptions;
  transformOptions: ClassTransformOptions;
  expectedType: Type<any> | undefined;
  exceptionFactory: (errors: ValidationError[]) => any;
  validateCustomDecorators: boolean;
  toValidate(metadata: ArgumentMetadata): boolean;
  closeArrayGaps(value: unknown): void;
  loadTransformer(
    transformerPackage?: TransformerPackage,
    target?: Function,
  ): TransformerPackage | Promise<TransformerPackage>;
  validate(
    object: object,
    validatorOptions?: ValidatorOptions,
  ): Promise<ValidationError[]>;
}

interface ClassValidatorPropertyInfo {
  readonly properties: Set<string>;
  readonly optionalProperties: Set<string>;
  readonly hasRules: boolean;
}

function isNonRecordBuiltIn(value: object): boolean {
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
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (typeof URL !== "undefined" && value instanceof URL) return true;
  if (typeof Request !== "undefined" && value instanceof Request) return true;
  if (typeof Response !== "undefined" && value instanceof Response) return true;
  if (typeof Headers !== "undefined" && value instanceof Headers) return true;
  if (typeof FormData !== "undefined" && value instanceof FormData) return true;
  if (
    typeof ReadableStream !== "undefined" &&
    value instanceof ReadableStream
  ) {
    return true;
  }
  return false;
}

function extractClassValidatorPropertyInfo(
  metatype: Function,
  validatorOptions: ValidatorOptions,
): ClassValidatorPropertyInfo {
  const properties = new Set<string>();
  const optionalProperties = new Set<string>();
  try {
    const metas = getValidationMetadatasForTarget(
      metatype,
      Boolean(validatorOptions.always),
      Boolean(validatorOptions.strictGroups),
      validatorOptions.groups,
    );
    for (let i = 0; i < metas.length; i++) {
      const meta = metas[i];
      if (!meta || !meta.propertyName) continue;
      properties.add(meta.propertyName);
      if (meta.type === "conditionalValidation") {
        optionalProperties.add(meta.propertyName);
      }
    }
  } catch {
    // Gracefully skip if validation metadata storage is unavailable
  }
  return {
    properties,
    optionalProperties,
    hasRules: properties.size > 0,
  };
}

function pickWhitelistedKeys(
  raw: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (allowedKeys.has(key)) {
      out[key] = raw[key];
    }
  }
  return out;
}

/**
 * Idempotently integrates `@Entity()` single-source-of-truth schema validation
 * into `ValidationPipe` while preserving canonical class identity with
 * `@bunest/core` (`ValidationPipe === Common.ValidationPipe`) and full
 * `class-validator` / `class-transformer` interoperability.
 */
export function registerEntityValidationPipeHook(): void {
  const proto = ValidationPipe.prototype as unknown as Record<
    PropertyKey,
    unknown
  >;
  if (proto[ENTITY_PIPE_HOOK_SYMBOL]) {
    return;
  }
  proto[ENTITY_PIPE_HOOK_SYMBOL] = true;

  const originalTransform = ValidationPipe.prototype.transform;
  const originalHasValidationRules = (
    ValidationPipe.prototype as unknown as {
      hasValidationRules: (metatype: Type<unknown>) => Promise<boolean>;
    }
  ).hasValidationRules;

  ValidationPipe.prototype.transform =
    async function transformWithEntitySupport(
      this: ValidationPipeInternal,
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
        typeof metatype !== "function" ||
        !hasEntitySchema(metatype)
      ) {
        return originalTransform.call(
          this as unknown as ValidationPipe,
          value,
          metadata,
        );
      }

      if (
        !this.toValidate({
          ...effectiveMeta,
          metatype,
        })
      ) {
        return value;
      }

      const rootFieldName = effectiveMeta.data ?? effectiveMeta.type ?? "value";

      // Guard 1: Reject null, undefined, primitives, arrays, and non-record built-ins (ADR-009)
      if (
        value === null ||
        value === undefined ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        isNonRecordBuiltIn(value)
      ) {
        const rootError: ValidationError = {
          property: rootFieldName,
          children: [],
          constraints: {
            isObject: this.validatorOptions.dismissDefaultMessages
              ? ""
              : `${rootFieldName} must be a valid object`,
          },
        };
        throw this.exceptionFactory([rootError]);
      }

      // Guard 2: Reject dangerous prototype-pollution keys unless pre-sanitized (ADR-009)
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

      this.closeArrayGaps(value);

      const isWhitelistEnabled = Boolean(this.validatorOptions.whitelist);
      const forbidNonWhitelisted = Boolean(
        this.validatorOptions.forbidNonWhitelisted,
      );
      const cvInfo = extractClassValidatorPropertyInfo(
        metatype,
        this.validatorOptions,
      );

      const entityOptions = {
        whitelist: isWhitelistEnabled,
        forbidNonWhitelisted,
        transform: this.isTransformEnabled,
        enableImplicitConversion: this.isTransformEnabled,
        skipMissingProperties: Boolean(
          this.validatorOptions.skipMissingProperties,
        ),
        skipNullProperties: Boolean(this.validatorOptions.skipNullProperties),
        skipUndefinedProperties: Boolean(
          this.validatorOptions.skipUndefinedProperties,
        ),
        stopAtFirstError: Boolean(this.validatorOptions.stopAtFirstError),
        dismissDefaultMessages: Boolean(
          this.validatorOptions.dismissDefaultMessages,
        ),
        extraWhitelistedProperties: cvInfo.properties,
        optionalProperties: cvInfo.optionalProperties,
        validationError: this.validatorOptions.validationError,
        rootFieldName,
      };

      // Fast path: pure @Entity class without class-validator rules
      if (!cvInfo.hasRules) {
        const result = validateEntity(
          metatype as Type<any>,
          value,
          entityOptions,
        );
        if (!result.valid) {
          throw this.exceptionFactory(result.errors);
        }
        return result.value;
      }

      // Hybrid path: class carries BOTH @Entity/@Column AND class-validator decorators
      const transformerPkg = await this.loadTransformer(undefined, metatype);
      const plainToInstanceFn = transformerPkg.plainToInstance;
      if (typeof plainToInstanceFn !== "function") {
        throw new Error(
          'Configured transformerPackage is missing "plainToInstance()".',
        );
      }

      const rawRecord = value as Record<string, unknown>;
      const rawKeys = Object.keys(rawRecord);
      const entitySchema = getEntitySchema(metatype);
      const allowedKeys = new Set<string>(cvInfo.properties);
      if (entitySchema) {
        for (const col of entitySchema.columns) {
          allowedKeys.add(col.propertyName);
        }
      }

      const cvInstance = plainToInstanceFn(
        metatype as Type<any>,
        value,
        this.transformOptions,
      ) as Record<string, unknown>;

      if (typeof cvInstance !== "object" || cvInstance === null) {
        const rootError: ValidationError = {
          property: rootFieldName,
          children: [],
          constraints: {
            isObject: this.validatorOptions.dismissDefaultMessages
              ? ""
              : `${rootFieldName} must be a valid object`,
          },
        };
        throw this.exceptionFactory([rootError]);
      }

      // Build an input record reflecting raw keys + any @Transform/@Type outputs on those keys
      // so entity validation sees transformed values without falsely treating class field initializers as extra keys.
      const hybridInput: Record<PropertyKey, unknown> = {};
      if (
        (value as Record<PropertyKey, unknown>)[BODY_SANITIZED_SYMBOL] === true
      ) {
        Object.defineProperty(hybridInput, BODY_SANITIZED_SYMBOL, {
          value: true,
          enumerable: false,
        });
      }
      for (let i = 0; i < rawKeys.length; i++) {
        const key = rawKeys[i]!;
        hybridInput[key] = Object.hasOwn(cvInstance, key)
          ? cvInstance[key]
          : rawRecord[key];
      }

      const entityResult = validateEntityDetailed(
        metatype as Type<any>,
        hybridInput,
        entityOptions,
      );

      // Apply all type-valid coerced entity column values onto cvInstance before running class-validator
      // (even when another column had validation errors, preventing spurious type failures)
      if (this.isTransformEnabled && entityResult.resolvedValues.size > 0) {
        for (const [
          prop,
          coercedVal,
        ] of entityResult.resolvedValues.entries()) {
          if (Object.hasOwn(rawRecord, prop)) {
            cvInstance[prop] = coercedVal;
          }
        }
      }

      // Strip non-whitelisted raw keys from cvInstance when whitelist is enabled
      if (isWhitelistEnabled) {
        for (let i = 0; i < rawKeys.length; i++) {
          const key = rawKeys[i]!;
          if (!allowedKeys.has(key)) {
            delete cvInstance[key];
          }
        }
      }

      const cvErrors = await this.validate(cvInstance, {
        ...this.validatorOptions,
        whitelist: false,
        forbidNonWhitelisted: false,
        forbidUnknownValues: false,
      });

      const mergedErrors = mergeValidationErrors(
        entityResult.errors,
        cvErrors,
        Boolean(this.validatorOptions.stopAtFirstError),
      );
      if (mergedErrors.length > 0) {
        throw this.exceptionFactory(mergedErrors);
      }

      if (this.isTransformEnabled) {
        return cvInstance;
      }

      if (isWhitelistEnabled) {
        return pickWhitelistedKeys(rawRecord, allowedKeys);
      }

      return value;
    };

  if (typeof originalHasValidationRules === "function") {
    (
      ValidationPipe.prototype as unknown as {
        hasValidationRules: (metatype: Type<unknown>) => Promise<boolean>;
      }
    ).hasValidationRules = async function hasValidationRulesWithEntitySupport(
      this: ValidationPipe,
      metatype: Type<unknown>,
    ): Promise<boolean> {
      if (hasEntitySchema(metatype)) {
        return true;
      }
      return originalHasValidationRules.call(this, metatype);
    };
  }
}

registerEntityValidationPipeHook();
