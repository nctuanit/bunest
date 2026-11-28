import {
  coerceBooleanSafe,
  coerceNumberSafe,
  readDesignType,
} from "../transformer/engine/builtins.util";
import { Exclude } from "../transformer/decorators/exclude.decorator";
import { Expose } from "../transformer/decorators/expose.decorator";
import { Transform } from "../transformer/decorators/transform.decorator";
import { Type } from "../transformer/decorators/type.decorator";
import type {
  ExcludeOptions,
  TransformFn,
} from "../transformer/interfaces/decorator-options.interface";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
} from "../validator/decorators/array/array.decorators";
import { IsIn, IsNotEmpty } from "../validator/decorators/common/common.decorators";
import {
  IsDefined,
  IsOptional,
  ValidateIf,
  ValidateNested,
} from "../validator/decorators/core.decorators";
import {
  IsNegative,
  IsPositive,
  Max,
  Min,
} from "../validator/decorators/number/number.decorators";
import {
  Matches,
  MaxLength,
  MinLength,
} from "../validator/decorators/string/string-basic.decorators";
import {
  IsUUID,
  type UUIDVersion,
} from "../validator/decorators/string/string-format.decorators";
import {
  IsEmail,
  IsUrl,
} from "../validator/decorators/string/string-network.decorators";
import {
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsString,
} from "../validator/decorators/typechecker/typechecker.decorators";
import type { ValidationOptions } from "../validator/interfaces/validation-options.interface";
import {
  getPropDocMetadataStorage,
  type PropDocMetadata,
} from "./prop-metadata";

export interface PropOptions extends PropDocMetadata {
  // Optionality
  readonly optional?: boolean;

  // Explicit coercion & transformation (ADR-009 compliant: opt-in per property)
  readonly coerce?: boolean;
  readonly type?: () => Function;
  readonly expose?: boolean | string;
  readonly exclude?: boolean | ExcludeOptions;
  readonly transform?: TransformFn;

  // Type validators
  readonly string?: boolean;
  readonly number?: boolean;
  readonly int?: boolean;
  readonly boolean?: boolean;
  readonly date?: boolean;
  readonly array?: boolean;
  readonly object?: boolean;

  // String rules
  readonly email?: boolean;
  readonly url?: boolean;
  readonly uuid?: boolean | UUIDVersion;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly matches?: RegExp;
  readonly notEmpty?: boolean;

  // Number rules
  readonly min?: number;
  readonly max?: number;
  readonly positive?: boolean;
  readonly negative?: boolean;

  // Enum / allowlist
  readonly enum?: object;
  readonly isIn?: readonly unknown[];

  // Array rules
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly unique?: boolean;
  readonly each?: boolean;

  // Nested DTO validation & transformation
  readonly nested?: boolean | (() => Function);

  // Common validation options (groups applies to validation decorators only)
  readonly message?: ValidationOptions["message"];
  readonly groups?: string[];
}

function coerceSafeString(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return value;
}

function coerceSafeDate(value: unknown): unknown {
  if (value instanceof Date) return new Date(value.valueOf());
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return value;
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? value : parsed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed;
  }
  return value;
}

function extractDocMetadata(options: PropOptions): PropDocMetadata | undefined {
  const doc: Record<string, unknown> = {};
  let hasAny = false;

  const keys: ReadonlyArray<keyof PropDocMetadata> = [
    "description",
    "example",
    "examples",
    "deprecated",
    "format",
    "title",
    "default",
    "readOnly",
    "writeOnly",
    "nullable",
    "hide",
  ];

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    if (options[k] !== undefined) {
      doc[k] = options[k];
      hasAny = true;
    }
  }

  return hasAny ? (doc as PropDocMetadata) : undefined;
}

/**
 * Unified DTO property decorator combining Validation, Explicit Transformation,
 * and OpenAPI/Swagger documentation metadata in a single declaration.
 *
 * Respects ADR-009: coercion is opt-in per property (`coerce: true`) so global
 * `enableImplicitConversion` remains `false`.
 */
