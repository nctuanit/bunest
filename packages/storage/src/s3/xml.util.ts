export function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec: string) =>
      String.fromCodePoint(parseInt(dec, 10)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function encodeXml(text: string): string {
  return Bun.escapeHTML(text).replaceAll("&#x27;", "&apos;");
}

/**
 * Parses an S3 XML response document via Bun's native `Bun.XML.parse()`.
 * Returns `undefined` when the input is empty or not valid XML.
 */
export function parseS3Xml(xml: string): Record<string, unknown> | undefined {
  const trimmed = xml.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = Bun.XML.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function findFirstTagValue(node: unknown, tag: string): string | undefined {
  if (node === null || node === undefined) return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findFirstTagValue(item, tag);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (typeof node !== "object") return undefined;
  const obj = node as Record<string, unknown>;
  if (Object.hasOwn(obj, tag)) {
    const val = obj[tag];
    if (val === null || val === undefined) return "";
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      return String(val);
    }
    if (Array.isArray(val) && val.length > 0) {
      const first = val[0];
      if (typeof first === "string" || typeof first === "number" || typeof first === "boolean") {
        return String(first);
      }
    }
  }
  for (const child of Object.values(obj)) {
    const hit = findFirstTagValue(child, tag);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Extracts all objects/records matching `<tag>` via native `Bun.XML.parse()`. */
export function xmlNodes(xml: string, tag: string): Array<Record<string, unknown>> {
  const parsed = parseS3Xml(xml);
  if (!parsed) return [];
  const results: Array<Record<string, unknown>> = [];
  const visit = (node: unknown): void => {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (Object.hasOwn(obj, tag)) {
      const val = obj[tag];
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item && typeof item === "object") {
            results.push(item as Record<string, unknown>);
          }
        }
      } else if (val && typeof val === "object") {
        results.push(val as Record<string, unknown>);
      }
    }
    for (const child of Object.values(obj)) {
      visit(child);
    }
  };
  visit(parsed);
  return results;
}

/** The inner XML of every `<tag>` element (and `''` for `<tag/>`). */
export function xmlElements(xml: string, tag: string): string[] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<${escaped}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${escaped}>)`,
    "g",
  );
  const out: string[] = [];
  for (const match of xml.matchAll(re)) {
    out.push(match[1] ?? "");
  }
  return out;
}

/** The decoded text of the first `<tag>` element (powered by `Bun.XML.parse()`). */
export function xmlText(xml: string, tag: string): string | undefined {
  const parsed = parseS3Xml(xml);
  if (parsed) {
    const found = findFirstTagValue(parsed, tag);
    if (found !== undefined) return found;
  }
  const elements = xmlElements(xml, tag);
  if (elements.length === 0) {
    return undefined;
  }
  return decodeXml(elements[0]!);
}
