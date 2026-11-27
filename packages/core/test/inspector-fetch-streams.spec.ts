import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Global,
  Inject,
  Injectable,
  Module,
  RequestTimeoutException,
  Scope,
  TimeoutError,
  UseInterceptors,
  mapAsyncIterable,
  tapAsyncIterable,
  withTimeout,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
  type OnModuleDestroy,
  type OnModuleInit,
} from "../src/common/index";
import {
  BunestFactory,
  GraphInspector,
  ScopeLeakException,
  SerializedGraph,
  mapAsyncIterable as coreMapAsyncIterable,
  tapAsyncIterable as coreTapAsyncIterable,
  withTimeout as coreWithTimeout,
} from "../src";

describe("GraphInspector cross-module resolution & Cold-Start Boot Profiling", () => {
  it("resolves actual owning module IDs for cross-module, re-exported, and @Global() dependencies without dangling edges", async () => {
    @Injectable()
    class GlobalConfigService {}

    @Global()
    @Module({
      providers: [GlobalConfigService],
      exports: [GlobalConfigService],
    })
    class GlobalConfigModule {}

    @Injectable()
    class LeafService {}

    @Module({
      providers: [LeafService],
      exports: [LeafService],
    })
    class LeafModule {}

    @Module({
      imports: [LeafModule],
      exports: [LeafModule],
    })
    class MiddleModule {}

    @Injectable()
    class SharedService {}

    @Module({
      providers: [SharedService],
      exports: [SharedService],
    })
    class SharedModule {}

    @Injectable()
    class LocalHelper {}

    @Injectable()
    class FeatureService {
      @Inject(SharedService)
      readonly propShared!: SharedService;

      constructor(
        readonly local: LocalHelper,
        readonly shared: SharedService,
        readonly leaf: LeafService,
        readonly config: GlobalConfigService,
      ) {}
    }

    @Module({
      imports: [SharedModule, MiddleModule],
      providers: [LocalHelper, FeatureService],
      exports: [FeatureService],
    })
    class FeatureModule {}

    @Module({
      imports: [GlobalConfigModule, FeatureModule],
    })
    class RootAppModule {}

    const ctx = await BunestFactory.createApplicationContext(RootAppModule, {
      logger: false,
      snapshot: true,
    });
    try {
      const container = ctx.getModuleContainer();
      const inspector = new GraphInspector(container);
      const modules = [...container.getModules().values()];
      const findMod = (name: string) =>
        modules.find((m) => m.name === name)!;

      const featureMod = findMod("FeatureModule");
      const sharedMod = findMod("SharedModule");
      const leafMod = findMod("LeafModule");
      const globalMod = findMod("GlobalConfigModule");

      inspector.inspectInstanceWrapper(
        {
          token: FeatureService,
          metatype: FeatureService,
          instance: ctx.get(FeatureService),
          moduleRef: container.getModuleRef(featureMod.id),
          moduleId: featureMod.id,
          scope: Scope.SINGLETON,
          isDependencyTreeStatic: true,
        },
        featureMod,
      );

      const graphJson = inspector.getSerializedGraph().toJSON();
      const classEdges = Object.values(graphJson.edges).filter(
        (e) =>
          e.metadata.type === "class-to-class" &&
          e.source === `${featureMod.id}:provider:FeatureService`,
      );

      expect(classEdges.length).toBe(5);

      // Every single edge target MUST exist as a real node in graphJson.nodes (zero dangling edges)
      for (const edge of classEdges) {
        expect(graphJson.nodes[edge.target]).toBeDefined();
      }

      const byTarget = new Map(
        classEdges.map((e) => [
          `${e.metadata.type === "class-to-class" ? e.metadata.injectionType : ""}:${
            e.metadata.type === "class-to-class" ? e.metadata.targetClassName : ""
          }`,
          e,
        ]),
      );

      expect(byTarget.get("constructor:LocalHelper")?.target).toBe(
        `${featureMod.id}:provider:LocalHelper`,
      );
      expect(byTarget.get("constructor:SharedService")?.target).toBe(
        `${sharedMod.id}:provider:SharedService`,
      );
      expect(byTarget.get("constructor:LeafService")?.target).toBe(
        `${leafMod.id}:provider:LeafService`,
      );
      expect(byTarget.get("constructor:GlobalConfigService")?.target).toBe(
        `${globalMod.id}:provider:GlobalConfigService`,
      );
      expect(byTarget.get("property:SharedService")?.target).toBe(
        `${sharedMod.id}:provider:SharedService`,
      );

      const sharedEdge = byTarget.get("constructor:SharedService")!;
      if (sharedEdge.metadata.type === "class-to-class") {
        expect(sharedEdge.metadata.sourceModuleName).toBe("FeatureModule");
        expect(sharedEdge.metadata.targetModuleName).toBe("SharedModule");
      }
    } finally {
      await ctx.close();
    }
  });

  it("records per-module and per-provider initTimeMs when snapshot: true or BUNEST_BOOT_PROFILE=1, and has zero graph overhead otherwise", async () => {
    const SLOW_TOKEN = Symbol("SLOW_TOKEN");

    @Module({
      providers: [
        {
          provide: SLOW_TOKEN,
          useFactory: async () => {
            await Bun.sleep(15);
            return "warm";
          },
        },
      ],
      exports: [SLOW_TOKEN],
    })
    class SlowModule {}

    // 1. Default (snapshot off, env unset) -> zero profiling overhead (no nodes recorded)
    const prevEnv = process.env.BUNEST_BOOT_PROFILE;
    delete process.env.BUNEST_BOOT_PROFILE;
    try {
      const fastCtx = await BunestFactory.createApplicationContext(SlowModule, {
        logger: false,
      });
      try {
        const emptyGraph = fastCtx.get(SerializedGraph).toJSON();
        expect(Object.keys(emptyGraph.nodes)).toHaveLength(0);
      } finally {
        await fastCtx.close();
      }

      // 2. snapshot: true -> records initTimeMs on both module and provider nodes
      const snapCtx = await BunestFactory.createApplicationContext(SlowModule, {
        logger: false,
        snapshot: true,
      });
      try {
        const snapJson = snapCtx.get(SerializedGraph).toJSON();
        const modNode = Object.values(snapJson.nodes).find(
          (n) => n.metadata.type === "module" && n.label === "SlowModule",
        );
        const provNode = Object.values(snapJson.nodes).find(
          (n) =>
            n.metadata.type === "provider" &&
            n.label.includes("SLOW_TOKEN"),
        );

        expect(modNode).toBeDefined();
        expect(provNode).toBeDefined();
        expect(typeof modNode!.metadata.initTimeMs).toBe("number");
        expect(typeof provNode!.metadata.initTimeMs).toBe("number");
        expect(modNode!.metadata.initTimeMs!).toBeGreaterThanOrEqual(10);
        expect(provNode!.metadata.initTimeMs!).toBeGreaterThanOrEqual(10);
        expect(provNode!.metadata.initTime).toBe(provNode!.metadata.initTimeMs);
      } finally {
        await snapCtx.close();
      }

      // 3. BUNEST_BOOT_PROFILE=1 without snapshot: true
      process.env.BUNEST_BOOT_PROFILE = "1";
      const envCtx = await BunestFactory.createApplicationContext(SlowModule, {
        logger: false,
      });
      try {
        const envJson = envCtx.get(SerializedGraph).toJSON();
        const modNode = Object.values(envJson.nodes).find(
          (n) => n.metadata.type === "module" && n.label === "SlowModule",
        );
        const provNode = Object.values(envJson.nodes).find(
          (n) =>
            n.metadata.type === "provider" &&
            n.label.includes("SLOW_TOKEN"),
        );
        expect(modNode?.metadata.initTimeMs).toBeGreaterThanOrEqual(10);
        expect(provNode?.metadata.initTimeMs).toBeGreaterThanOrEqual(10);
      } finally {
        await envCtx.close();
      }
    } finally {
      if (prevEnv === undefined) {
        delete process.env.BUNEST_BOOT_PROFILE;
      } else {
        process.env.BUNEST_BOOT_PROFILE = prevEnv;
      }
    }
  });

  it("preserves ADR-012 fail-fast ScopeLeakException when profiling is enabled", async () => {
    @Injectable({ scope: Scope.REQUEST })
    class ReqScoped {}

    @Injectable()
    class BadSingleton {
      constructor(readonly req: ReqScoped) {}
    }

    @Module({ providers: [ReqScoped, BadSingleton] })
    class LeakyModule {}

    await expect(
      BunestFactory.createApplicationContext(LeakyModule, {
        logger: false,
        snapshot: true,
      }),
    ).rejects.toThrow(ScopeLeakException);
  });
});

