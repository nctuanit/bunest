import { METADATA_KEYS } from "../constants/metadata-keys";
import { HttpStatus, Scope } from "../enums/scope.enum";
import { HttpException } from "../exceptions/http.exception";
import type {
  ArgumentMetadata,
  PipeTransform,
} from "../interfaces/http.interface";
import type { Type } from "../interfaces/type.interface";
import { MetadataRegistry } from "../metadata/metadata-registry";
import {
  isNullish as isNil,
  isPlainObject,
} from "../utils/type-guards.util";
import {
  OMITTED_ERRORS_MESSAGE,
  resolveMaxErrorMessagesLength,
} from "./validation-errors.constants";
import { createStatusHttpException } from "./validation-http.util";
import { ValidationPipe, type ValidationPipeOptions } from "./validation.pipe";

export interface ParsePipeOptions {
  errorHttpStatusCode?: number;
  exceptionFactory?: (error: string) => unknown;
  optional?: boolean;
}

export interface ParseIntPipeOptions extends ParsePipeOptions {
  /**
   * Optional inclusive lower bound for the parsed integer.
   */
  min?: number;
  /**
   * Optional inclusive upper bound for the parsed integer.
   */
  max?: number;
}

export interface ParseFloatPipeOptions extends ParsePipeOptions {
  /**
   * Optional inclusive lower bound for the parsed number.
   */
  min?: number;
  /**
   * Optional inclusive upper bound for the parsed number.
   */
  max?: number;
}
export type ParseBoolPipeOptions = ParsePipeOptions;
export type ParseEnumPipeOptions = ParsePipeOptions;
export type UUIDVersion =
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "all"
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8;

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
  [HttpStatus.LOCKED]: "Locked",
  [HttpStatus.FAILED_DEPENDENCY]: "Failed Dependency",
  [HttpStatus.TOO_EARLY]: "Too Early",
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
): (error: string | string[]) => unknown {
  if (options?.exceptionFactory) {
    return options.exceptionFactory as (error: string | string[]) => unknown;
  }
  const status = options?.errorHttpStatusCode ?? HttpStatus.BAD_REQUEST;
  const errorLabel = HTTP_STATUS_REASON_PHRASES[status] ?? "Http Exception";
  return (message: string | string[]) =>
    createStatusHttpException(
      HttpException.createBody(message, errorLabel, status) as Record<
        string,
        unknown
      >,
      status,
    );
}

