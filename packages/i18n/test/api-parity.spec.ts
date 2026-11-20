import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import * as i18n from "../src/index";
import type {
  I18nCatalog,
  I18nCatalogs,
  I18nDateFormatOptions,
  I18nForRootOptions,
  I18nKey,
  I18nMissingKeyPolicy,
  I18nModuleAsyncOptions,
  I18nModuleOptions,
  I18nNumberFormatOptions,
  I18nOptionsFactory,
  I18nTranslateOptions,
  I18nTypes,
  JsonI18nLoaderOptions,
  LocaleResolverInput,
} from "../src/index";
import { PlaceholderMessageFormatter } from "../src/formatters/placeholder-message.formatter";

const EXPECTED_RUNTIME_EXPORTS = [
  "I18N_MODULE_OPTIONS",
  "I18nModule",
  "I18nService",
  "I18nContext",
  "CurrentLocale",
  "t",
  "I18nMissingKeyError",
  "I18nLoader",
  "InMemoryI18nLoader",
  "JsonI18nLoader",
  "I18nMessageFormatter",
  "LocaleResolver",
  "AcceptLanguageLocaleResolver",
  "CookieLocaleResolver",
  "HeaderLocaleResolver",
  "QueryLocaleResolver",
  "I18nStandardSchemaValidationPipe",
  "I18nValidationPipe",
  "i18nValidationMessage",
  "translateValidationErrors",
  "i18nIssueMessage",
  "translateStandardSchemaIssues",
].sort();

