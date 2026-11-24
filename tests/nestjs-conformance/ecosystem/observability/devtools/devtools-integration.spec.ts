import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Global,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Param,
  ParseIntPipe,
  Scope,
  Sse,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
  forwardRef,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  type PipeTransform,
} from "../../../../../packages/core/src/common";
import {
  BunestFactory,
  DIContainer,
  SerializedGraph,
} from "../../../../../packages/core/src";
import {
  DEVTOOLS_OPTIONS,
  DevtoolsModule,
  DevtoolsService,
  GraphPublisher,
  type DevtoolsApplicationGraph,
  type DevtoolsModuleOptions,
  type DevtoolsOptionsFactory,
} from "../../../../../packages/observability/src";
import {
  createSandbox,
  createTestApp,
  describeConformance,
  type TestAppContext,
} from "../../../_helpers/index";

describeConformance(
  "Devtools Integration Parity (DevtoolsModule, DevtoolsService, GraphPublisher)",
  {
    upstreamPath: "devtools-integration/supplemental-parity.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002", "ADR-008"],
    notes:
      "Supplemental parity conformance spec for @nestjs/devtools-integration (commercial non-public upstream repo) targeting @bunest/observability DevtoolsModule, DevtoolsService, and GraphPublisher.",
  },
  () => {
    const sandbox = createSandbox();
    const contexts: TestAppContext[] = [];
    const rawApps: Array<{ close: () => Promise<void> }> = [];
    const servers: Array<ReturnType<typeof Bun.serve>> = [];
    let savedNodeEnv: string | undefined;
    let savedApiUrl: string | undefined;

    beforeEach(() => {
      savedNodeEnv = process.env.NODE_ENV;
      savedApiUrl = process.env.DEVTOOLS_API_URL;
      process.env.NODE_ENV = "development";
      delete process.env.DEVTOOLS_API_URL;
    });

    afterEach(async () => {
      sandbox.restore();
      if (savedNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = savedNodeEnv;
      }
      if (savedApiUrl === undefined) {
        delete process.env.DEVTOOLS_API_URL;
      } else {
        process.env.DEVTOOLS_API_URL = savedApiUrl;
      }

      await Promise.all([
        ...contexts.splice(0).map((ctx) => ctx.close()),
        ...rawApps.splice(0).map((app) => app.close()),
      ]);
      for (const s of servers.splice(0)) {
        s.stop(true);
      }
    });

    describe("DevtoolsModule registration modes", () => {
      @Injectable()
      class DevtoolsConfigProvider {
        readonly allowInProduction = true;
      }

      @Injectable()
      class CustomDevtoolsOptionsFactory implements DevtoolsOptionsFactory {
        createDevtoolsOptions(): DevtoolsModuleOptions {
          return {
            http: true,
            allowInProduction: true,
          };
        }
      }

      @Module({
        providers: [DevtoolsConfigProvider, CustomDevtoolsOptionsFactory],
        exports: [DevtoolsConfigProvider, CustomDevtoolsOptionsFactory],
      })
      class ConfigModule {}

      it("registers synchronously via DevtoolsModule.register() and DevtoolsModule.forRoot()", async () => {
        const reg = DevtoolsModule.register({ global: true, path: "/_dt" });
        expect(reg.global).toBe(true);

        const fr = DevtoolsModule.forRoot({ http: false });
        expect(fr.controllers).toHaveLength(0);

        const ctx = await createTestApp(
          { imports: [DevtoolsModule.register({ http: true })] },
          { silentLogger: true },
        );
        contexts.push(ctx);

        expect(ctx.moduleRef.get(DevtoolsService)).toBeInstanceOf(
          DevtoolsService,
        );
        expect(ctx.moduleRef.get(DEVTOOLS_OPTIONS)).toEqual({ http: true });
      });

      it("registers asynchronously via registerAsync({ useFactory }) with imports & inject", async () => {
        const ctx = await createTestApp(
          {
            imports: [
              DevtoolsModule.registerAsync({
                imports: [ConfigModule],
                inject: [DevtoolsConfigProvider],
                useFactory: async (cfg: DevtoolsConfigProvider) => ({
                  allowInProduction: cfg.allowInProduction,
                }),
                extraProviders: [{ provide: "EXTRA_DT", useValue: 123 }],
              }),
            ],
          },
          { silentLogger: true },
        );
        contexts.push(ctx);

        expect(ctx.moduleRef.get<number>("EXTRA_DT")).toBe(123);
        expect(ctx.moduleRef.get(DEVTOOLS_OPTIONS)).toEqual({
          allowInProduction: true,
        });

        process.env.NODE_ENV = "production";
        await ctx.request().get("/_devtools/graph").expect(200);
      });

      it("registers asynchronously via registerAsync({ useClass })", async () => {
        const ctx = await createTestApp(
          {
            imports: [
              DevtoolsModule.registerAsync({
                useClass: CustomDevtoolsOptionsFactory,
              }),
            ],
          },
          { silentLogger: true },
        );
        contexts.push(ctx);

        process.env.NODE_ENV = "production";
        await ctx.request().get("/_devtools/graph").expect(200);
      });

      it("registers asynchronously via forRootAsync({ useExisting })", async () => {
        const ctx = await createTestApp(
          {
            imports: [
              DevtoolsModule.forRootAsync({
                imports: [ConfigModule],
                useExisting: CustomDevtoolsOptionsFactory,
                path: "/_inspect",
              }),
            ],
          },
          { silentLogger: true },
        );
        contexts.push(ctx);

        process.env.NODE_ENV = "production";
        await ctx.request().get("/_inspect/graph").expect(200);
      });

      it("throws when registerAsync() receives none of useFactory, useClass, or useExisting", () => {
        expect(() => DevtoolsModule.registerAsync({})).toThrow(
          /requires one of "useFactory", "useClass", or "useExisting"/,
        );
      });
    });

    describe("HTTP introspection endpoints & graph structure", () => {
      it("exposes /_devtools/graph, /_devtools/routes, and /_devtools/mermaid with rich metadata", async () => {
        @Injectable()
        class AuditGuard implements CanActivate {
          canActivate() {
            return true;
          }
        }

        @Injectable()
        class TimingInterceptor implements BunestInterceptor {
          intercept(_ctx: ExecutionContext, next: CallHandler) {
            return next.handle();
          }
        }

        @Injectable()
        class NoopPipe implements PipeTransform {
          transform(value: unknown) {
            return value;
          }
        }

        @Injectable()
        class CustomFilter implements ExceptionFilter {
          catch() {}
        }

        @Injectable()
        class DbPool {}

        @Global()
        @Module({
          providers: [DbPool],
          exports: [DbPool],
        })
        class GlobalDbModule {}

        @Module({
          imports: [GlobalDbModule],
          exports: [GlobalDbModule],
        })
        class DataLayerModule {}

        @Injectable()
        class UsersRepo {
          constructor(public readonly db: DbPool) {}
        }

        @Injectable()
        class UsersService {
          constructor(
            @Inject(forwardRef(() => UsersRepo))
            public readonly repo: UsersRepo,
          ) {}
        }

        @Injectable({ scope: Scope.REQUEST })
        class RequestTrace {}

        @Injectable({ scope: Scope.TRANSIENT })
        class EphemeralHelper {}

        @Controller("/users")
        @UseGuards(AuditGuard)
        @UseFilters(CustomFilter)
        class UsersController {
          constructor(public readonly users: UsersService) {}

          @Get(":id")
          @HttpCode(200)
          @UseInterceptors(TimingInterceptor)
          @UsePipes(NoopPipe)
          findOne(@Param("id", ParseIntPipe) id: number) {
            return { id };
          }

          @Sse("stream")
          async *stream() {
            yield { data: "hello" };
          }
        }

        @Module({
          imports: [DataLayerModule],
          controllers: [UsersController],
          providers: [
            UsersRepo,
            UsersService,
            RequestTrace,
            EphemeralHelper,
            AuditGuard,
            TimingInterceptor,
            NoopPipe,
            CustomFilter,
            {
              provide: "USERS_ALIAS",
              useExisting: UsersService,
            },
            {
              provide: "COMPUTED",
              useFactory: (svc: UsersService) => Boolean(svc),
              inject: [UsersService],
            },
          ],
        })
        class UsersModule {}

        @Module({
          imports: [UsersModule, DevtoolsModule.register({ http: true })],
        })
        class RootAppModule {}

        const app = await BunestFactory.create(RootAppModule, {
          logger: false,
          snapshot: true,
        });
        rawApps.push(app);
        const devtools = app.get(DevtoolsService);
        devtools.attachApplication(app);

        // 1. /_devtools/graph
        const graphRes = await app.fetch(
          new Request("http://localhost/_devtools/graph"),
        );
        expect(graphRes.status).toBe(200);
        const graph = (await graphRes.json()) as DevtoolsApplicationGraph;

        expect(typeof graph.generatedAt).toBe("string");
        expect(Number.isNaN(Date.parse(graph.generatedAt))).toBe(false);

        const modNames = graph.modules.map((m) => m.name);
        expect(modNames).toContain("RootAppModule");
        expect(modNames).toContain("UsersModule");
        expect(modNames).toContain("DataLayerModule");
        expect(modNames).toContain("GlobalDbModule");

        const globalDbMod = graph.modules.find(
          (m) => m.name === "GlobalDbModule",
        );
        expect(globalDbMod?.isGlobal).toBe(true);

        const devtoolsMod = graph.modules.find(
          (m) => m.name === "DevtoolsModule",
        );
        expect(devtoolsMod?.isDynamic).toBe(true);

        // Edges: import, re-export, provider-dependency
        expect(graph.edges.some((e) => e.type === "import")).toBe(true);
        expect(graph.edges.some((e) => e.type === "re-export")).toBe(true);
        expect(graph.edges.some((e) => e.type === "provider-dependency")).toBe(
          true,
        );

        // Providers: class, existing, factory, scopes, dependencies
        const usersSvc = graph.providers.find(
          (p) => p.token === "UsersService",
        );
        expect(usersSvc?.scope).toBe(Scope.SINGLETON);
        expect(usersSvc?.dependencies).toContain("UsersRepo");

        const reqTrace = graph.providers.find(
          (p) => p.token === "RequestTrace",
        );
        expect(reqTrace?.scope).toBe(Scope.REQUEST);

        const transient = graph.providers.find(
          (p) => p.token === "EphemeralHelper",
        );
        expect(transient?.scope).toBe(Scope.TRANSIENT);

        const alias = graph.providers.find((p) => p.token === '"USERS_ALIAS"');
        expect(alias?.kind).toBe("existing");
        expect(alias?.dependencies).toEqual(["UsersService"]);

        const factory = graph.providers.find((p) => p.token === '"COMPUTED"');
        expect(factory?.kind).toBe("factory");
        expect(factory?.dependencies).toEqual(["UsersService"]);

        // SerializedGraph snapshot attached when snapshot: true
        expect(graph.serializedGraph).toBeDefined();
        expect(
          Object.keys(graph.serializedGraph!.nodes).length,
        ).toBeGreaterThan(0);

        // Controllers
        const ctrl = graph.controllers.find(
          (c) => c.name === "UsersController",
        );
        expect(ctrl?.path).toBe("/users");
        expect(ctrl?.routeCount).toBe(2);

        // 2. /_devtools/routes
        const routesRes = await app.fetch(
          new Request("http://localhost/_devtools/routes"),
        );
        expect(routesRes.status).toBe(200);
        const { routes } = (await routesRes.json()) as {
          routes: DevtoolsApplicationGraph["routes"];
        };

        const findOneRoute = routes.find((r) => r.fullPath === "/users/:id");
        expect(findOneRoute).toBeDefined();
        expect(findOneRoute?.method).toBe("GET");
        expect(findOneRoute?.controller).toBe("UsersController");
        expect(findOneRoute?.handler).toBe("findOne");
        expect(findOneRoute?.httpCode).toBe(200);
        expect(findOneRoute?.isSse).toBe(false);
        expect(findOneRoute?.guards).toContain("AuditGuard");
        expect(findOneRoute?.interceptors).toContain("TimingInterceptor");
        expect(findOneRoute?.pipes).toContain("NoopPipe");
        expect(findOneRoute?.filters).toContain("CustomFilter");
        expect(findOneRoute?.parameters[0]).toMatchObject({
          index: 0,
          source: "param",
          key: "id",
          metatype: "Number",
        });

        const sseRoute = routes.find((r) => r.fullPath === "/users/stream");
        expect(sseRoute?.isSse).toBe(true);

        // 3. /_devtools/mermaid
        const mermaidRes = await app.fetch(
          new Request("http://localhost/_devtools/mermaid"),
        );
        expect(mermaidRes.status).toBe(200);
        expect(mermaidRes.headers.get("content-type")).toBe(
          "text/plain; charset=utf-8",
        );
        const mermaid = await mermaidRes.text();
        expect(mermaid.startsWith("flowchart LR")).toBe(true);
        expect(mermaid).toContain("RootAppModule");
        expect(mermaid).toContain("GlobalDbModule (global)");
        expect(mermaid).toContain("DevtoolsModule (dynamic)");
        expect(mermaid).toContain("-.->|re-export|");
        expect(mermaid).toContain("-.->|provides|");
        expect(mermaid).toContain("-->|injects|");
      });

      it("supports custom base path and disabling endpoints via exposeEndpoints: false or http: false", async () => {
        const customPath = await createTestApp(
          {
            imports: [DevtoolsModule.register({ path: "/internal/devtools" })],
          },
          { silentLogger: true },
        );
        contexts.push(customPath);

        await customPath.request().get("/_devtools/graph").expect(404);
        await customPath.request().get("/internal/devtools/graph").expect(200);
        await customPath.request().get("/internal/devtools/routes").expect(200);
        await customPath
          .request()
          .get("/internal/devtools/mermaid")
          .expect(200);

        const disabledByExpose = await createTestApp(
          { imports: [DevtoolsModule.register({ exposeEndpoints: false })] },
          { silentLogger: true },
        );
        contexts.push(disabledByExpose);
        await disabledByExpose.request().get("/_devtools/graph").expect(404);
        expect(disabledByExpose.moduleRef.get(DevtoolsService)).toBeInstanceOf(
          DevtoolsService,
        );

        const disabledByHttp = await createTestApp(
          { imports: [DevtoolsModule.register({ http: false })] },
          { silentLogger: true },
        );
        contexts.push(disabledByHttp);
        await disabledByHttp.request().get("/_devtools/graph").expect(404);
      });
    });

    describe("production security gate", () => {
      it("returns 403 Forbidden on all endpoints when NODE_ENV=production by default", async () => {
        const ctx = await createTestApp(
          { imports: [DevtoolsModule.register()] },
          { silentLogger: true },
        );
        contexts.push(ctx);

        process.env.NODE_ENV = "production";
        expect(ctx.moduleRef.get(DevtoolsService).isEndpointsEnabled()).toBe(
          false,
        );

        await ctx.request().get("/_devtools/graph").expect(403);
        await ctx.request().get("/_devtools/routes").expect(403);
        await ctx.request().get("/_devtools/mermaid").expect(403);
      });

      it("allows endpoints in production when allowInProduction: true or enabled: true", async () => {
        process.env.NODE_ENV = "production";

        const allowCtx = await createTestApp(
          { imports: [DevtoolsModule.register({ allowInProduction: true })] },
          { silentLogger: true },
        );
        contexts.push(allowCtx);
        await allowCtx.request().get("/_devtools/graph").expect(200);

        const enabledCtx = await createTestApp(
          { imports: [DevtoolsModule.register({ enabled: true })] },
          { silentLogger: true },
        );
        contexts.push(enabledCtx);
        await enabledCtx.request().get("/_devtools/graph").expect(200);
      });

      it("blocks endpoints even in development when enabled: false", async () => {
        process.env.NODE_ENV = "development";

        const ctx = await createTestApp(
          { imports: [DevtoolsModule.register({ enabled: false })] },
          { silentLogger: true },
        );
        contexts.push(ctx);

        expect(ctx.moduleRef.get(DevtoolsService).isEndpointsEnabled()).toBe(
          false,
        );
        await ctx.request().get("/_devtools/graph").expect(403);
      });
    });

    describe("DevtoolsService target resolution & introspection API", () => {
      it("auto-discovers module graph without attachApplication(), and supports explicit target & attachContainer()", async () => {
        @Injectable()
        class PingService {}

        @Controller("/ping")
        class PingController {
          constructor(public readonly svc: PingService) {}

          @Get()
          ping() {
            return { pong: true };
          }
        }

        @Module({
          imports: [DevtoolsModule.forRoot({ exposeEndpoints: false })],
          controllers: [PingController],
          providers: [PingService],
        })
        class AppMod {}

        const app = await BunestFactory.create(AppMod, {
          logger: false,
          snapshot: true,
        });
        rawApps.push(app);

        const devtools = app.get(DevtoolsService);
        // 1. Auto-discovered via DiscoveryService
        const autoGraph = devtools.getGraph();
        expect(autoGraph.modules.some((m) => m.name === "AppMod")).toBe(true);
        expect(autoGraph.providers.some((p) => p.token === "PingService")).toBe(
          true,
        );
        expect(devtools.getRoutes().some((r) => r.fullPath === "/ping")).toBe(
          true,
        );

        // 2. Explicit target (BunestApplication & DIContainer)
        const container: DIContainer = app.getModuleContainer();
        const standalone = new DevtoolsService();
        expect(() => standalone.getGraph()).toThrow(
          /no attached BunestApplication, DIContainer, or DiscoveryService/,
        );

        expect(
          standalone
            .getGraph(container)
            .modules.some((m) => m.name === "AppMod"),
        ).toBe(true);
        expect(standalone.getSerializedGraph(container)?.nodes).toBeDefined();

        standalone.attachContainer(container);
        expect(standalone.toMermaidGraph()).toContain("PingService");
        expect(standalone.getSerializedGraph()?.nodes).toBeDefined();

        // 3. BunestApplicationContext target
        const appCtx = await BunestFactory.createApplicationContext(AppMod, {
          logger: false,
          snapshot: true,
        });
        rawApps.push(appCtx);
        expect(
          standalone.getGraph(appCtx).modules.some((m) => m.name === "AppMod"),
        ).toBe(true);
        expect(standalone.getSerializedGraph(appCtx)?.nodes).toBeDefined();
      });

      it("expands multi-path controllers and multi-path route decorators in getRoutes()", async () => {
        @Controller(["/v1/catalog", "/v2/catalog"])
        class MultiPathController {
          @Get(["items", "products"])
          list() {
            return [];
          }
        }

        @Module({
          imports: [DevtoolsModule.register({ exposeEndpoints: false })],
          controllers: [MultiPathController],
        })
        class MultiPathApp {}

        const app = await BunestFactory.create(MultiPathApp, { logger: false });
        rawApps.push(app);

        const routes = app.get(DevtoolsService).getRoutes();
        const fullPaths = routes.map((r) => r.fullPath).sort();
        expect(fullPaths).toEqual([
          "/v1/catalog/items",
          "/v1/catalog/products",
          "/v2/catalog/items",
          "/v2/catalog/products",
        ]);
      });

      it("sanitizes Mermaid node IDs and escapes quotes in labels for string/symbol provider tokens", async () => {
        const symToken = Symbol("my.token");

        @Module({
          imports: [DevtoolsModule.register({ exposeEndpoints: false })],
          providers: [
            { provide: '123-"quoted".token', useValue: 1 },
            { provide: symToken, useValue: 2 },
          ],
        })
        class SpecialTokensMod {}

        const app = await BunestFactory.create(SpecialTokensMod, {
          logger: false,
        });
        rawApps.push(app);

        const mermaid = app.get(DevtoolsService).toMermaidGraph();
        expect(mermaid.startsWith("flowchart LR")).toBe(true);
        expect(mermaid).toContain("SpecialTokensMod");
        expect(mermaid).not.toContain('""quoted""');
      });

      it("supports passing container directly in DevtoolsService constructor options", async () => {
        @Module({})
        class TargetMod {}

        const app = await BunestFactory.create(TargetMod, {
          logger: false,
          snapshot: true,
        });
        rawApps.push(app);

        const direct = new DevtoolsService({
          container: app.getModuleContainer(),
        });
        expect(
          direct.getGraph().modules.some((m) => m.name === "TargetMod"),
        ).toBe(true);
        expect(direct.getSerializedGraph()?.nodes).toBeDefined();
      });
    });

    describe("GraphPublisher", () => {
      it("throws when SerializedGraph cannot be resolved from target", () => {
        const invalidTarget = {
          get() {
            return undefined;
          },
        } as unknown as Parameters<typeof Reflect.construct>[1][0];

        expect(() => new GraphPublisher(invalidTarget)).toThrow(
          /Could not resolve SerializedGraph/,
        );
      });

      it("resolves SerializedGraph from BunestApplicationContext and omits optional target/targetBranch when unset", async () => {
        @Module({})
        class CtxMod {}

        const appCtx = await BunestFactory.createApplicationContext(CtxMod, {
          logger: false,
          snapshot: true,
        });
        rawApps.push(appCtx);

        let capturedBody: Record<string, unknown> = {};
        const logStub = sandbox.stub(console, "log");
        const publisher = new GraphPublisher(appCtx);

        await publisher.publish({
          apiKey: "ctx-key",
          owner: "org",
          repository: "repo",
          branch: "main",
          trigger: "push",
          sha: "112233",
          endpoint: "http://devtools.local",
          fetch: async (_url, init) => {
            capturedBody = JSON.parse(String(init.body));
            return Response.json({});
          },
        });

        expect(capturedBody.target).toBeUndefined();
        expect("targetBranch" in capturedBody).toBe(false);
        expect(typeof capturedBody.snapshot).toBe("string");
        expect(String(logStub.firstCall?.args[0])).toContain("Preview: -");
      });

      it("validates required publish options (owner, repository, sha, branch)", async () => {
        @Module({})
        class MinMod {}
        const app = await BunestFactory.create(MinMod, {
          logger: false,
          snapshot: true,
        });
        rawApps.push(app);
        const publisher = new GraphPublisher(app);

        const base = {
          apiKey: "key",
          owner: "org",
          repository: "repo",
          branch: "main",
          trigger: "push" as const,
          sha: "deadbeef",
        };

        for (const field of ["owner", "repository", "sha", "branch"] as const) {
          await expect(
            publisher.publish({ ...base, [field]: "" }),
          ).rejects.toThrow(new RegExp(`"${field}" parameter is required`));
        }
      });

      it("publishes a valid zlib-deflated base64 SerializedGraph with ApiKey auth to local HTTP endpoint", async () => {
        @Injectable()
        class BillingService {}

        @Module({ providers: [BillingService] })
        class BillingModule {}

        const app = await BunestFactory.create(BillingModule, {
          logger: false,
          snapshot: true,
        });
        rawApps.push(app);

        let capturedPath = "";
        let capturedAuth = "";
        let capturedAccept = "";
        let capturedContentType = "";
        let capturedBody: Record<string, unknown> = {};

        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(req) {
            capturedPath = new URL(req.url).pathname;
            capturedAuth = req.headers.get("authorization") ?? "";
            capturedAccept = req.headers.get("accept") ?? "";
            capturedContentType = req.headers.get("content-type") ?? "";
            capturedBody = (await req.json()) as Record<string, unknown>;
            return Response.json({
              previewUrl: "https://devtools.local/preview/42",
              reportUrl: "https://devtools.local/report/42",
            });
          },
        });
        servers.push(server);

        const logStub = sandbox.stub(console, "log");
        const publisher = new GraphPublisher(app);

        await publisher.publish({
          apiKey: "dt_live_secret",
          owner: "bunest-org",
          repository: "core-api",
          branch: "feat/devtools",
          trigger: "pull",
          sha: "0123456789abcdef",
          target: "staging",
          targetBranch: "main",
          endpoint: `http://127.0.0.1:${server.port}///`,
        });

        expect(capturedPath).toBe(
          "/organizations/bunest-org/projects/core-api/builds",
        );
        expect(capturedAuth).toBe("ApiKey dt_live_secret");
        expect(capturedAccept).toBe("application/json");
        expect(capturedContentType).toBe("application/json");
        expect(capturedBody.branch).toBe("feat/devtools");
        expect(capturedBody.trigger).toBe("pull");
        expect(capturedBody.hash).toBe("0123456789abcdef");
        expect(capturedBody.target).toBe("staging");
        expect(capturedBody.targetBranch).toBe("main");

        // Decompress RFC 1950 zlib-deflated base64 snapshot and verify valid SerializedGraph JSON
        const compressed = Buffer.from(String(capturedBody.snapshot), "base64");
        expect(compressed[0]).toBe(0x78);
        const inflatedBytes = Bun.inflateSync(
          compressed.subarray(2, compressed.length - 4),
        );
        expect(compressed.readUInt32BE(compressed.length - 4)).toBe(
          Bun.hash.adler32(inflatedBytes) >>> 0,
        );
        const inflated = new TextDecoder().decode(inflatedBytes);
        const parsedSnapshot = JSON.parse(inflated) as {
          nodes: Record<string, unknown>;
          edges: Record<string, unknown>;
        };
        expect(parsedSnapshot.nodes).toBeDefined();
        expect(parsedSnapshot.edges).toBeDefined();
        expect(inflated).toBe(app.get(SerializedGraph).toString());

        expect(logStub.calledOnce).toBe(true);
        expect(String(logStub.firstCall?.args[0])).toContain(
          "Preview: https://devtools.local/preview/42",
        );
        expect(String(logStub.firstCall?.args[0])).toContain(
          "Report: https://devtools.local/report/42",
        );
      });

      it("handles HTTP 401, 400, and 500 responses gracefully via injected fetch and supports DEVTOOLS_API_URL", async () => {
        @Module({})
        class SmallMod {}
        const app = await BunestFactory.create(SmallMod, {
          logger: false,
          snapshot: true,
        });
        rawApps.push(app);
        const publisher = new GraphPublisher(app);

        const logStub = sandbox.stub(console, "log");
        const errStub = sandbox.stub(console, "error");
        process.env.DEVTOOLS_API_URL = "http://env-devtools.local";

        const urls: string[] = [];
        const runWithStatus = async (status: number, body: string) => {
          logStub.resetHistory();
          errStub.resetHistory();
          await publisher.publish({
            apiKey: "k",
            owner: "o",
            repository: "r",
            branch: "main",
            trigger: "push",
            sha: "abc",
            fetch: async (url) => {
              urls.push(url);
              return new Response(body, { status });
            },
          });
        };

        await runWithStatus(401, "invalid key");
        expect(String(logStub.firstCall?.args[0])).toContain(
          "401 Unauthorized",
        );
        expect(errStub.calledOnce).toBe(true);
        expect(errStub.firstCall?.args).toEqual(["Error:", "invalid key", 401]);

        await runWithStatus(400, "malformed snapshot");
        expect(String(logStub.firstCall?.args[0])).toContain("400 Bad Request");
        expect(errStub.firstCall?.args).toEqual([
          "Error:",
          "malformed snapshot",
          400,
        ]);

        await runWithStatus(500, "server error");
        expect(String(logStub.firstCall?.args[0])).toContain(
          "Something went wrong",
        );
        expect(errStub.firstCall?.args).toEqual([
          "Error:",
          "server error",
          500,
        ]);

        expect(urls[0]).toBe(
          "http://env-devtools.local/organizations/o/projects/r/builds",
        );
      });
    });
  },
);
