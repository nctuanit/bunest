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
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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

/** The decoded text of the first `<tag>` element. */
export function xmlText(xml: string, tag: string): string | undefined {
  const elements = xmlElements(xml, tag);
  if (elements.length === 0) {
    return undefined;
  }
  return decodeXml(elements[0]!);
}
