import type { ValidationOptions } from "../../interfaces/validation-options.interface";
import { buildMessage, createBuiltInDecorator } from "../core.decorators";

export const IS_UUID = "isUuid";
export const IS_MONGO_ID = "isMongoId";
export const IS_JWT = "isJwt";
export const IS_JSON = "isJson";
export const IS_SEM_VER = "isSemVer";
export const IS_STRONG_PASSWORD = "isStrongPassword";
export const IS_BOOLEAN_STRING = "isBooleanString";
export const IS_NUMBER_STRING = "isNumberString";
export const IS_DECIMAL = "isDecimal";
export const IS_OCTAL = "isOctal";
export const IS_HEXADECIMAL = "isHexadecimal";
export const IS_HASH = "isHash";
export const IS_HEX_COLOR = "isHexColor";
export const IS_RGB_COLOR = "isRgbColor";
export const IS_HSL = "isHSL";
export const IS_BASE32 = "isBase32";
export const IS_BASE58 = "isBase58";
export const IS_BASE64 = "isBase64";

export type UUIDVersion =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "all"
  | "nil"
  | "max";

export interface IsStrongPasswordOptions {
  minLength?: number;
  minLowercase?: number;
  minUppercase?: number;
  minNumbers?: number;
  minSymbols?: number;
}

export interface IsNumericOptions {
  no_symbols?: boolean;
  locale?: string;
}

export interface IsDecimalOptions {
  force_decimal?: boolean;
  decimal_digits?: string;
  locale?: string;
}

export interface IsBase32Options {
  crockford?: boolean;
}

export interface IsBase64Options {
  urlSafe?: boolean;
}

export type HashAlgorithm =
  | "md4"
  | "md5"
  | "sha1"
  | "sha256"
  | "sha384"
  | "sha512"
  | "ripemd128"
  | "ripemd160"
  | "tiger128"
  | "tiger160"
  | "tiger192"
  | "crc32"
  | "crc32b";

const UUID_REGEXES: Readonly<Record<string, RegExp>> = {
  "1": /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "2": /^[0-9a-f]{8}-[0-9a-f]{4}-2[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "3": /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "4": /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "5": /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "6": /^[0-9a-f]{8}-[0-9a-f]{4}-6[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "7": /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "8": /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  nil: /^0{8}-0{4}-0{4}-0{4}-0{12}$/,
  max: /^f{8}-f{4}-f{4}-f{4}-f{12}$/i,
  all: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
};

export function isUUID(value: unknown, version?: UUIDVersion): boolean {
  if (typeof value !== "string" || value.length !== 36) return false;
  const key = version !== undefined ? String(version) : "all";
  const pattern = UUID_REGEXES[key];
  return pattern !== undefined && pattern.test(value);
}

export function IsUUID(
  version?: UUIDVersion,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_UUID,
    (value) => isUUID(value, version),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a UUID`,
      validationOptions,
    ),
    [version],
    validationOptions,
  );
}

const MONGO_ID_RE = /^[0-9a-fA-F]{24}$/;

export function isMongoId(value: unknown): boolean {
  return typeof value === "string" && MONGO_ID_RE.test(value);
}

export function IsMongoId(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_MONGO_ID,
    isMongoId,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a mongodb id`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export function isJWT(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  return (
    parts[0]!.length > 0 &&
    parts[1]!.length > 0 &&
    BASE64URL_RE.test(parts[0]!) &&
    BASE64URL_RE.test(parts[1]!) &&
    (parts[2]!.length === 0 || BASE64URL_RE.test(parts[2]!))
  );
}

export function IsJWT(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_JWT,
    isJWT,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a jwt string`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isJSON(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object";
  } catch {
    return false;
  }
}

export function IsJSON(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_JSON,
    isJSON,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a json string`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

export function isSemVer(value: unknown): boolean {
  return (
    typeof value === "string" && value.length <= 256 && SEMVER_RE.test(value)
  );
}

export function IsSemVer(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_SEM_VER,
    isSemVer,
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must be a Semantic Versioning Specification`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isStrongPassword(
  value: unknown,
  options: IsStrongPasswordOptions = {},
): boolean {
  if (typeof value !== "string") return false;
  const minLength = options.minLength ?? 8;
  const minLowercase = options.minLowercase ?? 1;
  const minUppercase = options.minUppercase ?? 1;
  const minNumbers = options.minNumbers ?? 1;
  const minSymbols = options.minSymbols ?? 1;

  if (value.length < minLength) return false;

  let lower = 0;
  let upper = 0;
  let digits = 0;
  let symbols = 0;

  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 97 && c <= 122) lower++;
    else if (c >= 65 && c <= 90) upper++;
    else if (c >= 48 && c <= 57) digits++;
    else symbols++;
  }

  return (
    lower >= minLowercase &&
    upper >= minUppercase &&
    digits >= minNumbers &&
    symbols >= minSymbols
  );
}

export function IsStrongPassword(
  options?: IsStrongPasswordOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_STRONG_PASSWORD,
    (value) => isStrongPassword(value, options),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property is not strong enough`,
      validationOptions,
    ),
    [options],
    validationOptions,
  );
}

export function isBooleanString(value: unknown): boolean {
  return value === "true" || value === "false" || value === "1" || value === "0";
}

export function IsBooleanString(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_BOOLEAN_STRING,
    isBooleanString,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a boolean string`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

const NUMERIC_WITH_SYMBOLS_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
const NUMERIC_NO_SYMBOLS_RE = /^\d+$/;

export function isNumberString(
  value: unknown,
  options?: IsNumericOptions,
): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  return options?.no_symbols
    ? NUMERIC_NO_SYMBOLS_RE.test(value)
    : NUMERIC_WITH_SYMBOLS_RE.test(value);
}

export function IsNumberString(
  options?: IsNumericOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_NUMBER_STRING,
    (value) => isNumberString(value, options),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a number string`,
      validationOptions,
    ),
    [options],
    validationOptions,
  );
}

