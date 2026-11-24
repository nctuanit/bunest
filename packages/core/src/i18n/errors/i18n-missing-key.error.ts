import { quote } from "../utils/quote.util";

/** Thrown for a missing translation under the `missingKey: 'throw'` policy. */
export class I18nMissingKeyError extends Error {
  readonly key: string;
  readonly locale: string;

  constructor(key: string, locale: string) {
    super(`Missing translation ${quote(key)} for locale ${quote(locale)}`);
    this.key = key;
    this.locale = locale;
    this.name = "I18nMissingKeyError";
  }
}
