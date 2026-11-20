import { METADATA_KEYS } from "../constants/metadata-keys";
import { HttpStatus, Scope } from "../enums/scope.enum";
import { HttpException } from "../exceptions/http.exception";
import type {
  ArgumentMetadata,
  PipeTransform,
} from "../interfaces/http.interface";
import type { Type } from "../interfaces/type.interface";
import { MetadataRegistry } from "../metadata/metadata-registry";
import { ValidationPipe, type ValidationPipeOptions } from "./validation.pipe";

export interface ParsePipeOptions {
  errorHttpStatusCode?: number;
  exceptionFactory?: (error: string) => unknown;
  optional?: boolean;
}

export type ParseIntPipeOptions = ParsePipeOptions;
export type ParseFloatPipeOptions = ParsePipeOptions;
export type ParseBoolPipeOptions = ParsePipeOptions;
export type ParseEnumPipeOptions = ParsePipeOptions;
export type UUIDVersion = "3" | "4" | "5" | "7" | "all";

const HTTP_STATUS_REASON_PHRASES: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: "Bad Request",
  [HttpStatus.UNAUTHORIZED]: "Unauthorized",
  [HttpStatus.PAYMENT_REQUIRED]: "Payment Required",
  [HttpStatus.FORBIDDEN]: "Forbidden",
  [HttpStatus.NOT_FOUND]: "Not Found",
  [HttpStatus.METHOD_NOT_ALLOWED]: "Method Not Allowed",
  [HttpStatus.NOT_ACCEPTABLE]: "Not Acceptable",
  [HttpStatus.REQUEST_TIMEOUT]: "Request Timeout",
  [HttpStatus.CONFLICT]: "Conflict",
  [HttpStatus.GONE]: "Gone",
  [HttpStatus.LENGTH_REQUIRED]: "Length Required",
  [HttpStatus.PRECONDITION_FAILED]: "Precondition Failed",
  [HttpStatus.PAYLOAD_TOO_LARGE]: "Payload Too Large",
  [HttpStatus.URI_TOO_LONG]: "URI Too Long",
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: "Unsupported Media Type",
  [HttpStatus.I_AM_A_TEAPOT]: "I'm a Teapot",
  [HttpStatus.UNPROCESSABLE_ENTITY]: "Unprocessable Entity",
  [HttpStatus.FAILED_DEPENDENCY]: "Failed Dependency",
  [HttpStatus.PRECONDITION_REQUIRED]: "Precondition Required",
  [HttpStatus.TOO_MANY_REQUESTS]: "Too Many Requests",
  [HttpStatus.INTERNAL_SERVER_ERROR]: "Internal Server Error",
  [HttpStatus.NOT_IMPLEMENTED]: "Not Implemented",
  [HttpStatus.BAD_GATEWAY]: "Bad Gateway",
  [HttpStatus.SERVICE_UNAVAILABLE]: "Service Unavailable",
  [HttpStatus.GATEWAY_TIMEOUT]: "Gateway Timeout",
};

function buildPipeExceptionFactory(
  options?: ParsePipeOptions,
): (error: string) => any {
  if (options?.exceptionFactory) {
    return options.exceptionFactory;
  }
  const status = options?.errorHttpStatusCode ?? HttpStatus.BAD_REQUEST;
  const errorLabel = HTTP_STATUS_REASON_PHRASES[status] ?? "Http Exception";
  return (message: string) =>
    new HttpException(
      HttpException.createBody(message, errorLabel, status),
      status,
      { description: errorLabel },
    );
}