describe("@bunest/i18n NestJS v12 API Parity", () => {
  it("exports all 22 runtime symbols matching @nestjs/i18n@0.0.3", () => {
    const actual = Object.keys(i18n).sort();
    expect(actual).toEqual(EXPECTED_RUNTIME_EXPORTS);
    expect(i18n.I18N_MODULE_OPTIONS).toBe("I18N_MODULE_OPTIONS");
  });

  it("dist/index.js bundle exports all 22 runtime symbols", async () => {
    const distUrl = new URL("../dist/index.js", import.meta.url).href;
    const built = (await import(distUrl)) as Record<string, unknown>;
    const actual = Object.keys(built).sort();
    expect(actual).toEqual(EXPECTED_RUNTIME_EXPORTS);
    expect(built.I18N_MODULE_OPTIONS).toBe("I18N_MODULE_OPTIONS");
  });

  it("exposes all public static and instance members on every exported class", () => {
    // I18nModule
    expect(typeof i18n.I18nModule.forRoot).toBe("function");
    expect(typeof i18n.I18nModule.forRootAsync).toBe("function");
    expect(typeof i18n.I18nModule.prototype.configure).toBe("function");

    // I18nService
    const svc = new i18n.I18nService(
      { defaultLocale: "en" },
      { en: { hello: "Hi" } },
      new i18n.InMemoryI18nLoader({ en: { hello: "Hi" } }),
      new PlaceholderMessageFormatter(),
    );
    expect(svc.defaultLocale).toBe("en");
    expect(svc.supportedLocales).toEqual(["en"]);
    expect(typeof svc.onModuleInit).toBe("function");
    expect(typeof svc.onModuleDestroy).toBe("function");
    expect(typeof svc.t).toBe("function");
    expect(typeof svc.translate).toBe("function");
    expect(typeof svc.exists).toBe("function");
    expect(typeof svc.formatNumber).toBe("function");
    expect(typeof svc.formatDate).toBe("function");
    expect(typeof svc.matchLocale).toBe("function");

    // I18nContext
    const ctx = new i18n.I18nContext(svc);
    expect(ctx.locale).toBe("en");
    expect(typeof ctx.run).toBe("function");
    expect(typeof ctx.setLocale).toBe("function");

    // I18nMissingKeyError
    const err = new i18n.I18nMissingKeyError("k", "en");
    expect(err).toBeInstanceOf(Error);
    expect(err.key).toBe("k");
    expect(err.locale).toBe("en");
    expect(err.name).toBe("I18nMissingKeyError");

    // Loaders
    const mem = new i18n.InMemoryI18nLoader({ en: { a: "1" } });
    expect(mem).toBeInstanceOf(i18n.I18nLoader);
    expect(typeof mem.load).toBe("function");

    const jsonLoader = new i18n.JsonI18nLoader({ path: "." });
    expect(jsonLoader).toBeInstanceOf(i18n.I18nLoader);
    expect(jsonLoader.options).toEqual({ path: "." });
    expect(typeof jsonLoader.load).toBe("function");
    expect(typeof jsonLoader.watch).toBe("function");

    // Resolvers
    const acceptLang = new i18n.AcceptLanguageLocaleResolver();
    const cookie = new i18n.CookieLocaleResolver();
    const header = new i18n.HeaderLocaleResolver();
    const query = new i18n.QueryLocaleResolver();
    for (const r of [acceptLang, cookie, header, query]) {
      expect(r).toBeInstanceOf(i18n.LocaleResolver);
      expect(typeof r.resolve).toBe("function");
    }
    expect(acceptLang.varyHeaders).toEqual(["Accept-Language"]);
    expect(cookie.varyHeaders).toEqual(["Cookie"]);
    expect(header.varyHeaders).toEqual(["x-lang"]);

    // Pipes
    const valPipe = new i18n.I18nValidationPipe();
    expect(typeof valPipe.transform).toBe("function");
    expect(typeof valPipe.createExceptionFactory).toBe("function");

    const ssPipe = new i18n.I18nStandardSchemaValidationPipe();
    expect(typeof ssPipe.transform).toBe("function");
  });

  it("supports all 14 exported TypeScript types and typed I18nKey inference", () => {
    type SampleTranslations = {
      common: {
        hello: string;
        items: { one: string; other: string };
      };
    };

    const key1: I18nKey<SampleTranslations> = "common.hello";
    const key2: I18nKey<SampleTranslations> = "common.items";
    const catalog: I18nCatalog = { hello: "world" };
    const catalogs: I18nCatalogs = { en: catalog };
    const policy: I18nMissingKeyPolicy = "fallback";
    const modOpts: I18nModuleOptions = { defaultLocale: "en", missingKey: policy };
    const forRootOpts: I18nForRootOptions = {
      loader: new i18n.InMemoryI18nLoader(catalogs),
      defaultLocale: "en",
    };
    const asyncOpts: I18nModuleAsyncOptions = {
      useFactory: () => modOpts,
    };
    const factory: I18nOptionsFactory = {
      createI18nOptions: () => modOpts,
    };
    const tOpts: I18nTranslateOptions = { locale: "en", args: { x: 1 } };
    const numOpts: I18nNumberFormatOptions = { locale: "en", style: "decimal" };
    const dateOpts: I18nDateFormatOptions = { locale: "en", dateStyle: "short" };
    const jsonOpts: JsonI18nLoaderOptions = { path: "./i18n", watch: false };
    const resolverInput: LocaleResolverInput = { headers: {}, query: {} };
    const typesMarker: I18nTypes = {};

    const typedSvc = new i18n.I18nService<SampleTranslations>(
      { defaultLocale: "en" },
      {
        en: {
          common: {
            hello: "Hello",
            items: { one: "{count} item", other: "{count} items" },
          },
        },
      },
      new i18n.InMemoryI18nLoader({ en: { common: { hello: "Hello" } } }),
      new PlaceholderMessageFormatter(),
    );

    expect(typedSvc.t(key1)).toBe("Hello");
    expect(typedSvc.t(key2, { args: { count: 2 } })).toBe("2 items");
    expect([
      forRootOpts,
      asyncOpts,
      factory,
      tOpts,
      numOpts,
      dateOpts,
      jsonOpts,
      resolverInput,
      typesMarker,
    ].length).toBe(9);
  });
});
