import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  RequestMethod,
  type CallHandler,
  type ExecutionContext,
  type MicroserviceInstance,
  type NestInterceptor,
  type PipeLike,
  type GuardLike,
  type InterceptorLike,
  type ExceptionFilterLike,
  type WebSocketAdapter,
} from "../../../../../packages/core/src/common";
import {
  ApplicationConfig,
  BunHttpAdapter,
  BunestApplication,
  BunestFactory,
  HttpAdapterHost,
} from "../../../../../packages/core/src";
import {
  CapturingLogger,
  createSpy,
  describeConformance,
  itAdapted,
} from "../../../_helpers";

function createFakeMicroservice() {
  const globalPipes: PipeLike[] = [];
  const globalGuards: GuardLike[] = [];
  const globalInterceptors: InterceptorLike[] = [];
  const globalFilters: ExceptionFilterLike[] = [];
  let listening = false;
  let closed = false;

  const ms: MicroserviceInstance & {
    useGlobalPipes: (...pipes: PipeLike[]) => void;
    useGlobalGuards: (...guards: GuardLike[]) => void;
    useGlobalInterceptors: (...interceptors: InterceptorLike[]) => void;
    useGlobalFilters: (...filters: ExceptionFilterLike[]) => void;
    getGlobalInterceptors: () => InterceptorLike[];
    isListening: () => boolean;
    isClosed: () => boolean;
  } = {
    async listen() {
      listening = true;
    },
    async close() {
      listening = false;
      closed = true;
    },
    useGlobalPipes(...pipes: PipeLike[]) {
      globalPipes.push(...pipes);
    },
    useGlobalGuards(...guards: GuardLike[]) {
      globalGuards.push(...guards);
    },
    useGlobalInterceptors(...interceptors: InterceptorLike[]) {
      globalInterceptors.push(...interceptors);
    },
    useGlobalFilters(...filters: ExceptionFilterLike[]) {
      globalFilters.push(...filters);
    },
    getGlobalInterceptors: () => globalInterceptors,
    isListening: () => listening,
    isClosed: () => closed,
  };

  return ms;
}

