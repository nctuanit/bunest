import type { ValidationOptions } from "../../interfaces/validation-options.interface";
import { buildMessage, createBuiltInDecorator } from "../core.decorators";

export const IS_FIREBASE_PUSH_ID = "IsFirebasePushId";
export const IS_ETHEREUM_ADDRESS = "isEthereumAddress";
export const IS_BTC_ADDRESS = "isBtcAddress";
export const IS_CREDIT_CARD = "isCreditCard";
export const IS_IBAN = "isIBAN";
export const IS_BIC = "isBIC";
export const IS_ISBN = "isIsbn";
export const IS_ISSN = "isISSN";
export const IS_EAN = "isEAN";
export const IS_ISIN = "isIsin";
export const IS_ISRC = "isISRC";
export const IS_CURRENCY = "isCurrency";

export type IsISBNVersion = "10" | "13" | 10 | 13;

export interface IsISSNOptions {
  case_sensitive?: boolean;
  require_hyphen?: boolean;
}

export interface IsCurrencyOptions {
  symbol?: string;
  require_symbol?: boolean;
  allow_space_after_symbol?: boolean;
  symbol_after_digits?: boolean;
  allow_negatives?: boolean;
  parens_for_negatives?: boolean;
  negative_sign_before_digits?: boolean;
  negative_sign_after_digits?: boolean;
  allow_negative_sign_placeholder?: boolean;
  thousands_separator?: string;
  decimal_separator?: string;
  allow_decimal?: boolean;
  require_decimal?: boolean;
  digits_after_decimal?: number[];
  allow_space_after_digits?: boolean;
}

const FIREBASE_PUSH_ID_RE = /^[a-zA-Z0-9_-]{20}$/;

export function isFirebasePushId(value: unknown): boolean {
  return typeof value === "string" && FIREBASE_PUSH_ID_RE.test(value);
}

export function IsFirebasePushId(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_FIREBASE_PUSH_ID,
    isFirebasePushId,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a Firebase Push Id`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function isEthereumAddress(value: unknown): boolean {
  return typeof value === "string" && ETH_ADDR_RE.test(value);
}

export function IsEthereumAddress(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_ETHEREUM_ADDRESS,
    isEthereumAddress,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be an Ethereum address`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

const BTC_BASE58_RE = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;
const BTC_BECH32_RE = /^(?:bc1|tb1)[02-9ac-hj-np-z]{7,87}$/;

export function isBtcAddress(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return BTC_BASE58_RE.test(value) || BTC_BECH32_RE.test(value);
}

export function IsBtcAddress(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_BTC_ADDRESS,
    isBtcAddress,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a BTC address`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

function luhnCheck(digits: string): boolean {
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return false;
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

const CREDIT_CARD_PREFIX_RE =
  /^(?:4[0-9]{12}(?:[0-9]{3,6})?|5[1-5][0-9]{14}|2(?:2[2-9][0-9]|2[3-9][0-9]{2}|[3-6][0-9]{3}|7[01][0-9]{2}|720)[0-9]{12}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2}|4[4-9][0-9])[0-9]{12}|(?:2131|1800|35\d{3})\d{11}|62[0-9]{14,17})$/;

export function isCreditCard(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 32) return false;
  const sanitized = value.replace(/[- ]+/g, "");
  if (sanitized.length < 13 || sanitized.length > 19) return false;
  if (!CREDIT_CARD_PREFIX_RE.test(sanitized)) return false;
  return luhnCheck(sanitized);
}

export function IsCreditCard(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_CREDIT_CARD,
    isCreditCard,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a credit card`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22,
  BI: 27, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27,
  DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27,
  GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22,
  IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32,
  LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19,
  MR: 27, MT: 31, MU: 30, MZ: 25, NI: 28, NL: 18, NO: 15, PK: 24, PL: 28,
  PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24, SC: 31, SD: 18,
  SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23, TN: 24,
  TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};

export function isIBAN(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 50) return false;
  const cleaned = value.replace(/[\s-]+/g, "").toUpperCase();
  if (cleaned.length < 15 || cleaned.length > 34) return false;
  const country = cleaned.slice(0, 2);
  const expectedLen = IBAN_LENGTHS[country];
  if (!expectedLen || cleaned.length !== expectedLen) return false;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(cleaned)) return false;

  const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);
  let remainder = 0;
  for (let i = 0; i < rearranged.length; i++) {
    const code = rearranged.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      remainder = (remainder * 10 + (code - 48)) % 97;
    } else if (code >= 65 && code <= 90) {
      remainder = (remainder * 100 + (code - 55)) % 97;
    } else {
      return false;
    }
  }
  return remainder === 1;
}

