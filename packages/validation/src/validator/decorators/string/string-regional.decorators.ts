import type { ValidationOptions } from "../../interfaces/validation-options.interface";
import { buildMessage, createBuiltInDecorator } from "../core.decorators";

export const IS_ISO31661_ALPHA_2 = "isISO31661Alpha2";
export const IS_ISO31661_ALPHA_3 = "isISO31661Alpha3";
export const IS_ISO4217_CURRENCY_CODE = "isISO4217CurrencyCode";
export const IS_PHONE_NUMBER = "isPhoneNumber";
export const IS_MOBILE_PHONE = "isMobilePhone";
export const IS_POSTAL_CODE = "isPostalCode";
export const IS_IDENTITY_CARD = "isIdentityCard";
export const IS_PASSPORT_NUMBER = "isPassportNumber";
export const IS_TAX_ID = "isTaxId";

export interface IsMobilePhoneOptions {
  strictMode?: boolean;
}

export type PhoneNumberValidatorFn = (value: string, region?: string) => boolean;

const PHONE_VALIDATOR_HOOK_SYMBOL = Symbol.for(
  "bunest:class-validator:phone_validator_hook",
);

export function registerPhoneNumberValidator(
  validatorFn: PhoneNumberValidatorFn | undefined,
): void {
  (globalThis as Record<PropertyKey, unknown>)[PHONE_VALIDATOR_HOOK_SYMBOL] =
    validatorFn;
}

function getRegisteredPhoneValidator(): PhoneNumberValidatorFn | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[
    PHONE_VALIDATOR_HOOK_SYMBOL
  ] as PhoneNumberValidatorFn | undefined;
}

const ISO31661_ALPHA_2 = new Set<string>([
  "AD","AE","AF","AG","AI","AL","AM","AO","AQ","AR","AS","AT","AU","AW","AX","AZ",
  "BA","BB","BD","BE","BF","BG","BH","BI","BJ","BL","BM","BN","BO","BQ","BR","BS",
  "BT","BV","BW","BY","BZ","CA","CC","CD","CF","CG","CH","CI","CK","CL","CM","CN",
  "CO","CR","CU","CV","CW","CX","CY","CZ","DE","DJ","DK","DM","DO","DZ","EC","EE",
  "EG","EH","ER","ES","ET","FI","FJ","FK","FM","FO","FR","GA","GB","GD","GE","GF",
  "GG","GH","GI","GL","GM","GN","GP","GQ","GR","GS","GT","GU","GW","GY","HK","HM",
  "HN","HR","HT","HU","ID","IE","IL","IM","IN","IO","IQ","IR","IS","IT","JE","JM",
  "JO","JP","KE","KG","KH","KI","KM","KN","KP","KR","KW","KY","KZ","LA","LB","LC",
  "LI","LK","LR","LS","LT","LU","LV","LY","MA","MC","MD","ME","MF","MG","MH","MK",
  "ML","MM","MN","MO","MP","MQ","MR","MS","MT","MU","MV","MW","MX","MY","MZ","NA",
  "NC","NE","NF","NG","NI","NL","NO","NP","NR","NU","NZ","OM","PA","PE","PF","PG",
  "PH","PK","PL","PM","PN","PR","PS","PT","PW","PY","QA","RE","RO","RS","RU","RW",
  "SA","SB","SC","SD","SE","SG","SH","SI","SJ","SK","SL","SM","SN","SO","SR","SS",
  "ST","SV","SX","SY","SZ","TC","TD","TF","TG","TH","TJ","TK","TL","TM","TN","TO",
  "TR","TT","TV","TW","TZ","UA","UG","UM","US","UY","UZ","VA","VC","VE","VG","VI",
  "VN","VU","WF","WS","YE","YT","ZA","ZM","ZW",
]);