describeConformance(
  "NestApplication",
  {
    upstreamPath: "packages/core/test/nest-application.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Tests BunestApplication (NestApplication alias) across cookies, hybrid microservices, global prefix, double init, close, buffered logs, middleware instrumentation, WebSocket adapter, CSRF protection, and security headers.",
  },
  () => {
    @Controller("items")
    class ItemsController {
      @Get()
      list() {
        return { ok: true };
      }

      @Post()
      create() {
        return { created: true };
      }
    }

    @Controller("hooks")
    class HooksController {
      @Post()
      trigger() {
        return { hook: true };
      }
    }

    @Module({ controllers: [ItemsController, HooksController] })
    class AppModule {}

    describe("cookies option", () => {
      it("should accept cookie secret array for signed cookie extraction", async () => {
        const app = await BunestFactory.create(AppModule, {
          logger: false,
          cookies: { secret: ["new", "old"] },
        });
        expect(app).toBeInstanceOf(BunestApplication);
        await app.close();
      });

      it("should work without a cookie secret", async () => {
        const app1 = await BunestFactory.create(AppModule, { logger: false });
        const app2 = await BunestFactory.create(AppModule, {
          logger: false,
          cookies: {},
        });
        expect(app1).toBeInstanceOf(BunestApplication);
        expect(app2).toBeInstanceOf(BunestApplication);
        await app1.close();
        await app2.close();
      });

      // BUNEST_BUG: BunHttpAdapter/BunestApplication rejects empty cookie secret with generic Error instead of TypeError (packages/core/src/http/adapter/bun-http.adapter.ts & packages/core/src/application/bunest-application.ts).
      it.skip("should reject an empty cookie secret", async () => {
        await expect(
          BunestFactory.create(AppModule, {
            logger: false,
            cookies: { secret: "" },
          }),
        ).rejects.toThrow(TypeError);

        await expect(
          BunestFactory.create(AppModule, {
            logger: false,
            cookies: { secret: [] },
          }),
        ).rejects.toThrow(TypeError);

        await expect(
          BunestFactory.create(AppModule, {
            logger: false,
            cookies: { secret: ["new", ""] },
          }),
        ).rejects.toThrow(TypeError);
      });
    });

    describe("Hybrid Application", () => {
      class Interceptor implements NestInterceptor {
        public async intercept(_context: ExecutionContext, next: CallHandler) {
          return next.handle();
        }
      }

      it("default should not inherit parent global enhancers", async () => {
        const app = await BunestFactory.create(AppModule, { logger: false });
        app.useGlobalInterceptors(new Interceptor());
        const ms = createFakeMicroservice();
        app.connectMicroservice(ms);
        await app.startAllMicroservices();

        expect(app.get(ApplicationConfig).getGlobalInterceptors().length).toBe(
          1,
        );
        expect(ms.getGlobalInterceptors().length).toBe(0);
        await app.close();
      });

      it("should inherit existing ApplicationConfig when inheritAppConfig is true", async () => {
        const app = await BunestFactory.create(AppModule, { logger: false });
        app.useGlobalInterceptors(new Interceptor());
        const ms = createFakeMicroservice();
        app.connectMicroservice(ms, { inheritAppConfig: true });
        await app.startAllMicroservices();

        expect(app.get(ApplicationConfig).getGlobalInterceptors().length).toBe(
          1,
        );
        expect(ms.getGlobalInterceptors().length).toBe(1);
        await app.close();
      });

      it("should list connected microservices and close them on app.close()", async () => {
        const app = await BunestFactory.create(AppModule, { logger: false });
        const ms = createFakeMicroservice();
        app.connectMicroservice(ms);
        expect(app.getMicroservices()).toHaveLength(1);

        await app.startAllMicroservices();
        expect(ms.isListening()).toBe(true);

        await app.close();
        expect(ms.isClosed()).toBe(true);
      });
    });

    describe("Global Prefix", () => {
      it("should store global prefix and exclude options in ApplicationConfig", async () => {
        const app = await BunestFactory.create(AppModule, { logger: false });
        const excludeRoute = [
          "foo",
          { path: "bar", method: RequestMethod.GET },
        ];
        app.setGlobalPrefix("api", {
          exclude: excludeRoute,
        });

        const config = app.get(ApplicationConfig);
        expect(config.getGlobalPrefix()).toBe("api");
        expect(config.getGlobalPrefixOptions().exclude).toEqual(excludeRoute);
        await app.close();
      });
    });

    describe("Double initialization", () => {
      it("should initialize lifecycle hooks only once when init() is called twice", async () => {
        const initSpy = createSpy();

        @Injectable()
        class InitTracker {
          onModuleInit() {
            initSpy();
          }
        }

        @Module({ providers: [InitTracker] })
        class InitModule {}

        const app = await BunestFactory.create(InitModule, { logger: false });
        await app.init();
        await app.init();

        expect(initSpy.callCount).toBe(1);
        await app.close();
      });
    });

    describe("close", () => {
      itAdapted(
        "ADR-001",
        "should reset listening state and getUrl() after close()",
        async () => {
          const app = await BunestFactory.create(AppModule, { logger: false });
          await app.listen(0, "127.0.0.1");
          expect(app.get(HttpAdapterHost).listening).toBe(true);
          expect(app.getUrl()).toBeDefined();

          await app.close();

          expect(app.get(HttpAdapterHost).listening).toBe(false);
          expect(app.getUrl()).toBeUndefined();
        },
      );
    });

    describe("buffered logs", () => {
      it("should flush buffered logs when useLogger() is called with autoFlushLogs default", async () => {
        const capturing = new CapturingLogger();
        const app = await BunestFactory.create(AppModule, {
          logger: capturing,
          bufferLogs: true,
        });
        app.getLogger().log("buffered message");
        expect(capturing.entries).toHaveLength(0);

        app.useLogger(capturing);
        expect(
          capturing.entries.some((e) =>
            String(e.message).includes("buffered message"),
          ),
        ).toBe(true);
        await app.close();
      });

      it("should not auto-flush buffered logs when autoFlushLogs is false", async () => {
        const capturing = new CapturingLogger();
        const app = await BunestFactory.create(AppModule, {
          logger: capturing,
          bufferLogs: true,
          autoFlushLogs: false,
        });
        app.getLogger().log("buffered message");
        await app.init();

        expect(capturing.entries).toHaveLength(0);

        app.flushLogs();
        expect(
          capturing.entries.some((e) =>
            String(e.message).includes("buffered message"),
          ),
        ).toBe(true);
        await app.close();
      });

      // BUNEST_BUG: BunestApplication.init() does not auto-flush buffered logs when bufferLogs is true and autoFlushLogs defaults to true (packages/core/src/application/bunest-application.ts & bunest-application-context.ts).
      it.skip("should flush buffered logs on app.init() by default", async () => {
        const capturing = new CapturingLogger();
        const app = await BunestFactory.create(AppModule, {
          logger: capturing,
          bufferLogs: true,
        });
        app.getLogger().log("init buffered message");
        await app.init();

        expect(
          capturing.entries.some((e) =>
            String(e.message).includes("init buffered message"),
          ),
        ).toBe(true);
        await app.close();
      });

      // BUNEST_BUG: BunestApplication.init() does not auto-flush buffered logs when initialization fails (packages/core/src/application/bunest-application.ts & bunest-application-context.ts).
      it.skip("should flush buffered logs when init() fails", async () => {
        const capturing = new CapturingLogger();

        @Injectable()
        class FailingInit {
          onModuleInit() {
            throw new Error("init failed");
          }
        }

        @Module({ providers: [FailingInit] })
        class FailModule {}

        const app = await BunestFactory.create(FailModule, {
          logger: capturing,
          bufferLogs: true,
        });
        app.getLogger().log("buffered before failure");

        await expect(app.init()).rejects.toThrow("init failed");
        expect(
          capturing.entries.some((e) =>
            String(e.message).includes("buffered before failure"),
          ),
        ).toBe(true);
        await app.close();
      });
    });

    describe("use (middleware & instrumentation)", () => {
      it("should execute registered function middleware via app.use()", async () => {
        const calls: string[] = [];
        const app = await BunestFactory.create(AppModule, { logger: false });
        app.use(async (_req, _res, next) => {
          calls.push("mw");
          await next();
        });
        await app.init();

        const res = await app.inject("/items");
        expect(res.statusCode).toBe(200);
        expect(calls).toEqual(["mw"]);
        await app.close();
      });

      // BUNEST_BUG: BunestApplication.use() does not wrap function middleware with options.instrument.instanceDecorator (packages/core/src/application/bunest-application.ts).
      it.skip("should decorate function middleware with instrument.instanceDecorator when configured", async () => {
        const calls: string[] = [];
        const instanceDecorator = createSpy((instance: unknown) => {
          if (typeof instance === "function") {
            return async (req: any, res: any, next: any) => {
              calls.push("decorated");
              return (instance as any)(req, res, next);
            };
          }
          return instance;
        });

        const app = await BunestFactory.create(AppModule, {
          logger: false,
          instrument: { instanceDecorator },
        });
        const mw = async (
          _req: any,
          _res: any,
          next: () => Promise<Response | void> | Response | void,
        ) => {
          calls.push("original");
          await next();
        };
        app.use(mw);
        await app.init();

        const res = await app.inject("/items");
        expect(res.statusCode).toBe(200);
        expect(calls).toEqual(["decorated", "original"]);
        await app.close();
      });
    });

    describe("useWebSocketAdapter", () => {
      it("should set WebSocket adapter on ApplicationConfig and call attachToHttpAdapter", async () => {
        const app = await BunestFactory.create(AppModule, { logger: false });
        const attachSpy = createSpy();
        const wsAdapter: WebSocketAdapter = {
          create: () => ({}),
          bindClientConnect: () => {},
          bindMessageHandlers: () => {},
          attachToHttpAdapter: attachSpy,
          close: async () => {},
        };

        expect(app.useWebSocketAdapter(wsAdapter)).toBe(app);
        expect(app.getWebSocketAdapter()).toBe(wsAdapter);
        expect(app.get(ApplicationConfig).getIoAdapter()).toBe(wsAdapter);
        expect(attachSpy.callCount).toBe(1);
        expect(attachSpy.args[0]?.[0]).toBeInstanceOf(BunHttpAdapter);
        await app.close();
      });
    });

    describe("enableCsrfProtection", () => {
      it("should reject cross-site POST requests and allow same-origin/none requests", async () => {
        const app = await BunestFactory.create(AppModule, { logger: false });
        expect(app.enableCsrfProtection()).toBe(app);
        await app.init();

        const blocked = await app.inject({
          method: "POST",
          url: "/items",
          headers: {
            host: "a.example",
            "sec-fetch-site": "cross-site",
          },
        });
        expect(blocked.statusCode).toBe(403);

        const allowed = await app.inject({
          method: "POST",
          url: "/items",
          headers: {
            host: "a.example",
            "sec-fetch-site": "none",
          },
        });
        expect(allowed.statusCode).toBe(201);
        await app.close();
      });

      it("should respect exclusions combined with global prefix", async () => {
        const app = await BunestFactory.create(AppModule, { logger: false });
        app.enableCsrfProtection({ exclude: ["/api/hooks"] });
        app.setGlobalPrefix("api");
        await app.init();

        const excluded = await app.inject({
          method: "POST",
          url: "/api/hooks",
          headers: {
            host: "a.example",
            "sec-fetch-site": "cross-site",
          },
        });
        expect(excluded.statusCode).toBe(201);

        const protectedRes = await app.inject({
          method: "POST",
          url: "/api/items",
          headers: {
            host: "a.example",
            "sec-fetch-site": "cross-site",
          },
        });
        expect(protectedRes.statusCode).toBe(403);
        await app.close();
      });

      // BUNEST_BUG: BunestApplication.enableCsrfProtection() does not guard against being called after app.init() (packages/core/src/application/bunest-application.ts).
      it.skip("should throw when called after init", async () => {
        const app = await BunestFactory.create(AppModule, { logger: false });
        await app.init();

        expect(() => app.enableCsrfProtection()).toThrow(
          /must be called before app.init\(\)/,
        );
        await app.close();
      });

      // BUNEST_BUG: BunestApplication.enableCsrfProtection() does not guard against being called twice (packages/core/src/application/bunest-application.ts).
      it.skip("should throw when called twice", async () => {
        const app = await BunestFactory.create(AppModule, { logger: false });
        app.enableCsrfProtection();

        expect(() => app.enableCsrfProtection()).toThrow(/only be called once/);
        await app.close();
      });

      it("should validate trustedOrigins option eagerly", async () => {
        const app = await BunestFactory.create(AppModule, { logger: false });

        expect(() =>
          app.enableCsrfProtection({ trustedOrigins: ["https://a.example/"] }),
        ).toThrow(/Invalid trusted origin/i);
        expect(() => app.enableCsrfProtection()).not.toThrow();
        await app.close();
      });
    });

    describe("useSecurityHeaders", () => {
      it("should apply security headers on responses and honor disabled options", async () => {
        const app = await BunestFactory.create(AppModule, { logger: false });
        expect(app.useSecurityHeaders({ xFrameOptions: false })).toBe(app);
        await app.init();

        const res = await app.inject("/items");
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-security-policy"]).toBeDefined();
        expect(res.headers["x-frame-options"]).toBeUndefined();
        expect(res.headers["x-powered-by"]).toBeUndefined();
        await app.close();
      });

      it("should write security headers even on CSRF rejection regardless of registration order", async () => {
        for (const order of [
          ["headers", "csrf"],
          ["csrf", "headers"],
        ] as const) {
          const app = await BunestFactory.create(AppModule, { logger: false });
          for (const feature of order) {
            if (feature === "headers") {
              app.useSecurityHeaders();
            } else {
              app.enableCsrfProtection();
            }
          }
          await app.init();

          const res = await app.inject({
            method: "POST",
            url: "/items",
            headers: {
              host: "a.example",
              "sec-fetch-site": "cross-site",
            },
          });
          expect(res.statusCode).toBe(403);
          expect(res.headers["x-content-type-options"]).toBe("nosniff");
          await app.close();
        }
      });

      // BUNEST_BUG: BunestApplication.useSecurityHeaders() / compileSecurityHeaders() does not reject semicolon/CRLF directive injection in CSP values (packages/core/src/http/security/security-headers.ts).
      it.skip("should validate CSP directives eagerly", async () => {
        const app = await BunestFactory.create(AppModule, { logger: false });

        expect(() =>
          app.useSecurityHeaders({
            contentSecurityPolicy: { directives: { scriptSrc: "'self'; x" } },
          }),
        ).toThrow(/Content-Security-Policy/i);
        expect(() => app.useSecurityHeaders()).not.toThrow();
        await app.close();
      });

      // BUNEST_BUG: BunestApplication.useSecurityHeaders() does not guard against being called twice or after app.init() (packages/core/src/application/bunest-application.ts).
      it.skip("should throw when called after init or twice", async () => {
        const app1 = await BunestFactory.create(AppModule, { logger: false });
        app1.useSecurityHeaders();
        expect(() => app1.useSecurityHeaders()).toThrow(/only be called once/);
        await app1.close();

        const app2 = await BunestFactory.create(AppModule, { logger: false });
        await app2.init();
        expect(() => app2.useSecurityHeaders()).toThrow(
          /must be called before app.init\(\)/,
        );
        await app2.close();
      });
    });
  },
);
