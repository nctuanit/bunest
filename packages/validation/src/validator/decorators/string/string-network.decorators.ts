import {
  isValidationOptions,
  type ValidationOptions,
} from "../../interfaces/validation-options.interface";
import { buildMessage, createBuiltInDecorator } from "../core.decorators";

export const IS_EMAIL = "isEmail";
export const IS_URL = "isUrl";
export const IS_FQDN = "isFqdn";
export const IS_IP = "isIp";
export const IS_PORT = "isPort";
export const IS_MAC_ADDRESS = "isMacAddress";
export const IS_MAGNET_URI = "isMagnetURI";
export const IS_DATA_URI = "isDataURI";
export const IS_MIME_TYPE = "isMimeType";
export const IS_TIMEZONE = "isTimeZone";
export const IS_LOCALE = "isLocale";

export type IsIpVersion = "4" | "6" | 4 | 6;

export interface IsFQDNOptions {
  require_tld?: boolean;
  allow_underscores?: boolean;
  allow_trailing_dot?: boolean;
  allow_numeric_tld?: boolean;
  allow_wildcard?: boolean;
}

export interface IsEmailOptions {
  allow_display_name?: boolean;
  require_display_name?: boolean;
  allow_utf8_local_part?: boolean;
  require_tld?: boolean;
  ignore_max_length?: boolean;
  allow_ip_domain?: boolean;
  domain_specific_validation?: boolean;
  blacklisted_chars?: string;
  host_blacklist?: string[];
  host_whitelist?: string[];
}

export interface IsURLOptions {
  protocols?: string[];
  require_tld?: boolean;
  require_protocol?: boolean;
  require_host?: boolean;
  require_port?: boolean;
  require_valid_protocol?: boolean;
  allow_underscores?: boolean;
  host_whitelist?: Array<string | RegExp>;
  host_blacklist?: Array<string | RegExp>;
  allow_trailing_dot?: boolean;
  allow_protocol_relative_urls?: boolean;
  allow_fragments?: boolean;
  allow_query_components?: boolean;
  disallow_auth?: boolean;
  validate_length?: boolean;
  max_allowed_length?: number;
}

export interface IsMACAddressOptions {
  no_colons?: boolean;
  no_separators?: boolean;
  eui?: "48" | "64";
}

function isIPv4(str: string): boolean {
  if (str.length < 7 || str.length > 15) return false;
  const parts = str.split(".");
  if (parts.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const p = parts[i]!;
    if (p.length === 0 || p.length > 3) return false;
    if (p.length > 1 && p.charCodeAt(0) === 48) return false;
    let num = 0;
    for (let j = 0; j < p.length; j++) {
      const c = p.charCodeAt(j);
      if (c < 48 || c > 57) return false;
      num = num * 10 + (c - 48);
    }
    if (num > 255) return false;
  }
  return true;
}

function isHexGroup1To4(part: string): boolean {
  if (part.length < 1 || part.length > 4) return false;
  for (let i = 0; i < part.length; i++) {
    const c = part.charCodeAt(i);
    const isHex =
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 70) ||
      (c >= 97 && c <= 102);
    if (!isHex) return false;
  }
  return true;
}