const ISO31661_ALPHA_3 = new Set<string>([
  "ABW","AFG","AGO","AIA","ALA","ALB","AND","ARE","ARG","ARM","ASM","ATA","ATF","ATG",
  "AUS","AUT","AZE","BDI","BEL","BEN","BES","BFA","BGD","BGR","BHR","BHS","BIH","BLM",
  "BLR","BLZ","BMU","BOL","BRA","BRB","BRN","BTN","BVT","BWA","CAF","CAN","CCK","CHE",
  "CHL","CHN","CIV","CMR","COD","COG","COK","COL","COM","CPV","CRI","CUB","CUW","CXR",
  "CYM","CYP","CZE","DEU","DJI","DMA","DNK","DOM","DZA","ECU","EGY","ERI","ESH","ESP",
  "EST","ETH","FIN","FJI","FLK","FRA","FRO","FSM","GAB","GBR","GEO","GGY","GHA","GIB",
  "GIN","GLP","GMB","GNB","GNQ","GRC","GRD","GRL","GTM","GUF","GUM","GUY","HKG","HMD",
  "HND","HRV","HTI","HUN","IDN","IMN","IND","IOT","IRL","IRN","IRQ","ISL","ISR","ITA",
  "JAM","JEY","JOR","JPN","KAZ","KEN","KGZ","KHM","KIR","KNA","KOR","KWT","LAO","LBN",
  "LBR","LBY","LCA","LIE","LKA","LSO","LTU","LUX","LVA","MAC","MAF","MAR","MCO","MDA",
  "MDG","MDV","MEX","MHL","MKD","MLI","MLT","MMR","MNE","MNG","MNP","MOZ","MRT","MSR",
  "MTQ","MUS","MWI","MYS","MYT","NAM","NCL","NER","NFK","NGA","NIC","NIU","NLD","NOR",
  "NPL","NRU","NZL","OMN","PAK","PAN","PCN","PER","PHL","PLW","PNG","POL","PRI","PRK",
  "PRT","PRY","PSE","PYF","QAT","REU","ROU","RUS","RWA","SAU","SDN","SEN","SGP","SGS",
  "SHN","SJM","SLB","SLE","SLV","SMR","SOM","SPM","SRB","SSD","STP","SUR","SVK","SVN",
  "SWE","SWZ","SXM","SYC","SYR","TCA","TCD","TGO","THA","TJK","TKL","TKM","TLS","TON",
  "TTO","TUN","TUR","TUV","TWN","TZA","UGA","UKR","UMI","URY","USA","UZB","VAT","VCT",
  "VEN","VGB","VIR","VNM","VUT","WLF","WSM","YEM","ZAF","ZMB","ZWE",
]);

const ISO4217_CODES = new Set<string>([
  "AED","AFN","ALL","AMD","ANG","AOA","ARS","AUD","AWG","AZN","BAM","BBD","BDT","BGN",
  "BHD","BIF","BMD","BND","BOB","BOV","BRL","BSD","BTN","BWP","BYN","BZD","CAD","CDF",
  "CHE","CHF","CHW","CLF","CLP","CNY","COP","COU","CRC","CUC","CUP","CVE","CZK","DJF",
  "DKK","DOP","DZD","EGP","ERN","ETB","EUR","FJD","FKP","GBP","GEL","GHS","GIP","GMD",
  "GNF","GTQ","GYD","HKD","HNL","HRK","HTG","HUF","IDR","ILS","INR","IQD","IRR","ISK",
  "JMD","JOD","JPY","KES","KGS","KHR","KMF","KPW","KRW","KWD","KYD","KZT","LAK","LBP",
  "LKR","LRD","LSL","LYD","MAD","MDL","MGA","MKD","MMK","MNT","MOP","MRU","MUR","MVR",
  "MWK","MXN","MXV","MYR","MZN","NAD","NGN","NIO","NOK","NPR","NZD","OMR","PAB","PEN",
  "PGK","PHP","PKR","PLN","PYG","QAR","RON","RSD","RUB","RWF","SAR","SBD","SCR","SDG",
  "SEK","SGD","SHP","SLE","SLL","SOS","SRD","SSP","STN","SVC","SYP","SZL","THB","TJS",
  "TMT","TND","TOP","TRY","TTD","TWD","TZS","UAH","UGX","USD","USN","UYI","UYU","UYW",
  "UZS","VED","VES","VND","VUV","WST","XAF","XAG","XAU","XBA","XBB","XBC","XBD","XCD",
  "XDR","XOF","XPD","XPF","XPT","XSU","XTS","XUA","XXX","YER","ZAR","ZMW","ZWL",
]);