export function IsIBAN(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_IBAN,
    isIBAN,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be an IBAN`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

const BIC_RE = /^[A-Za-z]{6}[A-Za-z0-9]{2}(?:[A-Za-z0-9]{3})?$/;

export function isBIC(value: unknown): boolean {
  return typeof value === "string" && BIC_RE.test(value);
}

export function IsBIC(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_BIC,
    isBIC,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a BIC or SWIFT code`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

function isISBN10(sanitized: string): boolean {
  if (!/^\d{9}[\dX]$/.test(sanitized)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += (i + 1) * (sanitized.charCodeAt(i) - 48);
  }
  sum += sanitized[9] === "X" ? 100 : 10 * (sanitized.charCodeAt(9) - 48);
  return sum % 11 === 0;
}

function isISBN13(sanitized: string): boolean {
  if (!/^(?:978|979)\d{10}$/.test(sanitized)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = sanitized.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? d : d * 3;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === sanitized.charCodeAt(12) - 48;
}

export function isISBN(value: unknown, version?: IsISBNVersion): boolean {
  if (typeof value !== "string" || value.length > 25) return false;
  const sanitized = value.replace(/[\s-]+/g, "").toUpperCase();
  const v = version !== undefined ? String(version) : "";
  if (v === "10") return isISBN10(sanitized);
  if (v === "13") return isISBN13(sanitized);
  return isISBN10(sanitized) || isISBN13(sanitized);
}

export function IsISBN(
  version?: IsISBNVersion,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_ISBN,
    (value) => isISBN(value, version),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be an ISBN`,
      validationOptions,
    ),
    [version],
    validationOptions,
  );
}

export function isISSN(value: unknown, options: IsISSNOptions = {}): boolean {
  if (typeof value !== "string" || value.length > 9) return false;
  const requireHyphen = options.require_hyphen ?? false;
  const caseSensitive = options.case_sensitive ?? false;
  const re = requireHyphen
    ? caseSensitive
      ? /^\d{4}-\d{3}[\dX]$/
      : /^\d{4}-\d{3}[\dXx]$/
    : caseSensitive
      ? /^\d{4}-?\d{3}[\dX]$/
      : /^\d{4}-?\d{3}[\dXx]$/;
  if (!re.test(value)) return false;
  const digits = value.replace("-", "").toUpperCase();
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const d = digits[i] === "X" ? 10 : digits.charCodeAt(i) - 48;
    sum += d * (8 - i);
  }
  return sum % 11 === 0;
}

export function IsISSN(
  options?: IsISSNOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_ISSN,
    (value) => isISSN(value, options),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a ISSN`,
      validationOptions,
    ),
    [options],
    validationOptions,
  );
}

