import { I18nMessageFormatter } from "./i18n-message.formatter";

const SIMPLE_PLACEHOLDER_RE = /^\w+$/;
const ICU_HEADER_RE = /^(\w+)\s*,\s*(plural|select|number|date)(?:\s*,\s*([\s\S]*))?$/;
const DATE_STYLES = new Set(["short", "medium", "long", "full"]);
const MAX_INTL_CACHE = 200;

/**
 * The default formatter (internal): `{name}` placeholders where a name is
 * letters, digits and `_`, escaped literal braces `{{` / `}}`, and inline
 * `Intl`-backed `plural`, `select`, `number`, and `date` expressions.
 * A placeholder without an argument stays as written.
 */
export class PlaceholderMessageFormatter extends I18nMessageFormatter {
  private readonly pluralRules = new Map<string, Intl.PluralRules>();
  private readonly numberFormats = new Map<string, Intl.NumberFormat>();
  private readonly dateFormats = new Map<string, Intl.DateTimeFormat>();

  override format(
    message: string,
    args: Record<string, unknown>,
    locale = "en",
  ): string {
    if (!message.includes("{") && !message.includes("}")) {
      return message;
    }

    // Fast path when there are no ICU-style comma expressions
    if (!message.includes(",")) {
      return message.replace(/\{\{|\}\}|\{(\w+)\}/g, (match, name: string | undefined) => {
        if (name === undefined) {
          return match[0] ?? match;
        }
        return Object.hasOwn(args, name) ? toText(args[name]) : match;
      });
    }

    return this.formatRich(message, args, locale);
  }

  private formatRich(
    message: string,
    args: Record<string, unknown>,
    locale: string,
  ): string {
    let out = "";
    let i = 0;
    const len = message.length;

    while (i < len) {
      const ch = message[i];
      if (ch === "{") {
        if (message[i + 1] === "{") {
          out += "{";
          i += 2;
          continue;
        }
        const close = findClosingBrace(message, i);
        if (close === -1) {
          out += "{";
          i += 1;
          continue;
        }
        const raw = message.slice(i, close + 1);
        const inner = message.slice(i + 1, close);
        out += this.evaluateExpression(inner, raw, args, locale);
        i = close + 1;
        continue;
      }

      if (ch === "}" && message[i + 1] === "}") {
        out += "}";
        i += 2;
        continue;
      }

      out += ch;
      i += 1;
    }

    return out;
  }

  private evaluateExpression(
    inner: string,
    raw: string,
    args: Record<string, unknown>,
    locale: string,
  ): string {
    if (SIMPLE_PLACEHOLDER_RE.test(inner)) {
      return Object.hasOwn(args, inner) ? toText(args[inner]) : raw;
    }

    const header = ICU_HEADER_RE.exec(inner.trim());
    if (!header) {
      return raw;
    }

    const name = header[1]!;
    const kind = header[2]!;
    const rest = header[3]?.trim();

    if (!Object.hasOwn(args, name)) {
      return raw;
    }

    const value = args[name];

    switch (kind) {
      case "plural":
        return this.formatPlural(value, rest, raw, args, locale);
      case "select":
        return this.formatSelect(value, rest, raw, args, locale);
      case "number":
        return this.formatNumberValue(value, rest, raw, locale);
      case "date":
        return this.formatDateValue(value, rest, raw, locale);
      default:
        return raw;
    }
  }

  private formatPlural(
    value: unknown,
    body: string | undefined,
    raw: string,
    args: Record<string, unknown>,
    locale: string,
  ): string {
    if (typeof value !== "number" || !Number.isFinite(value) || !body) {
      return raw;
    }

    const parsed = parseBranches(body, true);
    if (!parsed) {
      return raw;
    }

    const exact = parsed.branches.get(`=${value}`);
    const adjusted = value - parsed.offset;
    let selected = exact;
    if (selected === undefined) {
      const category = this.getPluralRules(locale).select(adjusted);
      selected = parsed.branches.get(category) ?? parsed.branches.get("other");
    }
    if (selected === undefined) {
      return raw;
    }

    const formattedCount = this.getNumberFormat(locale, {}).format(adjusted);
    const withHash = replaceTopLevelHash(selected, formattedCount);
    return this.formatRich(withHash, args, locale);
  }

  private formatSelect(
    value: unknown,
    body: string | undefined,
    raw: string,
    args: Record<string, unknown>,
    locale: string,
  ): string {
    if (!body) {
      return raw;
    }

    const parsed = parseBranches(body, false);
    if (!parsed) {
      return raw;
    }

    const key = toText(value);
    const selected = parsed.branches.get(key) ?? parsed.branches.get("other");
    if (selected === undefined) {
      return raw;
    }

    return this.formatRich(selected, args, locale);
  }

  private formatNumberValue(
    value: unknown,
    style: string | undefined,
    raw: string,
    locale: string,
  ): string {
    if (typeof value !== "number" && typeof value !== "bigint") {
      return raw;
    }

    let options: Intl.NumberFormatOptions = {};
    if (style) {
      if (style === "integer") {
        options = { maximumFractionDigits: 0 };
      } else if (style === "percent") {
        options = { style: "percent" };
      } else if (style.startsWith("currency:")) {
        const currency = style.slice("currency:".length).trim().toUpperCase();
        if (currency.length === 3) {
          options = { style: "currency", currency };
        } else {
          return raw;
        }
      } else {
        return raw;
      }
    }

    return this.getNumberFormat(locale, options).format(value);
  }

