/** A header or query value repeated as an array counts by its first entry; an empty string counts as none (internal). */
export function first(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * The query string of a raw request URL, as an object (internal). A repeated
 * parameter keeps its first value, as `QueryLocaleResolver` reads the first
 * entry of the arrays Express and Fastify parse: `?lang=pl&lang=de` -> `pl`.
 */
export function queryOf(url: unknown): Record<string, string> {
  if (typeof url !== "string") {
    return {};
  }
  const start = url.indexOf("?");
  // Null prototype: a `__proto__` parameter is an ordinary key.
  const query: Record<string, string> = Object.create(null);
  if (start === -1) {
    return query;
  }
  const hash = url.indexOf("#", start);
  const search = hash === -1 ? url.slice(start) : url.slice(start, hash);
  for (const [name, value] of new URLSearchParams(search)) {
    if (!Object.hasOwn(query, name)) {
      query[name] = value;
    }
  }
  return query;
}

/**
 * Normalizes Web `Headers` or Node/Express/Fastify plain header records into
 * a lower-cased, null-prototype record (internal).
 */
export function headersOf(
  rawHeaders: unknown,
): Record<string, string | string[] | undefined> {
  const normalized: Record<string, string | string[] | undefined> =
    Object.create(null);
  if (!rawHeaders || typeof rawHeaders !== "object") {
    return normalized;
  }

  if (
    typeof (rawHeaders as Headers).forEach === "function" &&
    typeof (rawHeaders as Headers).get === "function"
  ) {
    (rawHeaders as Headers).forEach((value, key) => {
      normalized[key.toLowerCase()] = value;
    });
    return normalized;
  }

  for (const [key, value] of Object.entries(
    rawHeaders as Record<string, unknown>,
  )) {
    if (
      typeof value === "string" ||
      Array.isArray(value) ||
      value === undefined
    ) {
      normalized[key.toLowerCase()] = value as string | string[] | undefined;
    }
  }
  return normalized;
}