function isIPv6(raw: string): boolean {
  if (raw.length < 2 || raw.length > 64) return false;
  const pctIdx = raw.indexOf("%");
  const str = pctIdx !== -1 ? raw.slice(0, pctIdx) : raw;
  if (pctIdx !== -1 && pctIdx === raw.length - 1) return false;

  const doubleColonIdx = str.indexOf("::");
  if (doubleColonIdx !== -1) {
    if (str.indexOf("::", doubleColonIdx + 2) !== -1) return false;
    const left =
      doubleColonIdx === 0 ? [] : str.slice(0, doubleColonIdx).split(":");
    const rightRaw = str.slice(doubleColonIdx + 2);
    const right = rightRaw.length === 0 ? [] : rightRaw.split(":");

    let ipv4Groups = 0;
    if (right.length > 0 && right[right.length - 1]!.includes(".")) {
      if (!isIPv4(right.pop()!)) return false;
      ipv4Groups = 2;
    } else if (
      right.length === 0 &&
      left.length > 0 &&
      left[left.length - 1]!.includes(".")
    ) {
      return false;
    }

    for (let i = 0; i < left.length; i++) {
      if (!isHexGroup1To4(left[i]!)) return false;
    }
    for (let i = 0; i < right.length; i++) {
      if (!isHexGroup1To4(right[i]!)) return false;
    }
    return left.length + right.length + ipv4Groups < 8;
  }

  const groups = str.split(":");
  let ipv4Groups = 0;
  if (groups.length === 7 && groups[6]!.includes(".")) {
    if (!isIPv4(groups.pop()!)) return false;
    ipv4Groups = 2;
  }
  if (groups.length + ipv4Groups !== 8) return false;
  for (let i = 0; i < groups.length; i++) {
    if (!isHexGroup1To4(groups[i]!)) return false;
  }
  return true;
}

export function isIP(value: unknown, version?: IsIpVersion): boolean {
  if (typeof value !== "string") return false;
  const v = version !== undefined ? String(version) : "";
  if (v === "4") return isIPv4(value);
  if (v === "6") return isIPv6(value);
  return isIPv4(value) || isIPv6(value);
}

export function IsIP(
  version?: IsIpVersion,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_IP,
    (value) => isIP(value, version),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be an ip address`,
      validationOptions,
    ),
    [version],
    validationOptions,
  );
}

export function isFQDN(value: unknown, options: IsFQDNOptions = {}): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) {
    return false;
  }
  const requireTld = options.require_tld ?? true;
  const allowUnderscores = options.allow_underscores ?? false;
  const allowTrailingDot = options.allow_trailing_dot ?? false;
  const allowNumericTld = options.allow_numeric_tld ?? false;
  const allowWildcard = options.allow_wildcard ?? false;

  let domain = value;
  if (allowTrailingDot && domain.endsWith(".")) domain = domain.slice(0, -1);
  if (allowWildcard && domain.startsWith("*.")) domain = domain.slice(2);
  if (domain.length === 0 || domain.length > 253) return false;

  const parts = domain.split(".");
  if (requireTld && parts.length < 2) return false;

  for (let i = 0; i < parts.length; i++) {
    const label = parts[i]!;
    if (label.length === 0 || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
    for (let j = 0; j < label.length; j++) {
      const c = label.charCodeAt(j);
      const valid =
        (c >= 97 && c <= 122) ||
        (c >= 65 && c <= 90) ||
        (c >= 48 && c <= 57) ||
        c === 45 ||
        (allowUnderscores && c === 95) ||
        c > 127;
      if (!valid) return false;
    }
  }

  if (requireTld) {
    const tld = parts[parts.length - 1]!;
    if (tld.length < 2) return false;
    if (!allowNumericTld) {
      let allDigits = true;
      for (let i = 0; i < tld.length; i++) {
        const c = tld.charCodeAt(i);
        if (c < 48 || c > 57) {
          allDigits = false;
          break;
        }
      }
      if (allDigits) return false;
      if (!tld.toLowerCase().startsWith("xn--")) {
        for (let i = 0; i < tld.length; i++) {
          const c = tld.charCodeAt(i);
          const isAlphaOrIdn =
            (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c > 127;
          if (!isAlphaOrIdn) return false;
        }
      }
    }
  }

  return true;
}

export function IsFQDN(
  options?: IsFQDNOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_FQDN,
    (value) => isFQDN(value, options),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a valid domain name`,
      validationOptions,
    ),
    [options],
    validationOptions,
  );
}

