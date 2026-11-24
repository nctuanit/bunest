import { afterEach, expect, it } from "bun:test";
import {
  Injectable,
  Module,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
} from "../../../../../packages/core/src/common";
import {
  NestFactory,
  type BunestApplication,
} from "../../../../../packages/core/src";
import { describeConformance } from "../../../_helpers";

describeConformance(
  "enableShutdownHooks",
  {
    upstreamPath: "integration/hooks/e2e/enable-shutdown-hook.spec.ts",
    category: "DIRECT_PORT",
    notes:
      "Dispatches registered process signal listeners in-process (cross-platform Windows + POSIX safe, avoiding POSIX SIGHUP process.kill failures on win32).",
  },
  () => {
    let app: BunestApplication | undefined;

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    function createAppModule(calls: string[]) {
      @Injectable()
      class TestInjectable
        implements OnApplicationShutdown, BeforeApplicationShutdown
      {
        beforeApplicationShutdown(signal?: string) {
          calls.push(`beforeApplicationShutdown ${signal ?? ""}`);
        }

        onApplicationShutdown(signal?: string) {
          calls.push(`onApplicationShutdown ${signal ?? ""}`);
        }
      }

      @Module({ providers: [TestInjectable] })
      class AppModule {}

      return AppModule;
    }

    it("should call the correct hooks when a default shutdown signal is emitted", async () => {
      const calls: string[] = [];
      app = await NestFactory.create(createAppModule(calls), { logger: false });
      app.enableShutdownHooks();
      await app.init();

      const beforeCount = process.listeners("SIGTERM").length;
      expect(beforeCount).toBeGreaterThan(0);

      // Invoke only the last registered SIGTERM listener (owned by this app)
      const listeners = process.listeners("SIGTERM");
      const listener = listeners[listeners.length - 1] as
        (() => void) | undefined;
      listener?.();

      await new Promise((r) => setTimeout(r, 30));

      expect(calls).toEqual([
        "beforeApplicationShutdown SIGTERM",
        "onApplicationShutdown SIGTERM",
      ]);
    });

    it("should call the correct hooks when a specific shutdown signal is registered", async () => {
      const calls: string[] = [];
      app = await NestFactory.create(createAppModule(calls), { logger: false });
      app.enableShutdownHooks(["SIGINT"]);
      await app.init();

      const listeners = process.listeners("SIGINT");
      const listener = listeners[listeners.length - 1] as
        (() => void) | undefined;
      listener?.();

      await new Promise((r) => setTimeout(r, 30));

      expect(calls).toEqual([
        "beforeApplicationShutdown SIGINT",
        "onApplicationShutdown SIGINT",
      ]);
    });

    it("should ignore system signals which are not specified", async () => {
      const calls: string[] = [];
      const sigintBefore = process.listeners("SIGINT").length;
      const sigtermBefore = process.listeners("SIGTERM").length;

      app = await NestFactory.create(createAppModule(calls), { logger: false });
      app.enableShutdownHooks(["SIGTERM"]);
      await app.init();

      expect(process.listeners("SIGINT").length).toBe(sigintBefore);
      expect(process.listeners("SIGTERM").length).toBe(sigtermBefore + 1);
      expect(calls).toEqual([]);
    });

    it('should not register signal listeners if "enableShutdownHooks" was not called', async () => {
      const calls: string[] = [];
      const sigintBefore = process.listeners("SIGINT").length;
      const sigtermBefore = process.listeners("SIGTERM").length;

      app = await NestFactory.create(createAppModule(calls), { logger: false });
      await app.init();

      expect(process.listeners("SIGINT").length).toBe(sigintBefore);
      expect(process.listeners("SIGTERM").length).toBe(sigtermBefore);
      expect(calls).toEqual([]);
    });

    it("should clean up registered signal listeners on close() without leaking", async () => {
      const calls: string[] = [];
      const sigtermBefore = process.listeners("SIGTERM").length;

      app = await NestFactory.create(createAppModule(calls), { logger: false });
      app.enableShutdownHooks(["SIGTERM"]);
      await app.init();
      expect(process.listeners("SIGTERM").length).toBe(sigtermBefore + 1);

      await app.close();
      expect(process.listeners("SIGTERM").length).toBe(sigtermBefore);
    });
  },
);