export function isISO31661Alpha2(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length === 2 &&
    ISO31661_ALPHA_2.has(value.toUpperCase())
  );
}

export function IsISO31661Alpha2(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_ISO31661_ALPHA_2,
    isISO31661Alpha2,
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must be a valid ISO31661 Alpha2 code`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isISO31661Alpha3(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length === 3 &&
    ISO31661_ALPHA_3.has(value.toUpperCase())
  );
}

export function IsISO31661Alpha3(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_ISO31661_ALPHA_3,
    isISO31661Alpha3,
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must be a valid ISO31661 Alpha3 code`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

export function isISO4217CurrencyCode(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length === 3 &&
    ISO4217_CODES.has(value.toUpperCase())
  );
}

export function IsISO4217CurrencyCode(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_ISO4217_CURRENCY_CODE,
    isISO4217CurrencyCode,
    buildMessage(
      (eachPrefix) =>
        `${eachPrefix}$property must be a valid ISO4217 currency code`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

const REGION_PHONE_RULES: Readonly<
  Record<string, { cc: string; min: number; max: number }>
> = {
  US: { cc: "1", min: 10, max: 10 },
  CA: { cc: "1", min: 10, max: 10 },
  GB: { cc: "44", min: 9, max: 10 },
  VN: { cc: "84", min: 9, max: 10 },
  JP: { cc: "81", min: 9, max: 10 },
  KR: { cc: "82", min: 9, max: 11 },
  CN: { cc: "86", min: 11, max: 11 },
  SG: { cc: "65", min: 8, max: 8 },
  AU: { cc: "61", min: 9, max: 9 },
  DE: { cc: "49", min: 7, max: 12 },
  FR: { cc: "33", min: 9, max: 9 },
  ES: { cc: "34", min: 9, max: 9 },
  IT: { cc: "39", min: 8, max: 11 },
  NL: { cc: "31", min: 9, max: 9 },
  BR: { cc: "55", min: 10, max: 11 },
  IN: { cc: "91", min: 10, max: 10 },
  ID: { cc: "62", min: 9, max: 12 },
  TH: { cc: "66", min: 8, max: 9 },
  MY: { cc: "60", min: 9, max: 10 },
  PH: { cc: "63", min: 10, max: 10 },
  PL: { cc: "48", min: 9, max: 9 },
  RU: { cc: "7", min: 10, max: 10 },
  UA: { cc: "380", min: 9, max: 9 },
  MX: { cc: "52", min: 10, max: 10 },
  TR: { cc: "90", min: 10, max: 10 },
  SA: { cc: "966", min: 9, max: 9 },
  AE: { cc: "971", min: 9, max: 9 },
  ZA: { cc: "27", min: 9, max: 9 },
  NZ: { cc: "64", min: 8, max: 10 },
  SE: { cc: "46", min: 7, max: 10 },
  CH: { cc: "41", min: 9, max: 9 },
  AT: { cc: "43", min: 7, max: 13 },
  BE: { cc: "32", min: 8, max: 9 },
  PT: { cc: "351", min: 9, max: 9 },
  IE: { cc: "353", min: 7, max: 9 },
  HK: { cc: "852", min: 8, max: 8 },
  TW: { cc: "886", min: 9, max: 9 },
};

const PHONE_CHAR_RE = /^\+?[\d\s().-]{5,30}$/;

export function isPhoneNumber(value: unknown, region?: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 32) {
    return false;
  }
  const hook = getRegisteredPhoneValidator();
  if (hook) return hook(value, region);
  if (!PHONE_CHAR_RE.test(value)) return false;

  const trimmed = value.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (hasPlus) {
    if (digits.length < 7 || digits.length > 15 || digits[0] === "0") {
      return false;
    }
    if (region) {
      const rule = REGION_PHONE_RULES[region.toUpperCase()];
      if (rule) {
        if (!digits.startsWith(rule.cc)) return false;
        const national = digits.slice(rule.cc.length);
        return national.length >= rule.min && national.length <= rule.max;
      }
    }
    return true;
  }

  if (!region) return false;

  const rule = REGION_PHONE_RULES[region.toUpperCase()];
  if (rule) {
    const national = digits.startsWith("0") ? digits.slice(1) : digits;
    if (national.length >= rule.min && national.length <= rule.max) return true;
    if (digits.startsWith(rule.cc)) {
      const stripped = digits.slice(rule.cc.length);
      return stripped.length >= rule.min && stripped.length <= rule.max;
    }
    return false;
  }

  return digits.length >= 7 && digits.length <= 15;
}

export function IsPhoneNumber(
  region?: string,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_PHONE_NUMBER,
    (value) => isPhoneNumber(value, region),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a valid phone number`,
      validationOptions,
    ),
    [region],
    validationOptions,
  );
}

const MOBILE_PHONE_PATTERNS: Readonly<Record<string, RegExp>> = {
  "en-US": /^(?:\+?1)?[2-9]\d{2}[2-9]\d{6}$/,
  "en-CA": /^(?:\+?1)?[2-9]\d{2}[2-9]\d{6}$/,
  "en-GB": /^(?:\+?44|0)7\d{9}$/,
  "en-AU": /^(?:\+?61|0)4\d{8}$/,
  "vi-VN": /^(?:\+?84|0)(?:3|5|7|8|9)\d{8}$/,
  "ja-JP": /^(?:\+?81|0)[789]0\d{8}$/,
  "ko-KR": /^(?:\+?82|0)1[016789]\d{7,8}$/,
  "zh-CN": /^(?:\+?86)?1[3-9]\d{9}$/,
  "de-DE": /^(?:\+?49|0)1[567]\d{8,9}$/,
  "fr-FR": /^(?:\+?33|0)[67]\d{8}$/,
  "es-ES": /^(?:\+?34)?[67]\d{8}$/,
  "it-IT": /^(?:\+?39)?3\d{8,9}$/,
  "pt-BR": /^(?:\+?55)?[1-9]{2}9\d{8}$/,
  "ru-RU": /^(?:\+?7|8)9\d{9}$/,
  "en-IN": /^(?:\+?91|0)?[6-9]\d{9}$/,
  "en-SG": /^(?:\+?65)?[89]\d{7}$/,
  "id-ID": /^(?:\+?62|0)8\d{8,11}$/,
  "th-TH": /^(?:\+?66|0)[689]\d{8}$/,
  "nl-NL": /^(?:\+?31|0)6\d{8}$/,
  "pl-PL": /^(?:\+?48)?[4-8]\d{8}$/,
};

const GENERIC_MOBILE_STRICT = /^\+[1-9]\d{6,14}$/;
const GENERIC_MOBILE_LOOSE = /^\+?\d{7,15}$/;

export function isMobilePhone(
  value: unknown,
  locale?: string | readonly string[],
  options?: IsMobilePhoneOptions,
): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 24) {
    return false;
  }
  const normalized = value.replace(/[\s()-]+/g, "");
  if (options?.strictMode && !normalized.startsWith("+")) return false;
  if (!locale || locale === "any") {
    return options?.strictMode
      ? GENERIC_MOBILE_STRICT.test(normalized)
      : GENERIC_MOBILE_LOOSE.test(normalized);
  }
  const locales = Array.isArray(locale) ? locale : [locale];
  for (let i = 0; i < locales.length; i++) {
    const pattern = MOBILE_PHONE_PATTERNS[locales[i]!];
    if (pattern) {
      if (pattern.test(normalized)) return true;
    } else if (
      options?.strictMode
        ? GENERIC_MOBILE_STRICT.test(normalized)
        : GENERIC_MOBILE_LOOSE.test(normalized)
    ) {
      return true;
    }
  }
  return false;
}

export function IsMobilePhone(
  locale?: string | readonly string[],
  options?: IsMobilePhoneOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_MOBILE_PHONE,
    (value) => isMobilePhone(value, locale, options),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a phone number`,
      validationOptions,
    ),
    [locale, options],
    validationOptions,
  );
}

