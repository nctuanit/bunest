import { ValidationTypes } from "../constants/validation-types";
import { replaceMessageSpecialTokens } from "../error/message-formatter";
import { ValidationError } from "../error/validation-error";
import type {
  ConstraintMetadata,
  ValidationMetadata,
} from "../interfaces/metadata.interface";
import type { ValidationArguments } from "../interfaces/validation-arguments.interface";
import type { ValidatorOptions } from "../interfaces/validation-options.interface";
import {
  MetadataStorage,
  getMetadataStorage,
} from "../storage/metadata-storage";
import {
  getCompiledValidationPlan,
  type CompiledPropertyPlan,
  type CompiledRule,
} from "../compiler/validation-plan-compiler";

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isBinaryValue(value: unknown): boolean {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function convertToArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return Array.from(value);
  if (value instanceof Map) return Array.from(value.values());
  return [];
}

export class ValidationExecutor {
  public readonly awaitingPromises: Promise<unknown>[] = [];
  public ignoreAsyncValidations = false;

  private readonly validatorOptions: ValidatorOptions | undefined;
  private readonly storage: MetadataStorage;
  private readonly includeTarget: boolean;
  private readonly includeValue: boolean;
  private readonly skipUndefined: boolean;
  private readonly skipNull: boolean;
  private readonly skipMissing: boolean;
  private readonly whitelistEnabled: boolean;
  private readonly forbidNonWhitelisted: boolean;
  private readonly forbidUnknownValues: boolean;
  private readonly stopAtFirstError: boolean;
  private readonly dismissDefaultMessages: boolean;
  private readonly always: boolean;
  private readonly strictGroups: boolean;
  private readonly groups: string[] | undefined;
  private activeStack: Set<object> | undefined;

  constructor(
    validatorOptions?: ValidatorOptions,
    storage: MetadataStorage = getMetadataStorage(),
  ) {
    this.validatorOptions = validatorOptions;
    this.storage = storage;
    this.includeTarget =
      validatorOptions?.validationError?.target === undefined ||
      validatorOptions.validationError.target === true;
    this.includeValue =
      validatorOptions?.validationError?.value === undefined ||
      validatorOptions.validationError.value === true;
    this.skipUndefined = validatorOptions?.skipUndefinedProperties === true;
    this.skipNull = validatorOptions?.skipNullProperties === true;
    this.skipMissing = validatorOptions?.skipMissingProperties === true;
    this.whitelistEnabled = validatorOptions?.whitelist === true;
    this.forbidNonWhitelisted = validatorOptions?.forbidNonWhitelisted === true;
    this.forbidUnknownValues =
      validatorOptions?.forbidUnknownValues === undefined ||
      validatorOptions.forbidUnknownValues !== false;
    this.stopAtFirstError = validatorOptions?.stopAtFirstError === true;
    this.dismissDefaultMessages =
      validatorOptions?.dismissDefaultMessages === true;
    this.always = validatorOptions?.always === true;
    this.strictGroups = validatorOptions?.strictGroups === true;
    this.groups = validatorOptions?.groups;
  }

  execute(
    object: object,
    targetSchema: string,
    validationErrors: ValidationError[],
  ): void {
    if (
      !this.storage.hasValidationMetaData &&
      this.validatorOptions?.enableDebugMessages === true
    ) {
      console.warn(
        "No validation metadata found. No validation will be performed.",
      );
    }

    if (object === null || object === undefined || typeof object !== "object") {
      if (this.forbidUnknownValues) {
        validationErrors.push(this.createUnknownValueError(object));
      }
      return;
    }

    if (this.activeStack?.has(object)) return;

    const ctor = (object as { constructor?: Function }).constructor;
    const plan =
      typeof ctor === "function"
        ? getCompiledValidationPlan(
            ctor,
            targetSchema,
            this.always,
            this.strictGroups,
            this.groups,
            this.storage,
          )
        : undefined;

    if (!plan || plan.isEmpty) {
      if (this.forbidUnknownValues) {
        validationErrors.push(this.createUnknownValueError(object));
      }
      return;
    }

    if (this.whitelistEnabled) {
      this.runWhitelist(object, plan.allowedProperties, validationErrors);
    }

    const record = object as Record<string, unknown>;
    const props = plan.properties;
    let pushedStack = false;

    for (let i = 0; i < props.length; i++) {
      const propPlan = props[i]!;
      const propName = propPlan.propertyName;
      const value = record[propName];

      if (
        !pushedStack &&
        propPlan.nestedMetadatas.length > 0 &&
        value !== null &&
        value !== undefined &&
        typeof value === "object"
      ) {
        this.activeStack ??= new Set();
        this.activeStack.add(object);
        pushedStack = true;
      }

      if (propPlan.hasPromiseValidation && value instanceof Promise) {
        if (!this.ignoreAsyncValidations) {
          this.awaitingPromises.push(
            value.then((resolvedValue) => {
              this.validateProperty(
                object,
                resolvedValue,
                propPlan,
                validationErrors,
              );
            }),
          );
        }
      } else {
        this.validateProperty(object, value, propPlan, validationErrors);
      }
    }

    if (pushedStack && this.activeStack) {
      this.activeStack.delete(object);
    }
  }

