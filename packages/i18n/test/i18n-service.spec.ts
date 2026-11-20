import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  I18nContext,
  I18nLoader,
  I18nMessageFormatter,
  I18nMissingKeyError,
  I18nService,
  InMemoryI18nLoader,
  type I18nCatalogs,
  type I18nModuleOptions,
} from "../src/index";
import { PlaceholderMessageFormatter } from "../src/formatters/placeholder-message.formatter";

function createService(
  catalogs: I18nCatalogs,
  options: I18nModuleOptions = {},
  formatter: I18nMessageFormatter = new PlaceholderMessageFormatter(),
  loader: I18nLoader = new InMemoryI18nLoader(catalogs),
) {
  const service = new I18nService(options, catalogs, loader, formatter);
  const context = new I18nContext(service);
  return { service, context };
}

describe("I18nService & Message Formatting", () => {
  it("translates nested keys, placeholders, escaped braces, and null-prototype args", () => {
    const { service } = createService({
      en: {
        common: {
          hello: "Hello, {name}!",
          literal: "Use {{name}} to greet {name}",
          triple: "{{{name}}}",
          missingArg: "Hello {unknown}",
          raw: "Value: {val}",
        },
      },
    });

    expect(service.t("common.hello", { args: { name: "Ada" } })).toBe(
      "Hello, Ada!",
    );
    expect(service.t("common.literal", { args: { name: "Ada" } })).toBe(
      "Use {name} to greet Ada",
    );
    expect(service.t("common.triple", { args: { name: "Ada" } })).toBe(
      "{Ada}",
    );
    expect(service.t("common.missingArg")).toBe("Hello {unknown}");

    const nullProto = Object.create(null);
    expect(service.t("common.raw", { args: { val: nullProto } })).toBe(
      "Value: [object Object]",
    );
  });

  it("selects plural forms via Intl.PluralRules across locales and falls back to other", () => {
    const { service } = createService({
      en: {
        items: {
          one: "{count} item",
          other: "{count} items",
        },
      },
      pl: {
        items: {
          one: "{count} przedmiot",
          few: "{count} przedmioty",
          many: "{count} przedmiotów",
          other: "{count} przedmiotu",
        },
      },
    });

    expect(service.t("items", { args: { count: 1 } })).toBe("1 item");
    expect(service.t("items", { args: { count: 0 } })).toBe("0 items");
    expect(service.t("items", { args: { count: 5 } })).toBe("5 items");
    expect(service.t("items")).toBe("{count} items");

    expect(service.t("items", { locale: "pl", args: { count: 1 } })).toBe(
      "1 przedmiot",
    );
    expect(service.t("items", { locale: "pl", args: { count: 2 } })).toBe(
      "2 przedmioty",
    );
    expect(service.t("items", { locale: "pl", args: { count: 5 } })).toBe(
      "5 przedmiotów",
    );
  });

  it("supports inline Intl plural, select, number, and date formatting in default formatter", () => {
    const { service } = createService({
      en: {
        cart: "{count, plural, =0 {No items} one {# item for {user}} other {# items for {user}}}",
        party:
          "{count, plural, offset:1 =0 {Nobody} =1 {Only {host}} one {{host} and # other} other {{host} and # others}}",
        pronoun:
          "{gender, select, female {She ordered {item}} male {He ordered {item}} other {They ordered {item}}}",
        price: "Total: {amount, number, currency:USD}",
        ratio: "Progress: {rate, number, percent}",
        whole: "Rounded: {n, number, integer}",
        dateMsg: "On {when, date, short}",
      },
      de: {
        price: "Summe: {amount, number, currency:EUR}",
      },
    });

    expect(service.t("cart", { args: { count: 0, user: "Sam" } })).toBe(
      "No items",
    );
    expect(service.t("cart", { args: { count: 1, user: "Sam" } })).toBe(
      "1 item for Sam",
    );
    expect(service.t("cart", { args: { count: 3, user: "Sam" } })).toBe(
      "3 items for Sam",
    );

    expect(service.t("party", { args: { count: 0, host: "Lin" } })).toBe(
      "Nobody",
    );
    expect(service.t("party", { args: { count: 1, host: "Lin" } })).toBe(
      "Only Lin",
    );
    expect(service.t("party", { args: { count: 2, host: "Lin" } })).toBe(
      "Lin and 1 other",
    );
    expect(service.t("party", { args: { count: 4, host: "Lin" } })).toBe(
      "Lin and 3 others",
    );

    expect(
      service.t("pronoun", { args: { gender: "female", item: "tea" } }),
    ).toBe("She ordered tea");
    expect(
      service.t("pronoun", { args: { gender: "other", item: "tea" } }),
    ).toBe("They ordered tea");

    expect(service.t("price", { args: { amount: 12.5 } })).toBe(
      `Total: ${new Intl.NumberFormat("en", { style: "currency", currency: "USD" }).format(12.5)}`,
    );
    expect(service.t("price", { locale: "de", args: { amount: 12.5 } })).toBe(
      `Summe: ${new Intl.NumberFormat("de", { style: "currency", currency: "EUR" }).format(12.5)}`,
    );
    expect(service.t("ratio", { args: { rate: 0.75 } })).toBe(
      `Progress: ${new Intl.NumberFormat("en", { style: "percent" }).format(0.75)}`,
    );
    expect(service.t("whole", { args: { n: 42.9 } })).toBe(
      `Rounded: ${new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(42.9)}`,
    );

    const sampleDate = new Date(Date.UTC(2025, 0, 15));
    expect(service.t("dateMsg", { args: { when: sampleDate } })).toBe(
      `On ${new Intl.DateTimeFormat("en", { dateStyle: "short" }).format(sampleDate)}`,
    );
  });

  it("supports custom I18nMessageFormatter implementations", () => {
    class UpperFormatter extends I18nMessageFormatter {
      override format(
        message: string,
        args: Record<string, unknown>,
        locale: string,
      ): string {
        return `[${locale}] ${message.replace("%s", String(args.v ?? "")).toUpperCase()}`;
      }
    }

    const { service } = createService(
      { en: { greet: "hi %s" } },
      {},
      new UpperFormatter(),
    );
    expect(service.t("greet", { args: { v: "world" } })).toBe("[en] HI WORLD");
  });

  it("formats numbers and dates via formatNumber and formatDate", () => {
    const { service, context } = createService({
      en: { ok: "ok" },
      de: { ok: "ok" },
    });

    const expectedEnNum = new Intl.NumberFormat("en", {
      style: "currency",
      currency: "USD",
    }).format(1234.5);
    const expectedDeNum = new Intl.NumberFormat("de", {
      style: "currency",
      currency: "EUR",
    }).format(1234.5);

    expect(
      service.formatNumber(1234.5, { style: "currency", currency: "USD" }),
    ).toBe(expectedEnNum);
    expect(
      service.formatNumber(1234.5, {
        locale: "de-DE",
        style: "currency",
        currency: "EUR",
      }),
    ).toBe(expectedDeNum);

    const d = new Date(Date.UTC(2025, 4, 1));
    const expectedDeDate = new Intl.DateTimeFormat("de", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
    context.run("de", () => {
      expect(
        service.formatDate(d, {
          timeZone: "UTC",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }),
      ).toBe(expectedDeDate);
    });
  });

  it("matches BCP 47 locales with normalization, prefix stripping, and singleton removal", () => {
    const { service } = createService(
      {
        en: { ok: "ok" },
        "zh-Hant": { ok: "ok" },
        zh: { ok: "ok" },
        "sr-Latn": { ok: "ok" },
        pl: { ok: "ok" },
      },
      { fallbacks: { "de-AT": "en" } },
    );

    expect(service.matchLocale("PL_pl")).toBe("pl");
    expect(service.matchLocale("zh-Hant-TW")).toBe("zh-Hant");
    expect(service.matchLocale("zh-Hans-CN")).toBe("zh");
    expect(service.matchLocale("sr-Latn-x-private-ext")).toBe("sr-Latn");
    expect(service.matchLocale("de_at")).toBe("de-AT");
    expect(service.matchLocale("fr-FR")).toBeUndefined();
    expect(service.matchLocale("x".repeat(500))).toBeUndefined();
    expect(service.supportedLocales).toContain("de-AT");
  });

  it("follows fallback chains and missingKey policies (fallback, key, empty, throw, custom fn)", () => {
    const catalogs: I18nCatalogs = {
      en: {
        shared: "EN shared",
        onlyEn: "EN only",
        plural: { one: "{count} EN one", other: "{count} EN other" },
      },
      de: {
        shared: "DE shared",
      },
      "de-AT": {
        local: "AT local",
      },
    };

    const { service: fallbackSvc } = createService(catalogs, {
      fallbacks: { "de-AT": "de" },
      missingKey: "fallback",
      logMissingKeys: "never",
    });
    expect(fallbackSvc.t("local", { locale: "de-AT" })).toBe("AT local");
    expect(fallbackSvc.t("shared", { locale: "de-AT" })).toBe("DE shared");
    expect(fallbackSvc.t("onlyEn", { locale: "de-AT" })).toBe("EN only");
    expect(fallbackSvc.t("nope", { locale: "de-AT" })).toBe("nope");
    expect(fallbackSvc.exists("onlyEn", "de-AT")).toBe(true);
    expect(fallbackSvc.exists("plural", "en")).toBe(true);
    expect(fallbackSvc.exists("missing.ns", "en")).toBe(false);

    // key policy: still uses explicit/prefix fallback de-AT -> de, but NOT defaultLocale en
    const { service: keySvc } = createService(catalogs, {
      fallbacks: { "de-AT": "de" },
      missingKey: "key",
      logMissingKeys: "never",
    });
    expect(keySvc.t("shared", { locale: "de-AT" })).toBe("DE shared");
    expect(keySvc.t("onlyEn", { locale: "de-AT" })).toBe("onlyEn");
    expect(keySvc.exists("onlyEn", "de-AT")).toBe(false);

    // empty policy
    const { service: emptySvc } = createService(catalogs, {
      missingKey: "empty",
      logMissingKeys: "never",
    });
    expect(emptySvc.t("onlyEn", { locale: "de" })).toBe("");

    // throw policy
    const { service: throwSvc } = createService(catalogs, {
      missingKey: "throw",
      logMissingKeys: "never",
    });
    let caught: unknown;
    try {
      throwSvc.t("onlyEn", { locale: "de" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(I18nMissingKeyError);
    expect((caught as I18nMissingKeyError).key).toBe("onlyEn");
    expect((caught as I18nMissingKeyError).locale).toBe("de");
    expect((caught as I18nMissingKeyError).name).toBe("I18nMissingKeyError");

    // function policy
    const { service: fnSvc } = createService(catalogs, {
      missingKey: (key, locale) => `[MISSING:${locale}:${key}]`,
      logMissingKeys: "never",
    });
    expect(fnSvc.t("onlyEn", { locale: "de" })).toBe("[MISSING:de:onlyEn]");
  });

  it("validates startup options and catalog locale tags strictly", () => {
    expect(() =>
      createService({ en: { a: "1" } }, { defaultLocale: "pt_BR" }),
    ).toThrow(/Use "pt-BR"/);

    expect(() =>
      createService({ pt_BR: { a: "1" }, en: { a: "1" } }),
    ).toThrow(/Rename it to "pt-BR"/);

    expect(() =>
      createService({ pl: { a: "1" } }, { defaultLocale: "en" }),
    ).toThrow(/no catalog for defaultLocale "en"/);

    expect(() =>
      createService(
        { en: { a: "1" } },
        { missingKey: "invalid" as unknown as "fallback" },
      ),
    ).toThrow(/missingKey/);

    expect(() =>
      createService(
        { en: { a: "1" } },
        { logMissingKeys: "sometimes" as unknown as "once" },
      ),
    ).toThrow(/logMissingKeys/);

    expect(() =>
      createService(
        { en: { a: "1" } },
        { fallbacks: { "bad_tag": "en" } },
      ),
    ).toThrow(/fallbacks/);
  });

  it("ignores prototype keys safely when looking up translations", () => {
    const { service } = createService(
      { en: { nested: { ok: "yes" } } },
      { missingKey: "key", logMissingKeys: "never" },
    );

    expect(service.t("toString")).toBe("toString");
    expect(service.t("constructor")).toBe("constructor");
    expect(service.t("__proto__")).toBe("__proto__");
    expect(service.t("nested.toString")).toBe("nested.toString");
    expect(service.exists("toString")).toBe(false);
  });

  it("hot-reloads catalogs via loader.watch() and retains previous catalogs on invalid reload", () => {
    let emit: ((next: I18nCatalogs) => void) | undefined;
    let stopped = false;

    class WatchableLoader extends I18nLoader {
      override load(): I18nCatalogs {
        return { en: { msg: "v1" } };
      }
      override watch(onChange: (catalogs: I18nCatalogs) => void): () => void {
        emit = onChange;
        return () => {
          stopped = true;
        };
      }
    }

    const loader = new WatchableLoader();
    const { service } = createService(
      loader.load(),
      { logMissingKeys: "never" },
      new PlaceholderMessageFormatter(),
      loader,
    );

    service.onModuleInit();
    expect(service.t("msg")).toBe("v1");

    emit!({ en: { msg: "v2" }, fr: { msg: "bonjour" } });
    expect(service.t("msg")).toBe("v2");
    expect(service.t("msg", { locale: "fr" })).toBe("bonjour");

    // Invalid reload (no defaultLocale catalog) must not throw and must keep v2
    emit!({ fr: { msg: "only-fr" } });
    expect(service.t("msg")).toBe("v2");

    service.onModuleDestroy();
    expect(stopped).toBe(true);
  });
});
