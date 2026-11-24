import { describe, expect, it } from "bun:test";
import { Controller, Get, Injectable, Module } from "@bunest/core";
import { BunestFactory } from "@bunest/core";
import {
  DevtoolsModule,
  DevtoolsService,
  DiskHealthIndicator,
  FetchHealthIndicator,
  GRPCHealthIndicator,
  GraphPublisher,
  HEALTH_CHECK_METADATA,
  HealthCheck,
  HealthCheckAttempt,
  HealthCheckError,
  HealthCheckException,
  HealthCheckService,
  HealthCheckStatus,
  HealthIndicator,
  HealthIndicatorService,
  HealthIndicatorSession,
  HealthIndicatorStatus,
  HealthModule,
  HttpHealthIndicator,
  MemoryHealthIndicator,
  MicroserviceHealthIndicator,
  PrismaHealthIndicator,
  TerminusModule,
  TimeoutError,
  toBytes,
  toMs,
  type DevtoolsModuleOptions,
  type DevtoolsOptionsFactory,
  type TerminusAsyncModuleOptions,
  type TerminusOptionsFactory,
} from "../src";
import { MetadataRegistry } from "@bunest/core";

describe("@bunest/observability Terminus v12 & Devtools Parity", () => {
  it("exports runtime HealthIndicatorStatus and HealthCheckStatus constants and unit parsers", () => {
    expect(HealthIndicatorStatus.UP).toBe("up");
    expect(HealthIndicatorStatus.DOWN).toBe("down");
    expect(HealthIndicatorStatus.DEGRADED).toBe("degraded");

    expect(HealthCheckStatus.OK).toBe("ok");
    expect(HealthCheckStatus.ERROR).toBe("error");
    expect(HealthCheckStatus.DEGRADED).toBe("degraded");
    expect(HealthCheckStatus.SHUTTING_DOWN).toBe("shutting_down");

    expect(toMs(250)).toBe(250);
    expect(toMs("300ms")).toBe(300);
    expect(toMs("2s")).toBe(2000);
    expect(toMs("1.5m")).toBe(90_000);
    expect(toMs("1h")).toBe(3_600_000);
    expect(toMs("1d")).toBe(86_400_000);
    expect(toMs("1w")).toBe(604_800_000);
    expect(() => toMs("5x" as any)).toThrow(/Invalid duration/);

    expect(toBytes(1024)).toBe(1024);
    expect(toBytes("2kb")).toBe(2048);
    expect(toBytes("1mb")).toBe(1024 * 1024);
    expect(toBytes("1gb")).toBe(1024 ** 3);
    expect(toBytes("1tb")).toBe(1024 ** 4);
    expect(() => toBytes("10pb" as any)).toThrow(/Invalid size/);

    const timeoutErr = new TimeoutError(500);
    expect(timeoutErr).toBeInstanceOf(Error);
    expect(timeoutErr.timeoutMs).toBe(500);
    expect(timeoutErr.message).toContain("500ms");
  });

  it("supports HealthIndicatorService, HealthIndicatorSession, and HealthCheckAttempt fluent API", async () => {
    const svc = new HealthIndicatorService();
    const session = svc.check("cache");
    expect(session).toBeInstanceOf(HealthIndicatorSession);

    expect(session.up({ nodes: 3 })).toEqual({
      cache: { status: "up", nodes: 3 },
    });
    expect(session.down("unreachable")).toEqual({
      cache: { status: "down", message: "unreachable" },
    });
    expect(session.degraded({ latency: 420 })).toEqual({
      cache: { status: "degraded", latency: 420 },
    });
    expect(() => session.up({ status: "down" } as any)).toThrow(/reserved key/);

    // Attempt with static, success data, failure data, degradedOnFailure, degradedAfter
    const attempt = svc
      .check("payments")
      .attempt(async () => ({ region: "us-east", ok: true }))
      .withData({ owner: "billing" })
      .withSuccessData((res) => ({ region: res.region }));

    expect(attempt).toBeInstanceOf(HealthCheckAttempt);
    const res = await attempt;
    expect(res.payments.status).toBe("up");
    expect(res.payments.owner).toBe("billing");
    expect((res.payments as { region?: string }).region).toBe("us-east");
    expect(typeof res.payments.responseTime).toBe("number");

    // Degraded on failure + failure data
    const degradedFail = await svc
      .check("recs")
      .attempt(async () => {
        const err = Object.assign(new Error("downstream down"), {
          code: "E_DOWN",
        });
        throw err;
      })
      .withFailureData((e) => ({ code: (e as { code?: string }).code }))
      .degradedOnFailure();

    expect(degradedFail.recs.status).toBe("degraded");
    expect(degradedFail.recs.code).toBe("E_DOWN");
    expect(degradedFail.recs.message).toBe("downstream down");

    // Degraded after threshold
    const slowDegraded = await svc
      .check("slow_svc")
      .attempt(async () => {
        await Bun.sleep(25);
      })
      .degradedAfter("10ms");
    expect(slowDegraded.slow_svc.status).toBe("degraded");

    // Timeout with AbortSignal cancellation
    let aborted = false;
    const timedOut = await svc
      .check("hang_svc")
      .attempt(async ({ signal }) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        await Bun.sleep(200);
      })
      .withTimeout("20ms");
    expect(timedOut.hang_svc.status).toBe("down");
    expect(timedOut.hang_svc.message).toContain("20ms");
    expect(aborted).toBe(true);

    // Single-flight caching via .cacheFor()
    let invocations = 0;
    const makeCachedAttempt = () =>
      svc
        .check("cached_dep")
        .attempt(async () => {
          invocations++;
          await Bun.sleep(15);
          return { count: invocations };
        })
        .withSuccessData((r) => r)
        .cacheFor("2s");

    const [firstA, firstB] = await Promise.all([
      makeCachedAttempt(),
      makeCachedAttempt(),
    ]);
    expect(invocations).toBe(1);
    expect(firstA.cached_dep.cachedResponse).toBeUndefined();
    expect(firstB.cached_dep.cachedResponse).toBeUndefined();

    const second = await makeCachedAttempt();
    expect(invocations).toBe(1);
    expect(second.cached_dep.cachedResponse).toBe(true);
    expect((second.cached_dep as { count?: number }).count).toBe(1);
  });

  it("handles degraded (HTTP 200), shutting_down (503), HealthCheckError, legacy HealthIndicator, and @HealthCheck() Cache-Control", async () => {
    class LegacyIndicator extends HealthIndicator {
      checkDog(healthy: boolean) {
        return this.getStatus("dog", healthy, { badboys: healthy ? 0 : 2 });
      }
    }

    const logs: string[] = [];
    const customLogger = {
      log: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
    };

    const indicatorSvc = new HealthIndicatorService(customLogger);
    const healthSvc = new HealthCheckService(
      { errorLogStyle: "pretty", gracefulShutdownTimeoutMs: 10 },
      customLogger,
    );
    const legacy = new LegacyIndicator();

    // Degraded returns without throwing (HTTP 200)
    const degradedResult = await healthSvc.check([
      () => legacy.checkDog(true),
      indicatorSvc
        .check("search")
        .attempt(() => {
          throw new Error("search lagging");
        })
        .degradedOnFailure(),
    ]);
    expect(degradedResult.status).toBe(HealthCheckStatus.DEGRADED);
    expect(degradedResult.info?.dog?.status).toBe("up");
    expect(degradedResult.info?.search?.status).toBe("degraded");
    expect(Object.keys(degradedResult.error ?? {})).toHaveLength(0);

    // HealthCheckError construction (both string + result forms)
    const err1 = new HealthCheckError("Dog failed", legacy.checkDog(false));
    expect(err1).toBeInstanceOf(HealthCheckException);
    expect(err1.getStatus()).toBe(503);
    expect(err1.causes).toEqual({ dog: { status: "down", badboys: 2 } });

    const err2 = new HealthCheckError(degradedResult);
    expect(err2.result).toBe(degradedResult);

    // Shutdown transitions to shutting_down (throws 503)
    await healthSvc.beforeApplicationShutdown("SIGTERM");
    try {
      await healthSvc.check([() => legacy.checkDog(true)]);
      expect.unreachable("Expected shutting_down HealthCheckException");
    } catch (err) {
      expect(err).toBeInstanceOf(HealthCheckException);
      expect((err as HealthCheckException).result.status).toBe(
        HealthCheckStatus.SHUTTING_DOWN,
      );
    }

    // @HealthCheck() decorator sets Cache-Control header & metadata
    @Controller("/health-ctrl")
    class HealthCtrl {
      constructor(
        private readonly health: HealthCheckService,
        private readonly indicators: HealthIndicatorService,
      ) {}

      @Get("nocache")
      @HealthCheck()
      checkDefault() {
        return this.health.check([() => this.indicators.check("api").up()]);
      }

      @Get("cached")
      @HealthCheck({ noCache: false, swaggerDocumentation: false })
      checkCached() {
        return this.health.check([() => this.indicators.check("api").up()]);
      }
    }

    @Module({
      imports: [TerminusModule.forRoot({ logger: false })],
      controllers: [HealthCtrl],
    })
    class AppMod {}

    const meta = MetadataRegistry.get<{
      noCache: boolean;
      swaggerDocumentation: boolean;
    }>(HEALTH_CHECK_METADATA, HealthCtrl.prototype.checkDefault);
    expect(meta).toEqual({ noCache: true, swaggerDocumentation: true });

    const app = await BunestFactory.create(AppMod, { logger: false });
    try {
      const r1 = await app.fetch(
        new Request("http://localhost/health-ctrl/nocache"),
      );
      expect(r1.status).toBe(200);
      expect(r1.headers.get("cache-control")).toBe(
        "no-cache, no-store, must-revalidate",
      );
      const body1 = (await r1.json()) as { status: string };
      expect(body1.status).toBe("ok");

      const r2 = await app.fetch(
        new Request("http://localhost/health-ctrl/cached"),
      );
      expect(r2.status).toBe(200);
      expect(r2.headers.get("cache-control")).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("supports FetchHealthIndicator, HttpHealthIndicator, MemoryHealthIndicator (ByteSize), DiskHealthIndicator, PrismaHealthIndicator, MicroserviceHealthIndicator, and GRPCHealthIndicator", async () => {
    const indicatorSvc = new HealthIndicatorService();

    // 1. FetchHealthIndicator
    let bodyCanceled = false;
    const fetchInd = new FetchHealthIndicator(indicatorSvc);
    const fetchUp = await fetchInd.pingCheck("api", "https://example.test/ok", {
      fetch: async () =>
        ({
          status: 200,
          statusText: "OK",
          bodyUsed: false,
          body: {
            cancel: async () => {
              bodyCanceled = true;
            },
          },
        }) as unknown as Response,
    });
    expect(fetchUp.api.status).toBe("up");
    expect(bodyCanceled).toBe(true);

    const fetchDown = await fetchInd.pingCheck(
      "api",
      "https://example.test/fail",
      {
        fetch: async () =>
          ({
            status: 503,
            statusText: "Service Unavailable",
          }) as unknown as Response,
      },
    );
    expect(fetchDown.api.status).toBe("down");
    expect(fetchDown.api.statusCode).toBe(503);
    expect(fetchDown.api.statusText).toBe("Service Unavailable");

    const fetchVerifyFail = await fetchInd.pingCheck(
      "billing",
      "https://example.test/200",
      {
        fetch: async () =>
          ({ status: 200, statusText: "OK" }) as unknown as Response,
        verify: (res) => res.status === 204,
      },
    );
    expect(fetchVerifyFail.billing.status).toBe("down");
    expect(fetchVerifyFail.billing.message).toContain("did not pass");

    // 2. HttpHealthIndicator
    const httpInd = new HttpHealthIndicator(undefined, indicatorSvc);
    await httpInd.onModuleInit();
    const httpUp = await httpInd.pingCheck("web", "https://example.test/ok", {
      fetch: async () => new Response("ok", { status: 200 }),
    });
    expect(httpUp.web.status).toBe("up");

    const httpRespCheck = await httpInd.responseCheck<{ healthy: boolean }>(
      "json_api",
      "https://example.test/status",
      (res) => res.status === 200 && res.data.healthy === true,
      {
        fetch: async () =>
          new Response(JSON.stringify({ healthy: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );
    expect(httpRespCheck.json_api?.status).toBe("up");

    // 3. MemoryHealthIndicator with ByteSize string + chaining
    const memInd = new MemoryHealthIndicator(indicatorSvc);
    const heapUp = await memInd.checkHeap("heap", "16gb");
    expect(heapUp.heap.status).toBe("up");
    const heapDegraded = await memInd
      .checkHeap("heap_low", "1kb")
      .degradedOnFailure();
    expect(heapDegraded.heap_low.status).toBe("degraded");

    // 4. DiskHealthIndicator (real statfs + mocked checkDiskSpace)
    const realDisk = new DiskHealthIndicator(undefined, indicatorSvc);
    const realDiskRes = await realDisk.checkStorage("disk_real", {
      path: process.cwd(),
      thresholdPercent: 1.0,
    });
    expect(realDiskRes.disk_real.status).toBe("up");

    const mockDisk = new DiskHealthIndicator(
      async () => ({ size: 100 * 1024 ** 3, free: 20 * 1024 ** 3 }),
      indicatorSvc,
    );
    // Used = 80gb
    expect(
      (await mockDisk.checkStorage("d1", { path: "/", threshold: "90gb" })).d1
        .status,
    ).toBe("up");
    expect(
      (await mockDisk.checkStorage("d2", { path: "/", threshold: "50gb" })).d2
        .status,
    ).toBe("down");
    expect(
      (await mockDisk.checkStorage("d3", { path: "/", thresholdPercent: 0.85 }))
        .d3.status,
    ).toBe("up");
    expect(
      (await mockDisk.checkStorage("d4", { path: "/", thresholdPercent: 0.5 }))
        .d4.status,
    ).toBe("down");

    // 5. PrismaHealthIndicator (SQL + Mongo + Error with code)
    const prismaInd = new PrismaHealthIndicator(indicatorSvc);
    const sqlPrismaRes = await prismaInd.pingCheck("prisma_sql", {
      $queryRawUnsafe: async (q: string) => (q === "SELECT 1" ? [1] : []),
    });
    expect(sqlPrismaRes.prisma_sql.status).toBe("up");

    const mongoPrismaRes = await prismaInd.pingCheck("prisma_mongo", {
      $runCommandRaw: async () => ({ ok: 1 }),
    });
    expect(mongoPrismaRes.prisma_mongo.status).toBe("up");

    const prismaFallback = await prismaInd.pingCheck("prisma_fallback", {
      $runCommandRaw: async () => {
        throw new Error("Use the mongodb provider to run raw commands");
      },
      $queryRawUnsafe: async () => [1],
    });
    expect(prismaFallback.prisma_fallback.status).toBe("up");

    const prismaDown = await prismaInd.pingCheck("prisma_err", {
      $queryRawUnsafe: async () => {
        throw Object.assign(new Error("connection refused"), { code: "P1001" });
      },
    });
    expect(prismaDown.prisma_err.status).toBe("down");
    expect(prismaDown.prisma_err.code).toBe("P1001");

    // 6. MicroserviceHealthIndicator (real TCP Bun.listen server + custom client)
    const msInd = new MicroserviceHealthIndicator(indicatorSvc);
    await msInd.onModuleInit();

    const tcpServer = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data() {},
      },
    });
    try {
      const tcpUp = await msInd.pingCheck("tcp", {
        transport: 0,
        options: { host: "127.0.0.1", port: tcpServer.port },
      });
      expect(tcpUp.tcp.status).toBe("up");
    } finally {
      tcpServer.stop(true);
    }

    let closedClient = false;
    const clientUp = await msInd.pingCheck("custom_ms", {
      transport: "REDIS",
      client: {
        connect: async () => {},
        close: async () => {
          closedClient = true;
        },
      },
    });
    expect(clientUp.custom_ms.status).toBe("up");
    expect(closedClient).toBe(true);

    // 7. GRPCHealthIndicator (SERVING, NOT_SERVING, cleanup)
    const grpcInd = new GRPCHealthIndicator(indicatorSvc);
    await grpcInd.onModuleInit();
    let grpcClosed = false;

    const grpcUp = await grpcInd.checkService("hero", "hero.v1", {
      client: {
        getService: () => ({
          check: async () => ({ status: 1 }),
        }),
        close: () => {
          grpcClosed = true;
        },
      },
    });
    expect(grpcUp.hero.status).toBe("up");
    expect(grpcUp.hero.statusCode).toBe(1);
    expect(grpcUp.hero.servingStatus).toBe("SERVING");

    const grpcDown = await grpcInd.checkService("hero_down", "hero.v1", {
      healthServiceCheck: async () => ({ status: 2 }),
    });
    expect(grpcDown.hero_down.status).toBe("down");
    expect(grpcDown.hero_down.statusCode).toBe(2);
    expect(grpcDown.hero_down.servingStatus).toBe("NOT_SERVING");

    grpcInd.onApplicationShutdown();
    expect(grpcClosed).toBe(true);
  });

  it("supports TerminusModule.forRootAsync (useFactory, useClass, useExisting) and HealthModule.forRootAsync", async () => {
    @Injectable()
    class TerminusConfigFactory implements TerminusOptionsFactory {
      createTerminusOptions(): TerminusAsyncModuleOptions {
        return { errorLogStyle: "pretty", logger: false };
      }
    }

    @Module({
      providers: [TerminusConfigFactory],
      exports: [TerminusConfigFactory],
    })
    class ConfigMod {}

    // 1. useFactory
    @Module({
      imports: [
        TerminusModule.forRootAsync({
          useFactory: async () => ({ logger: false, errorLogStyle: "json" }),
        }),
      ],
    })
    class FactoryApp {}

    const app1 = await BunestFactory.create(FactoryApp, { logger: false });
    try {
      expect(app1.get(HealthCheckService)).toBeInstanceOf(HealthCheckService);
      expect(app1.get(FetchHealthIndicator)).toBeInstanceOf(
        FetchHealthIndicator,
      );
      expect(app1.get(DiskHealthIndicator)).toBeInstanceOf(DiskHealthIndicator);
      expect(app1.get(PrismaHealthIndicator)).toBeInstanceOf(
        PrismaHealthIndicator,
      );
      expect(app1.get(MicroserviceHealthIndicator)).toBeInstanceOf(
        MicroserviceHealthIndicator,
      );
      expect(app1.get(GRPCHealthIndicator)).toBeInstanceOf(GRPCHealthIndicator);
      expect(app1.get(HttpHealthIndicator)).toBeInstanceOf(HttpHealthIndicator);
    } finally {
      await app1.close();
    }

    // 2. useClass
    @Module({
      imports: [
        TerminusModule.forRootAsync({ useClass: TerminusConfigFactory }),
      ],
    })
    class ClassApp {}
    const app2 = await BunestFactory.create(ClassApp, { logger: false });
    try {
      expect(app2.get(HealthIndicatorService)).toBeInstanceOf(
        HealthIndicatorService,
      );
    } finally {
      await app2.close();
    }

    // 3. useExisting + HealthModule.forRootAsync
    @Module({
      imports: [
        HealthModule.forRootAsync({
          imports: [ConfigMod],
          useExisting: TerminusConfigFactory,
        }),
      ],
    })
    class ExistingApp {}
    const app3 = await BunestFactory.create(ExistingApp, { logger: false });
    try {
      expect(app3.get(HealthCheckService)).toBeInstanceOf(HealthCheckService);
    } finally {
      await app3.close();
    }
  });

  it("supports DevtoolsModule.register(), registerAsync(), and GraphPublisher", async () => {
    @Injectable()
    class DevtoolsConfigFactory implements DevtoolsOptionsFactory {
      createDevtoolsOptions(): DevtoolsModuleOptions {
        return { http: true, port: 8000, allowInProduction: true };
      }
    }

    @Module({
      imports: [
        DevtoolsModule.register({
          http: false,
          port: 8000,
        }),
      ],
    })
    class NoHttpDevtoolsApp {}

    const noHttpApp = await BunestFactory.create(NoHttpDevtoolsApp, {
      logger: false,
      snapshot: true,
    });
    try {
      expect(noHttpApp.get(DevtoolsService)).toBeInstanceOf(DevtoolsService);
      // http: false disables HTTP endpoints
      const res = await noHttpApp.fetch(
        new Request("http://localhost/_devtools/graph"),
      );
      expect(res.status).toBe(404);

      // GraphPublisher publishes deflated base64 SerializedGraph via fetch
      const publisher = new GraphPublisher(noHttpApp);
      let capturedUrl = "";
      let capturedAuth = "";
      let capturedBody: Record<string, unknown> = {};

      await publisher.publish({
        apiKey: "secret-key",
        owner: "bunest-org",
        repository: "bunest",
        branch: "main",
        trigger: "push",
        sha: "abc123",
        target: "prod",
        endpoint: "https://devtools.test",
        fetch: async (url, init) => {
          capturedUrl = url;
          capturedAuth =
            (init.headers as Record<string, string>).Authorization ?? "";
          capturedBody = JSON.parse(String(init.body));
          return Response.json({
            previewUrl: "https://devtools.test/preview/1",
            reportUrl: "https://devtools.test/report/1",
          });
        },
      });

      expect(capturedUrl).toBe(
        "https://devtools.test/organizations/bunest-org/projects/bunest/builds",
      );
      expect(capturedAuth).toBe("ApiKey secret-key");
      expect(capturedBody.branch).toBe("main");
      expect(capturedBody.hash).toBe("abc123");
      expect(capturedBody.trigger).toBe("push");
      expect(capturedBody.target).toBe("prod");
      expect(typeof capturedBody.snapshot).toBe("string");
      expect((capturedBody.snapshot as string).length).toBeGreaterThan(10);

      // Required option validation
      await expect(
        publisher.publish({
          apiKey: "k",
          owner: "",
          repository: "r",
          branch: "main",
          trigger: "push",
          sha: "1",
        }),
      ).rejects.toThrow(/"owner" parameter is required/);
    } finally {
      await noHttpApp.close();
    }

    // DevtoolsModule.registerAsync (useClass & useFactory)
    @Module({
      imports: [
        DevtoolsModule.registerAsync({
          useClass: DevtoolsConfigFactory,
        }),
      ],
    })
    class AsyncDevtoolsApp {}

    const asyncApp = await BunestFactory.create(AsyncDevtoolsApp, {
      logger: false,
    });
    try {
      const res = await asyncApp.fetch(
        new Request("http://localhost/_devtools/graph"),
      );
      expect(res.status).toBe(200);
    } finally {
      await asyncApp.close();
    }
  });
});
