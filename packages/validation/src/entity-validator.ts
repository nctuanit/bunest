import {
  BODY_SANITIZED_SYMBOL,
  getEntitySchema,
  type Abstract,
  type EntityColumnMetadata,
  type Type,
  type ValidationError,
} from "@bunest/common";
import {
  buildDangerousKeyValidationErrors,
  findDangerousKeys,
} from "./utils/sanitize.util";

export interface EntityValidationOptions {
  /**
   * Strip properties not declared as entity columns (or listed in `extraWhitelistedProperties`).
   * @default true
   */
  readonly whitelist?: boolean;
  /**
   * Emit `whitelistValidation` errors for unknown properties instead of silently stripping them.
   * Defaults to the value of `whitelist` (`true` by default), matching `ValidationPipe`.
   */
  readonly forbidNonWhitelisted?: boolean;
  /**
   * Instantiate `entityClass` and coerce compatible primitive values (e.g., numeric strings
   * for `integer`/`real`/`bigint`, `"true"`/`"false"` for `boolean`, ISO strings for `datetime`).
   * When `false`, returns a plain whitelisted copy (if `whitelist: true`) or the original value.
   * @default true
   */
  readonly transform?: boolean;
  /**
   * Controls safe primitive coercion during validation.
   * Defaults to `transform` (`true` when `transform: true`, `false` when `transform: false`).
   */
  readonly enableImplicitConversion?: boolean;
  /**
   * Skip validation for omitted (`undefined`) or `null` columns (useful for partial updates).
   * @default false
   */
  readonly skipMissingProperties?: boolean;
  /**
   * Skip validation for columns whose value is `null`.
   * @default false
   */
  readonly skipNullProperties?: boolean;
  /**
   * Skip validation for columns whose value is `undefined`.
   * @default false
   */
  readonly skipUndefinedProperties?: boolean;
  /**
   * Stop checking remaining constraints on a column after its first failing constraint.
   * @default false
   */
  readonly stopAtFirstError?: boolean;
  /**
   * Omit default human-readable error messages (sets constraint values to `""`).
   * @default false
   */
  readonly dismissDefaultMessages?: boolean;
  /**
   * Additional property names treated as whitelisted alongside `@Column` / `@PrimaryKey` columns
   * (for example, `class-validator`-only properties on hybrid entity classes).
   */
  readonly extraWhitelistedProperties?: ReadonlySet<string> | readonly string[];
  /**
   * Additional property names treated as optional when omitted or `null`
   * (for example, properties decorated with `class-validator`'s `@IsOptional()`).
   */
  readonly optionalProperties?: ReadonlySet<string> | readonly string[];
  /**
   * Control whether `target` and/or `value` are attached to emitted `ValidationError` entries.
   * Defaults to `{ target: false, value: false }` per ADR-009.
   */
  readonly validationError?: {
    readonly target?: boolean;
    readonly value?: boolean;
  };
  /**
   * Root property name reported when `value` is not a valid object.
   * @default "value"
   */
  readonly rootFieldName?: string;
}

export interface EntityValidationResult<T = unknown> {
  readonly valid: boolean;
  readonly value: T;
  readonly errors: ValidationError[];
}

export interface InternalEntityValidationResult<T = unknown>
  extends EntityValidationResult<T> {
  readonly resolvedValues: ReadonlyMap<string, unknown>;
}