const EMAIL_ATEXT_ASCII = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+$/;
const EMAIL_ATEXT_UTF8 = /^[\p{L}\p{N}!#$%&'*+\-/=?^_`{|}~]+$/u;

export function isEmail(
  value: unknown,
  options: IsEmailOptions = {},
): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const ignoreMaxLength = options.ignore_max_length ?? false;
  const allowUtf8 = options.allow_utf8_local_part ?? true;
  const requireTld = options.require_tld ?? true;
  const allowIpDomain = options.allow_ip_domain ?? false;

  let addr = value;
  if (options.allow_display_name || options.require_display_name) {
    const lt = addr.lastIndexOf("<");
    const gt = addr.lastIndexOf(">");
    if (lt !== -1 && gt === addr.length - 1 && lt < gt) {
      const displayName = addr.slice(0, lt).trim();
      if (displayName.length === 0 && options.require_display_name) return false;
      addr = addr.slice(lt + 1, gt);
    } else if (options.require_display_name) {
      return false;
    }
  }

  if (!ignoreMaxLength && addr.length > 254) return false;

  const atIdx = addr.lastIndexOf("@");
  if (atIdx <= 0 || atIdx === addr.length - 1) return false;

  const local = addr.slice(0, atIdx);
  const domain = addr.slice(atIdx + 1);

  if (!ignoreMaxLength && (local.length > 64 || domain.length > 255)) {
    return false;
  }

  if (options.blacklisted_chars) {
    for (let i = 0; i < options.blacklisted_chars.length; i++) {
      if (local.includes(options.blacklisted_chars[i]!)) return false;
    }
  }

  const lowerDomain = domain.toLowerCase();
  if (
    options.host_blacklist &&
    options.host_blacklist.some((h) => h.toLowerCase() === lowerDomain)
  ) {
    return false;
  }
  if (
    options.host_whitelist &&
    options.host_whitelist.length > 0 &&
    !options.host_whitelist.some((h) => h.toLowerCase() === lowerDomain)
  ) {
    return false;
  }

  if (local.startsWith('"') && local.endsWith('"') && local.length >= 2) {
    const inner = local.slice(1, -1);
    for (let i = 0; i < inner.length; i++) {
      const c = inner.charCodeAt(i);
      if (c === 92) {
        i += 1;
        continue;
      }
      if (c === 34 || c < 32 || c === 127) return false;
    }
  } else {
    if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
      return false;
    }
    const localParts = local.split(".");
    const re = allowUtf8 ? EMAIL_ATEXT_UTF8 : EMAIL_ATEXT_ASCII;
    for (let i = 0; i < localParts.length; i++) {
      const part = localParts[i]!;
      if (part.length === 0 || !re.test(part)) return false;
    }
  }

  if (allowIpDomain) {
    if (domain.startsWith("[") && domain.endsWith("]")) {
      if (isIP(domain.slice(1, -1))) return true;
    }
    if (isIP(domain)) return true;
  }

  return isFQDN(domain, { require_tld: requireTld });
}

