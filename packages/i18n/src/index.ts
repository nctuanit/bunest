import "reflect-metadata";

// Module
export { I18N_MODULE_OPTIONS } from "./i18n.constants";
export { I18nModule } from "./i18n.module";
export type {
  I18nForRootOptions,
  I18nModuleAsyncOptions,
  I18nOptionsFactory,
} from "./i18n.module-definition";
export type {
  I18nCatalog,
  I18nCatalogs,
  I18nMissingKeyPolicy,
} from "./interfaces/i18n-catalog.interface";
export type { I18nKey, I18nTypes } from "./interfaces/i18n-keys.interface";
export type { I18nModuleOptions } from "./interfaces/i18n-module-options.interface";
export type {
  I18nDateFormatOptions,
  I18nNumberFormatOptions,
  I18nTranslateOptions,
} from "./interfaces/i18n-translate-options.interface";
export type { JsonI18nLoaderOptions } from "./interfaces/json-loader-options.interface";
export type { LocaleResolverInput } from "./interfaces/locale-resolver-input.interface";

// Translating: the service, the request's locale, and t() for code without DI
export { I18nContext } from "./context/i18n.context";
export { t } from "./context/translate";
export { CurrentLocale } from "./decorators/current-locale.decorator";
export { I18nMissingKeyError } from "./errors/i18n-missing-key.error";
export { I18nService } from "./i18n.service";

// Catalog loaders
export { I18nLoader } from "./loaders/i18n.loader";
export { InMemoryI18nLoader } from "./loaders/in-memory.loader";
export { JsonI18nLoader } from "./loaders/json.loader";

// Message formatting: extend it for another message syntax, such as ICU
export { I18nMessageFormatter } from "./formatters/i18n-message.formatter";

// Locale resolvers
export { AcceptLanguageLocaleResolver } from "./resolvers/accept-language-locale.resolver";
export { CookieLocaleResolver } from "./resolvers/cookie-locale.resolver";
export { HeaderLocaleResolver } from "./resolvers/header-locale.resolver";
export { LocaleResolver } from "./resolvers/locale.resolver";
export { QueryLocaleResolver } from "./resolvers/query-locale.resolver";

// Validation messages: class-validator and Standard Schema
export { I18nStandardSchemaValidationPipe } from "./pipes/i18n-standard-schema-validation.pipe";
export { I18nValidationPipe } from "./pipes/i18n-validation.pipe";
export {
  i18nIssueMessage,
  translateStandardSchemaIssues,
} from "./validation/standard-schema-messages";
export {
  i18nValidationMessage,
  translateValidationErrors,
} from "./validation/validation-messages";