const POSTAL_CODE_PATTERNS: Readonly<Record<string, RegExp>> = {
  US: /^\d{5}(?:-\d{4})?$/,
  CA: /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d$/i,
  GB: /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i,
  DE: /^\d{5}$/,
  FR: /^\d{5}$/,
  IT: /^\d{5}$/,
  ES: /^(?:0[1-9]|[1-4]\d|5[0-2])\d{3}$/,
  NL: /^\d{4}\s?[A-Z]{2}$/i,
  BE: /^\d{4}$/,
  CH: /^\d{4}$/,
  AT: /^\d{4}$/,
  AU: /^\d{4}$/,
  NZ: /^\d{4}$/,
  JP: /^\d{3}-?\d{4}$/,
  KR: /^\d{5}$/,
  CN: /^\d{6}$/,
  VN: /^\d{5,6}$/,
  SG: /^\d{6}$/,
  IN: /^[1-9]\d{5}$/,
  BR: /^\d{5}-?\d{3}$/,
  MX: /^\d{5}$/,
  PL: /^\d{2}-\d{3}$/,
  PT: /^\d{4}-\d{3}$/,
  SE: /^\d{3}\s?\d{2}$/,
  NO: /^\d{4}$/,
  DK: /^\d{4}$/,
  FI: /^\d{5}$/,
  RU: /^\d{6}$/,
  UA: /^\d{5}$/,
  ZA: /^\d{4}$/,
  ID: /^\d{5}$/,
  TH: /^\d{5}$/,
  MY: /^\d{5}$/,
  PH: /^\d{4}$/,
  TW: /^\d{3}(?:\d{2,3})?$/,
  IL: /^\d{5}(?:\d{2})?$/,
  TR: /^\d{5}$/,
  IE: /^[AC-FHKNPRTV-Y]\d{2}\s?[0-9AC-FHKNPRTV-Y]{4}$/i,
};

