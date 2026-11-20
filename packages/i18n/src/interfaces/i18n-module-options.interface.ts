import type { I18nMessageFormatter } from "../formatters/i18n-message.formatter";
import type { I18nLoader } from "../loaders/i18n.loader";
import type { LocaleResolver } from "../resolvers/locale.resolver";
import type {
  I18nCatalog,
  I18nCatalogs,
  I18nMissingKeyPolicy,
} from "./i18n-catalog.interface";

export type { I18nCatalog, I18nCatalogs, I18nMissingKeyPolicy };

/**
 * What `forRootAsync()`'s factory returns, and what `forRoot()` takes next to
 * its top-level options. The factory can return `loader` and `resolvers`
 * instances built from injected configuration. Classes that Bunest
 * instantiates go at the top level of `forRoot()` and `forRootAsync()`.
 */
export interface I18nModuleOptions {
  /**
   * Where catalogs come from, such as `new JsonI18nLoader({ path })`.
   * Required, here or at the top level.
   */
  loader?: I18nLoader;
  /** Locale resolvers, tried in order. Default `[new AcceptLanguageLocaleResolver()]`. */
  resolvers?: LocaleResolver[];
  /**
   * Turns messages into text, such as an ICU MessageFormat formatter. The
   * default fills `{name}` placeholders.
   */
  formatter?: I18nMessageFormatter;
  /** Used when no resolver finds a supported locale, and outside requests. Default `'en'`. */
  defaultLocale?: string;
  /**
   * The locales requests can get, as BCP 47 tags (`pl`, `de-AT`). Defaults to
   * the locales the loader returned.
   */
  supportedLocales?: string[];
  /** Explicit fallbacks, e.g. `{ 'de-AT': 'de' }`. Keys count as supported. */
  fallbacks?: Record<string, string>;
  /** Default `'fallback'`. */
  missingKey?: I18nMissingKeyPolicy;
  /**
   * Warn when a key is missing everywhere, and when the `fallback` policy
   * serves a message from `defaultLocale`. Default `'once'` (per key, and per
   * key and locale for fallbacks).
   */
  logMissingKeys?: "once" | "always" | "never";
  /**
   * Set `Content-Language` (the resolved locale) and `Vary` (the headers the
   * resolvers read) on HTTP responses. Default `true`.
   */
  responseHeaders?: boolean;
}