export function Prop(options: PropOptions = {}): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    const prop = String(propertyName);
    const designType = readDesignType(target, prop);

    const baseOpts: ValidationOptions = {};
    if (options.message !== undefined) baseOpts.message = options.message;
    if (options.groups !== undefined) baseOpts.groups = options.groups;

    const itemOpts: ValidationOptions = options.each
      ? { ...baseOpts, each: true }
      : baseOpts;

    // 1. Optionality & Nullability
    if (options.optional === true) {
      IsOptional(baseOpts)(target, propertyName);
    } else if (options.nullable === true) {
      // Allow explicit `null` while still requiring the property to be defined (non-undefined)
      ValidateIf((_, value) => value !== null, baseOpts)(target, propertyName);
    }

    // 2. Serialization & Transform decorators
    if (options.exclude === true) {
      Exclude()(target, propertyName);
    } else if (options.exclude && typeof options.exclude === "object") {
      Exclude(options.exclude)(target, propertyName);
    }
    if (options.expose === true) {
      Expose()(target, propertyName);
    } else if (typeof options.expose === "string") {
      Expose({ name: options.expose })(target, propertyName);
    }
    if (options.transform) {
      Transform(options.transform)(target, propertyName);
    }

    // 3. Explicit Type / Coercion
    const hasNumericConstraints =
      options.min !== undefined ||
      options.max !== undefined ||
      options.positive === true ||
      options.negative === true;
    const hasStringConstraints =
      options.string === true ||
      options.email === true ||
      options.url === true ||
      (options.uuid !== undefined && options.uuid !== false) ||
      options.minLength !== undefined ||
      options.maxLength !== undefined ||
      options.matches !== undefined;

    const nestedTypeFn =
      typeof options.nested === "function" ? options.nested : options.type;

    if (options.type && !options.nested) {
      Type(options.type)(target, propertyName);
    } else if (options.coerce === true) {
      const wantsBoolean =
        options.boolean === true ||
        (!options.number &&
          !options.int &&
          !hasNumericConstraints &&
          !hasStringConstraints &&
          !options.date &&
          designType === Boolean);
      const wantsNumber =
        options.int === true ||
        options.number === true ||
        hasNumericConstraints ||
        (!options.boolean &&
          !hasStringConstraints &&
          !options.date &&
          designType === Number);
      const wantsDate =
        options.date === true ||
        (!options.boolean &&
          !options.number &&
          !options.int &&
          !hasNumericConstraints &&
          !hasStringConstraints &&
          designType === Date);
      const wantsString =
        hasStringConstraints ||
        (!options.boolean &&
          !options.number &&
          !options.int &&
          !hasNumericConstraints &&
          !options.date &&
          designType === String);

      if (wantsBoolean) {
        Transform(
          ({ value }) =>
            options.each && Array.isArray(value)
              ? value.map(coerceBooleanSafe)
              : coerceBooleanSafe(value),
          { toClassOnly: true },
        )(target, propertyName);
      } else if (wantsNumber) {
        Transform(
          ({ value }) =>
            options.each && Array.isArray(value)
              ? value.map(coerceNumberSafe)
              : coerceNumberSafe(value),
          { toClassOnly: true },
        )(target, propertyName);
      } else if (wantsDate) {
        Transform(
          ({ value }) =>
            options.each && Array.isArray(value)
              ? value.map(coerceSafeDate)
              : coerceSafeDate(value),
          { toClassOnly: true },
        )(target, propertyName);
      } else if (wantsString) {
        Transform(
          ({ value }) =>
            options.each && Array.isArray(value)
              ? value.map(coerceSafeString)
              : coerceSafeString(value),
          { toClassOnly: true },
        )(target, propertyName);
      } else if (designType && designType !== Object && designType !== Array) {
        Type(() => designType)(target, propertyName);
      }
    }

    // 4. Nested DTO validation & transformation
    const hasNested = options.nested !== undefined && options.nested !== false;
    const isNestedArray =
      hasNested &&
      (options.each === true || designType === Array || options.array === true);
    if (hasNested) {
      if (isNestedArray) {
        IsArray(baseOpts)(target, propertyName);
      } else if (options.optional !== true) {
        // ValidateNested skips `undefined`; require the nested property to be defined unless optional
        IsDefined(baseOpts)(target, propertyName);
      }
      ValidateNested({
        ...(isNestedArray ? { ...baseOpts, each: true } : itemOpts),
        ...(nestedTypeFn ? { type: nestedTypeFn } : {}),
      })(target, propertyName);
    }

    // 5. Array container & element rules
    const hasArrayConstraints =
      options.array === true ||
      options.each === true ||
      options.minItems !== undefined ||
      options.maxItems !== undefined ||
      options.unique === true;
    if (hasArrayConstraints && !hasNested) {
      IsArray(baseOpts)(target, propertyName);
    }
    if (options.minItems !== undefined) {
      ArrayMinSize(options.minItems, baseOpts)(target, propertyName);
    }
    if (options.maxItems !== undefined) {
      ArrayMaxSize(options.maxItems, baseOpts)(target, propertyName);
    }
    if (options.unique === true) {
      ArrayUnique(baseOpts)(target, propertyName);
    }

    // 6. Explicit type & format validators
    let hasExplicitTypeValidator = hasNested || hasArrayConstraints;

    if (options.string === true) {
      IsString(itemOpts)(target, propertyName);
      hasExplicitTypeValidator = true;
    }
    if (options.email === true) {
      IsEmail(undefined, itemOpts)(target, propertyName);
      hasExplicitTypeValidator = true;
    }
    if (options.url === true) {
      IsUrl(undefined, itemOpts)(target, propertyName);
      hasExplicitTypeValidator = true;
    }
    if (options.uuid !== undefined && options.uuid !== false) {
      const version = options.uuid === true ? undefined : options.uuid;
      IsUUID(version, itemOpts)(target, propertyName);
      hasExplicitTypeValidator = true;
    }
    if (options.int === true) {
      IsInt(itemOpts)(target, propertyName);
      hasExplicitTypeValidator = true;
    } else if (options.number === true || hasNumericConstraints) {
      IsNumber({}, itemOpts)(target, propertyName);
      hasExplicitTypeValidator = true;
    }
    if (options.boolean === true) {
      IsBoolean(itemOpts)(target, propertyName);
      hasExplicitTypeValidator = true;
    }
    if (options.date === true) {
      IsDate(itemOpts)(target, propertyName);
      hasExplicitTypeValidator = true;
    }
    if (options.object === true) {
      IsObject(itemOpts)(target, propertyName);
      hasExplicitTypeValidator = true;
    }
    if (options.enum !== undefined) {
      IsEnum(options.enum, itemOpts)(target, propertyName);
      hasExplicitTypeValidator = true;
    }
    if (options.isIn !== undefined) {
      IsIn(options.isIn, itemOpts)(target, propertyName);
      hasExplicitTypeValidator = true;
    }

    // 7. String & number constraint rules
    if (options.notEmpty === true) {
      IsNotEmpty(itemOpts)(target, propertyName);
    }
    if (options.minLength !== undefined) {
      MinLength(options.minLength, itemOpts)(target, propertyName);
      hasExplicitTypeValidator = true;
    }
    if (options.maxLength !== undefined) {
      MaxLength(options.maxLength, itemOpts)(target, propertyName);
      hasExplicitTypeValidator = true;
    }
    if (options.matches !== undefined) {
      Matches(options.matches, itemOpts)(target, propertyName);
      hasExplicitTypeValidator = true;
    }
    if (options.min !== undefined) {
      Min(options.min, itemOpts)(target, propertyName);
    }
    if (options.max !== undefined) {
      Max(options.max, itemOpts)(target, propertyName);
    }
    if (options.positive === true) {
      IsPositive(itemOpts)(target, propertyName);
    }
    if (options.negative === true) {
      IsNegative(itemOpts)(target, propertyName);
    }

    // 8. Fallback type inference from TypeScript `design:type` when no explicit validator was set
    if (!hasExplicitTypeValidator) {
      if (designType === String) {
        IsString(itemOpts)(target, propertyName);
      } else if (designType === Number) {
        IsNumber({}, itemOpts)(target, propertyName);
      } else if (designType === Boolean) {
        IsBoolean(itemOpts)(target, propertyName);
      } else if (designType === Date) {
        IsDate(itemOpts)(target, propertyName);
      } else if (designType === Array) {
        IsArray(baseOpts)(target, propertyName);
      }
    }

    // 9. Store OpenAPI / documentation metadata (read by @bunest/swagger with 0 runtime coupling)
    const docMeta = extractDocMetadata(options);
    if (docMeta) {
      getPropDocMetadataStorage().set(target.constructor, prop, docMeta);
    }
  };
}
