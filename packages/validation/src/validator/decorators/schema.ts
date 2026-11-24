import { ValidationTypes } from "../constants/validation-types";
import type { ValidationSchema } from "../interfaces/validation-schema.interface";
import {
  createConstraintMetadata,
  createValidationMetadata,
  getMetadataStorage,
} from "../storage/metadata-storage";
import { isDefined } from "./core.decorators";
import * as common from "./common/common.decorators";
import * as tc from "./typechecker/typechecker.decorators";
import * as num from "./number/number.decorators";
import * as dt from "./date/date.decorators";
import * as arr from "./array/array.decorators";
import * as strBasic from "./string/string-basic.decorators";
import * as strNet from "./string/string-network.decorators";
import * as strFmt from "./string/string-format.decorators";
import * as strDt from "./string/string-datetime.decorators";
import * as strCrypto from "./string/string-crypto-and-ids.decorators";
import * as strReg from "./string/string-regional.decorators";

type SchemaPredicate = (value: unknown, constraints: readonly unknown[]) => boolean;

const SCHEMA_PREDICATES: Readonly<Record<string, SchemaPredicate>> = {
  isDefined: (v) => isDefined(v),
  equals: (v, c) => common.equals(v, c[0]),
  notEquals: (v, c) => common.notEquals(v, c[0]),
  isEmpty: (v) => common.isEmpty(v),
  isNotEmpty: (v) => common.isNotEmpty(v),
  isIn: (v, c) => common.isIn(v, (c[0] as readonly unknown[]) ?? []),
  isNotIn: (v, c) => common.isNotIn(v, (c[0] as readonly unknown[]) ?? []),
  isLatLong: (v) => common.isLatLong(v),
  isLatitude: (v) => common.isLatitude(v),
  isLongitude: (v) => common.isLongitude(v),
  isBoolean: (v) => tc.isBoolean(v),
  isDate: (v) => tc.isDate(v),
  isString: (v) => tc.isString(v),
  isNumber: (v, c) => tc.isNumber(v, c[0] as tc.IsNumberOptions | undefined),
  isInt: (v) => tc.isInt(v),
  isArray: (v) => tc.isArray(v),
  isEnum: (v, c) => tc.isEnum(v, c[0] as object),
  isObject: (v) => tc.isObject(v),
  isNotEmptyObject: (v, c) =>
    tc.isNotEmptyObject(v, c[0] as tc.IsNotEmptyObjectOptions | undefined),
  isInstance: (v, c) => tc.isInstance(v, c[0] as Function),
  isDivisibleBy: (v, c) => num.isDivisibleBy(v, c[0] as number),
  isPositive: (v) => num.isPositive(v),
  isNegative: (v) => num.isNegative(v),
  min: (v, c) => num.min(v, c[0] as number),
  max: (v, c) => num.max(v, c[0] as number),
  minDate: (v, c) => dt.minDate(v, c[0] as Date),
  maxDate: (v, c) => dt.maxDate(v, c[0] as Date),
  arrayContains: (v, c) =>
    arr.arrayContains(v, (c[0] as readonly unknown[]) ?? []),
  arrayNotContains: (v, c) =>
    arr.arrayNotContains(v, (c[0] as readonly unknown[]) ?? []),
  arrayNotEmpty: (v) => arr.arrayNotEmpty(v),
  arrayMinSize: (v, c) => arr.arrayMinSize(v, c[0] as number),
  arrayMaxSize: (v, c) => arr.arrayMaxSize(v, c[0] as number),
  arrayUnique: (v, c) =>
    arr.arrayUnique(v, c[0] as arr.ArrayUniqueIdentifier | undefined),
  contains: (v, c) => strBasic.contains(v, c[0] as string),
  notContains: (v, c) => strBasic.notContains(v, c[0] as string),
  isLength: (v, c) =>
    strBasic.length(v, c[0] as number, c[1] as number | undefined),
  minLength: (v, c) => strBasic.minLength(v, c[0] as number),
  maxLength: (v, c) => strBasic.maxLength(v, c[0] as number),
  matches: (v, c) =>
    strBasic.matches(v, c[0] as RegExp | string, c[1] as string | undefined),
  isAlpha: (v, c) => strBasic.isAlpha(v, c[0] as string | undefined),
  isAlphanumeric: (v, c) =>
    strBasic.isAlphanumeric(v, c[0] as string | undefined),
  isAscii: (v) => strBasic.isAscii(v),
  isLowercase: (v) => strBasic.isLowercase(v),
  isUppercase: (v) => strBasic.isUppercase(v),
  isFullWidth: (v) => strBasic.isFullWidth(v),
  isHalfWidth: (v) => strBasic.isHalfWidth(v),
  isVariableWidth: (v) => strBasic.isVariableWidth(v),
  isMultibyte: (v) => strBasic.isMultibyte(v),
  isSurrogatePair: (v) => strBasic.isSurrogatePair(v),
  isByteLength: (v, c) =>
    strBasic.isByteLength(v, c[0] as number, c[1] as number | undefined),
  isEmail: (v, c) =>
    strNet.isEmail(v, c[0] as strNet.IsEmailOptions | undefined),
  isUrl: (v, c) => strNet.isURL(v, c[0] as strNet.IsURLOptions | undefined),
  isFqdn: (v, c) => strNet.isFQDN(v, c[0] as strNet.IsFQDNOptions | undefined),
  isIp: (v, c) => strNet.isIP(v, c[0] as strNet.IsIpVersion | undefined),
  isPort: (v) => strNet.isPort(v),
  isMacAddress: (v, c) =>
    strNet.isMACAddress(v, c[0] as strNet.IsMACAddressOptions | undefined),
  isMagnetURI: (v) => strNet.isMagnetURI(v),
  isDataURI: (v) => strNet.isDataURI(v),
  isMimeType: (v) => strNet.isMimeType(v),
  isTimeZone: (v) => strNet.isTimeZone(v),
  isLocale: (v) => strNet.isLocale(v),
  isUuid: (v, c) => strFmt.isUUID(v, c[0] as strFmt.UUIDVersion | undefined),
  isMongoId: (v) => strFmt.isMongoId(v),
  isJwt: (v) => strFmt.isJWT(v),
  isJson: (v) => strFmt.isJSON(v),
  isSemVer: (v) => strFmt.isSemVer(v),
  isStrongPassword: (v, c) =>
    strFmt.isStrongPassword(
      v,
      c[0] as strFmt.IsStrongPasswordOptions | undefined,
    ),
  isBooleanString: (v) => strFmt.isBooleanString(v),
  isNumberString: (v, c) =>
    strFmt.isNumberString(v, c[0] as strFmt.IsNumericOptions | undefined),
  isDecimal: (v, c) =>
    strFmt.isDecimal(v, c[0] as strFmt.IsDecimalOptions | undefined),
  isOctal: (v) => strFmt.isOctal(v),
  isHexadecimal: (v) => strFmt.isHexadecimal(v),
  isHash: (v, c) => strFmt.isHash(v, c[0] as strFmt.HashAlgorithm),
  isHexColor: (v) => strFmt.isHexColor(v),
  isRgbColor: (v, c) => strFmt.isRgbColor(v, c[0] as boolean | undefined),
  isHSL: (v) => strFmt.isHSL(v),
  isBase32: (v, c) =>
    strFmt.isBase32(v, c[0] as strFmt.IsBase32Options | undefined),
  isBase58: (v) => strFmt.isBase58(v),
  isBase64: (v, c) =>
    strFmt.isBase64(v, c[0] as strFmt.IsBase64Options | undefined),
  isIso8601: (v, c) =>
    strDt.isISO8601(v, c[0] as strDt.IsISO8601Options | undefined),
  isDateString: (v, c) =>
    strDt.isDateString(v, c[0] as strDt.IsISO8601Options | undefined),
  isRFC3339: (v) => strDt.isRFC3339(v),
  isMilitaryTime: (v) => strDt.isMilitaryTime(v),
  IsFirebasePushId: (v) => strCrypto.isFirebasePushId(v),
  isEthereumAddress: (v) => strCrypto.isEthereumAddress(v),
  isBtcAddress: (v) => strCrypto.isBtcAddress(v),
  isCreditCard: (v) => strCrypto.isCreditCard(v),
  isIBAN: (v) => strCrypto.isIBAN(v),
  isBIC: (v) => strCrypto.isBIC(v),
  isIsbn: (v, c) =>
    strCrypto.isISBN(v, c[0] as strCrypto.IsISBNVersion | undefined),
  isISSN: (v, c) =>
    strCrypto.isISSN(v, c[0] as strCrypto.IsISSNOptions | undefined),
  isEAN: (v) => strCrypto.isEAN(v),
  isIsin: (v) => strCrypto.isISIN(v),
  isISRC: (v) => strCrypto.isISRC(v),
  isCurrency: (v, c) =>
    strCrypto.isCurrency(v, c[0] as strCrypto.IsCurrencyOptions | undefined),
  isISO31661Alpha2: (v) => strReg.isISO31661Alpha2(v),
  isISO31661Alpha3: (v) => strReg.isISO31661Alpha3(v),
  isISO4217CurrencyCode: (v) => strReg.isISO4217CurrencyCode(v),
  isPhoneNumber: (v, c) => strReg.isPhoneNumber(v, c[0] as string | undefined),
  isMobilePhone: (v, c) =>
    strReg.isMobilePhone(
      v,
      c[0] as string | readonly string[] | undefined,
      c[1] as strReg.IsMobilePhoneOptions | undefined,
    ),
  isPostalCode: (v, c) => strReg.isPostalCode(v, c[0] as string),
  isIdentityCard: (v, c) =>
    strReg.isIdentityCard(v, c[0] as string | undefined),
  isPassportNumber: (v, c) =>
    strReg.isPassportNumber(v, c[0] as string | undefined),
  isTaxId: (v, c) => strReg.isTaxId(v, c[0] as string | undefined),
};

