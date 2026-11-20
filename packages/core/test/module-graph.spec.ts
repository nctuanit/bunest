import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  Controller,
  Global,
  Inject,
  Injectable,
  Module,
  RequestMethod,
  forwardRef,
  type DynamicModule,
} from "@bunest/common";
import {
  AmbiguousProviderException,
  CircularDependencyException,
  CoreMiddlewareConsumer,
  DIContainer,
  DuplicateProviderException,
  InvalidExportException,
  InvalidModuleException,
  ModuleScanner,
  UnknownDependencyException,
} from "../src";

describe("ModuleScanner & Module Visibility (ADR-007)", () => {
  it("deduplicates static modules in diamond graphs and shares a single singleton instance", async () => {
    let creations = 0;

    @Injectable()
    class SharedDb {
      readonly id = ++creations;
    }

    @Module({ providers: [SharedDb], exports: [SharedDb] })
    class DbModule {}

    @Injectable()
    class UsersService {
      constructor(public readonly db: SharedDb) {}
    }
    @Module({
      imports: [DbModule],
      providers: [UsersService],
      exports: [UsersService],
    })
    class UsersModule {}

    @Injectable()
    class OrdersService {
      constructor(public readonly db: SharedDb) {}
    }
    @Module({
      imports: [DbModule],
      providers: [OrdersService],
      exports: [OrdersService],
    })
    class OrdersModule {}

    @Module({ imports: [UsersModule, OrdersModule] })
    class AppModule {}

    const graph = await new ModuleScanner().scan(AppModule);
    const container = new DIContainer(graph);
    await container.initialize();

    const appRef = container.getModuleRef(graph.root.id);
    const users = appRef.get(UsersService);
    const orders = appRef.get(OrdersService);

    expect(creations).toBe(1);
    expect(users.db).toBe(orders.db);
    expect(users.db.id).toBe(1);
  });

  it("enforces encapsulation (private by default, explicit exports, no implicit transitive leaking, re-exports)", async () => {
    @Injectable()
    class SecretHelper {}

    @Injectable()
    class PublicHelper {}

    @Module({ providers: [SecretHelper, PublicHelper], exports: [PublicHelper] })
    class ModA {}

    // Private provider cannot be injected by importer
    @Injectable()
    class BadConsumer {
      constructor(public readonly s: SecretHelper) {}
    }
    @Module({ imports: [ModA], providers: [BadConsumer] })
    class BadImporter {}

    const badGraph = await new ModuleScanner().scan(BadImporter);
    await expect(new DIContainer(badGraph).initialize()).rejects.toThrow(
      UnknownDependencyException,
    );

    // No implicit transitive leaking unless ModB re-exports ModA
    @Module({ imports: [ModA] })
    class ModBNoReExport {}

    @Injectable()
    class ConsumerC {
      constructor(public readonly p: PublicHelper) {}
    }
    @Module({ imports: [ModBNoReExport], providers: [ConsumerC] })
    class ModCBlocked {}

    const blockedGraph = await new ModuleScanner().scan(ModCBlocked);
    await expect(new DIContainer(blockedGraph).initialize()).rejects.toThrow(
      UnknownDependencyException,
    );

    // With explicit re-export of ModA, ConsumerC resolves PublicHelper cleanly
    @Module({ imports: [ModA], exports: [ModA] })
    class ModBWithReExport {}

    @Module({ imports: [ModBWithReExport], providers: [ConsumerC] })
    class ModCAllowed {}

    const allowedGraph = await new ModuleScanner().scan(ModCAllowed);
    const container = new DIContainer(allowedGraph);
    await container.initialize();
    const consumer = container.getModuleRef(allowedGraph.root.id).get(ConsumerC);
    expect(consumer.p).toBeInstanceOf(PublicHelper);
  });

  it("supports provider object direct exports, sync/async DynamicModule deduplication, and @Global() encapsulation", async () => {
    const CONFIG_A = Symbol("CONFIG_A");
    const CONFIG_B = Symbol("CONFIG_B");
    const DIRECT_EXPORT = Symbol("DIRECT_EXPORT");
    const GLOBAL_PUBLIC = Symbol("GLOBAL_PUBLIC");
    const GLOBAL_PRIVATE = Symbol("GLOBAL_PRIVATE");

    @Global()
    @Module({
      providers: [
        { provide: GLOBAL_PUBLIC, useValue: "visible-everywhere" },
        { provide: GLOBAL_PRIVATE, useValue: "stays-private" },
      ],
      exports: [GLOBAL_PUBLIC],
    })
    class GlobalModule {}

    class ConfigModule {
      static forFeature(token: symbol, val: string): DynamicModule {
        return {
          module: ConfigModule,
          providers: [{ provide: token, useValue: val }],
          exports: [token],
        };
      }

      static async forRootAsync(): Promise<DynamicModule> {
        await Promise.resolve();
        return {
          module: ConfigModule,
          exports: [{ provide: DIRECT_EXPORT, useValue: "exported-direct" }],
        };
      }
    }

    const sharedDyn = ConfigModule.forFeature(CONFIG_A, "shared-a");

    @Injectable()
    class FeatureConsumer {
      constructor(
        @Inject(CONFIG_A) public readonly a: string,
        @Inject(CONFIG_B) public readonly b: string,
        @Inject(DIRECT_EXPORT) public readonly direct: string,
        @Inject(GLOBAL_PUBLIC) public readonly pub: string,
      ) {}
    }

    @Module({
      imports: [
        GlobalModule,
        sharedDyn,
        sharedDyn, // exact same reference deduplicates cleanly
        ConfigModule.forFeature(CONFIG_B, "distinct-b"),
        ConfigModule.forRootAsync(),
      ],
      providers: [FeatureConsumer],
    })
    class AppModule {}

    const graph = await new ModuleScanner().scan(AppModule);
    const container = new DIContainer(graph);
    await container.initialize();

    const consumer = container
      .getModuleRef(graph.root.id)
      .get(FeatureConsumer);
    expect(consumer.a).toBe("shared-a");
    expect(consumer.b).toBe("distinct-b");
    expect(consumer.direct).toBe("exported-direct");
    expect(consumer.pub).toBe("visible-everywhere");

    // Non-exported provider of @Global() module MUST remain private
    @Injectable()
    class LeakingGlobalConsumer {
      constructor(@Inject(GLOBAL_PRIVATE) public readonly priv: string) {}
    }
    @Module({ imports: [GlobalModule], providers: [LeakingGlobalConsumer] })
    class BadGlobalApp {}

    const badGraph = await new ModuleScanner().scan(BadGlobalApp);
    await expect(new DIContainer(badGraph).initialize()).rejects.toThrow(
      UnknownDependencyException,
    );
  });

  it("enforces local > imports > global precedence and throws AmbiguousProviderException on conflicting exports", async () => {
    const TOKEN = Symbol("SHARED_TOKEN");

    @Global()
    @Module({
      providers: [{ provide: TOKEN, useValue: "from-global" }],
      exports: [TOKEN],
    })
    class GlobalMod {}

    @Module({
      providers: [{ provide: TOKEN, useValue: "from-import-1" }],
      exports: [TOKEN],
    })
    class Import1 {}

    @Module({
      providers: [{ provide: TOKEN, useValue: "from-import-2" }],
      exports: [TOKEN],
    })
    class Import2 {}

    // Direct import shadows global
    @Module({ imports: [GlobalMod, Import1] })
    class ImportWinsApp {}
    const g1 = await new ModuleScanner().scan(ImportWinsApp);
    const c1 = new DIContainer(g1);
    await c1.initialize();
    expect(c1.getModuleRef(g1.root.id).get(TOKEN)).toBe("from-import-1");

    // Local shadows both import and global (even when two imports conflict!)
    @Module({
      imports: [GlobalMod, Import1, Import2],
      providers: [{ provide: TOKEN, useValue: "from-local" }],
    })
    class LocalWinsApp {}
    const g2 = await new ModuleScanner().scan(LocalWinsApp);
    const c2 = new DIContainer(g2);
    await c2.initialize();
    expect(c2.getModuleRef(g2.root.id).get(TOKEN)).toBe("from-local");

    // Conflicting direct imports without local override fail fast with AmbiguousProviderException
    @Injectable()
    class AmbiguousConsumer {
      constructor(@Inject(TOKEN) public readonly v: string) {}
    }
    @Module({
      imports: [Import1, Import2],
      providers: [AmbiguousConsumer],
    })
    class AmbiguousApp {}
    const g3 = await new ModuleScanner().scan(AmbiguousApp);
    await expect(new DIContainer(g3).initialize()).rejects.toThrow(
      AmbiguousProviderException,
    );

    // Conflicting @Global() modules without local/import override ALSO fail fast
    @Global()
    @Module({
      providers: [{ provide: TOKEN, useValue: "from-global-2" }],
      exports: [TOKEN],
    })
    class GlobalMod2 {}

    @Module({
      imports: [GlobalMod, GlobalMod2],
      providers: [AmbiguousConsumer],
    })
    class AmbiguousGlobalApp {}
    const g4 = await new ModuleScanner().scan(AmbiguousGlobalApp);
    await expect(new DIContainer(g4).initialize()).rejects.toThrow(
      AmbiguousProviderException,
    );
  });

  it("fails fast on InvalidModuleException, DuplicateProviderException, InvalidExportException, and unwrapped module cycles", async () => {
    class NotAModule {}
    await expect(new ModuleScanner().scan(NotAModule)).rejects.toThrow(
      InvalidModuleException,
    );

    const DUP = Symbol("DUP");
    @Module({
      providers: [
        { provide: DUP, useValue: 1 },
        { provide: DUP, useValue: 2 },
      ],
    })
    class DupModule {}
    await expect(new ModuleScanner().scan(DupModule)).rejects.toThrow(
      DuplicateProviderException,
    );

    const UNKNOWN = Symbol("UNKNOWN");
    @Module({ exports: [UNKNOWN] })
    class BadExportTokenModule {}
    await expect(new ModuleScanner().scan(BadExportTokenModule)).rejects.toThrow(
      InvalidExportException,
    );

    @Module({})
    class UnimportedMod {}
    @Module({ exports: [UnimportedMod] })
    class BadReExportModule {}
    await expect(new ModuleScanner().scan(BadReExportModule)).rejects.toThrow(
      InvalidExportException,
    );

    // Circular module imports WITH forwardRef succeed
    @Injectable()
    class SvcA {}
    @Injectable()
    class SvcB {}

    @Module({
      imports: [forwardRef(() => CycleB)],
      providers: [SvcA],
      exports: [SvcA],
    })
    class CycleA {}

    @Module({
      imports: [forwardRef(() => CycleA)],
      providers: [SvcB],
      exports: [SvcB],
    })
    class CycleB {}

    const cycGraph = await new ModuleScanner().scan(CycleA);
    expect(cycGraph.modules.size).toBe(2);

    // Unwrapped circular module import fails fast
    const dynA: DynamicModule = { module: class DynA {}, imports: [] };
    const dynB: DynamicModule = { module: class DynB {}, imports: [dynA] };
    dynA.imports!.push(dynB);
    await expect(new ModuleScanner().scan(dynA)).rejects.toThrow(
      CircularDependencyException,
    );
  });

  it("collects middleware rules in CoreMiddlewareConsumer for string, RouteInfo, and Controller targets", () => {
    @Controller("/users")
    class UsersController {}

    const mw = (_req: Request, _res: unknown, next: () => void) => next();
    const consumer = new CoreMiddlewareConsumer("mod-1");
    consumer
      .apply(mw as never)
      .exclude({ path: "/users/health", method: RequestMethod.GET })
      .forRoutes(UsersController, "/admin");

    const configs = consumer.getConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0]?.moduleId).toBe("mod-1");
    expect(configs[0]?.exclude).toEqual([
      { path: "/users/health", method: RequestMethod.GET },
    ]);
    expect(configs[0]?.include).toEqual([
      { path: "/users", method: RequestMethod.ALL },
      { path: "/users/*", method: RequestMethod.ALL },
      { path: "/admin", method: RequestMethod.ALL },
    ]);
  });
});