describe("BunestFactory.createFetchHandler()", () => {
  it("performs lazy single-flight cold-start bootstrap under 25 concurrent first requests and supports configure() & close()", async () => {
    let factoryBootCount = 0;
    let initCount = 0;
    let destroyCount = 0;

    @Injectable()
    class ColdStartService implements OnModuleInit, OnModuleDestroy {
      constructor(@Inject("BOOT_ID") readonly bootId: string) {}
      onModuleInit() {
        initCount += 1;
      }
      onModuleDestroy() {
        destroyCount += 1;
      }
    }

    @Controller("serverless")
    class ServerlessController {
      constructor(private readonly svc: ColdStartService) {}

      @Get("ping")
      ping() {
        return { ok: true, bootId: this.svc.bootId };
      }
    }

    @Module({
      controllers: [ServerlessController],
      providers: [
        ColdStartService,
        {
          provide: "BOOT_ID",
          useFactory: async () => {
            factoryBootCount += 1;
            await Bun.sleep(20);
            return `boot-${factoryBootCount}`;
          },
        },
      ],
    })
    class ServerlessAppModule {}

    const handler = BunestFactory.createFetchHandler(ServerlessAppModule, {
      logger: false,
      configure: (app) => {
        app.setGlobalPrefix("api");
      },
    });

    // Lazy: nothing booted yet!
    expect(factoryBootCount).toBe(0);
    expect(initCount).toBe(0);

    try {
      const responses = await Promise.all(
        Array.from({ length: 25 }, () =>
          handler(new Request("http://edge.local/api/serverless/ping")),
        ),
      );

      expect(factoryBootCount).toBe(1);
      expect(initCount).toBe(1);

      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, bootId: "boot-1" });
      }
    } finally {
      await handler.close();
      await handler.close(); // idempotent
    }

    expect(destroyCount).toBe(1);
  });

  it("recovers from a transient cold-start failure and supports await using disposal", async () => {
    let attempt = 0;
    let destroyed = false;

    @Injectable()
    class FlakyResource implements OnModuleDestroy {
      onModuleDestroy() {
        destroyed = true;
      }
    }

    @Controller("retry")
    class RetryController {
      @Get()
      ok() {
        return { attempt };
      }
    }

    @Module({
      controllers: [RetryController],
      providers: [
        FlakyResource,
        {
          provide: "FLAKY",
          useFactory: async () => {
            attempt += 1;
            if (attempt === 1) {
              throw new Error("transient cold-start failure");
            }
            return "recovered";
          },
        },
      ],
    })
    class FlakyModule {}

    {
      await using handler = BunestFactory.createFetchHandler(FlakyModule, {
        logger: false,
      });

      await expect(
        handler(new Request("http://edge.local/retry")),
      ).rejects.toThrow("transient cold-start failure");

      const res = await handler(new Request("http://edge.local/retry"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ attempt: 2 });
    }

    expect(destroyed).toBe(true);
  });
});

