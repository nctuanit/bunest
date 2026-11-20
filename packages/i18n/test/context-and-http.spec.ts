import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  BadRequestException,
  Catch,
  Controller,
  Get,
  Injectable,
  Module,
  UseFilters,
  UseGuards,
  type ArgumentsHost,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
} from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  AcceptLanguageLocaleResolver,
  CookieLocaleResolver,
  CurrentLocale,
  HeaderLocaleResolver,
  I18N_MODULE_OPTIONS,
  I18nContext,
  I18nLoader,
  I18nMessageFormatter,
  I18nModule,
  I18nService,
  InMemoryI18nLoader,
  LocaleResolver,
  QueryLocaleResolver,
  t,
  type I18nCatalogs,
  type I18nModuleOptions,
  type I18nOptionsFactory,
  type LocaleResolverInput,
} from "../src/index";
import { I18nInterceptor } from "../src/interceptors/i18n.interceptor";
import { I18nMiddleware } from "../src/middleware/i18n.middleware";
import { LocaleResolution } from "../src/services/locale-resolution.service";
import { PlaceholderMessageFormatter } from "../src/formatters/placeholder-message.formatter";

const CATALOGS: I18nCatalogs = {
  en: {
    greet: "Hello {name}",
    errors: {
      bad: "Bad request ({locale})",
      denied: "Access denied",
    },
  },
  pl: {
    greet: "Cześć {name}",
    errors: {
      bad: "Nieprawidłowe żądanie ({locale})",
      denied: "Brak dostępu",
    },
  },
  de: {
    greet: "Hallo {name}",
    errors: {
      bad: "Ungültige Anfrage ({locale})",
      denied: "Zugriff verweigert",
    },
  },
};

describe("I18nContext, t(), and DI Module Registration", () => {
  it("isolates concurrent async executions and handles setLocale()", async () => {
    const loader = new InMemoryI18nLoader(CATALOGS);
    const service = new I18nService(
      { defaultLocale: "en" },
      CATALOGS,
      loader,
      new PlaceholderMessageFormatter(),
    );
    const ctx = new I18nContext(service);

    // Outside context
    expect(ctx.locale).toBe("en");
    expect(t("greet", { args: { name: "World" } })).toBe("greet");
    expect(() => ctx.setLocale("pl")).toThrow(/outside a locale context/);

    // Concurrent isolated runs
    const [r1, r2, r3] = await Promise.all([
      ctx.run("pl-PL", async () => {
        await new Promise((r) => setTimeout(r, 20));
        return `${ctx.locale}:${t("greet", { args: { name: "Jan" } })}`;
      }),
      ctx.run("de", async () => {
        await new Promise((r) => setTimeout(r, 5));
        const switched = ctx.setLocale("pl");
        const ignored = ctx.setLocale("xx-INVALID");
        return `${switched}:${String(ignored)}:${ctx.locale}:${service.t("greet", { args: { name: "Max" } })}`;
      }),
      ctx.run(undefined, async () => {
        return ctx.locale;
      }),
    ]);

    expect(r1).toBe("pl:Cześć Jan");
    expect(r2).toBe("pl:undefined:pl:Cześć Max");
    expect(r3).toBe("en");
  });

  it("I18nModule.forRoot validates missing loader and supports DI loader/resolver/formatter classes", async () => {
    expect(() =>
      I18nModule.forRoot({} as unknown as Parameters<typeof I18nModule.forRoot>[0]),
    ).toThrow(/loader.*required/);

    const PREFIX_TOKEN = "TEST_PREFIX";

    @Module({
      providers: [{ provide: PREFIX_TOKEN, useValue: "DI" }],
      exports: [PREFIX_TOKEN],
    })
    class HelperModule {}

    @Injectable()
    class DiLoader extends I18nLoader {
      override load(): I18nCatalogs {
        return CATALOGS;
      }
    }

    @Injectable()
    class DiFormatter extends I18nMessageFormatter {
      override format(
        message: string,
        args: Record<string, unknown>,
        locale: string,
      ): string {
        return `[${locale}] ${message.replace("{name}", String(args.name ?? ""))}`;
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        I18nModule.forRoot({
          imports: [HelperModule],
          loader: DiLoader,
          formatter: DiFormatter,
          defaultLocale: "en",
        }),
      ],
    }).compile();

    const svc = mod.get(I18nService);
    expect(svc.t("greet", { locale: "pl", args: { name: "Ada" } })).toBe(
      "[pl] Cześć Ada",
    );
    expect(mod.get(I18N_MODULE_OPTIONS)).toBeDefined();
    await mod.close();
  });

  it("I18nModule.forRootAsync works with useFactory, useClass (I18nOptionsFactory), and validates factory output", async () => {
    // 1. useFactory
    const modFactory = await Test.createTestingModule({
      imports: [
        I18nModule.forRootAsync({
          useFactory: async () => ({
            defaultLocale: "pl",
            loader: new InMemoryI18nLoader(CATALOGS),
          }),
        }),
      ],
    }).compile();
    expect(modFactory.get(I18nService).defaultLocale).toBe("pl");
    await modFactory.close();

    // 2. useClass with I18nOptionsFactory
    @Injectable()
    class MyI18nConfig implements I18nOptionsFactory {
      createI18nOptions(): I18nModuleOptions {
        return {
          defaultLocale: "de",
          loader: new InMemoryI18nLoader(CATALOGS),
        };
      }
    }
    const modClass = await Test.createTestingModule({
      imports: [
        I18nModule.forRootAsync({
          useClass: MyI18nConfig,
        }),
      ],
    }).compile();
    expect(modClass.get(I18nService).defaultLocale).toBe("de");
    await modClass.close();

    // 3. Invalid factory return (missing loader)
    await expect(
      Test.createTestingModule({
        imports: [
          I18nModule.forRootAsync({
            useFactory: () => ({ defaultLocale: "en" }),
          }),
        ],
      }).compile(),
    ).rejects.toThrow(/loader/);

    // 4. Invalid factory returning isGlobal
    await expect(
      Test.createTestingModule({
        imports: [
          I18nModule.forRootAsync({
            useFactory: () =>
              ({
                isGlobal: false,
                loader: new InMemoryI18nLoader(CATALOGS),
              }) as unknown as I18nModuleOptions,
          }),
        ],
      }).compile(),
    ).rejects.toThrow(/pass "isGlobal" to forRootAsync/);

    // 5. Invalid factory returning class in loader
    await expect(
      Test.createTestingModule({
        imports: [
          I18nModule.forRootAsync({
            useFactory: () =>
              ({
                loader: InMemoryI18nLoader,
              }) as unknown as I18nModuleOptions,
          }),
        ],
      }).compile(),
    ).rejects.toThrow(/factory returned.*class/);

    // 6. Duplicate loader at top level AND factory
    await expect(
      Test.createTestingModule({
        imports: [
          I18nModule.forRootAsync({
            loader: new InMemoryI18nLoader(CATALOGS),
            useFactory: () => ({
              loader: new InMemoryI18nLoader(CATALOGS),
            }),
          }),
        ],
      }).compile(),
    ).rejects.toThrow(/set both at the top level/);
  });
});