const INTEGER_STRING_RE = /^[+-]?\d+$/;
const REAL_STRING_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

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
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream) {
    return true;
  }
  return false;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseIsoDateTime(raw: string): Date | undefined {
  const match = ISO_DATETIME_RE.exec(raw);
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return undefined;
  }
  if (match[4] !== undefined) {
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = match[6] !== undefined ? Number(match[6]) : 0;
    if (hour > 23 || minute > 59 || second > 60) {
      return undefined;
    }
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function buildStatelessRegExp(pattern: RegExp | string): RegExp {
  if (pattern instanceof RegExp) {
    if (pattern.global || pattern.sticky) {
      return new RegExp(
        pattern.source,
        pattern.flags.replace(/[gy]/g, ""),
      );
    }
    return pattern;
  }
  return new RegExp(pattern);
}

function isValidJsonValue(value: unknown): boolean {
  const t = typeof value;
  if (
    t === "function" ||
    t === "symbol" ||
    t === "bigint" ||
    t === "undefined"
  ) {
    return false;
  }
  if (t === "number") {
    return Number.isFinite(value);
  }
  return true;
}

function toStringSet(
  input: ReadonlySet<string> | readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  if (!input) {
    return undefined;
  }
  return input instanceof Set ? input : new Set(input);
}

function isAutoOptionalColumn(col: EntityColumnMetadata): boolean {
  return (
    col.generated ||
    col.createdAt ||
    col.updatedAt ||
    col.hasDefault ||
    col.nullable
  );
}

function instantiateEntity<T>(entityClass: Type<T> | Abstract<T>): Record<string, unknown> {
  try {
    return new (entityClass as new () => Record<string, unknown>)();
  } catch {
    return Object.create(entityClass.prototype) as Record<string, unknown>;
  }
}

/**
 * Internal variant returning `resolvedValues` alongside errors so hybrid
 * `@Entity` + `class-validator` pipelines can propagate coerced column values
 * even when another column has validation errors.
 */
export function validateEntityDetailed<T = Record<string, unknown>>(
  entityClass: Type<T> | Abstract<T>,
  value: unknown,
  options: EntityValidationOptions = {},
): InternalEntityValidationResult<T> {
  const schema = getEntitySchema(entityClass);
  if (!schema) {
    throw new TypeError(
      `Class "${entityClass.name || "Anonymous"}" is not decorated with @Entity().`,
    );
  }

  const whitelist = options.whitelist ?? true;
  const forbidNonWhitelisted = options.forbidNonWhitelisted ?? whitelist;
  const transform = options.transform ?? true;
  const coerce = options.enableImplicitConversion ?? transform;
  const skipMissingProperties = options.skipMissingProperties ?? false;
  const skipNullProperties = options.skipNullProperties ?? false;
  const skipUndefinedProperties = options.skipUndefinedProperties ?? false;
  const stopAtFirstError = options.stopAtFirstError ?? false;
  const dismissDefaultMessages = options.dismissDefaultMessages ?? false;
  const includeTarget = options.validationError?.target ?? false;
  const includeValue = options.validationError?.value ?? false;
  const rootFieldName = options.rootFieldName ?? "value";

  const formatMsg = (msg: string): string => (dismissDefaultMessages ? "" : msg);
  const resolvedValues = new Map<string, unknown>();

  // Guard 1: Payload must be a non-null, non-array record object
  if (
    value === null ||
    value === undefined ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    isNonRecordBuiltIn(value)
  ) {
    return {
      valid: false,
      value: value as T,
      errors: [
        {
          property: rootFieldName,
          children: [],
          constraints: {
            isObject: formatMsg(`${rootFieldName} must be a valid object`),
          },
          ...(includeValue ? { value } : {}),
        },
      ],
      resolvedValues,
    };
  }

  // Guard 2: Reject prototype-pollution keys unless already sanitized by @bunest/http
  if (
    (value as Record<PropertyKey, unknown>)[BODY_SANITIZED_SYMBOL] !== true
  ) {
    const dangerous = findDangerousKeys(value);
    if (dangerous.length > 0) {
      return {
        valid: false,
        value: value as T,
        errors: buildDangerousKeyValidationErrors(dangerous),
        resolvedValues,
      };
    }
  }

  const input = value as Record<string, unknown>;
  const extraWhitelisted = toStringSet(options.extraWhitelistedProperties);
  const optionalProps = toStringSet(options.optionalProperties);

  const allowedKeys = new Set<string>();
  for (let i = 0; i < schema.columns.length; i++) {
    const col = schema.columns[i]!;
    allowedKeys.add(col.propertyName);
  }
  if (extraWhitelisted) {
    for (const extra of extraWhitelisted) {
      allowedKeys.add(extra);
    }
  }

  const errors: ValidationError[] = [];
  const inputKeys = Object.keys(input);

  // 1. Whitelist enforcement on raw input keys
  if (whitelist && forbidNonWhitelisted) {
    for (let i = 0; i < inputKeys.length; i++) {
      const key = inputKeys[i]!;
      if (!allowedKeys.has(key)) {
        errors.push({
          property: key,
          children: [],
          constraints: {
            whitelistValidation: formatMsg(
              `property ${key} should not exist`,
            ),
          },
          ...(includeTarget ? { target: value } : {}),
          ...(includeValue ? { value: input[key] } : {}),
        });
      }
    }
  }

  // 2. Column-by-column validation and safe coercion
  for (let i = 0; i < schema.columns.length; i++) {
    const col = schema.columns[i]!;
    const prop = col.propertyName;
    const hasOwn = Object.hasOwn(input, prop);
    const rawVal = hasOwn ? input[prop] : undefined;
    const isMarkedOptional = optionalProps?.has(prop) === true;

    if (rawVal === undefined) {
      if (
        skipMissingProperties ||
        skipUndefinedProperties ||
        isAutoOptionalColumn(col) ||
        isMarkedOptional
      ) {
        continue;
      }
      errors.push({
        property: prop,
        children: [],
        constraints: {
          isDefined: formatMsg(`${prop} should not be null or undefined`),
        },
        ...(includeTarget ? { target: value } : {}),
        ...(includeValue ? { value: rawVal } : {}),
      });
      continue;
    }

    if (rawVal === null) {
      if (
        col.nullable ||
        skipMissingProperties ||
        skipNullProperties ||
        isMarkedOptional
      ) {
        resolvedValues.set(prop, null);
        continue;
      }
      errors.push({
        property: prop,
        children: [],
        constraints: {
          isDefined: formatMsg(`${prop} should not be null or undefined`),
        },
        ...(includeTarget ? { target: value } : {}),
        ...(includeValue ? { value: rawVal } : {}),
      });
      continue;
    }

    const constraints: Record<string, string> = {};
    let constraintCount = 0;
    const addConstraint = (key: string, message: string): void => {
      if (stopAtFirstError && constraintCount > 0) {
        return;
      }
      if (!Object.hasOwn(constraints, key)) {
        constraints[key] = formatMsg(message);
        constraintCount++;
      }
    };

    let resolvedVal: unknown = rawVal;
    let typeValid = true;

    switch (col.type) {
      case "integer": {
        if (typeof rawVal === "number") {
          typeValid = Number.isInteger(rawVal);
        } else if (coerce && typeof rawVal === "string") {
          const trimmed = rawVal.trim();
          if (INTEGER_STRING_RE.test(trimmed)) {
            const parsed = Number(trimmed);
            if (Number.isSafeInteger(parsed)) {
              resolvedVal = parsed;
              typeValid = true;
            } else {
              typeValid = false;
            }
          } else {
            typeValid = false;
          }
        } else {
          typeValid = false;
        }
        if (!typeValid) {
          addConstraint("isInt", `${prop} must be an integer number`);
        }
        break;
      }

      case "real": {
        if (typeof rawVal === "number") {
          typeValid = Number.isFinite(rawVal);
        } else if (coerce && typeof rawVal === "string") {
          const trimmed = rawVal.trim();
          if (REAL_STRING_RE.test(trimmed)) {
            const parsed = Number(trimmed);
            if (Number.isFinite(parsed)) {
              resolvedVal = parsed;
              typeValid = true;
            } else {
              typeValid = false;
            }
          } else {
            typeValid = false;
          }
        } else {
          typeValid = false;
        }
        if (!typeValid) {
          addConstraint("isNumber", `${prop} must be a number`);
        }
        break;
      }

      case "bigint": {
        if (typeof rawVal === "bigint") {
          typeValid = true;
        } else if (
          coerce &&
          typeof rawVal === "number" &&
          Number.isInteger(rawVal)
        ) {
          resolvedVal = BigInt(rawVal);
          typeValid = true;
        } else if (
          coerce &&
          typeof rawVal === "string" &&
          INTEGER_STRING_RE.test(rawVal.trim())
        ) {
          resolvedVal = BigInt(rawVal.trim());
          typeValid = true;
        } else {
          typeValid = false;
        }
        if (!typeValid) {
          addConstraint("isBigInt", `${prop} must be a bigint`);
        }
        break;
      }

      case "text":
      case "varchar": {
        if (typeof rawVal !== "string") {
          typeValid = false;
          addConstraint("isString", `${prop} must be a string`);
        }
        break;
      }

      case "boolean": {
        if (typeof rawVal === "boolean") {
          typeValid = true;
        } else if (coerce && rawVal === "true") {
          resolvedVal = true;
          typeValid = true;
        } else if (coerce && rawVal === "false") {
          resolvedVal = false;
          typeValid = true;
        } else {
          typeValid = false;
          addConstraint("isBoolean", `${prop} must be a boolean value`);
        }
        break;
      }

      case "uuid": {
        if (typeof rawVal !== "string" || !UUID_RE.test(rawVal)) {
          typeValid = false;
          addConstraint("isUuid", `${prop} must be a UUID`);
        }
        break;
      }

      case "datetime": {
        if (rawVal instanceof Date) {
          typeValid = !Number.isNaN(rawVal.getTime());
        } else if (typeof rawVal === "string") {
          const parsedDate = parseIsoDateTime(rawVal);
          if (parsedDate) {
            typeValid = true;
            if (
              coerce &&
              (col.designType === Date || col.designType === undefined)
            ) {
              resolvedVal = parsedDate;
            }
          } else {
            typeValid = false;
          }
        } else {
          typeValid = false;
        }
        if (!typeValid) {
          addConstraint(
            "isDate",
            `${prop} must be a valid date or ISO 8601 date string`,
          );
        }
        break;
      }

      case "json": {
        if (col.designType === Array) {
          if (!Array.isArray(rawVal)) {
            typeValid = false;
            addConstraint("isArray", `${prop} must be an array`);
          }
        } else if (!isValidJsonValue(rawVal)) {
          typeValid = false;
          addConstraint("isJson", `${prop} must be a valid JSON value`);
        }
        break;
      }

      case "blob": {
        if (!(rawVal instanceof ArrayBuffer || ArrayBuffer.isView(rawVal))) {
          typeValid = false;
          addConstraint("isBlob", `${prop} must be binary data`);
        }
        break;
      }
    }

    // Secondary constraints when base type check passed
    if (typeValid) {
      if (typeof resolvedVal === "string") {
        if (col.minLength !== undefined && resolvedVal.length < col.minLength) {
          addConstraint(
            "minLength",
            `${prop} must be longer than or equal to ${col.minLength} characters`,
          );
        }
        const effectiveMaxLength =
          col.maxLength ??
          (col.type === "varchar" || col.type === "text"
            ? col.length
            : undefined);
        if (
          effectiveMaxLength !== undefined &&
          resolvedVal.length > effectiveMaxLength
        ) {
          addConstraint(
            "maxLength",
            `${prop} must be shorter than or equal to ${effectiveMaxLength} characters`,
          );
        }
        if (col.pattern !== undefined) {
          const regex = buildStatelessRegExp(col.pattern);
          if (!regex.test(resolvedVal)) {
            addConstraint(
              "matches",
              `${prop} must match ${String(col.pattern)} regular expression`,
            );
          }
        }
      }

      if (typeof resolvedVal === "number" || typeof resolvedVal === "bigint") {
        if (col.min !== undefined && resolvedVal < col.min) {
          addConstraint("min", `${prop} must not be less than ${col.min}`);
        }
        if (col.max !== undefined && resolvedVal > col.max) {
          addConstraint("max", `${prop} must not be greater than ${col.max}`);
        }
      }

      if (col.enum !== undefined && col.enum.length > 0) {
        if (!col.enum.includes(resolvedVal as string | number)) {
          addConstraint(
            "isEnum",
            `${prop} must be one of the following values: ${col.enum.join(", ")}`,
          );
        }
      }
    }

    if (typeValid) {
      resolvedValues.set(prop, resolvedVal);
    }

    if (constraintCount > 0) {
      errors.push({
        property: prop,
        children: [],
        constraints,
        ...(includeTarget ? { target: value } : {}),
        ...(includeValue ? { value: rawVal } : {}),
      });
    }
  }

  if (errors.length > 0) {
    return {
      valid: false,
      value: value as T,
      errors,
      resolvedValues,
    };
  }

  if (transform) {
    const instance = instantiateEntity(entityClass);
    for (const [key, val] of resolvedValues.entries()) {
      instance[key] = val;
    }
    for (let i = 0; i < inputKeys.length; i++) {
      const key = inputKeys[i]!;
      if (resolvedValues.has(key)) {
        continue;
      }
      if (!whitelist || allowedKeys.has(key)) {
        instance[key] = input[key];
      }
    }
    return {
      valid: true,
      value: instance as T,
      errors: [],
      resolvedValues,
    };
  }

  if (whitelist) {
    const whitelistedPlain: Record<string, unknown> = {};
    for (let i = 0; i < inputKeys.length; i++) {
      const key = inputKeys[i]!;
      if (allowedKeys.has(key)) {
        whitelistedPlain[key] = input[key];
      }
    }
    return {
      valid: true,
      value: whitelistedPlain as T,
      errors: [],
      resolvedValues,
    };
  }

  return {
    valid: true,
    value: value as T,
    errors: [],
    resolvedValues,
  };
}

/**
 * Validates (and optionally transforms & whitelists) an incoming payload against
 * an `@Entity()` class's single-source-of-truth `@Column` / `@PrimaryKey` /
 * `@PrimaryGeneratedColumn` / `@CreateDateColumn` / `@UpdateDateColumn` schema metadata.
 */
export function validateEntity<T = Record<string, unknown>>(
  entityClass: Type<T> | Abstract<T>,
  value: unknown,
  options: EntityValidationOptions = {},
): EntityValidationResult<T> {
  const { valid, value: outValue, errors } = validateEntityDetailed(
    entityClass,
    value,
    options,
  );
  return { valid, value: outValue, errors };
}

/**
 * Merges two `ValidationError[]` lists by property path without duplicating
 * constraint keys (when both lists report the same constraint key for a property,
 * `preferred` wins so custom `class-validator` messages override defaults).
 */
export function mergeValidationErrors(
  entityErrors: readonly ValidationError[],
  classValidatorErrors: readonly ValidationError[],
  stopAtFirstError = false,
): ValidationError[] {
  if (entityErrors.length === 0) {
    return [...classValidatorErrors];
  }
  if (classValidatorErrors.length === 0) {
    return [...entityErrors];
  }

  const orderedKeys: string[] = [];
  const mergedByProp = new Map<string, ValidationError>();

  const upsert = (
    err: ValidationError,
    preferIncomingConstraints: boolean,
  ): void => {
    const existing = mergedByProp.get(err.property);
    if (!existing) {
      orderedKeys.push(err.property);
      const copiedConstraints = err.constraints
        ? { ...err.constraints }
        : undefined;
      mergedByProp.set(err.property, {
        ...err,
        ...(copiedConstraints ? { constraints: copiedConstraints } : {}),
        ...(err.children ? { children: [...err.children] } : {}),
      });
      return;
    }

    let nextConstraints = existing.constraints
      ? { ...existing.constraints }
      : undefined;
    if (err.constraints) {
      nextConstraints ??= {};
      for (const [k, msg] of Object.entries(err.constraints)) {
        if (preferIncomingConstraints || !Object.hasOwn(nextConstraints, k)) {
          nextConstraints[k] = msg;
        }
      }
    }

    const existingChildren = existing.children ?? [];
    const incomingChildren = err.children ?? [];
    const nextChildren =
      existingChildren.length > 0 && incomingChildren.length > 0
        ? mergeValidationErrors(
            existingChildren,
            incomingChildren,
            stopAtFirstError,
          )
        : existingChildren.length > 0
          ? existingChildren
          : incomingChildren;

    mergedByProp.set(err.property, {
      ...existing,
      ...(nextConstraints ? { constraints: nextConstraints } : {}),
      children: nextChildren,
    });
  };

  for (let i = 0; i < entityErrors.length; i++) {
    upsert(entityErrors[i]!, false);
  }
  for (let i = 0; i < classValidatorErrors.length; i++) {
    upsert(classValidatorErrors[i]!, true);
  }

  const result: ValidationError[] = [];
  for (let i = 0; i < orderedKeys.length; i++) {
    const entry = mergedByProp.get(orderedKeys[i]!)!;
    if (
      stopAtFirstError &&
      entry.constraints &&
      Object.keys(entry.constraints).length > 1
    ) {
      const [firstKey, firstMsg] = Object.entries(entry.constraints)[0]!;
      result.push({
        ...entry,
        constraints: { [firstKey]: firstMsg },
      });
    } else {
      result.push(entry);
    }
  }

  return result;
}
