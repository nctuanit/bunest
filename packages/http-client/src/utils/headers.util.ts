import type {
  HeaderValue,
  HttpHeadersInit,
} from "../interfaces/http-request.interface";

/**
 * Layers header inputs; `null` removes, `undefined` is ignored, arrays repeat.
 * An invalid value (a line break, say) throws without echoing it, since
 * header values are often credentials.
 */
export function mergeHeaders(
  target: Headers,
  ...layers: Array<HttpHeadersInit | undefined>
): Headers {
  for (const layer of layers) {
    if (!layer) {
      continue;
    }
    const entries: Array<[string, HeaderValue]> = [];
    if (isHeadersLike(layer)) {
      layer.forEach((value, key) => entries.push([key, value]));
    } else {
      entries.push(...Object.entries(layer));
    }
    for (const [key, value] of entries) {
      if (value === undefined) {
        continue;
      }
      target.delete(key); // throws for an invalid name, which is safe to show
      if (value === null) {
        continue;
      }
      const items = Array.isArray(value) ? value : [String(value)];
      for (const item of items) {
        try {
          target.append(key, item);
        } catch {
          throw new TypeError(
            `Invalid value for the "${key}" header: it contains a line break or NUL`,
          );
        }
      }
    }
  }
  return target;
}

/** A `Headers` instance, from this realm or another one. */
function isHeadersLike(value: unknown): value is Headers {
  if (value instanceof Headers) {
    return true;
  }
  const candidate = value as Partial<Headers> | null | undefined;
  return (
    typeof candidate?.forEach === "function" &&
    typeof candidate.get === "function" &&
    typeof candidate.has === "function"
  );
}