export function registerSchema(schema: ValidationSchema): void {
  const storage = getMetadataStorage();
  for (const [propertyName, rules] of Object.entries(schema.properties)) {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]!;
      const pred = SCHEMA_PREDICATES[rule.type];
      if (pred) {
        const constraints = rule.constraints ?? [];
        const marker = function SchemaRuleConstraint() {};
        const fastValidate = (value: unknown) => pred(value, constraints);
        storage.addConstraintMetadata(
          createConstraintMetadata(marker, rule.type, false, {
            validate: fastValidate,
            defaultMessage: () => `$property failed ${rule.type} validation`,
          }),
        );
        storage.addValidationMetadata(
          createValidationMetadata({
            type:
              rule.type === ValidationTypes.IS_DEFINED
                ? ValidationTypes.IS_DEFINED
                : ValidationTypes.CUSTOM_VALIDATION,
            name: rule.type,
            target: schema.name,
            propertyName,
            constraintCls: marker,
            constraints,
            validationTypeOptions: rule.options,
            validationOptions: {
              message: rule.message,
              groups: rule.groups,
              always: rule.always,
              each: rule.each,
              context: rule.context,
            },
          }),
        );
      } else {
        storage.addValidationMetadata(
          createValidationMetadata({
            type: rule.type,
            name: rule.type,
            target: schema.name,
            propertyName,
            constraints: rule.constraints,
            validationTypeOptions: rule.options,
            validationOptions: {
              message: rule.message,
              groups: rule.groups,
              always: rule.always,
              each: rule.each,
              context: rule.context,
            },
          }),
        );
      }
    }
  }
}