export function isEAN(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const len = value.length;
  if (len !== 8 && len !== 13 && len !== 14) return false;
  if (!/^\d+$/.test(value)) return false;

  let sum = 0;
  for (let i = 0; i < len - 1; i++) {
    const d = value.charCodeAt(i) - 48;
    const weight = len === 13 ? (i % 2 === 0 ? 1 : 3) : i % 2 === 0 ? 3 : 1;
    sum += d * weight;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === value.charCodeAt(len - 1) - 48;
}

export function IsEAN(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_EAN,
    isEAN,
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must be an EAN (European Article Number)`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

export function isISIN(value: unknown): boolean {
  if (
    typeof value !== "string" ||
    value.length !== 12 ||
    !ISIN_RE.test(value)
  ) {
    return false;
  }
  let expanded = "";
  for (let i = 0; i < 12; i++) {
    const code = value.charCodeAt(i);
    expanded += code >= 65 && code <= 90 ? String(code - 55) : value[i]!;
  }
  return luhnCheck(expanded);
}

export function IsISIN(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_ISIN,
    isISIN,
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must be an ISIN (stock/security identifier)`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

const ISRC_RE = /^[A-Z]{2}[0-9A-Z]{3}\d{2}\d{5}$/;

export function isISRC(value: unknown): boolean {
  return typeof value === "string" && ISRC_RE.test(value);
}

export function IsISRC(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_ISRC,
    isISRC,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be an ISRC`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

function escapeRegExpLiteral(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isCurrency(
  value: unknown,
  options: IsCurrencyOptions = {},
): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    return false;
  }
  const symbol = escapeRegExpLiteral(options.symbol ?? "$");
  const requireSymbol = options.require_symbol ?? false;
  const allowSpaceAfterSymbol = options.allow_space_after_symbol ?? false;
  const symbolAfterDigits = options.symbol_after_digits ?? false;
  const allowNegatives = options.allow_negatives ?? true;
  const parensForNegatives = options.parens_for_negatives ?? false;
  const negativeBefore = options.negative_sign_before_digits ?? false;
  const negativeAfter = options.negative_sign_after_digits ?? false;
  const allowNegativePlaceholder =
    options.allow_negative_sign_placeholder ?? false;
  const thousandsSep = escapeRegExpLiteral(options.thousands_separator ?? ",");
  const decimalSep = escapeRegExpLiteral(options.decimal_separator ?? ".");
  const allowDecimal = options.allow_decimal ?? true;
  const requireDecimal = options.require_decimal ?? false;
  const digitsAfterDecimal = options.digits_after_decimal ?? [2];
  const allowSpaceAfterDigits = options.allow_space_after_digits ?? false;

  const symPart = `(?:${symbol})${requireSymbol ? "" : "?"}`;
  const spaceAfterSym = allowSpaceAfterSymbol ? " ?" : "";
  const wholeDigits = `(?:[1-9]\\d{0,2}(?:${thousandsSep}\\d{3})*|0|[1-9]\\d*)`;
  const decLengths = digitsAfterDecimal.map((d) => `\\d{${d}}`).join("|");
  const decimalPart = allowDecimal
    ? `(?:${decimalSep}(?:${decLengths}))${requireDecimal ? "" : "?"}`
    : "";
  const amount = `(?:${wholeDigits}${decimalPart}|${decimalSep}(?:${decLengths}))`;

  const body = symbolAfterDigits
    ? `${amount}${allowSpaceAfterDigits ? " ?" : ""}${symPart}`
    : `${symPart}${spaceAfterSym}${amount}`;

  let negPrefix = "";
  let negSuffix = "";
  if (allowNegatives) {
    if (parensForNegatives) {
      return (
        new RegExp(`^\\(${body}\\)$`).test(value) ||
        new RegExp(`^${body}$`).test(value)
      );
    }
    const negOpt = allowNegativePlaceholder ? "[- ]?" : "-?";
    if (negativeBefore) negPrefix = negOpt;
    else if (negativeAfter) negSuffix = negOpt;
    else negPrefix = negOpt;
  }

  return new RegExp(`^${negPrefix}${body}${negSuffix}$`).test(value);
}

export function IsCurrency(
  options?: IsCurrencyOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_CURRENCY,
    (value) => isCurrency(value, options),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a currency`,
      validationOptions,
    ),
    [options],
    validationOptions,
  );
}