export function IsEmail(
  options?: IsEmailOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_EMAIL,
    (value) => isEmail(value, options),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be an email`,
      validationOptions,
    ),
    [options],
    validationOptions,
  );
}

const DEFAULT_URL_PROTOCOLS = ["http", "https", "ftp"];

function matchesHostRule(
  host: string,
  rules: ReadonlyArray<string | RegExp>,
): boolean {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    if (typeof rule === "string") {
      if (host === rule) return true;
    } else if (rule instanceof RegExp && rule.test(host)) {
      return true;
    }
  }
  return false;
}

export function isURL(value: unknown, options: IsURLOptions = {}): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const validateLength = options.validate_length ?? true;
  const maxLen = options.max_allowed_length ?? 2084;
  if (validateLength && value.length > maxLen) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 32 || c === 127) return false;
  }
  if (value.startsWith("mailto:")) return false;

  const protocols = options.protocols ?? DEFAULT_URL_PROTOCOLS;
  const requireProtocol = options.require_protocol ?? false;
  const requireValidProtocol = options.require_valid_protocol ?? true;
  const requireTld = options.require_tld ?? true;
  const requireHost = options.require_host ?? true;
  const requirePort = options.require_port ?? false;
  const allowProtocolRelative = options.allow_protocol_relative_urls ?? false;
  const allowFragments = options.allow_fragments ?? true;
  const allowQuery = options.allow_query_components ?? true;
  const disallowAuth = options.disallow_auth ?? false;

  let working = value;
  let hasProtocol = false;

  if (working.startsWith("//")) {
    if (!allowProtocolRelative || requireProtocol) return false;
    working = `http:${working}`;
  } else {
    const schemeEnd = working.indexOf("://");
    if (schemeEnd !== -1) {
      const protocol = working.slice(0, schemeEnd).toLowerCase();
      if (!/^[a-z][a-z0-9+.-]*$/.test(protocol)) return false;
      if (requireValidProtocol && !protocols.includes(protocol)) return false;
      hasProtocol = true;
    } else {
      if (requireProtocol) return false;
      working = `http://${working}`;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(working);
  } catch {
    return false;
  }

  if (!allowFragments && parsed.hash.length > 0) return false;
  if (!allowQuery && parsed.search.length > 0) return false;
  if (
    disallowAuth &&
    (parsed.username.length > 0 || parsed.password.length > 0)
  ) {
    return false;
  }
  if (requirePort && parsed.port.length === 0) return false;

  const host = parsed.hostname;
  if (requireHost && host.length === 0) return false;

  if (host.length > 0) {
    if (
      options.host_blacklist &&
      matchesHostRule(host, options.host_blacklist)
    ) {
      return false;
    }
    if (
      options.host_whitelist &&
      options.host_whitelist.length > 0 &&
      !matchesHostRule(host, options.host_whitelist)
    ) {
      return false;
    }

    const strippedHost =
      host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    const isValidHost =
      isIP(strippedHost) ||
      isFQDN(host, {
        require_tld: requireTld,
        allow_underscores: options.allow_underscores ?? false,
        allow_trailing_dot: options.allow_trailing_dot ?? false,
      }) ||
      (!requireTld && host === "localhost");

    if (!isValidHost) return false;
  } else if (!hasProtocol) {
    return false;
  }

  return true;
}