const STRICT_INT_REGEX = /^[+-]?\d+$/;
const STRICT_FLOAT_REGEX = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const UUID_REGEX: Record<string, RegExp> = {
  "1": /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "2": /^[0-9a-f]{8}-[0-9a-f]{4}-2[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "3": /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "4": /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "5": /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "6": /^[0-9a-f]{8}-[0-9a-f]{4}-6[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "7": /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "8": /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  all: /^(?:00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
};

export class ParseIntPipe implements PipeTransform<
  unknown,
  Promise<number | undefined>
> {
  protected readonly options?: ParseIntPipeOptions;
  protected exceptionFactory: (error: string) => unknown;

  constructor(options?: ParseIntPipeOptions) {
    this.options = options;
    this.exceptionFactory = buildPipeExceptionFactory(options);
  }

  async transform(
    value: unknown,
    _metadata?: ArgumentMetadata,
  ): Promise<number | undefined> {
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
    const result = parsed === 0 ? 0 : parsed;
    if (this.options?.min !== undefined && result < this.options.min) {
      throw this.exceptionFactory(
        `Validation failed (numeric integer must not be less than ${this.options.min})`,
      );
    }
    if (this.options?.max !== undefined && result > this.options.max) {
      throw this.exceptionFactory(
        `Validation failed (numeric integer must not be greater than ${this.options.max})`,
      );
    }
    return result;
  }

  protected isNumeric(value: unknown): boolean {
    if (typeof value === "number") {
      return Number.isSafeInteger(value);
    }
    return typeof value === "string" && STRICT_INT_REGEX.test(value);
  }
}

export class ParseFloatPipe implements PipeTransform<
  unknown,
  Promise<number | undefined>
> {
  protected readonly options?: ParseFloatPipeOptions;
  protected exceptionFactory: (error: string) => unknown;

  constructor(options?: ParseFloatPipeOptions) {
    this.options = options;
    this.exceptionFactory = buildPipeExceptionFactory(options);
  }

  async transform(
    value: unknown,
    _metadata?: ArgumentMetadata,
  ): Promise<number | undefined> {
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
    const result = parsed === 0 ? 0 : parsed;
    if (this.options?.min !== undefined && result < this.options.min) {
      throw this.exceptionFactory(
        `Validation failed (numeric value must not be less than ${this.options.min})`,
      );
    }
    if (this.options?.max !== undefined && result > this.options.max) {
      throw this.exceptionFactory(
        `Validation failed (numeric value must not be greater than ${this.options.max})`,
      );
    }
    return result;
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
export class ParseBoolPipe implements PipeTransform<
  unknown,
  Promise<boolean | undefined>
> {
  protected readonly options?: ParseBoolPipeOptions;
  protected exceptionFactory: (error: string) => unknown;

  constructor(options?: ParseBoolPipeOptions) {
    this.options = options;
    this.exceptionFactory = buildPipeExceptionFactory(options);
  }

  async transform(
    value: unknown,
    _metadata?: ArgumentMetadata,
  ): Promise<boolean | undefined> {
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

export class ParseUUIDPipe implements PipeTransform<
  unknown,
  Promise<string | undefined>
> {
  protected static uuidRegExps: Record<string, RegExp> = UUID_REGEX;

  protected readonly options?: ParseUUIDPipeOptions;
  protected exceptionFactory: (errors: string) => unknown;
  private readonly version: string;

  constructor(options?: ParseUUIDPipeOptions) {
    this.options = options;
    this.version =
      options?.version !== undefined ? String(options.version) : "all";
    this.exceptionFactory = buildPipeExceptionFactory(options);
  }

  async transform(
    value: unknown,
    _metadata?: ArgumentMetadata,
  ): Promise<string | undefined> {
    if (isNil(value) && this.options?.optional) {
      return undefined;
    }

    if (this.isUUID(value, this.version as UUIDVersion)) {
      return value as string;
    }

    const versionMsg =
      this.version === "all" ? "uuid" : `uuid v ${this.version}`;
    throw this.exceptionFactory(
      `Validation failed (${versionMsg} is expected)`,
    );
  }

  protected isUUID(str: unknown, version: UUIDVersion = "all"): boolean {
    if (typeof str !== "string") {
      return false;
    }
    const pattern = ParseUUIDPipe.uuidRegExps[String(version)];
    return Boolean(pattern && pattern.test(str));
  }
}

export interface ParseArrayPipeOptions extends Omit<
  ValidationPipeOptions,
  "transform" | "validateCustomDecorators" | "exceptionFactory"
> {
  items?: Type<unknown> | typeof Number | typeof Boolean | typeof String;
  separator?: string;
  optional?: boolean;
  itemPipe?: PipeTransform;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exceptionFactory?: (error: any) => unknown;
}

export type ParseArrayOptions = ParseArrayPipeOptions;

export class ParseArrayPipe implements PipeTransform<
  unknown,
  Promise<unknown[] | undefined>
> {
  protected readonly options: ParseArrayPipeOptions;
  protected readonly validationPipe: ValidationPipe;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected exceptionFactory: (error: any) => unknown;
  private readonly separator: string;
  private readonly stopAtFirstError: boolean;
  private readonly maxErrorMessagesLength: number;

  constructor(options: ParseArrayPipeOptions = {}) {
    this.options = options;
    this.separator = options.separator ?? ",";
    this.stopAtFirstError = options.stopAtFirstError ?? true;
    const hasCustomFactory = typeof options.exceptionFactory === "function";
    this.maxErrorMessagesLength = hasCustomFactory
      ? Infinity
      : resolveMaxErrorMessagesLength(options.maxErrorMessagesLength);

    const status = options.errorHttpStatusCode ?? HttpStatus.BAD_REQUEST;
    const errorLabel = HTTP_STATUS_REASON_PHRASES[status] ?? "Bad Request";
    this.exceptionFactory =
      options.exceptionFactory ??
      ((error: string | string[]) =>
        createStatusHttpException(
          HttpException.createBody(error, errorLabel, status) as Record<
            string,
            unknown
          >,
          status,
        ));

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
      errorFormat: options.errorFormat ?? "list",
      ...(options.exceptionFactory
        ? { exceptionFactory: options.exceptionFactory }
        : {}),
    });
  }

  async transform(
    value: unknown,
    metadata?: ArgumentMetadata,
  ): Promise<unknown[] | undefined> {
    if (isNil(value) && this.options.optional) {
      return undefined;
    }

    const fromString = typeof value === "string";
    let rawItems: unknown[];
    if (Array.isArray(value)) {
      rawItems = value;
    } else if (fromString) {
      rawItems = (value as string).split(this.separator);
    } else {
      throw this.exceptionFactory(
        "Validation failed (parsable array expected)",
      );
    }

    const itemType = this.options.items;
    const itemPipe = this.options.itemPipe;
    const isPrimitiveItem = this.isExpectedTypePrimitive();
    const result: unknown[] = [];

    // Collect only populated entries so sparse arrays (even with huge length)
    // are traversed in O(populated items) and gaps are closed.
    const entries: Array<[number, unknown]> = [];
    for (const key of Object.keys(rawItems)) {
      const idx = Number(key);
      if (Number.isInteger(idx) && idx >= 0 && String(idx) === key) {
        entries.push([idx, rawItems[idx]]);
      }
    }

    if (this.stopAtFirstError) {
      for (const [index, item] of entries) {
        const transformed = await this.transformItem(
          item,
          index,
          fromString,
          isPrimitiveItem,
          itemType,
          itemPipe,
          metadata,
        );
        result.push(transformed);
      }
      return result;
    }

    const collectedErrors: string[] = [];
    let collectedLength = 0;
    let omitted = false;

    for (const [index, item] of entries) {
      try {
        const transformed = await this.transformItem(
          item,
          index,
          fromString,
          isPrimitiveItem,
          itemType,
          itemPipe,
          metadata,
        );
        if (collectedErrors.length === 0) {
          result.push(transformed);
        }
      } catch (err) {
        if (!(err instanceof HttpException)) {
          throw err;
        }
        const itemMessages = this.extractItemErrorMessages(err, index);
        if (itemMessages.length === 0) {
          continue;
        }
        if (collectedLength >= this.maxErrorMessagesLength) {
          collectedErrors.push(OMITTED_ERRORS_MESSAGE);
          omitted = true;
          break;
        }
        for (const msg of itemMessages) {
          collectedErrors.push(msg);
          collectedLength += msg.length;
        }
      }
    }

    if (collectedErrors.length > 0 || omitted) {
      throw this.exceptionFactory(collectedErrors);
    }

    return result;
  }

  private async transformItem(
    item: unknown,
    index: number,
    fromString: boolean,
    isPrimitiveItem: boolean,
    itemType: ParseArrayPipeOptions["items"],
    itemPipe: PipeTransform | undefined,
    metadata?: ArgumentMetadata,
  ): Promise<unknown> {
    let transformed: unknown = item;

    if (isPrimitiveItem) {
      transformed = this.validatePrimitive(item, index);
    } else if (itemType) {
      let candidate: unknown = item;
      if (fromString && typeof candidate === "string") {
        try {
          candidate = JSON.parse(candidate);
        } catch {
          throw this.exceptionFactory([
            "Validation failed (object is expected)",
          ]);
        }
      }
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        Array.isArray(candidate)
      ) {
        throw this.exceptionFactory(["Validation failed (object is expected)"]);
      }
      transformed = await this.validationPipe.transform(candidate, {
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

    return transformed;
  }

  private extractItemErrorMessages(
    err: HttpException,
    index: number,
  ): string[] {
    const response = err.getResponse();
    const rawMessage =
      typeof response === "string"
        ? response
        : (response as Record<string, unknown>)?.message;
    const prefix = `[${index}] `;

    const prefixMessage = (msg: string): string =>
      msg.startsWith(prefix) ? msg : `${prefix}${msg}`;

    if (typeof rawMessage === "string") {
      return [prefixMessage(rawMessage)];
    }

    if (Array.isArray(rawMessage)) {
      const out: string[] = [];
      for (const entry of rawMessage) {
        if (typeof entry === "string") {
          out.push(prefixMessage(entry));
        }
      }
      return out;
    }

    if (rawMessage && typeof rawMessage === "object") {
      const out: string[] = [];
      for (const [field, value] of Object.entries(
        rawMessage as Record<string, unknown>,
      )) {
        const list = Array.isArray(value) ? value : [value];
        for (const item of list) {
          if (typeof item !== "string") continue;
          if (field === "..." || item === OMITTED_ERRORS_MESSAGE) {
            out.push(prefixMessage(item));
          } else {
            out.push(`${prefix}${field}: ${item}`);
          }
        }
      }
      return out;
    }

    return [prefixMessage(err.message)];
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

  protected validatePrimitive(originalValue: unknown, index = 0): unknown {
    const itemType = this.options.items;
    if (itemType === Number) {
      if (this.isNumeric(originalValue)) {
        const num =
          typeof originalValue === "number"
            ? originalValue
            : Number(String(originalValue).trim());
        if (Number.isFinite(num)) {
          return num === 0 ? 0 : num;
        }
      }
      throw this.exceptionFactory(`[${index}] item must be a number`);
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
      throw this.exceptionFactory(`[${index}] item must be a boolean value`);
    }

    if (itemType === String) {
      if (
        typeof originalValue === "string" ||
        typeof originalValue === "number" ||
        typeof originalValue === "boolean"
      ) {
        return String(originalValue);
      }
      throw this.exceptionFactory(`[${index}] item must be a string`);
    }

    return originalValue;
  }
}

export class ParseEnumPipe<
  TEnum extends Record<string, string | number> = Record<
    string,
    string | number
  >,
> implements PipeTransform<unknown, Promise<TEnum[keyof TEnum] | undefined>> {
  protected readonly enumType: TEnum;
  protected readonly options?: ParseEnumPipeOptions;
  protected exceptionFactory: (error: string) => unknown;
  private cachedEnumValues?: (string | number)[];
  private validValues?: ReadonlySet<string | number>;
  private numericValues?: ReadonlySet<number>;

  constructor(enumType: TEnum, options?: ParseEnumPipeOptions) {
    if (!enumType && !options?.optional) {
      throw new Error(
        `"ParseEnumPipe" requires "enumType" argument specified (to validate input values).`,
      );
    }
    this.enumType = enumType;
    this.options = options;
    this.exceptionFactory = buildPipeExceptionFactory(options);
  }

  private ensureEnumSets(): {
    validValues: ReadonlySet<string | number>;
    numericValues: ReadonlySet<number>;
  } {
    if (!this.validValues || !this.numericValues) {
      const values = this.enumType ? this.getEnumValues() : [];
      this.validValues = new Set(values);
      this.numericValues = new Set(
        values.filter((v): v is number => typeof v === "number"),
      );
    }
    return {
      validValues: this.validValues,
      numericValues: this.numericValues,
    };
  }

  async transform(
    value: unknown,
    _metadata?: ArgumentMetadata,
  ): Promise<TEnum[keyof TEnum] | undefined> {
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
    const { validValues, numericValues } = this.ensureEnumSets();
    if (
      (typeof value === "string" || typeof value === "number") &&
      validValues.has(value)
    ) {
      return value;
    }

    if (
      typeof value === "string" &&
      numericValues.size > 0 &&
      value.length > 0
    ) {
      const parsed = Number(value);
      if (
        Number.isFinite(parsed) &&
        String(parsed) === value &&
        numericValues.has(parsed)
      ) {
        return parsed;
      }
    }

    return undefined;
  }

  protected computeEnumValues(): (string | number)[] {
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
    return values;
  }

  protected getEnumValues(): (string | number)[] {
    if (this.cachedEnumValues) {
      return this.cachedEnumValues;
    }
    this.cachedEnumValues = this.computeEnumValues();
    return this.cachedEnumValues;
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
  protected exceptionFactory: (error: string) => unknown;

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
    const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const daysInMonth =
      month === 2 && isLeapYear ? 29 : (DAYS_IN_MONTH[month - 1] ?? 31);
    return Number(match[3]) > daysInMonth;
  }
}

export class DefaultValuePipe<T = unknown, R = T> implements PipeTransform<
  T | null | undefined,
  T | R
> {
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
  protected copyDefaultValue<V>(value: V, copies?: Map<unknown, unknown>): V {
    const isArray =
      Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
    if (!isArray && !isPlainObject(value)) {
      return value;
    }
    const seen = copies ?? new Map<unknown, unknown>();
    if (seen.has(value)) {
      return seen.get(value) as V;
    }
    if (isArray) {
      const arrCopy = new Array((value as unknown[]).length) as unknown[];
      seen.set(value, arrCopy);
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (!desc) continue;
        if ("value" in desc) {
          Object.defineProperty(arrCopy, key, {
            ...desc,
            value: this.copyDefaultValue(desc.value, seen),
          });
        } else {
          Object.defineProperty(arrCopy, key, desc);
        }
      }
      return arrCopy as unknown as V;
    }
    const objCopy = Object.create(
      Object.getPrototypeOf(value),
    ) as Record<PropertyKey, unknown>;
    seen.set(value, objCopy);
    for (const key of Reflect.ownKeys(value)) {
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc) continue;
      if ("value" in desc) {
        Object.defineProperty(objCopy, key, {
          ...desc,
          value: this.copyDefaultValue(desc.value, seen),
        });
      } else {
        Object.defineProperty(objCopy, key, desc);
      }
    }
    return objCopy as V;
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

for (const optionalPipeClass of [
  ParseIntPipe,
  ParseFloatPipe,
  ParseBoolPipe,
  ParseUUIDPipe,
  ParseArrayPipe,
  ParseDatePipe,
]) {
  MetadataRegistry.define(METADATA_KEYS.OPTIONAL_DEPS, [0], optionalPipeClass);
}