const COMMA_DECIMAL_LOCALES = new Set([
  "de-DE",
  "fr-FR",
  "es-ES",
  "it-IT",
  "nl-NL",
  "pt-BR",
  "pt-PT",
  "pl-PL",
  "ru-RU",
  "vi-VN",
  "tr-TR",
  "sv-SE",
  "da-DK",
  "fi-FI",
  "nb-NO",
  "cs-CZ",
  "hu-HU",
  "uk-UA",
  "ro-RO",
  "el-GR",
  "id-ID",
]);

export function isDecimal(
  value: unknown,
  options: IsDecimalOptions = {},
): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  const sep =
    options.locale && COMMA_DECIMAL_LOCALES.has(options.locale) ? "," : ".";
  const forceDecimal = options.force_decimal ?? false;
  const decimalDigits = options.decimal_digits ?? "1,";
  const escapedSep = sep === "." ? "\\." : sep;
  const re = forceDecimal
    ? new RegExp(`^[+-]?\\d*${escapedSep}\\d{${decimalDigits}}$`)
    : new RegExp(
        `^[+-]?(?:\\d+(?:${escapedSep}\\d{${decimalDigits}})?|${escapedSep}\\d{${decimalDigits}})$`,
      );
  return re.test(trimmed);
}

export function IsDecimal(
  options?: IsDecimalOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_DECIMAL,
    (value) => isDecimal(value, options),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property is not a valid decimal number.`,
      validationOptions,
    ),
    [options],
    validationOptions,
  );
}

const OCTAL_RE = /^(?:0o)?[0-7]+$/i;

export function isOctal(value: unknown): boolean {
  return typeof value === "string" && OCTAL_RE.test(value);
}

export function IsOctal(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_OCTAL,
    isOctal,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be valid octal number`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

const HEX_RE = /^(?:0x|0h)?[0-9a-f]+$/i;

export function isHexadecimal(value: unknown): boolean {
  return typeof value === "string" && HEX_RE.test(value);
}

export function IsHexadecimal(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_HEXADECIMAL,
    isHexadecimal,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a hexadecimal number`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

const HASH_LENGTHS: Readonly<Record<string, number>> = {
  md4: 32,
  md5: 32,
  sha1: 40,
  sha256: 64,
  sha384: 96,
  sha512: 128,
  ripemd128: 32,
  ripemd160: 40,
  tiger128: 32,
  tiger160: 40,
  tiger192: 48,
  crc32: 8,
  crc32b: 8,
};

export function isHash(value: unknown, algorithm: HashAlgorithm): boolean {
  if (typeof value !== "string") return false;
  const expectedLen = HASH_LENGTHS[algorithm];
  if (!expectedLen || value.length !== expectedLen) return false;
  for (let i = 0; i < expectedLen; i++) {
    const c = value.charCodeAt(i);
    const isHex =
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 70) ||
      (c >= 97 && c <= 102);
    if (!isHex) return false;
  }
  return true;
}

export function IsHash(
  algorithm: HashAlgorithm,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_HASH,
    (value) => isHash(value, algorithm),
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must be a hash of type $constraint1`,
      validationOptions,
    ),
    [algorithm],
    validationOptions,
  );
}

