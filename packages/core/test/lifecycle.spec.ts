import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  Injectable,
  Module,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@bunest/common";
import { DIContainer, LifecycleManager, ModuleScanner } from "../src";

describe("LifecycleManager (ADR-007 §7)", () => {
  it("invokes init/bootstrap in bottom-up topological order and shutdown in reverse order after stopServer()", async () => {
    const events: string[] = [];

    @Injectable()
    class DbService
      implements
        OnModuleInit,
        OnApplicationBootstrap,
        OnModuleDestroy,
        BeforeApplicationShutdown,
        OnApplicationShutdown
    {
      async onModuleInit() {
        await Promise.resolve();
        events.push("db:init");
      }
      onApplicationBootstrap() {
        events.push("db:bootstrap");
      }
      onModuleDestroy() {
        events.push("db:destroy");
      }
      beforeApplicationShutdown(signal?: string) {
        events.push(`db:beforeShutdown:${signal ?? "none"}`);
      }
      onApplicationShutdown(signal?: string) {
        events.push(`db:shutdown:${signal ?? "none"}`);
      }
    }

    @Module({ providers: [DbService], exports: [DbService] })
    class DbModule {}

    @Injectable()
    class AppService
      implements
        OnModuleInit,
        OnApplicationBootstrap,
        OnModuleDestroy,
        BeforeApplicationShutdown,
        OnApplicationShutdown
    {
      constructor(public readonly db: DbService) {}

      onModuleInit() {
        events.push("app:init");
      }
      onApplicationBootstrap() {
        events.push("app:bootstrap");
      }
      onModuleDestroy() {
        events.push("app:destroy");
      }
      beforeApplicationShutdown(signal?: string) {
        events.push(`app:beforeShutdown:${signal ?? "none"}`);
      }
      onApplicationShutdown(signal?: string) {
        events.push(`app:shutdown:${signal ?? "none"}`);
      }
    }

    @Module({ imports: [DbModule], providers: [AppService] })
    class AppModule {}

    const graph = await new ModuleScanner().scan(AppModule);
    const container = new DIContainer(graph);
    await container.initialize();

    const lifecycle = new LifecycleManager();
    const groups = container.getSingletonInstancesByModule();

    await lifecycle.callModuleInit(groups);
    await lifecycle.callApplicationBootstrap(groups);

    // Bottom-up topological init -> bootstrap
    expect(events).toEqual([
      "db:init",
      "app:init",
      "db:bootstrap",
      "app:bootstrap",
    ]);

    events.length = 0;

    await lifecycle.callShutdown(groups, "SIGTERM", async () => {
      events.push("server:stop");
    });

    // Server stops FIRST, then reverse topological destroy -> beforeShutdown -> shutdown
    expect(events).toEqual([
      "server:stop",
      "app:destroy",
      "db:destroy",
      "app:beforeShutdown:SIGTERM",
      "db:beforeShutdown:SIGTERM",
      "app:shutdown:SIGTERM",
      "db:shutdown:SIGTERM",
    ]);

    // Idempotent second shutdown call does nothing
    events.length = 0;
    await lifecycle.callShutdown(groups, "SIGTERM");
    expect(events).toEqual([]);
  });

  it("registers and cleanly unregisters process shutdown signal hooks without leaking listeners", async () => {
    const lifecycle = new LifecycleManager();
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");

    lifecycle.enableShutdownHooks(["SIGINT", "SIGTERM"], () => {});
    expect(lifecycle.getActiveHookCount()).toBe(2);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1);

    await lifecycle.callShutdown([]);
    expect(lifecycle.getActiveHookCount()).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
  });
});