  private createUnknownValueError(object: unknown): ValidationError {
    const err = new ValidationError();
    if (this.includeTarget && typeof object === "object" && object !== null) {
      err.target = object;
    }
    err.value = undefined;
    err.property = undefined as unknown as string;
    err.children = [];
    err.constraints = {
      unknownValue: "an unknown value was passed to the validate function",
    };
    return err;
  }

  private createPropertyError(
    object: object,
    value: unknown,
    propertyName: string,
  ): ValidationError {
    const err = new ValidationError();
    if (this.includeTarget) err.target = object;
    if (this.includeValue) err.value = value;
    err.property = propertyName;
    err.children = [];
    err.constraints = {};
    return err;
  }

  private runWhitelist(
    object: object,
    allowedProperties: ReadonlySet<string>,
    validationErrors: ValidationError[],
  ): void {
    const record = object as Record<string, unknown>;
    const keys = Object.keys(record);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      if (allowedProperties.has(key)) continue;
      if (this.forbidNonWhitelisted) {
        const err = this.createPropertyError(object, record[key], key);
        err.constraints = {
          [ValidationTypes.WHITELIST]: `property ${key} should not exist`,
        };
        delete err.children;
        validationErrors.push(err);
      } else {
        delete record[key];
      }
    }
  }

  private validateProperty(
    object: object,
    value: unknown,
    propPlan: CompiledPropertyPlan,
    validationErrors: ValidationError[],
  ): void {
    const conditions = propPlan.conditions;
    for (let i = 0; i < conditions.length; i++) {
      if (!conditions[i]!(object, value)) return;
    }

    let error: ValidationError | undefined;
    const ensureError = (): ValidationError => {
      if (!error) {
        error = this.createPropertyError(object, value, propPlan.propertyName);
        validationErrors.push(error);
      }
      return error;
    };

    if (propPlan.definedRules.length > 0) {
      this.runRules(
        object,
        value,
        propPlan.definedRules,
        ensureError,
        () => error,
      );
    }

    if (value === undefined && (this.skipUndefined || this.skipMissing)) {
      return;
    }
    if (value === null && (this.skipNull || this.skipMissing)) {
      return;
    }

    if (propPlan.customRules.length > 0) {
      this.runRules(
        object,
        value,
        propPlan.customRules,
        ensureError,
        () => error,
      );
    }

    if (propPlan.nestedMetadatas.length > 0) {
      this.runNested(
        object,
        value,
        propPlan.nestedMetadatas,
        ensureError,
        () => error,
      );
    }
  }

  private runRules(
    object: object,
    value: unknown,
    rules: readonly CompiledRule[],
    ensureError: () => ValidationError,
    getError: () => ValidationError | undefined,
  ): void {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]!;
      if (rule.isAsync && this.ignoreAsyncValidations) continue;

      const currentErr = getError();
      if (
        this.stopAtFirstError &&
        currentErr?.constraints &&
        Object.keys(currentErr.constraints).length > 0
      ) {
        return;
      }

      const isCollection =
        rule.each &&
        (Array.isArray(value) || value instanceof Set || value instanceof Map);

      if (rule.fastValidate && !isCollection) {
        if (rule.fastValidate(value)) continue;
        this.recordFailure(ensureError(), object, value, rule);
        continue;
      }

      if (rule.fastValidate && isCollection) {
        const items = convertToArray(value);
        let allValid = true;
        for (let k = 0; k < items.length; k++) {
          if (!rule.fastValidate(items[k])) {
            allValid = false;
            break;
          }
        }
        if (allValid) continue;
        this.recordFailure(ensureError(), object, value, rule);
        continue;
      }

      const instance = rule.constraintMeta.instance;
      const args: ValidationArguments = {
        targetName: object.constructor ? object.constructor.name : "",
        property: rule.metadata.propertyName,
        object,
        value,
        constraints: rule.metadata.constraints ?? [],
      };

      if (!isCollection) {
        const result = instance.validate(value, args);
        if (isPromiseLike(result)) {
          if (this.ignoreAsyncValidations) continue;
          const promise = Promise.resolve(result).then((isValid) => {
            if (!isValid) {
              this.recordFailure(ensureError(), object, value, rule);
            }
          });
          this.awaitingPromises.push(promise);
        } else if (!result) {
          this.recordFailure(ensureError(), object, value, rule);
        }
      } else {
        const items = convertToArray(value);
        const results: Array<boolean | Promise<boolean>> = new Array(
          items.length,
        );
        let anyAsync = false;
        for (let k = 0; k < items.length; k++) {
          const r = instance.validate(items[k], args);
          if (isPromiseLike(r)) anyAsync = true;
          results[k] = r;
        }

        if (anyAsync) {
          if (this.ignoreAsyncValidations) continue;
          const promise = Promise.all(
            results.map((r) => (isPromiseLike(r) ? r : Promise.resolve(r))),
          ).then((resolved) => {
            if (!resolved.every(Boolean)) {
              this.recordFailure(ensureError(), object, value, rule);
            }
          });
          this.awaitingPromises.push(promise);
        } else if (!results.every(Boolean)) {
          this.recordFailure(ensureError(), object, value, rule);
        }
      }
    }
  }

  private runNested(
    _object: object,
    value: unknown,
    nestedMetadatas: readonly ValidationMetadata[],
    ensureError: () => ValidationError,
    getError: () => ValidationError | undefined,
  ): void {
    if (value === undefined) return;

    for (let i = 0; i < nestedMetadatas.length; i++) {
      const metadata = nestedMetadatas[i]!;
      if (
        metadata.type !== ValidationTypes.NESTED_VALIDATION &&
        metadata.type !== ValidationTypes.PROMISE_VALIDATION
      ) {
        continue;
      }

      const currentErr = getError();
      if (
        this.stopAtFirstError &&
        currentErr?.constraints &&
        Object.keys(currentErr.constraints).length > 0
      ) {
        return;
      }

      if (
        Array.isArray(value) ||
        value instanceof Set ||
        value instanceof Map
      ) {
        const childrenCollector: ValidationError[] = [];
        if (value instanceof Map) {
          for (const [k, subValue] of value.entries()) {
            this.validateNestedCollectionItem(
              value,
              subValue,
              String(k),
              nestedMetadatas,
              childrenCollector,
            );
          }
        } else {
          const arr = value instanceof Set ? Array.from(value) : value;
          for (let idx = 0; idx < arr.length; idx++) {
            this.validateNestedCollectionItem(
              value,
              arr[idx],
              String(idx),
              nestedMetadatas,
              childrenCollector,
            );
          }
        }
        if (childrenCollector.length > 0) {
          const err = ensureError();
          err.children ??= [];
          err.children.push(...childrenCollector);
        }
      } else if (
        typeof value === "object" &&
        value !== null &&
        !isBinaryValue(value)
      ) {
        const targetSchema =
          typeof metadata.target === "string"
            ? metadata.target
            : metadata.target.name;
        const childrenCollector: ValidationError[] = [];
        this.execute(value, targetSchema, childrenCollector);
        if (childrenCollector.length > 0) {
          const err = ensureError();
          err.children ??= [];
          err.children.push(...childrenCollector);
        }
      } else {
        const err = ensureError();
        const [type, message] = this.renderErrorMessage(
          metadata.target,
          value,
          metadata,
          undefined,
        );
        err.constraints ??= {};
        err.constraints[type] = message;
        if (metadata.context) {
          err.contexts ??= {};
          err.contexts[type] = Object.assign(
            err.contexts[type] ?? {},
            metadata.context,
          );
        }
      }
    }
  }

  private validateNestedCollectionItem(
    collection: object,
    subValue: unknown,
    indexKey: string,
    nestedMetadatas: readonly ValidationMetadata[],
    parentChildren: ValidationError[],
  ): void {
    if (subValue === undefined) return;

    let itemErr: ValidationError | undefined;
    const ensureItemErr = (): ValidationError => {
      if (!itemErr) {
        itemErr = this.createPropertyError(collection, subValue, indexKey);
        parentChildren.push(itemErr);
      }
      return itemErr;
    };

    for (let i = 0; i < nestedMetadatas.length; i++) {
      const metadata = nestedMetadatas[i]!;
      if (metadata.type !== ValidationTypes.NESTED_VALIDATION) continue;
      if (
        Array.isArray(subValue) ||
        subValue instanceof Set ||
        subValue instanceof Map
      ) {
        const subChildren: ValidationError[] = [];
        const arr =
          subValue instanceof Set
            ? Array.from(subValue)
            : subValue instanceof Map
              ? Array.from(subValue.values())
              : subValue;
        for (let k = 0; k < arr.length; k++) {
          this.validateNestedCollectionItem(
            subValue,
            arr[k],
            String(k),
            nestedMetadatas,
            subChildren,
          );
        }
        if (subChildren.length > 0) {
          const err = ensureItemErr();
          err.children ??= [];
          err.children.push(...subChildren);
        }
      } else if (
        typeof subValue === "object" &&
        subValue !== null &&
        !isBinaryValue(subValue)
      ) {
        const targetSchema =
          typeof metadata.target === "string"
            ? metadata.target
            : metadata.target.name;
        const subChildren: ValidationError[] = [];
        this.execute(subValue, targetSchema, subChildren);
        if (subChildren.length > 0) {
          const err = ensureItemErr();
          err.children ??= [];
          err.children.push(...subChildren);
        }
      } else {
        const err = ensureItemErr();
        const [type, message] = this.renderErrorMessage(
          metadata.target,
          subValue,
          metadata,
          undefined,
        );
        err.constraints ??= {};
        err.constraints[type] = message;
        if (metadata.context) {
          err.contexts ??= {};
          err.contexts[type] = Object.assign(
            err.contexts[type] ?? {},
            metadata.context,
          );
        }
      }
    }
  }

  private recordFailure(
    error: ValidationError,
    object: object,
    value: unknown,
    rule: CompiledRule,
  ): void {
    const [type, message] = this.renderErrorMessage(
      object,
      value,
      rule.metadata,
      rule.constraintMeta,
    );
    error.constraints ??= {};
    error.constraints[type] = message;
    if (rule.metadata.context) {
      error.contexts ??= {};
      error.contexts[type] = Object.assign(
        error.contexts[type] ?? {},
        rule.metadata.context,
      );
    }
  }

  private renderErrorMessage(
    objectOrTarget: object | string,
    value: unknown,
    metadata: ValidationMetadata,
    constraintMeta: ConstraintMetadata | undefined,
  ): [string, string] {
    const targetName =
      typeof objectOrTarget === "string"
        ? objectOrTarget
        : typeof objectOrTarget === "function"
          ? objectOrTarget.name
          : objectOrTarget?.constructor
            ? objectOrTarget.constructor.name
            : "";

    const type =
      constraintMeta && constraintMeta.name
        ? constraintMeta.name
        : metadata.type;

    const validationArguments: ValidationArguments = {
      targetName,
      property: metadata.propertyName,
      object: typeof objectOrTarget === "object" ? objectOrTarget : {},
      value,
      constraints: metadata.constraints ?? [],
    };

    let message: string | ((args: ValidationArguments) => string) =
      metadata.message ?? "";

    if (!metadata.message && !this.dismissDefaultMessages) {
      const defaultMsgFn = constraintMeta?.instance?.defaultMessage;
      if (typeof defaultMsgFn === "function") {
        message = defaultMsgFn.call(
          constraintMeta!.instance,
          validationArguments,
        );
      }
    }

    const rendered = replaceMessageSpecialTokens(message, validationArguments);
    return [type, rendered];
  }

  finalizeErrors(errors: ValidationError[]): ValidationError[] {
    if (errors.length === 0) return errors;
    const out: ValidationError[] = [];
    for (let i = 0; i < errors.length; i++) {
      const err = errors[i]!;
      if (err.children && err.children.length > 0) {
        err.children = this.finalizeErrors(err.children);
      }
      const hasConstraints =
        err.constraints !== undefined &&
        Object.keys(err.constraints).length > 0;
      const hasChildren = err.children !== undefined && err.children.length > 0;

      if (!hasConstraints) {
        if (!hasChildren) continue;
        delete err.constraints;
      }
      out.push(err);
    }
    return out;
  }
}
