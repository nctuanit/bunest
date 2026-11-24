import type { I18nCatalogs } from "../interfaces/i18n-catalog.interface";
import { I18nLoader } from "./i18n.loader";

/** Catalogs given as an object. For tests and small apps. */
export class InMemoryI18nLoader extends I18nLoader {
  private readonly catalogs: I18nCatalogs;

  constructor(catalogs: I18nCatalogs) {
    super();
    this.catalogs = catalogs;
  }

  override load(): I18nCatalogs {
    return this.catalogs;
  }
}