describe("Zero-dep Async Stream Interceptor Helpers", () => {
  async function* genItems<T>(items: T[], delayMs = 0): AsyncGenerator<T> {
    for (const item of items) {
      if (delayMs > 0) {
        await Bun.sleep(delayMs);
      }
      yield item;
    }
  }

  it("exports mapAsyncIterable, tapAsyncIterable, and withTimeout identically from @bunest/core/common and @bunest/core", () => {
    expect(mapAsyncIterable).toBe(coreMapAsyncIterable);
    expect(tapAsyncIterable).toBe(coreTapAsyncIterable);
    expect(withTimeout).toBe(coreWithTimeout);
  });

  it("maps and taps async iterables lazily with completion, error, and early-break hooks", async () => {
    const seen: string[] = [];
    const events: string[] = [];

    const mapped = mapAsyncIterable(genItems([10, 20, 30]), async (n, idx) => {
      return `${idx}:${n * 2}`;
    });

    const tapped = tapAsyncIterable(
      mapped,
      (v) => {
        seen.push(v);
      },
      {
        onComplete: () => {
          events.push("complete");
        },
        onFinally: () => {
          events.push("finally");
        },
      },
    );

    const out: string[] = [];
    for await (const chunk of tapped) {
      out.push(chunk);
    }

    expect(out).toEqual(["0:20", "1:40", "2:60"]);
    expect(seen).toEqual(["0:20", "1:40", "2:60"]);
    expect(events).toEqual(["complete", "finally"]);

    // Early break fires onFinally without onComplete
    const breakEvents: string[] = [];
    const earlyStream = tapAsyncIterable(
      genItems([1, 2, 3, 4]),
      () => {},
      {
        onComplete: () => {
          breakEvents.push("complete");
        },
        onFinally: () => {
          breakEvents.push("finally");
        },
      },
    );
    for await (const x of earlyStream) {
      if (x === 2) break;
    }
    expect(breakEvents).toEqual(["finally"]);

    // Upstream error fires onError and onFinally
    const errEvents: string[] = [];
    async function* failingGen() {
      yield 1;
      throw new Error("stream-boom");
    }
    const errStream = tapAsyncIterable(
      failingGen(),
      () => {},
      {
        onError: (err) => {
          errEvents.push(`error:${(err as Error).message}`);
        },
        onFinally: () => {
          errEvents.push("finally");
        },
      },
    );
    const consumeErr = async () => {
      for await (const _ of errStream) {
        // consume
      }
    };
    await expect(consumeErr()).rejects.toThrow("stream-boom");
    expect(errEvents).toEqual(["error:stream-boom", "finally"]);
  });

  it("enforces withTimeout on Promises and AsyncIterables (chunk & total modes, hung streams, custom errors)", async () => {
    // Promise mode (backward-compatible)
    expect(await withTimeout(Promise.resolve("fast"), 100)).toBe("fast");
    await expect(
      withTimeout(new Promise(() => {}), 15, "promise-timeout"),
    ).rejects.toThrow(TimeoutError);

    // AsyncIterable chunk mode: 3 chunks x 8ms each with 30ms per-chunk limit succeeds
    const fastChunks: number[] = [];
    for await (const v of withTimeout(genItems([1, 2, 3], 6), 40)) {
      fastChunks.push(v);
    }
    expect(fastChunks).toEqual([1, 2, 3]);

    // AsyncIterable chunk mode: hung generator rejects promptly without deadlocking
    async function* hungGenerator(): AsyncGenerator<string> {
      yield "first";
      await new Promise(() => {});
    }
    const receivedBeforeTimeout: string[] = [];
    const runHung = async () => {
      for await (const v of withTimeout(hungGenerator(), 20, "chunk-stalled")) {
        receivedBeforeTimeout.push(v);
      }
    };
    await expect(runHung()).rejects.toThrow("chunk-stalled");
    expect(receivedBeforeTimeout).toEqual(["first"]);

    // AsyncIterable total mode with custom RequestTimeoutException
    const runTotal = async () => {
      for await (const _ of withTimeout(genItems([1, 2, 3, 4, 5], 12), 25, {
        mode: "total",
        onTimeout: () => new RequestTimeoutException("stream budget exceeded"),
      })) {
        // consume
      }
    };
    await expect(runTotal()).rejects.toThrow(RequestTimeoutException);
  });

  it("composes cleanly inside a Promise-based BunestInterceptor without RxJS", async () => {
    const logged: string[] = [];

    @Injectable()
    class StreamEnvelopeInterceptor implements BunestInterceptor {
      async intercept(
        _ctx: ExecutionContext,
        next: CallHandler,
      ): Promise<unknown> {
        const result = (await next.handle()) as AsyncIterable<number>;
        return withTimeout(
          tapAsyncIterable(
            mapAsyncIterable(result, (n) => `chunk:${n}`),
            (label) => {
              logged.push(label);
            },
          ),
          100,
        );
      }
    }

    const interceptor = new StreamEnvelopeInterceptor();
    const wrapped = (await interceptor.intercept(
      {} as ExecutionContext,
      {
        handle: async () => genItems([1, 2, 3]),
      },
    )) as AsyncIterable<string>;

    const collected: string[] = [];
    for await (const item of wrapped) {
      collected.push(item);
    }

    expect(collected).toEqual(["chunk:1", "chunk:2", "chunk:3"]);
    expect(logged).toEqual(["chunk:1", "chunk:2", "chunk:3"]);
  });
});
