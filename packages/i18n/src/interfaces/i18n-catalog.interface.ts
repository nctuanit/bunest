/** One locale's messages: `{ orders: { notFound: '...' } }`. */
export interface I18nCatalog {
  [key: string]: string | I18nCatalog;
}

/** Catalogs keyed by locale: `{ en: {...}, pl: {...} }`. */
export type I18nCatalogs = Record<string, I18nCatalog>;

/**
 * What to do when a key is missing from the requested locale's chain.
 * - `fallback` (default): also try `defaultLocale` (and warn, per
 *   `logMissingKeys`), then return the key
 * - `key`: return the key (no default-locale fallback)
 * - `empty`: return `''`
 * - `throw`: throw `I18nMissingKeyError`
 * - function: return whatever it returns
 * Explicit `fallbacks` and base-language fallback (`de-AT` -> `de`) apply in
 * every mode; only the jump to `defaultLocale` is policy-controlled.
 */
export type I18nMissingKeyPolicy =
  | "fallback"
  | "key"
  | "empty"
  | "throw"
  | ((key: string, locale: string) => string);