describe("End-to-End Bunest HTTP Integration", () => {
  it("resolves locale across resolvers, sets Content-Language & Vary, supports @CurrentLocale, setLocale, afterGuards, and ExceptionFilters", async () => {
    const USER_LOCALE_HEADER = "x-user-saved-locale";
    const guardObservedLocales: string[] = [];

    @Injectable()
    class AuthAttachGuard implements CanActivate {
      constructor(private readonly i18nCtx: I18nContext) {}

      canActivate(context: ExecutionContext): boolean {
        guardObservedLocales.push(this.i18nCtx.locale);
        const req = context.switchToHttp().getRequest<Request>();
        const saved = req.headers.get(USER_LOCALE_HEADER);
        if (saved) {
          (req as unknown as Record<string, unknown>).__userLocale = saved;
        }
        return true;
      }
    }

    class UserProfileLocaleResolver extends LocaleResolver {
      override readonly afterGuards = true;

      override resolve(input: LocaleResolverInput): string | undefined {
        const req = input.executionContext?.switchToHttp().getRequest<
          Request & { __userLocale?: string }
        >();
        return req?.__userLocale;
      }
    }

    @Catch(BadRequestException)
    class I18nBadRequestFilter implements ExceptionFilter {
      constructor(private readonly i18n: I18nService) {}

      catch(_exception: BadRequestException, _host: ArgumentsHost) {
        return {
          error: this.i18n.t("errors.bad", {
            args: { locale: this.i18n.t("greet", { args: { name: "err" } }) },
          }),
          fromTopLevelT: t("errors.denied"),
        };
      }
    }

    @Controller("demo")
    @UseGuards(AuthAttachGuard)
    @UseFilters(I18nBadRequestFilter)
    class DemoController {
      constructor(
        private readonly i18n: I18nService,
        private readonly i18nCtx: I18nContext,
      ) {}

      @Get("hello")
      hello(@CurrentLocale() locale: string) {
        return {
          locale,
          ctxLocale: this.i18nCtx.locale,
          message: this.i18n.t("greet", { args: { name: "Bunest" } }),
          viaT: t("greet", { args: { name: "Top" } }),
        };
      }

      @Get("switch")
      switchLocale() {
        this.i18nCtx.setLocale("de");
        return {
          locale: this.i18nCtx.locale,
          message: this.i18n.t("greet", { args: { name: "Switch" } }),
        };
      }

      @Get("fail")
      fail() {
        throw new BadRequestException("boom");
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        I18nModule.forRoot({
          defaultLocale: "en",
          loader: new InMemoryI18nLoader(CATALOGS),
          resolvers: [
            new QueryLocaleResolver("lang"),
            new UserProfileLocaleResolver(),
            new CookieLocaleResolver("lang"),
            new HeaderLocaleResolver("x-lang"),
            new AcceptLanguageLocaleResolver(),
          ],
        }),
      ],
      controllers: [DemoController],
      providers: [AuthAttachGuard, I18nBadRequestFilter],
    }).compile();

    const app = mod.createNestApplication();
    await app.init();

    // 1. Accept-Language resolution + Content-Language & Vary headers
    const res1 = await app.inject({
      url: "/demo/hello",
      headers: { "accept-language": "pl-PL,en;q=0.5" },
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.headers["content-language"]).toBe("pl");
    expect(String(res1.headers["vary"])).toContain("Cookie");
    expect(String(res1.headers["vary"])).toContain("x-lang");
    expect(String(res1.headers["vary"])).toContain("Accept-Language");
    expect(res1.json()).toEqual({
      locale: "pl",
      ctxLocale: "pl",
      message: "Cześć Bunest",
      viaT: "Cześć Top",
    });

    // 2. Query param outranks UserProfileLocaleResolver (afterGuards)
    const res2 = await app.inject({
      url: "/demo/hello?lang=de",
      headers: {
        [USER_LOCALE_HEADER]: "pl",
        "accept-language": "en",
      },
    });
    expect(res2.headers["content-language"]).toBe("de");
    expect(res2.json<{ locale: string }>().locale).toBe("de");

    // 3. afterGuards resolver outranks Accept-Language, while guard sees pre-guard locale!
    guardObservedLocales.length = 0;
    const res3 = await app.inject({
      url: "/demo/hello",
      headers: {
        [USER_LOCALE_HEADER]: "de",
        "accept-language": "pl",
      },
    });
    expect(guardObservedLocales).toEqual(["pl"]);
    expect(res3.headers["content-language"]).toBe("de");
    expect(res3.json<{ locale: string; message: string }>()).toMatchObject({
      locale: "de",
      message: "Hallo Bunest",
    });

    // 4. I18nContext.setLocale() updates Content-Language response header
    const res4 = await app.inject({
      url: "/demo/switch",
      headers: { "accept-language": "pl" },
    });
    expect(res4.headers["content-language"]).toBe("de");
    expect(res4.json()).toEqual({
      locale: "de",
      message: "Hallo Switch",
    });

    // 5. ExceptionFilter observes request locale cleanly
    const res5 = await app.inject({
      url: "/demo/fail",
      headers: { "x-lang": "pl" },
    });
    expect(res5.json()).toEqual({
      error: "Nieprawidłowe żądanie (Cześć err)",
      fromTopLevelT: "Brak dostępu",
    });

    await app.close();
  });

  it("supports Express/Fastify response shapes with writeHead Vary merging and WS/GraphQL/RPC in I18nInterceptor", async () => {
    const loader = new InMemoryI18nLoader(CATALOGS);
    const service = new I18nService(
      { defaultLocale: "en" },
      CATALOGS,
      loader,
      new PlaceholderMessageFormatter(),
    );
    const resolvers = [
      new HeaderLocaleResolver("x-lang"),
      new AcceptLanguageLocaleResolver(),
    ];
    const resolution = new LocaleResolution(resolvers, service);
    const middleware = new I18nMiddleware(resolution, service, {
      defaultLocale: "en",
    });

    // Express/Fastify-like response with writeHead
    const headersMap = new Map<string, string>();
    let capturedWriteHeadArgs: unknown[] = [];
    const mockRes = {
      headersSent: false,
      getHeader: (name: string) => headersMap.get(name.toLowerCase()),
      setHeader: (name: string, val: string) => {
        headersMap.set(name.toLowerCase(), val);
      },
      writeHead: (...args: unknown[]) => {
        capturedWriteHeadArgs = args;
      },
    };

    let insideLocale = "";
    await middleware.use(
      { headers: { "x-lang": "pl" }, url: "/items?foo=bar" },
      mockRes,
      () => {
        insideLocale = t("greet", { args: { name: "Express" } });
      },
    );

    expect(insideLocale).toBe("Cześć Express");
    expect(headersMap.get("content-language")).toBe("pl");
    expect(headersMap.get("vary")).toBe("x-lang, Accept-Language");

    mockRes.writeHead(200, { Vary: "Origin" });
    expect(capturedWriteHeadArgs[1]).toEqual({
      Vary: "Origin, x-lang, Accept-Language",
    });

    // I18nInterceptor directly on WebSocket & GraphQL contexts (no middleware)
    const interceptor = new I18nInterceptor(resolution, service);

    const wsContext = {
      getType: () => "ws",
      switchToWs: () => ({
        getClient: () => ({
          handshake: { headers: { "accept-language": "de" }, url: "/ws" },
        }),
      }),
    } as unknown as ExecutionContext;

    const wsResult = await interceptor.intercept(wsContext, {
      handle: async () => t("greet", { args: { name: "WS" } }),
    });
    expect(wsResult).toBe("Hallo WS");

    const gqlContext = {
      getType: () => "graphql",
      getArgByIndex: (idx: number) =>
        idx === 2
          ? { req: { headers: { "x-lang": "pl" }, url: "/graphql" } }
          : undefined,
    } as unknown as ExecutionContext;

    const gqlResult = await interceptor.intercept(gqlContext, {
      handle: async () => t("greet", { args: { name: "GQL" } }),
    });
    expect(gqlResult).toBe("Cześć GQL");
  });
});
