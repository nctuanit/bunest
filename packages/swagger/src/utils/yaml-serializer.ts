/**
 * Zero-dependency OpenAPI JSON-to-YAML 1.2 serializer.
 * Safely escapes YAML reserved literals, numeric strings, path keys, multiline strings,
 * and special indicators so any OpenAPI 3.x document serializes cleanly to valid YAML.
 */

const YAML_RESERVED_WORDS = new Set([
  "true",
  "false",
  "null",
  "yes",
  "no",
  "on",
  "off",
  "y",
  "n",
  "~",
  ".nan",
  ".inf",
  "-.inf",
  "+.inf",
]);

const NUMERIC_LIKE_RE =
  /^[+-]?(?:0|[1-9][0-9_]*)(?:\.[0-9_]*)?(?:[eE][+-]?[0-9]+)?$|^0x[0-9a-fA-F_]+$|^0o[0-7_]+$|^0b[01_]+$/;

const DATE_LIKE_RE = /^\d{4}-\d{2}-\d{2}(?:[tT ]\d{2}:\d{2}:\d{2})?/;

const UNSAFE_PLAIN_CHAR_RE = /[:#\[\]{}&*!|>'"%@`,?\\\r\n\t\x00-\x1f\x7f]/;

function needsQuotes(str: string, isKey = false): boolean {
  if (str.length === 0) return true;
  if (str.trim() !== str) return true;
  if (YAML_RESERVED_WORDS.has(str.toLowerCase())) return true;
  if (NUMERIC_LIKE_RE.test(str)) return true;
  if (DATE_LIKE_RE.test(str)) return true;
  if (str.startsWith("-") || str.startsWith("?") || str.startsWith(":")) {
    return true;
  }
  if (UNSAFE_PLAIN_CHAR_RE.test(str)) return true;
  if (isKey && (str.includes(" ") || str.includes("/"))) {
    // Path keys like /users/{id} have `{}` caught above; plain `/health` is safe unless quoted
    return str.includes(" ");
  }
  return false;
}

function formatScalarString(
  str: string,
  indent: number,
  isKey = false,
): string {
  if (
    !isKey &&
    str.includes("\n") &&
    !str.includes("\r") &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(str)
  ) {
    const lines = str.split("\n");
    const firstNonEmpty = lines.find((line) => line.length > 0);
    // All-newline / empty-lines-only strings serialize most safely as JSON strings
    if (firstNonEmpty === undefined) {
      return JSON.stringify(str);
    }
    const needsExplicitIndent = firstNonEmpty.startsWith(" ");
    const indentIndicator = needsExplicitIndent ? "2" : "";
    let chomp = "-";
    if (str.endsWith("\n\n")) {
      chomp = "+";
    } else if (str.endsWith("\n")) {
      chomp = "";
    }
    const pad = " ".repeat(indent + 2);
    const contentLines = str.endsWith("\n") ? lines.slice(0, -1) : lines;
    const body = contentLines
      .map((line) => (line.length > 0 ? `${pad}${line}` : ""))
      .join("\n");
    return `|${indentIndicator}${chomp}\n${body}`;
  }
  if (needsQuotes(str, isKey)) {
    return JSON.stringify(str);
  }
  return str;
}

function formatKey(key: string): string {
  return formatScalarString(key, 0, true);
}

function isPlainEmptyObject(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const [, v] of Object.entries(value)) {
    if (v !== undefined) return false;
  }
  return true;
}

function serializeNode(value: unknown, indent: number): string {
  if (value === null || value === undefined) {
    return "null";
  }

  const t = typeof value;
  if (t === "boolean") {
    return value ? "true" : "false";
  }
  if (t === "number") {
    return Number.isFinite(value as number) ? String(value) : "null";
  }
  if (t === "string") {
    return formatScalarString(value as string, indent, false);
  }
  if (t === "bigint") {
    return String(value);
  }

  const pad = " ".repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    const lines: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        !isPlainEmptyObject(item)
      ) {
        const entries = Object.entries(item).filter(([, v]) => v !== undefined);
        const firstEntry = entries[0]!;
        const firstKey = formatKey(firstEntry[0]);
        const firstVal = firstEntry[1];
        if (isCompoundNonEmpty(firstVal)) {
          lines.push(`${pad}- ${firstKey}:`);
          lines.push(serializeNode(firstVal, indent + 4));
        } else {
          lines.push(
            `${pad}- ${firstKey}: ${serializeNode(firstVal, indent + 2)}`,
          );
        }
        const subPad = " ".repeat(indent + 2);
        for (let j = 1; j < entries.length; j++) {
          const [k, v] = entries[j]!;
          const fk = formatKey(k);
          if (isCompoundNonEmpty(v)) {
            lines.push(`${subPad}${fk}:`);
            lines.push(serializeNode(v, indent + 4));
          } else {
            lines.push(`${subPad}${fk}: ${serializeNode(v, indent + 2)}`);
          }
        }
      } else if (Array.isArray(item) && item.length > 0) {
        lines.push(`${pad}-`);
        lines.push(serializeNode(item, indent + 2));
      } else {
        lines.push(`${pad}- ${serializeNode(item, indent)}`);
      }
    }
    return lines.join("\n");
  }

  if (t === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0) {
      return "{}";
    }
    const lines: string[] = [];
    for (const [k, v] of entries) {
      const fk = formatKey(k);
      if (isCompoundNonEmpty(v)) {
        lines.push(`${pad}${fk}:`);
        lines.push(serializeNode(v, indent + 2));
      } else {
        lines.push(`${pad}${fk}: ${serializeNode(v, indent)}`);
      }
    }
    return lines.join("\n");
  }

  return JSON.stringify(String(value));
}

function isCompoundNonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value !== null && typeof value === "object") {
    return !isPlainEmptyObject(value);
  }
  return false;
}

/**
 * Serializes any JSON-compatible OpenAPI object into a clean YAML 1.2 string.
 */
export function serializeToYaml(value: unknown): string {
  return `${serializeNode(value, 0)}\n`;
}