export function IsUrl(
  options?: IsURLOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_URL,
    (value) => isURL(value, options),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a URL address`,
      validationOptions,
    ),
    [options],
    validationOptions,
  );
}

export function isPort(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 5) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const n = Number(value);
  return n >= 0 && n <= 65535;
}

export function IsPort(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_PORT,
    isPort,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a port`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

const MAC_48_COLON = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const MAC_48_DASH = /^(?:[0-9a-f]{2}-){5}[0-9a-f]{2}$/i;
const MAC_48_DOT = /^(?:[0-9a-f]{4}\.){2}[0-9a-f]{4}$/i;
const MAC_48_PLAIN = /^[0-9a-f]{12}$/i;
const MAC_64_COLON = /^(?:[0-9a-f]{2}:){7}[0-9a-f]{2}$/i;
const MAC_64_DASH = /^(?:[0-9a-f]{2}-){7}[0-9a-f]{2}$/i;
const MAC_64_DOT = /^(?:[0-9a-f]{4}\.){3}[0-9a-f]{4}$/i;
const MAC_64_PLAIN = /^[0-9a-f]{16}$/i;

export function isMACAddress(
  value: unknown,
  options?: IsMACAddressOptions,
): boolean {
  if (typeof value !== "string") return false;
  const noSep = options?.no_separators || options?.no_colons;
  if (noSep) {
    if (options?.eui === "48") return MAC_48_PLAIN.test(value);
    if (options?.eui === "64") return MAC_64_PLAIN.test(value);
    return MAC_48_PLAIN.test(value) || MAC_64_PLAIN.test(value);
  }
  if (options?.eui === "48") {
    return (
      MAC_48_COLON.test(value) ||
      MAC_48_DASH.test(value) ||
      MAC_48_DOT.test(value)
    );
  }
  if (options?.eui === "64") {
    return (
      MAC_64_COLON.test(value) ||
      MAC_64_DASH.test(value) ||
      MAC_64_DOT.test(value)
    );
  }
  return (
    MAC_48_COLON.test(value) ||
    MAC_48_DASH.test(value) ||
    MAC_48_DOT.test(value) ||
    MAC_64_COLON.test(value) ||
    MAC_64_DASH.test(value) ||
    MAC_64_DOT.test(value)
  );
}

export function IsMACAddress(
  options?: IsMACAddressOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator;
export function IsMACAddress(
  validationOptions?: ValidationOptions,
): PropertyDecorator;
export function IsMACAddress(
  optionsOrValidationOptions?: IsMACAddressOptions | ValidationOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  const isValOpts = isValidationOptions(optionsOrValidationOptions);
  const macOpts = isValOpts
    ? undefined
    : (optionsOrValidationOptions as IsMACAddressOptions | undefined);
  const valOpts = isValOpts
    ? (optionsOrValidationOptions as ValidationOptions)
    : validationOptions;

  return createBuiltInDecorator(
    IS_MAC_ADDRESS,
    (value) => isMACAddress(value, macOpts),
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a MAC Address`,
      valOpts,
    ),
    [macOpts],
    valOpts,
  );
}

const MAGNET_URI_RE =
  /^magnet:\?xt=urn:[a-z0-9]+:[a-z0-9]{32,40}(?:&[a-z0-9_.+-]+=[^\s&]*)*$/i;

export function isMagnetURI(value: unknown): boolean {
  return typeof value === "string" && MAGNET_URI_RE.test(value);
}

export function IsMagnetURI(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_MAGNET_URI,
    isMagnetURI,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be magnet uri format`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

const DATA_URI_MEDIA_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const DATA_URI_PARAM_RE = /^[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+-]+$/i;

export function isDataURI(value: unknown): boolean {
  if (typeof value !== "string" || !value.startsWith("data:")) return false;
  const commaIdx = value.indexOf(",");
  if (commaIdx === -1) return false;
  const header = value.slice(5, commaIdx);
  const data = value.slice(commaIdx + 1);
  if (data.length === 0) return false;

  if (header.length > 0) {
    const attrs = header.split(";");
    const first = attrs[0]!;
    if (first.length > 0 && !DATA_URI_MEDIA_RE.test(first)) return false;
    for (let i = 1; i < attrs.length; i++) {
      const attr = attrs[i]!;
      if (i === attrs.length - 1 && attr === "base64") continue;
      if (!DATA_URI_PARAM_RE.test(attr)) return false;
    }
  }

  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c <= 32 || c === 127) return false;
  }
  return true;
}

export function IsDataURI(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_DATA_URI,
    isDataURI,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a data uri format`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

const MIME_TYPE_RE =
  /^(?:application|audio|font|image|message|model|multipart|text|video|x-[a-z0-9-]+)\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(?:\s*;\s*[a-z0-9-]+=(?:[a-z0-9_.+-]+|"[^"]*"))*$/i;

export function isMimeType(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length <= 255 &&
    MIME_TYPE_RE.test(value)
  );
}

export function IsMimeType(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_MIME_TYPE,
    isMimeType,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be MIME type format`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

let supportedTimeZones: Set<string> | undefined;

export function isTimeZone(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 100) {
    return false;
  }
  if (!supportedTimeZones && typeof Intl.supportedValuesOf === "function") {
    try {
      supportedTimeZones = new Set(Intl.supportedValuesOf("timeZone"));
      supportedTimeZones.add("UTC");
      supportedTimeZones.add("Etc/UTC");
      supportedTimeZones.add("Etc/GMT");
      supportedTimeZones.add("GMT");
    } catch {
      supportedTimeZones = new Set();
    }
  }
  if (supportedTimeZones && supportedTimeZones.has(value)) return true;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function IsTimeZone(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_TIMEZONE,
    isTimeZone,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be a valid IANA time-zone`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}

const LOCALE_RE =
  /^[A-Za-z]{2,4}(?:[_-][A-Za-z]{4})?(?:[_-](?:[A-Za-z]{2}|\d{3}))?$/;

export function isLocale(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value === "en_US_POSIX" || value === "ca_ES_VALENCIA") return true;
  return LOCALE_RE.test(value);
}

export function IsLocale(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return createBuiltInDecorator(
    IS_LOCALE,
    isLocale,
    buildMessage(
      (eachPrefix) => `${eachPrefix}$property must be locale`,
      validationOptions,
    ),
    undefined,
    validationOptions,
  );
}