const HEX_COLOR_RE =
  /^#?(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isHexColor(value: unknown): boolean {
  return typeof value === "string" && HEX_COLOR_RE.test(value);
}

export function IsHexColor(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_HEX_COLOR,
    isHexColor,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a hexadecimal color`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

const RGB_INT_RE =
  /^rgb\((?:(?:0|[1-9]\d?|1\d\d?|2[0-4]\d|25[0-5]),){2}(?:0|[1-9]\d?|1\d\d?|2[0-4]\d|25[0-5])\)$/;
const RGBA_INT_RE =
  /^rgba\((?:(?:0|[1-9]\d?|1\d\d?|2[0-4]\d|25[0-5]),){3}(?:0?\.\d+|1(?:\.0+)?|0(?:\.0+)?)\)$/;
const RGB_PCT_RE =
  /^rgb\((?:(?:0|[1-9]\d?|100)%,){2}(?:0|[1-9]\d?|100)%\)$/;
const RGBA_PCT_RE =
  /^rgba\((?:(?:0|[1-9]\d?|100)%,){3}(?:0?\.\d+|1(?:\.0+)?|0(?:\.0+)?)\)$/;

export function isRgbColor(
  value: unknown,
  includePercentValues = true,
): boolean {
  if (typeof value !== "string" || value.length > 64) return false;
  if (RGB_INT_RE.test(value) || RGBA_INT_RE.test(value)) return true;
  if (includePercentValues) {
    return RGB_PCT_RE.test(value) || RGBA_PCT_RE.test(value);
  }
  return false;
}

export function IsRgbColor(
  includePercentValues?: boolean,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_RGB_COLOR,
    (value) => isRgbColor(value, includePercentValues),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be RGB color`,
      validationOptions,
    ),
    [includePercentValues],
    validationOptions,
  );
}

const HSL_COMMA_RE =
  /^hsla?\(\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:deg|rad|grad|turn)?\s*,\s*(?:\d+(?:\.\d+)?|\.\d+)%\s*,\s*(?:\d+(?:\.\d+)?|\.\d+)%(?:\s*,\s*(?:0?\.\d+|1(?:\.0+)?|0(?:\.0+)?|\d+(?:\.\d+)?%))?\s*\)$/i;
const HSL_SPACE_RE =
  /^hsla?\(\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:deg|rad|grad|turn)?\s+(?:\d+(?:\.\d+)?|\.\d+)%\s+(?:\d+(?:\.\d+)?|\.\d+)%(?:\s*\/\s*(?:0?\.\d+|1(?:\.0+)?|0(?:\.0+)?|\d+(?:\.\d+)?%))?\s*\)$/i;

export function isHSL(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 100) return false;
  return HSL_COMMA_RE.test(value) || HSL_SPACE_RE.test(value);
}

export function IsHSL(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_HSL,
    isHSL,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a HSL color`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

const BASE32_RFC_RE = /^[A-Z2-7]+=*$/;
const BASE32_CROCKFORD_RE = /^[0-9A-HJKMNP-TV-Z]+$/i;

export function isBase32(value: unknown, options?: IsBase32Options): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (options?.crockford) return BASE32_CROCKFORD_RE.test(value);
  return value.length % 8 === 0 && BASE32_RFC_RE.test(value);
}

export function IsBase32(
  options?: IsBase32Options,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_BASE32,
    (value) => isBase32(value, options),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be base32 encoded`,
      validationOptions,
    ),
    [options],
    validationOptions,
  );
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function isBase58(value: unknown): boolean {
  return typeof value === "string" && BASE58_RE.test(value);
}

export function IsBase58(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_BASE58,
    isBase58,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be base58 encoded`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

const BASE64_STD_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64_URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

export function isBase64(value: unknown, options?: IsBase64Options): boolean {
  if (typeof value !== "string") return false;
  if (options?.urlSafe) return value.length > 0 && BASE64_URL_RE.test(value);
  if (value.length === 0) return true;
  if (value.length % 4 !== 0) return false;
  const firstPad = value.indexOf("=");
  if (firstPad !== -1 && firstPad < value.length - 2) return false;
  return BASE64_STD_RE.test(value);
}

export function IsBase64(
  options?: IsBase64Options,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_BASE64,
    (value) => isBase64(value, options),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be base64 encoded`,
      validationOptions,
    ),
    [options],
    validationOptions,
  );
}
