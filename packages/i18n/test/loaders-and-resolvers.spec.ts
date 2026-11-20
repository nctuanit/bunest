import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AcceptLanguageLocaleResolver,
  CookieLocaleResolver,
  HeaderLocaleResolver,
  InMemoryI18nLoader,
  JsonI18nLoader,
  QueryLocaleResolver,
  type I18nCatalogs,
} from "../src/index";
import { parseAcceptLanguage } from "../src/resolvers/accept-language-locale.resolver";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bunest-i18n-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("Loaders", () => {
  it("InMemoryI18nLoader returns given catalogs", () => {
    const catalogs: I18nCatalogs = { en: { greeting: "Hello" } };
    const loader = new InMemoryI18nLoader(catalogs);
    expect(loader.load()).toBe(catalogs);
  });

  it("JsonI18nLoader loads nested namespaces, merges file+dir, and skips hidden entries", async () => {
    const root = await makeTempDir();
    await mkdir(join(root, "en", "users"), { recursive: true });
    await mkdir(join(root, ".hidden"), { recursive: true });
    await mkdir(join(root, "pl"), { recursive: true });

    await writeFile(
      join(root, "en", "users.json"),
      JSON.stringify({ title: "Users", greeting: "Hi {name}" }),
    );
    await writeFile(
      join(root, "en", "users", "admin.json"),
      JSON.stringify({ role: "Administrator" }),
    );
    await writeFile(
      join(root, "en", ".ignored.json"),
      JSON.stringify({ secret: "nope" }),
    );
    await writeFile(
      join(root, ".hidden", "x.json"),
      JSON.stringify({ bad: "skip" }),
    );
    await writeFile(
      join(root, "pl", "users.json"),
      JSON.stringify({ title: "Użytkownicy" }),
    );

    const loader = new JsonI18nLoader({ path: root });
    const loaded = await loader.load();

    expect(Object.keys(loaded).sort()).toEqual(["en", "pl"]);
    expect(loaded.en).toEqual({
      users: {
        title: "Users",
        greeting: "Hi {name}",
        admin: {
          role: "Administrator",
        },
      },
    });
    expect(loaded.pl).toEqual({
      users: {
        title: "Użytkownicy",
      },
    });
  });

  it("JsonI18nLoader throws on duplicate keys across merged file and directory", async () => {
    const root = await makeTempDir();
    await mkdir(join(root, "en", "users"), { recursive: true });
    await writeFile(
      join(root, "en", "users.json"),
      JSON.stringify({ admin: "conflict" }),
    );
    await writeFile(
      join(root, "en", "users", "admin.json"),
      JSON.stringify({ role: "Admin" }),
    );

    const loader = new JsonI18nLoader({ path: root });
    await expect(loader.load()).rejects.toThrow(/defined twice/);
  });

  it("JsonI18nLoader throws clear errors on ENOENT and malformed JSON", async () => {
    const missing = join(tmpdir(), "bunest-i18n-definitely-missing-dir-12345");
    await expect(new JsonI18nLoader({ path: missing }).load()).rejects.toThrow(
      /ENOENT/,
    );

    const root = await makeTempDir();
    await mkdir(join(root, "en"), { recursive: true });
    await writeFile(join(root, "en", "bad.json"), "{ invalid json");
    await expect(new JsonI18nLoader({ path: root }).load()).rejects.toThrow(
      /bad\.json/,
    );
  });

  it("JsonI18nLoader watch() emits updated catalogs on file changes and stops cleanly", async () => {
    const root = await makeTempDir();
    await mkdir(join(root, "en"), { recursive: true });
    const file = join(root, "en", "app.json");
    await writeFile(file, JSON.stringify({ title: "Initial" }));

    const noWatchStop = new JsonI18nLoader({ path: root, watch: false }).watch(
      () => {},
    );
    noWatchStop();

    const loader = new JsonI18nLoader({ path: root, watch: true });
    let reloaded: I18nCatalogs | undefined;
    const stop = loader.watch((next) => {
      reloaded = next;
    });

    try {
      await new Promise((r) => setTimeout(r, 50));
      await writeFile(file, JSON.stringify({ title: "Updated" }));

      const deadline = Date.now() + 2000;
      while (!reloaded && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 30));
      }
      expect(reloaded?.en).toEqual({ app: { title: "Updated" } });
    } finally {
      stop();
    }
  });
});

describe("Locale Resolvers", () => {
  it("AcceptLanguageLocaleResolver parses q-values, ties, case-insensitive Q, and excludes * / q=0", () => {
    const resolver = new AcceptLanguageLocaleResolver();
    expect(resolver.varyHeaders).toEqual(["Accept-Language"]);

    expect(parseAcceptLanguage("de;q=0.3, pl-PL;q=0.9, en;Q=0.9, *;q=0.1, fr;q=0, bad;q=abc")).toEqual([
      "pl-PL",
      "en",
      "de",
    ]);

    expect(
      resolver.resolve({
        headers: { "accept-language": "es;q=0.5, pl;q=0.8" },
        query: {},
      }),
    ).toEqual(["pl", "es"]);

    expect(
      resolver.resolve({
        headers: {},
        query: {},
      }),
    ).toBeUndefined();
  });

  it("CookieLocaleResolver extracts cookies with default/custom names, quotes, and URL decoding", () => {
    const defaultResolver = new CookieLocaleResolver();
    expect(defaultResolver.varyHeaders).toEqual(["Cookie"]);
    expect(
      defaultResolver.resolve({
        headers: { cookie: 'theme=dark; lang="pt-BR"; foo=bar' },
        query: {},
      }),
    ).toBe("pt-BR");

    const customResolver = new CookieLocaleResolver("locale");
    expect(
      customResolver.resolve({
        headers: { cookie: "locale=zh%2DHant; other=1" },
        query: {},
      }),
    ).toBe("zh-Hant");

    expect(
      customResolver.resolve({
        headers: { cookie: "locale=%E0%A4%A" },
        query: {},
      }),
    ).toBe("%E0%A4%A");

    expect(
      customResolver.resolve({
        headers: { cookie: "locale=" },
        query: {},
      }),
    ).toBeUndefined();
  });

  it("HeaderLocaleResolver reads custom header case-insensitively and preserves Vary spelling", () => {
    const defaultResolver = new HeaderLocaleResolver();
    expect(defaultResolver.varyHeaders).toEqual(["x-lang"]);
    expect(
      defaultResolver.resolve({ headers: { "x-lang": "pl" }, query: {} }),
    ).toBe("pl");

    const customResolver = new HeaderLocaleResolver("X-Custom-Locale");
    expect(customResolver.varyHeaders).toEqual(["X-Custom-Locale"]);
    expect(
      customResolver.resolve({
        headers: { "x-custom-locale": ["de-AT", "en"] },
        query: {},
      }),
    ).toBe("de-AT");
  });

  it("QueryLocaleResolver reads query params with default/custom name and array support", () => {
    const defaultResolver = new QueryLocaleResolver();
    expect(defaultResolver.varyHeaders).toBeUndefined();
    expect(
      defaultResolver.resolve({ headers: {}, query: { lang: "pl" } }),
    ).toBe("pl");
    expect(
      defaultResolver.resolve({ headers: {}, query: { lang: ["de", "fr"] } }),
    ).toBe("de");
    expect(
      defaultResolver.resolve({ headers: {}, query: { lang: "" } }),
    ).toBeUndefined();

    const customResolver = new QueryLocaleResolver("l");
    expect(
      customResolver.resolve({ headers: {}, query: { l: "en" } }),
    ).toBe("en");
  });
});