  private formatDateValue(
    value: unknown,
    style: string | undefined,
    raw: string,
    locale: string,
  ): string {
    if (!(value instanceof Date) && typeof value !== "number") {
      return raw;
    }

    let options: Intl.DateTimeFormatOptions = {};
    if (style) {
      if (DATE_STYLES.has(style)) {
        options = { dateStyle: style as Intl.DateTimeFormatOptions["dateStyle"] };
      } else {
        return raw;
      }
    }

    return this.getDateFormat(locale, options).format(value);
  }

  private getPluralRules(locale: string): Intl.PluralRules {
    let rules = this.pluralRules.get(locale);
    if (!rules) {
      rules = new Intl.PluralRules(locale);
      if (this.pluralRules.size >= MAX_INTL_CACHE) {
        const oldest = this.pluralRules.keys().next().value;
        if (oldest !== undefined) {
          this.pluralRules.delete(oldest);
        }
      }
      this.pluralRules.set(locale, rules);
    }
    return rules;
  }

  private getNumberFormat(
    locale: string,
    options: Intl.NumberFormatOptions,
  ): Intl.NumberFormat {
    const key = `${locale}|${JSON.stringify(options)}`;
    let fmt = this.numberFormats.get(key);
    if (!fmt) {
      fmt = new Intl.NumberFormat(locale, options);
      if (this.numberFormats.size >= MAX_INTL_CACHE) {
        const oldest = this.numberFormats.keys().next().value;
        if (oldest !== undefined) {
          this.numberFormats.delete(oldest);
        }
      }
      this.numberFormats.set(key, fmt);
    }
    return fmt;
  }

  private getDateFormat(
    locale: string,
    options: Intl.DateTimeFormatOptions,
  ): Intl.DateTimeFormat {
    const key = `${locale}|${JSON.stringify(options)}`;
    let fmt = this.dateFormats.get(key);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat(locale, options);
      if (this.dateFormats.size >= MAX_INTL_CACHE) {
        const oldest = this.dateFormats.keys().next().value;
        if (oldest !== undefined) {
          this.dateFormats.delete(oldest);
        }
      }
      this.dateFormats.set(key, fmt);
    }
    return fmt;
  }
}

/** Finds the matching closing `}` for an opening `{` at `start`, tracking nested braces. */
function findClosingBrace(input: string, start: number): number {
  let depth = 0;
  for (let i = start; i < input.length; i++) {
    const ch = input[i];
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** Parses `offset:N` (when `allowOffset`) and `<selector> {template}` branches. */
function parseBranches(
  body: string,
  allowOffset: boolean,
): { offset: number; branches: Map<string, string> } | undefined {
  let i = 0;
  const len = body.length;
  let offset = 0;
  const branches = new Map<string, string>();

  const skipWhitespace = () => {
    while (i < len && /\s/.test(body[i]!)) {
      i += 1;
    }
  };

  skipWhitespace();
  if (allowOffset && body.slice(i).startsWith("offset:")) {
    i += "offset:".length;
    const numStart = i;
    while (i < len && /\d/.test(body[i]!)) {
      i += 1;
    }
    if (i === numStart) {
      return undefined;
    }
    offset = Number(body.slice(numStart, i));
    skipWhitespace();
  }

  while (i < len) {
    skipWhitespace();
    if (i >= len) {
      break;
    }
    const keyStart = i;
    while (i < len && !/\s|\{/.test(body[i]!)) {
      i += 1;
    }
    const key = body.slice(keyStart, i);
    if (!key) {
      return undefined;
    }
    skipWhitespace();
    if (body[i] !== "{") {
      return undefined;
    }
    const close = findClosingBrace(body, i);
    if (close === -1) {
      return undefined;
    }
    branches.set(key, body.slice(i + 1, close));
    i = close + 1;
  }

  return branches.size > 0 ? { offset, branches } : undefined;
}

/** Replaces `#` outside nested `{...}` expressions with the formatted plural count. */
function replaceTopLevelHash(template: string, replacement: string): string {
  if (!template.includes("#")) {
    return template;
  }
  let out = "";
  let depth = 0;
  for (let i = 0; i < template.length; i++) {
    const ch = template[i]!;
    if (ch === "{") {
      if (depth === 0 && template[i + 1] === "{") {
        out += "{{";
        i += 1;
        continue;
      }
      depth += 1;
      out += ch;
    } else if (ch === "}") {
      if (depth === 0 && template[i + 1] === "}") {
        out += "}}";
        i += 1;
        continue;
      }
      if (depth > 0) {
        depth -= 1;
      }
      out += ch;
    } else if (ch === "#" && depth === 0) {
      out += replacement;
    } else {
      out += ch;
    }
  }
  return out;
}

/** `String(value)`, except that it never throws (a null-prototype object has no string form). */
function toText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
