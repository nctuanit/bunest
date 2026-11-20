import type { RedactionOptions } from "../interfaces/observe-types";

const DEFAULT_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:AKIA|ASIA|AIDA|AROA)[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi,
  /\b((?:password|passwd|pwd|secret|token|apikey|api_key|access_token|refresh_token|authorization|private_key)\s*[=:]\s*)([^\s,;'"&]+)/gi,
];

const BUILTIN_KEY_SUFFIXES = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "apikey",
  "authorization",
  "cookie",
  "setcookie",
  "signature",
  "privatekey",
  "creditcard",
  "cardnumber",
  "cvv",
  "ssn",
];

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

function normalizeKeyName(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export class LogRedactor {
  private readonly rules: RegExp[];
  private readonly customKeys: Set<string>;
  private readonly replacement: string;
  private readonly redactCards: boolean;

  constructor(options?: RedactionOptions) {
    this.replacement = options?.replacement ?? "[REDACTED]";
    const useDefaults = options?.useDefaultPatterns !== false;
    this.redactCards = useDefaults;
    this.rules = [];
    if (useDefaults) {
      for (const re of DEFAULT_PATTERNS) {
        this.rules.push(new RegExp(re.source, re.flags));
      }
    }
    if (options?.patterns) {
      for (const re of options.patterns) {
        const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
        this.rules.push(new RegExp(re.source, flags));
      }
    }
    this.customKeys = new Set((options?.keys ?? []).map(normalizeKeyName));
  }

  isSensitiveKey(key: string): boolean {
    const norm = normalizeKeyName(key);
    if (this.customKeys.has(norm)) {
      return true;
    }
    return BUILTIN_KEY_SUFFIXES.some(
      (suffix) => norm === suffix || norm.endsWith(suffix),
    );
  }

  redactMessage(message: string): string {
    const clean = message.replace(ANSI_RE, "");
    return this.apply(clean);
  }

  redactSource(lines: string[]): string[] {
    const joined = lines.join("\n");
    const redacted = this.apply(joined);
    return redacted.split("\n");
  }

  redactAttributes(
    attributes: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (!attributes) return undefined;
    const seen = new WeakSet<object>();
    const walk = (node: unknown): unknown => {
      if (node === null || node === undefined) return node;
      if (typeof node === "string") return this.redactMessage(node);
      if (typeof node === "number") {
        return this.redactCards && this.isCardNumber(node)
          ? this.replacement
          : node;
      }
      if (typeof node !== "object") return node;
      if (seen.has(node)) return "[Circular]";
      seen.add(node);
      if (Array.isArray(node)) {
        return node.map((item) => walk(item));
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = this.isSensitiveKey(k) ? this.replacement : walk(v);
      }
      return out;
    };
    return walk(attributes) as Record<string, unknown>;
  }

  private apply(text: string): string {
    let out = text;
    for (const rule of this.rules) {
      const copy = new RegExp(rule.source, rule.flags);
      out = out.replace(copy, (...args) => {
        // Preserve URL user prefix or key= prefix if captured
        if (
          rule.source.startsWith("([a-z]") &&
          typeof args[1] === "string" &&
          typeof args[3] === "string"
        ) {
          return `${args[1]}${this.replacement}${args[3]}`;
        }
        if (
          rule.source.startsWith("\\b((?:password") &&
          typeof args[1] === "string"
        ) {
          return `${args[1]}${this.replacement}`;
        }
        return this.replacement;
      });
    }
    if (this.redactCards) {
      out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, (match) => {
        const digits = match.replace(/[ -]/g, "");
        if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
          return this.replacement;
        }
        return match;
      });
    }
    return out;
  }

  private isCardNumber(value: number): boolean {
    if (!Number.isInteger(value) || value < 0) return false;
    const digits = String(value);
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
  }
}
