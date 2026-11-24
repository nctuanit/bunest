import { Logger } from "../../common/index";
import type {
  I18nKey,
  I18nRegisteredTranslations,
  I18nTranslateArgs,
} from "../interfaces/i18n-keys.interface";
import type { I18nTranslateOptions } from "../interfaces/i18n-translate-options.interface";
import { quote } from "../utils/quote.util";
import { getI18nStore } from "./i18n.storage";

let warnedOutsideContext = false;

/**
 * `I18nService.t()` for code without dependency injection, such as an
 * exception factory of a pipe created with `new`:
 * `new BadRequestException(t('orders.invalidId'))`. Translates right away,
 * for the current request. Outside a request (and outside
 * `I18nContext.run()`) there's no catalog to read, so it returns the key.
 */
export function t<
  T = I18nRegisteredTranslations,
  K extends I18nKey<T> = I18nKey<T>,
>(key: K, ...[options]: I18nTranslateArgs<T, K>): string {
  return translateInContext(key, options);
}

/** Translates with the current store's service, or returns the key. */
export function translateInContext(
  key: string,
  options?: I18nTranslateOptions,
): string {
  const store = getI18nStore();
  if (store) {
    return store.service.translate(key, options);
  }
  if (!warnedOutsideContext) {
    warnedOutsideContext = true;
    new Logger("I18nModule").warn(
      `${quote(key)} was translated outside a request, so the key was returned. ` +
        "Inject I18nService, or wrap the code in I18nContext.run().",
    );
  }
  return key;
}
