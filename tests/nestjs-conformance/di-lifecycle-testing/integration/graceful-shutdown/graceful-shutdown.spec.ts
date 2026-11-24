import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  Module,
  type OnModuleDestroy,
} from "../../../../../packages/core/src/common";
import {
  NestFactory,
  type BunestApplication,
} from "../../../../../packages/core/src";
import { describeConformance, itAdapted } from "../../../_helpers";

@Controller()
class AppController {
  @Get("slow")
  async slow() {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return "ok";
  }
}

@Module({ controllers: [AppController] })
class AppModule {}

let hits = 0;

@Controller()
class HoldController {
  @Get("hold")
  hold() {
    hits += 1;
    return new Promise(() => {});
  }
}

@Module({ imports: [AppModule], controllers: [HoldController] })
class HoldModule {}

let shutdownHookEntered: Promise<void>;
let enterShutdownHook: () => void;
let shutdownHookReleased: Promise<void>;
let releaseShutdownHook: () => void;

@Injectable()
class SlowShutdownHook implements OnModuleDestroy {
  onModuleDestroy() {
    enterShutdownHook();
    return shutdownHookReleased;
  }
}

@Module({ imports: [AppModule], providers: [SlowShutdownHook] })
class SlowShutdownModule {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const within = <T>(promise: Promise<T>, ms = 2000) =>
  Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`Timed out after ${ms}ms`);
    }),
  ]);

describeConformance(
  "Graceful Shutdown (BunHttpAdapter)",
  {
    upstreamPath: "integration/graceful-shutdown/e2e/fastify.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-007"],
    notes:
      "Adapts Fastify graceful shutdown scenarios to native Bun.serve() / BunestApplication with forceCloseConnections and return503OnClosing.",
  },
  () => {
    let app: BunestApplication | undefined;

    beforeEach(() => {
      hits = 0;
      shutdownHookEntered = new Promise((resolve) => {
        enterShutdownHook = resolve;
      });
      shutdownHookReleased = new Promise((resolve) => {
        releaseShutdownHook = resolve;
      });
    });

    afterEach(async () => {
      releaseShutdownHook();
      await app?.close();
      app = undefined;
    });

    itAdapted(
      "ADR-001",
      "should let in-flight requests complete when forceCloseConnections is false",
      async () => {
        app = await NestFactory.create(AppModule, {
          forceCloseConnections: false,
          logger: false,
        });
        await app.listen(0, "127.0.0.1");
        const url = app.getUrl()!;

        const resPromise = fetch(new URL("/slow", url).toString()).then((r) =>
          r.text(),
        );
        await sleep(40);

        const closePromise = app.close();
        expect(await within(resPromise)).toBe("ok");
        await within(closePromise);
      },
    );

    itAdapted(
      "ADR-001",
      "should close cleanly when forceCloseConnections is enabled",
      async () => {
        app = await NestFactory.create(HoldModule, {
          forceCloseConnections: true,
          logger: false,
        });
        await app.listen(0, "127.0.0.1");
        const url = app.getUrl()!;

        const abort = new AbortController();
        const pending = fetch(new URL("/hold", url).toString(), {
          signal: abort.signal,
        }).catch(() => undefined);
        await sleep(40);
        expect(hits).toBe(1);

        await within(app.close());
        abort.abort();
        await within(pending);
      },
    );

    itAdapted(
      "ADR-007",
      "should run onModuleDestroy shutdown hooks asynchronously and wait for completion",
      async () => {
        app = await NestFactory.create(SlowShutdownModule, { logger: false });
        await app.listen(0, "127.0.0.1");

        let closed = false;
        const closePromise = app.close().then(() => {
          closed = true;
        });

        await within(shutdownHookEntered);
        expect(closed).toBe(false);

        releaseShutdownHook();
        await within(closePromise);
        expect(closed).toBe(true);
      },
    );

    itAdapted(
      "ADR-007",
      "should make repeated app.close() calls idempotent",
      async () => {
        app = await NestFactory.create(AppModule, { logger: false });
        await app.listen(0, "127.0.0.1");

        await app.close();
        await expect(app.close()).resolves.toBeUndefined();
      },
    );

    itAdapted(
      "ADR-001",
      "should return 503 for new requests while draining in-flight requests when return503OnClosing is enabled",
      async () => {
        app = await NestFactory.create(AppModule, {
          forceCloseConnections: false,
          return503OnClosing: true,
          logger: false,
        });
        await app.listen(0, "127.0.0.1");
        const url = app.getUrl()!;

        const slowPromise = fetch(new URL("/slow", url).toString());
        await sleep(30);

        const closePromise = app.close();
        await sleep(20);

        const duringClose = await app.inject({ method: "GET", url: "/slow" });
        expect(duringClose.statusCode).toBe(503);

        const slowRes = await within(slowPromise);
        expect(slowRes.status).toBe(200);
        expect(await slowRes.text()).toBe("ok");

        await within(closePromise);
      },
    );
  },
);