export function isPostalCode(value: unknown, locale: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 20) {
    return false;
  }
  if (locale === "any") {
    for (const re of Object.values(POSTAL_CODE_PATTERNS)) {
      if (re.test(value)) return true;
    }
    return false;
  }
  const pattern = POSTAL_CODE_PATTERNS[locale.toUpperCase()];
  if (!pattern) return /^[A-Za-z0-9][A-Za-z0-9\s-]{2,10}$/.test(value);
  return pattern.test(value);
}

export function IsPostalCode(
  locale: string,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_POSTAL_CODE,
    (value) => isPostalCode(value, locale),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a postal code`,
      validationOptions,
    ),
    [locale],
    validationOptions,
  );
}

const IDENTITY_CARD_PATTERNS: Readonly<Record<string, RegExp>> = {
  ES: /^[0-9XYZ]\d{7}[TRWAGMYFPDXBNJZSQVHLCKE]$/i,
  IN: /^[2-9]\d{11}$/,
  NO: /^\d{11}$/,
  "zh-CN":
    /^[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/,
  "zh-TW": /^[A-Z][12]\d{8}$/,
  "vi-VN": /^\d{9}(?:\d{3})?$/,
  PL: /^\d{11}$/,
  TH: /^\d{13}$/,
};

export function isIdentityCard(value: unknown, locale?: string): boolean {
  if (typeof value !== "string" || value.length < 5 || value.length > 32) {
    return false;
  }
  if (!locale || locale === "any") {
    for (const re of Object.values(IDENTITY_CARD_PATTERNS)) {
      if (re.test(value)) return true;
    }
    return /^[A-Za-z0-9-]{6,20}$/.test(value);
  }
  const re = IDENTITY_CARD_PATTERNS[locale];
  return re ? re.test(value) : /^[A-Za-z0-9-]{6,20}$/.test(value);
}

export function IsIdentityCard(
  locale?: string,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_IDENTITY_CARD,
    (value) => isIdentityCard(value, locale),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a identity card number`,
      validationOptions,
    ),
    [locale],
    validationOptions,
  );
}

