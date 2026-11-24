import { ContextStorage } from "../../common/index";
import { getCurrentRequestContext } from "../../http/index";
import type { I18nTranslateOptions } from "../interfaces/i18n-translate-options.interface";
import type { LocaleResolver } from "../resolvers/locale.resolver";

/** Minimal service contract stored inside `I18nStore` to avoid circular imports (internal). */
export interface I18nStoreService {
  translate(key: string, options?: I18nTranslateOptions): string;
  exists(key: string, locale?: string): boolean;
}

/** What the module keeps per request (internal). */
export interface I18nStore {
  locale: string;
  /** Lets code without DI (`t()`, validation messages) reach the catalogs. */
  service: I18nStoreService;
  /**
   * `afterGuards` resolvers that rank above the locale the middleware found.
   * The interceptor runs them once guards have run; `settled` makes the
   * concurrent calls of one request (GraphQL root fields) share one run.
   */
  pending?: {
    resolvers: LocaleResolver[];
    settled?: Promise<void>;
  };
  /** Keeps `Content-Language` in step when the locale changes after the middleware. */
  onChange?: (locale: string) => void;
}

/** One store for the package. `I18nContext` is its public face. */
export const i18nStorage = new ContextStorage<I18nStore>();

/**
 * Links a Bunest HTTP `RequestContext` to its `I18nStore` so exception filters
 * executed in the pipeline's `catch` stage (after middleware ALS unwinds) still
 * observe the exact request locale and service without memory leaks.
 */
const requestI18nStores = new WeakMap<object, I18nStore>();

/** Associates `store` with the active HTTP `RequestContext` (internal). */
export function bindRequestI18nStore(
  requestContext: object,
  store: I18nStore,
): void {
  requestI18nStores.set(requestContext, store);
}

/** Returns the active `I18nStore` from ALS or the ambient HTTP `RequestContext` (internal). */
export function getI18nStore(): I18nStore | undefined {
  const direct = i18nStorage.getStore();
  if (direct) {
    return direct;
  }
  const reqCtx = getCurrentRequestContext();
  return reqCtx ? requestI18nStores.get(reqCtx) : undefined;
}

/** Makes `locale`, a supported locale, the store's locale for the rest of the call. */
export function changeLocale(store: I18nStore, locale: string): void {
  if (store.locale === locale) {
    return;
  }
  store.locale = locale;
  store.onChange?.(locale);
}
