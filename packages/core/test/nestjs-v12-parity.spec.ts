import { afterEach, describe, expect, it } from "bun:test";
import {
  APP_GUARD,
  Body,
  ConfigurableModuleBuilder as CommonConfigurableModuleBuilder,
  Controller,
  ensureDir,
  Get,
  Inject,
  Injectable,
  join,
  Module,
  Post,
  removePath,
  REQUEST,
  Scope,
  ShutdownSignal as CommonShutdownSignal,
  StandardSchemaValidationPipe,
  UseGuards,
  type CanActivate,
  type ContextId,
  type HostComponentInfo,
  type MiddlewareFunction,
  type StandardSchemaV1,
} from "../src/common/index";
import {
  AbstractHttpAdapter,
  ApplicationConfig,
  BunHttpAdapter,
  BunestFactory,
  ConfigurableModuleBuilder,
  ContextIdFactory,
  CookieSigner,
  ExternalContextCreator,
  GraphInspector,
  HttpAdapterHost,
  InitializeOnPreviewAllowlist,
  MiddlewareBuilder,
  ModulesContainer,
  NestContainer,
  ServeStaticModule,
  ShutdownSignal,
  type ServeStaticModuleOptions,
  type ServeStaticModuleOptionsFactory,
} from "../src";

describe("@bunest/core NestJS v12 Parity Suite", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    ContextIdFactory.reset();
    InitializeOnPreviewAllowlist.clear();
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop()!;
      await removePath(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("re-exports AbstractHttpAdapter, canonical runtime ShutdownSignal enum, and deduplicated ConfigurableModuleBuilder", async () => {
    expect(ShutdownSignal).toBe(CommonShutdownSignal);
    expect(String(ShutdownSignal.SIGTERM)).toBe("SIGTERM");
    expect(String(ShutdownSignal.SIGINT)).toBe("SIGINT");
    expect(String(ShutdownSignal.SIGHUP)).toBe("SIGHUP");
    expect(Object.keys(ShutdownSignal).length).toBe(11);

    expect(ConfigurableModuleBuilder).toBe(CommonConfigurableModuleBuilder);

    const adapter = new BunHttpAdapter({ logger: false });
    expect(adapter).toBeInstanceOf(AbstractHttpAdapter);

    @Module({})
    class EmptyModule {}

    const app = await BunestFactory.create(EmptyModule, { logger: false });
    try {
      app.enableShutdownHooks([ShutdownSignal.SIGTERM]);
      expect(app.getLifecycleManager().getActiveHookCount()).toBe(1);
    } finally {
      await app.close();
    }
    expect(app.getLifecycleManager().getActiveHookCount()).toBe(0);
  });

  it("supports InitializeOnPreviewAllowlist.has() and populates HostComponentInfo.token in durable context resolution", async () => {
    class PreviewAllowed {}
    expect(InitializeOnPreviewAllowlist.has(PreviewAllowed)).toBe(false);
    InitializeOnPreviewAllowlist.add(PreviewAllowed);
    expect(InitializeOnPreviewAllowlist.has(PreviewAllowed)).toBe(true);

    const seenInfos: HostComponentInfo[] = [];
    const tenantContexts = new Map<string, ContextId>();

    ContextIdFactory.apply({
      attach(contextId, request: Request) {
        const tenantId = request.headers.get("x-tenant") ?? "default";
        let tenantCtx = tenantContexts.get(tenantId);
        if (!tenantCtx) {
          tenantCtx = ContextIdFactory.create();
          tenantContexts.set(tenantId, tenantCtx);
        }
        return (info: HostComponentInfo) => {
          seenInfos.push(info);
          return info.isTreeDurable ? tenantCtx : contextId;
        };
      },
    });

    const TENANT_SERVICE = Symbol("TENANT_SERVICE");

    @Injectable({ scope: Scope.REQUEST, durable: true })
    class TenantService {
      readonly id = Math.random();
    }

    @Controller({ path: "durable", scope: Scope.REQUEST, durable: true })
    class DurableController {
      constructor(
        @Inject(TENANT_SERVICE) private readonly tenantSvc: TenantService,
      ) {}

      @Get("id")
      getId() {
        return { id: this.tenantSvc.id };
      }
    }

    @Controller({ path: "req-to-durable", scope: Scope.REQUEST })
    class RequestToDurableController {
      constructor(
        @Inject(TENANT_SERVICE) private readonly tenantSvc: TenantService,
      ) {}

      @Get("id")
      getId() {
        return { id: this.tenantSvc.id };
      }
    }

    @Module({
      controllers: [DurableController, RequestToDurableController],
      providers: [
        {
          provide: TENANT_SERVICE,
          useClass: TenantService,
          scope: Scope.REQUEST,
          durable: true,
        },
      ],
    })
    class DurableModule {}

    const app = await BunestFactory.create(DurableModule, { logger: false });
    try {
      const r1 = await app.inject({
        url: "/durable/id",
        headers: { "x-tenant": "acme" },
      });
      const r2 = await app.inject({
        url: "/durable/id",
        headers: { "x-tenant": "acme" },
      });
      const r3 = await app.inject({
        url: "/req-to-durable/id",
        headers: { "x-tenant": "acme" },
      });
      expect(r1.statusCode).toBe(200);
      expect(r1.json()).toEqual(r2.json());
      expect(r3.statusCode).toBe(200);
      expect(r3.json()).toEqual(r1.json());
      expect(seenInfos.some((i) => i.token === DurableController)).toBe(true);
      expect(seenInfos.some((i) => i.token === TENANT_SERVICE)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("implements all 16 ApplicationConfig methods and BunestApplication / BunestApplicationContext parity methods", async () => {
    @Injectable({ scope: Scope.REQUEST })
    class RequestScopedGuard implements CanActivate {
      canActivate() {
        return true;
      }
    }

    @Controller("cfg")
    class CfgController {
      @Get("ping")
      ping() {
        return { pong: true };
      }
    }

    @Module({
      controllers: [CfgController],
      providers: [{ provide: APP_GUARD, useClass: RequestScopedGuard }],
    })
    class CfgModule {}

    const app = await BunestFactory.create(CfgModule, {
      logger: false,
      cookies: { secret: "top-secret" },
      routeConflictPolicy: "warn",
      routeResolutionStrategy: "specificity",
    });

    try {
      const cfg = app.get(ApplicationConfig);
      expect(cfg.getCookieSigner()).toBeInstanceOf(CookieSigner);
      expect(cfg.getRouteConflictPolicy()).toBe("warn");
      expect(cfg.getRouteResolutionStrategy()).toBe("specificity");
      expect(cfg.getGlobalRequestGuards().length).toBe(1);

      const hook = () => {};
      cfg.registerPreRequestHook(hook);
      expect(cfg.getGlobalPreRequestHooks()).toEqual([hook]);

      const fakeWrapper: any = { token: "X", scope: Scope.REQUEST };
      cfg.addGlobalRequestPipe(fakeWrapper);
      cfg.addGlobalRequestFilter(fakeWrapper);
      cfg.addGlobalRequestInterceptor(fakeWrapper);
      expect(cfg.getGlobalRequestPipes()).toEqual([fakeWrapper]);
      expect(cfg.getGlobalRequestFilters()).toEqual([fakeWrapper]);
      expect(cfg.getGlobalRequestInterceptors()).toEqual([fakeWrapper]);

      // BunestApplication / BunestApplicationContext methods
      app.useBodyParser("json", { limit: "2mb" });
      app.applyOptions();
      app.registerHttpServer();
      app.registerParserMiddleware();
      await app.registerModules();
      await app.registerWsModule();
      await app.registerRouter();
      await app.registerRouterHooks();
      await app.preloadLazyPackages();
      app.flushLogsOnOverride();
      app.selectContextModule();

      expect(app.getUnderlyingHttpServer()).toBe(app.getHttpServer());
      expect(app.createServer()).toBe(app.getHttpServer());
    } finally {
      await app.close();
    }
  });

  it("supports zero-RxJS HttpAdapterHost.init$/listen$ and ModulesContainer.addRpcTarget()/getRpcTargetRegistry()", async () => {
    @Controller("sub")
    class SubController {
      @Get("ok")
      ok() {
        return { ok: true };
      }
    }

    @Module({ controllers: [SubController] })
    class SubModule {}

    const app = await BunestFactory.create(SubModule, { logger: false });
    const adapterHost = app.get(HttpAdapterHost);
    const modulesContainer = app.get(ModulesContainer);

    let initCalls = 0;
    let listenCalls = 0;
    let cancelledCalls = 0;

    const subInit = adapterHost.init$.subscribe({
      next: () => {
        initCalls += 1;
      },
    });
    const subListen = adapterHost.listen$.subscribe(() => {
      listenCalls += 1;
    });
    const subCancel = adapterHost.listen$.subscribe(() => {
      cancelledCalls += 1;
    });
    subCancel.unsubscribe();

    try {
      await app.listen(0);
      expect(initCalls).toBe(1);
      expect(listenCalls).toBe(1);
      expect(cancelledCalls).toBe(0);

      // Verifier #55 defect #5: one-shot init$/listen$ listeners are automatically released on fire
      expect((adapterHost as any).initListeners.size).toBe(0);
      expect((adapterHost as any).listenListeners.size).toBe(0);

      // Replay semantics for late subscribers (must also not retain listeners)
      let lateInit = 0;
      let lateListen = 0;
      adapterHost.init$.subscribe(() => {
        lateInit += 1;
      });
      adapterHost.listen$.subscribe(() => {
        lateListen += 1;
      });
      expect(lateInit).toBe(1);
      expect(lateListen).toBe(1);
      expect((adapterHost as any).initListeners.size).toBe(0);
      expect((adapterHost as any).listenListeners.size).toBe(0);

      // ModulesContainer RPC target registry
      const observedRpc: string[] = [];
      modulesContainer.addRpcTarget("tcp-1");
      const rpcSub = modulesContainer
        .getRpcTargetRegistry<string>()
        .subscribe((t) => {
          observedRpc.push(t);
        });
      modulesContainer.addRpcTarget("grpc-2");
      rpcSub.unsubscribe();
      modulesContainer.addRpcTarget("kafka-3");
      expect(observedRpc).toEqual(["tcp-1", "grpc-2"]);
    } finally {
      subInit.unsubscribe();
      subListen.unsubscribe();
      await app.close();
    }
  });

  it("supports ExternalContextCreator.fromContainer(), MiddlewareBuilder.build(), GraphInspector, and NestContainer facade", async () => {
    @Injectable()
    class AllowGuard implements CanActivate {
      canActivate() {
        return true;
      }
    }

    @Injectable()
    class HelperService {
      greet(name: string) {
        return `hello ${name}`;
      }
    }

    @Injectable()
    class ExternalHandler {
      constructor(private readonly helper: HelperService) {}

      @UseGuards(AllowGuard)
      handle(name: string) {
        return this.helper.greet(name);
      }
    }

    @Module({ providers: [AllowGuard, HelperService, ExternalHandler] })
    class ExtModule {}

    const ctx = await BunestFactory.createApplicationContext(ExtModule, {
      logger: false,
      snapshot: true,
    });
    try {
      const container = ctx.getModuleContainer();
      const creator = ExternalContextCreator.fromContainer(container);
      const handler = ctx.get(ExternalHandler);

      const wrapped = creator.create(
        handler,
        handler.handle as (...args: unknown[]) => unknown,
        "handle",
      );
      expect(await wrapped("bunest")).toBe("hello bunest");

      // Direct helper methods
      expect(creator.getContextModuleKey(ExtModule)).toBeTruthy();
      expect(await creator.transformToResult(Promise.resolve(42))).toBe(42);
      expect(
        await creator.transformToResult({
          subscribe: (obs: any) => {
            obs.next("from-subscribable");
            obs.complete();
          },
        }),
      ).toBe("from-subscribable");

      const guardsFn = creator.createGuardsFn(
        [AllowGuard],
        handler,
        handler.handle,
      );
      expect(guardsFn).not.toBeNull();
      await guardsFn!(["arg"]);

      const meta = creator.getMetadata(handler, "handle");
      expect(meta.argsLength).toBeGreaterThanOrEqual(1);

      const exchanged = creator.exchangeKeysForValues(
        ["0:0"],
        { "0:0": { index: 0, data: "user" } },
        "",
        { exchangeKeyForValue: (_t, _d, args) => args[0] },
      );
      const pipesFn = creator.createPipesFn(
        [{ transform: (v: string) => v.toUpperCase() }],
        exchanged,
      );
      const outArgs: unknown[] = [];
      await pipesFn!(outArgs, "ada");
      expect(outArgs).toEqual(["ADA"]);

      const reqCtxId = ContextIdFactory.create();
      creator.registerRequestProvider({ user: "root" }, reqCtxId);

      // MiddlewareBuilder (`CoreMiddlewareConsumer`)
      const adapter = new BunHttpAdapter({ logger: false });
      const builder = new MiddlewareBuilder("ext", adapter);
      const noopMw: MiddlewareFunction = (_req, _res, next) => next();
      builder.apply(noopMw).forRoutes("/v1/users");
      expect(builder.getHttpAdapter()).toBe(adapter);
      expect(builder.build()).toHaveLength(1);
      expect(builder.getServedRoutes()).toHaveLength(1);

      // GraphInspector new methods
      const inspector = new GraphInspector(container);
      const extModNode = [...container.getModules().values()][0]!;
      const wrapper = {
        token: ExternalHandler,
        metatype: ExternalHandler,
        instance: handler,
        moduleRef: container.getModuleRef(extModNode.id),
        moduleId: extModNode.id,
        scope: Scope.SINGLETON,
        isDependencyTreeStatic: true,
      };
      inspector.insertClassNode(extModNode, wrapper, "provider");
      inspector.inspectInstanceWrapper(wrapper, extModNode);
      inspector.insertEnhancerMetadataCache({
        moduleToken: extModNode.id,
        classRef: ExternalHandler,
        enhancerRef: AllowGuard,
        targetNodeId: `${extModNode.id}:provider:ExternalHandler`,
        subtype: "guard",
      });
      const graphJson = inspector.getSerializedGraph().toJSON();
      expect(
        Object.keys(graphJson.nodes).some((id) =>
          id.includes("ExternalHandler"),
        ),
      ).toBe(true);
      expect(graphJson.extras.orphanedEnhancers.length).toBeGreaterThanOrEqual(
        1,
      );

      // NestContainer compatibility facade
      expect(container).toBeInstanceOf(NestContainer);
      expect(container.applicationConfig).toBe(
        container.getApplicationConfig(),
      );
      expect(container.serializedGraph).toBe(container.getSerializedGraph());
      expect(container.contextOptions).toBeDefined();
      expect(container.getModules().size).toBeGreaterThan(0);
      expect(container.getModuleByKey(extModNode.id)).toBe(extModNode);
      container.setHttpAdapter(adapter);
      expect(container.getHttpAdapterRef()).toBe(adapter);
      expect(container.getHttpAdapterHostRef()).toBe(
        container.getHttpAdapterHost(),
      );
      container.registerCoreModuleRef(extModNode);
      expect(container.getInternalCoreModuleRef()).toBe(extModNode);
      expect(container.isGlobalModule(ExtModule)).toBe(false);
      expect(container.isGlobalModule(ExtModule, { global: true })).toBe(true);

      await container.addDynamicMetadata("dyn-tok", { exports: ["A"] });
      expect(container.getDynamicMetadataByToken("dyn-tok", "exports")).toEqual(
        ["A"],
      );
      const compiled = await container.getModuleCompiler().compile(ExtModule);
      expect(compiled.type).toBe(ExtModule);
    } finally {
      await ctx.close();
    }
  });

  it("integrates ServeStaticModule.forRoot() and forRootAsync() with BunestFactory + globalPrefix + StandardSchemaValidationPipe", async () => {
    const dir = join(
      Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
      `bunest-core-static-${crypto.randomUUID()}`,
    );
    await ensureDir(dir);
    tmpDirs.push(dir);
    await Bun.write(join(dir, "index.html"), "<title>Bunest App</title>");
    await Bun.write(join(dir, "hello.txt"), "hello-from-serve-static");

    const nameSchema: StandardSchemaV1<unknown, { name: string }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate(v) {
          if (
            typeof v === "object" &&
            v !== null &&
            typeof (v as any).name === "string" &&
            (v as any).name.length >= 2
          ) {
            return { value: { name: (v as any).name.trim() } };
          }
          return { issues: [{ message: "name invalid", path: ["name"] }] };
        },
      },
    };

    @Controller("items")
    class ItemsController {
      @Post()
      create(@Body(nameSchema) body: { name: string }) {
        return body;
      }
    }

    @Injectable()
    class StaticConfigFactory implements ServeStaticModuleOptionsFactory {
      createLoggerOptions(): ServeStaticModuleOptions[] {
        return [
          {
            rootPath: dir,
            serveRoot: "/assets",
            useGlobalPrefix: true,
            exclude: ["/api/items*"],
          },
        ];
      }
    }

    @Module({
      imports: [
        ServeStaticModule.forRootAsync({
          useClass: StaticConfigFactory,
        }),
      ],
      controllers: [ItemsController],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    try {
      app.setGlobalPrefix("api");
      app.useGlobalPipes(new StandardSchemaValidationPipe());
      await app.init();

      const assetRes = await app.inject("/api/assets/hello.txt");
      expect(assetRes.statusCode).toBe(200);
      expect(assetRes.body).toBe("hello-from-serve-static");

      const postOk = await app.inject({
        method: "POST",
        url: "/api/items",
        payload: { name: "  Widget  " },
      });
      expect(postOk.statusCode).toBe(201);
      expect(postOk.json()).toEqual({ name: "Widget" });

      const postBad = await app.inject({
        method: "POST",
        url: "/api/items",
        payload: { name: "x" },
      });
      expect(postBad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