const PASSPORT_PATTERNS: Readonly<Record<string, RegExp>> = {
  US: /^[A-Z0-9]{6,9}$/,
  GB: /^\d{9}$/,
  CA: /^[A-Z]{2}\d{6}$/,
  AU: /^[A-Z]\d{7}$/,
  DE: /^[CFGHJKLMNPRTVWXYZ0-9]{9}$/,
  FR: /^\d{2}[A-Z]{2}\d{5}$/,
  JP: /^[A-Z]{2}\d{7}$/,
  KR: /^[MSRDG][0-9A-Z]\d{7}$/,
  CN: /^[EG]\d{8}$/,
  VN: /^[A-Z]\d{7,8}$/,
  IN: /^[A-PR-WYa-pr-wy][1-9]\d\s?\d{4}[1-9]$/,
  SG: /^[EK]\d{7}[A-Z]$/,
  BR: /^[A-Z]{2}\d{6}$/,
  IT: /^[A-Z]{2}\d{7}$/,
  ES: /^[A-Z]{3}\d{6}$/,
  NL: /^[A-Z]{2}[A-Z0-9]{6}\d$/,
};

export function isPassportNumber(
  value: unknown,
  countryCode?: string,
): boolean {
  if (typeof value !== "string" || value.length < 5 || value.length > 20) {
    return false;
  }
  const upper = value.toUpperCase();
  if (countryCode) {
    const pattern = PASSPORT_PATTERNS[countryCode.toUpperCase()];
    if (pattern) return pattern.test(upper);
  }
  return /^[A-Z0-9]{6,12}$/.test(upper);
}

export function IsPassportNumber(
  countryCode?: string,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_PASSPORT_NUMBER,
    (value) => isPassportNumber(value, countryCode),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be valid passport number`,
      validationOptions,
    ),
    [countryCode],
    validationOptions,
  );
}

const TAX_ID_PATTERNS: Readonly<Record<string, RegExp>> = {
  "en-US": /^\d{2}-\d{7}$|^\d{3}-\d{2}-\d{4}$/,
  "en-GB": /^\d{10}$/,
  "de-DE": /^\d{11}$/,
  "fr-FR": /^[0-3]\d{12}$/,
  "es-ES": /^[0-9XYZ]\d{7}[A-Z]$/i,
  "it-IT": /^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/i,
  "pt-BR":
    /^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$|^\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}$/,
  "vi-VN": /^\d{10}(?:-\d{3})?$/,
  "ja-JP": /^\d{12,13}$/,
  "en-AU": /^\d{8,9}$/,
  "en-CA": /^\d{9}$/,
  "pl-PL": /^\d{10}$/,
};

export function isTaxId(value: unknown, locale = "en-US"): boolean {
  if (typeof value !== "string" || value.length < 5 || value.length > 32) {
    return false;
  }
  const pattern = TAX_ID_PATTERNS[locale];
  if (pattern) return pattern.test(value);
  return /^[A-Za-z0-9.-]{6,20}$/.test(value);
}

export function IsTaxId(
  locale?: string,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_TAX_ID,
    (value) => isTaxId(value, locale),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a Tax Identification Number`,
      validationOptions,
    ),
    [locale],
    validationOptions,
  );
}