function isNil(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const STRICT_INT_REGEX = /^[+-]?\d+$/;
const STRICT_FLOAT_REGEX = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const UUID_REGEX: Record<UUIDVersion, RegExp> = {
  "3": /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "4": /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "5": /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "7": /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  all: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
};

export class ParseIntPipe implements PipeTransform<unknown, number | undefined> {
  protected readonly options?: ParseIntPipeOptions;
  protected exceptionFactory: (error: string) => any;

  constructor(options?: ParseIntPipeOptions) {
    this.options = options;
    this.exceptionFactory = buildPipeExceptionFactory(options);
  }

  transform(value: unknown, _metadata?: ArgumentMetadata): number | undefined {
    if (isNil(value) && this.options?.optional) {
      return undefined;
    }

    if (!this.isNumeric(value)) {
      throw this.exceptionFactory(
        "Validation failed (numeric integer string is expected)",
      );
    }

    const parsed =
      typeof value === "number" ? value : Number.parseInt(value as string, 10);
    if (!Number.isSafeInteger(parsed)) {
      throw this.exceptionFactory(
        "Validation failed (numeric integer string is expected)",
      );
    }
    return parsed === 0 ? 0 : parsed;
  }

  protected isNumeric(value: unknown): boolean {
    if (typeof value === "number") {
      return Number.isSafeInteger(value);
    }
    return typeof value === "string" && STRICT_INT_REGEX.test(value);
  }
}

export class ParseFloatPipe
  implements PipeTransform<unknown, number | undefined>
{
  protected readonly options?: ParseFloatPipeOptions;
  protected exceptionFactory: (error: string) => any;

  constructor(options?: ParseFloatPipeOptions) {
    this.options = options;
    this.exceptionFactory = buildPipeExceptionFactory(options);
  }

  transform(value: unknown, _metadata?: ArgumentMetadata): number | undefined {
    if (isNil(value) && this.options?.optional) {
      return undefined;
    }

    if (!this.isNumeric(value)) {
      throw this.exceptionFactory(
        "Validation failed (numeric string is expected)",
      );
    }

    const parsed =
      typeof value === "number" ? value : Number.parseFloat(value as string);
    if (!Number.isFinite(parsed)) {
      throw this.exceptionFactory(
        "Validation failed (numeric string is expected)",
      );
    }
    return parsed === 0 ? 0 : parsed;
  }

  protected isNumeric(value: unknown): boolean {
    if (typeof value === "number") {
      return Number.isFinite(value);
    }
    return typeof value === "string" && STRICT_FLOAT_REGEX.test(value);
  }
}

/**
 * Strictly parses boolean values.
 * Accepts ONLY `true`, `false`, `"true"`, and `"false"`. Rejects all other values.
 */
export class ParseBoolPipe
  implements PipeTransform<unknown, boolean | undefined>
{
  protected readonly options?: ParseBoolPipeOptions;
  protected exceptionFactory: (error: string) => any;

  constructor(options?: ParseBoolPipeOptions) {
    this.options = options;
    this.exceptionFactory = buildPipeExceptionFactory(options);
  }

  transform(value: unknown, _metadata?: ArgumentMetadata): boolean | undefined {
    if (isNil(value) && this.options?.optional) {
      return undefined;
    }

    if (this.isTrue(value)) {
      return true;
    }

    if (this.isFalse(value)) {
      return false;
    }

    throw this.exceptionFactory(
      "Validation failed (boolean string is expected)",
    );
  }

  protected isTrue(value: unknown): boolean {
    return value === true || value === "true";
  }

  protected isFalse(value: unknown): boolean {
    return value === false || value === "false";
  }
}

export interface ParseUUIDPipeOptions extends ParsePipeOptions {
  version?: UUIDVersion;
}

export class ParseUUIDPipe
  implements PipeTransform<unknown, string | undefined>
{
  protected static uuidRegExps: Record<UUIDVersion, RegExp> = UUID_REGEX;

  protected readonly options?: ParseUUIDPipeOptions;
  protected exceptionFactory: (errors: string) => any;
  private readonly version: UUIDVersion;

  constructor(options?: ParseUUIDPipeOptions) {
    this.options = options;
    this.version = options?.version ?? "all";
    this.exceptionFactory = buildPipeExceptionFactory(options);
  }

  transform(value: unknown, _metadata?: ArgumentMetadata): string | undefined {
    if (isNil(value) && this.options?.optional) {
      return undefined;
    }

    if (this.isUUID(value, this.version)) {
      return value as string;
    }

    const versionMsg =
      this.version === "all" ? "uuid" : `uuid v${this.version}`;
    throw this.exceptionFactory(`Validation failed (${versionMsg} is expected)`);
  }

  protected isUUID(str: unknown, version: UUIDVersion = "all"): boolean {
    if (typeof str !== "string") {
      return false;
    }
    const pattern = ParseUUIDPipe.uuidRegExps[version];
    return Boolean(pattern && pattern.test(str));
  }
}

export interface ParseArrayPipeOptions
  extends Omit<
    ValidationPipeOptions,
    "transform" | "validateCustomDecorators" | "exceptionFactory"
  > {
  items?: Type<unknown> | typeof Number | typeof Boolean | typeof String;
  separator?: string;
  optional?: boolean;
  itemPipe?: PipeTransform;
  exceptionFactory?: (error: any) => any;
}

export type ParseArrayOptions = ParseArrayPipeOptions;

export class ParseArrayPipe
  implements PipeTransform<unknown, unknown[] | undefined>
{
  protected readonly options: ParseArrayPipeOptions;
  protected readonly validationPipe: ValidationPipe;
  protected exceptionFactory: (error: string) => any;
  private readonly separator: string;

  constructor(options: ParseArrayPipeOptions = {}) {
    this.options = options;
    this.separator = options.separator ?? ",";
    this.exceptionFactory = buildPipeExceptionFactory(options);
    const {
      items: _items,
      separator: _sep,
      optional: _opt,
      itemPipe: _itemPipe,
      exceptionFactory: _excFactory,
      ...validationOpts
    } = options;
    this.validationPipe = new ValidationPipe({
      ...validationOpts,
      transform: true,
    });
  }

  async transform(
    value: unknown,
    metadata?: ArgumentMetadata,
  ): Promise<unknown[] | undefined> {
    if (isNil(value) && this.options.optional) {
      return undefined;
    }

    let rawItems: unknown[];
    if (Array.isArray(value)) {
      rawItems = value;
    } else if (typeof value === "string") {
      rawItems = value === "" ? [] : value.split(this.separator);
    } else {
      throw this.exceptionFactory(
        "Validation failed (parsable array expected)",
      );
    }

    const itemType = this.options.items;
    const itemPipe = this.options.itemPipe;
    const isPrimitiveItem = this.isExpectedTypePrimitive();
    const result: unknown[] = [];

    for (let index = 0; index < rawItems.length; index++) {
      const item = rawItems[index];
      let transformed: unknown = item;

      if (isPrimitiveItem) {
        transformed = this.validatePrimitive(item, index);
      } else if (itemType) {
        transformed = await this.validationPipe.transform(item, {
          type: metadata?.type ?? "body",
          metatype: itemType,
          data: metadata?.data,
        });
      }

      if (itemPipe) {
        transformed = await itemPipe.transform(
          transformed,
          metadata ?? { type: "custom" },
        );
      }

      result.push(transformed);
    }

    return result;
  }

  protected isExpectedTypePrimitive(): boolean {
    const itemType = this.options.items;
    return itemType === Number || itemType === Boolean || itemType === String;
  }

  protected isNumeric(value: unknown): boolean {
    if (typeof value === "number") {
      return Number.isFinite(value);
    }
    return typeof value === "string" && STRICT_FLOAT_REGEX.test(value.trim());
  }

  protected validatePrimitive(originalValue: any, _index?: number): any {
    const itemType = this.options.items;
    if (itemType === Number) {
      if (typeof originalValue === "number" && Number.isFinite(originalValue)) {
        return originalValue === 0 ? 0 : originalValue;
      }
      if (this.isNumeric(originalValue)) {
        const num = Number(String(originalValue).trim());
        if (Number.isFinite(num)) {
          return num === 0 ? 0 : num;
        }
      }
      throw this.exceptionFactory(
        "Validation failed (numeric array item expected)",
      );
    }

    if (itemType === Boolean) {
      const normalized =
        typeof originalValue === "string"
          ? originalValue.trim()
          : originalValue;
      if (normalized === true || normalized === "true") {
        return true;
      }
      if (normalized === false || normalized === "false") {
        return false;
      }
      throw this.exceptionFactory(
        "Validation failed (boolean array item expected)",
      );
    }

    if (itemType === String) {
      if (
        typeof originalValue === "string" ||
        typeof originalValue === "number" ||
        typeof originalValue === "boolean"
      ) {
        return String(originalValue);
      }
      throw this.exceptionFactory(
        "Validation failed (string array item expected)",
      );
    }

    return originalValue;
  }
}

export class ParseEnumPipe<
  TEnum extends Record<string, string | number> = Record<
    string,
    string | number
  >,
> implements PipeTransform<unknown, TEnum[keyof TEnum] | undefined>
{
  protected readonly enumType: TEnum;
  protected readonly options?: ParseEnumPipeOptions;
  protected exceptionFactory: (error: string) => any;
  private cachedEnumValues?: (string | number)[];
  private readonly validValues: ReadonlySet<string | number>;
  private readonly numericValues: ReadonlySet<number>;

  constructor(enumType: TEnum, options?: ParseEnumPipeOptions) {
    if (!enumType || typeof enumType !== "object") {
      throw new Error("ParseEnumPipe requires a valid enum object.");
    }
    this.enumType = enumType;
    this.options = options;
    this.exceptionFactory = buildPipeExceptionFactory(options);

    const values = this.getEnumValues();
    this.validValues = new Set(values);
    this.numericValues = new Set(
      values.filter((v): v is number => typeof v === "number"),
    );
  }

  transform(
    value: unknown,
    _metadata?: ArgumentMetadata,
  ): TEnum[keyof TEnum] | undefined {
    if (isNil(value) && this.options?.optional) {
      return undefined;
    }

    if (!this.isEnum(value)) {
      throw this.exceptionFactory(
        "Validation failed (enum string is expected)",
      );
    }

    return this.toEnumValue(value) as TEnum[keyof TEnum];
  }

  protected isEnum(value: unknown): boolean {
    return this.toEnumValue(value) !== undefined;
  }

  protected toEnumValue(value: unknown): string | number | undefined {
    if (
      (typeof value === "string" || typeof value === "number") &&
      this.validValues.has(value)
    ) {
      return value;
    }

    if (
      typeof value === "string" &&
      this.numericValues.size > 0 &&
      STRICT_INT_REGEX.test(value)
    ) {
      const parsed = Number.parseInt(value, 10);
      if (this.numericValues.has(parsed)) {
        return parsed;
      }
    }

    return undefined;
  }

  protected getEnumValues(): (string | number)[] {
    if (this.cachedEnumValues) {
      return this.cachedEnumValues;
    }
    const values: (string | number)[] = [];
    for (const key of Object.keys(this.enumType)) {
      const val = this.enumType[key];
      if (val === undefined) continue;
      // Skip TypeScript reverse mappings generated for numeric enums (e.g. Enum["0"] = "A" where Enum["A"] === 0)
      if (
        typeof val === "string" &&
        typeof this.enumType[val] === "number" &&
        String(this.enumType[val]) === key
      ) {
        continue;
      }
      values.push(val);
    }
    this.cachedEnumValues = values;
    return values;
  }
}

export interface ParseDatePipeOptions extends ParsePipeOptions {
  /**
   * Fallback `Date` factory invoked when input is `null` or `undefined`.
   */
  default?: () => Date;
}

/**
 * Parses ISO date strings, numeric epoch timestamps, or `Date` instances into
 * validated `Date` objects (matching NestJS v11/v12 `ParseDatePipe`).
 */
export class ParseDatePipe implements PipeTransform<unknown, Date | undefined> {
  protected readonly options?: ParseDatePipeOptions;
  protected exceptionFactory: (error: string) => any;

  constructor(options?: ParseDatePipeOptions) {
    this.options = options;
    this.exceptionFactory = buildPipeExceptionFactory(options);
  }

  transform(value: unknown, _metadata?: ArgumentMetadata): Date | undefined {
    if (isNil(value)) {
      if (this.options?.default) {
        return this.options.default();
      }
      if (this.options?.optional) {
        return undefined;
      }
    }

    if (value instanceof Date) {
      if (!Number.isNaN(value.getTime())) {
        return new Date(value.getTime());
      }
      throw this.exceptionFactory("Validation failed (valid date is expected)");
    }

    if (typeof value === "number") {
      if (Number.isFinite(value)) {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) {
          return parsed;
        }
      }
      throw this.exceptionFactory("Validation failed (valid date is expected)");
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0 && !this.hasDayPastMonthEnd(trimmed)) {
        const parsed = new Date(trimmed);
        if (!Number.isNaN(parsed.getTime())) {
          return parsed;
        }
      }
    }

    throw this.exceptionFactory("Validation failed (valid date is expected)");
  }

  /**
   * Checks whether an ISO date string specifies a day past the end of its month
   * (e.g. `"2024-02-30"`), which `new Date()` silently rolls into the next month.
   */
  protected hasDayPastMonthEnd(value: string): boolean {
    const match = /^\s*([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(value);
    if (!match) {
      return false;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month < 1 || month > 12) {
      return true;
    }
    const isLeapYear =
      (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const daysInMonth =
      month === 2 && isLeapYear ? 29 : (DAYS_IN_MONTH[month - 1] ?? 31);
    return Number(match[3]) > daysInMonth;
  }
}

export class DefaultValuePipe<T = unknown, R = T>
  implements PipeTransform<T | null | undefined, T | R>
{
  protected readonly defaultValue: R;

  constructor(defaultValue: R) {
    this.defaultValue = defaultValue;
  }

  transform(value: T | null | undefined, _metadata?: ArgumentMetadata): T | R {
    if (
      value === undefined ||
      value === null ||
      (typeof value === "number" && Number.isNaN(value))
    ) {
      return this.copyDefaultValue(this.defaultValue);
    }
    return value;
  }

  /**
   * Deep-copies plain objects and arrays (preserving shared & circular references)
   * so mutating a default value in one request never leaks to subsequent requests.
   * Class instances, `Date`, `Map`, and primitives are returned as-is.
   */
  protected copyDefaultValue<V>(
    value: V,
    copies?: Map<unknown, unknown>,
  ): V {
    const isArray =
      Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
    if (!isArray && !isPlainObject(value)) {
      return value;
    }
    const seen = copies ?? new Map<unknown, unknown>();
    if (seen.has(value)) {
      return seen.get(value) as V;
    }
    const copy = Object.assign(
      isArray ? [] : Object.create(Object.getPrototypeOf(value)),
      value,
    ) as Record<PropertyKey, unknown>;
    seen.set(value, copy);
    for (const key of Reflect.ownKeys(copy)) {
      copy[key] = this.copyDefaultValue(copy[key], seen);
    }
    return copy as V;
  }
}

for (const pipeClass of [
  ParseIntPipe,
  ParseFloatPipe,
  ParseBoolPipe,
  ParseUUIDPipe,
  ParseArrayPipe,
  ParseEnumPipe,
  ParseDatePipe,
  DefaultValuePipe,
]) {
  MetadataRegistry.define(
    METADATA_KEYS.INJECTABLE,
    { scope: Scope.SINGLETON },
    pipeClass,
  );
}
