import "reflect-metadata";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Module } from "../../../../../packages/common/src";
import {
  DrizzleModule,
  DrizzleService,
  getDrizzleToken,
  type DrizzleClosableClient,
  type DrizzleDatabaseLike,
  type DrizzleModuleOptions,
} from "../../../../../packages/sql/src";
import {
  Test,
  createSpy,
  describeConformance,
} from "../../../_helpers/index";

function createRealSqliteDrizzlePair(): {
  db: DrizzleDatabaseLike & { readonly isClosed: boolean };
  client: DrizzleClosableClient & { readonly isClosed: boolean };
} {
  const sqlite = new Database(":memory:");
  let closed = false;

  const client: DrizzleClosableClient & { readonly isClosed: boolean } = {
    get isClosed() {
      return closed;
    },
    close() {
      if (!closed) {
        closed = true;
        sqlite.close(true);
      }
    },
  };

  const db: DrizzleDatabaseLike & { readonly isClosed: boolean } = {
    get isClosed() {
      return closed;
    },
    run(query: unknown) {
      return sqlite.run(String(query));
    },
  };

  return { db, client };
}

async function bootAndClose(...registrations: DrizzleModuleOptions[]) {
  @Module({
    imports: registrations.map((options) => DrizzleModule.forRoot(options)),
  })
  class AppModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile({ logger: false });
  await moduleRef.init();
  await moduleRef.close();
}

describeConformance(
  "Persistence (drizzle) - shutdown & application lifecycle",
  {
    upstreamPath: "drizzle/tests/e2e/drizzle-shutdown.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts DrizzleModule/DrizzleService shutdown hooks (client.close/client.end, autoClose: false, onDestroy, error cleanup, shared clients, per-app forRootAsync lifecycle) to @bunest/sql.",
  },
  () => {
    it("should close a real bun:sqlite client on application shutdown", async () => {
      const { db, client } = createRealSqliteDrizzlePair();
      await bootAndClose({ db, client });
      expect(client.isClosed).toBe(true);
    });

    it("should call end() on pool-based clients", async () => {
      const end = createSpy(async () => undefined);
      await bootAndClose({ db: {}, client: { end } });
      expect(end.calledOnce).toBe(true);
    });

    it("should prefer close() over end() when both are present (Bunest DrizzleService contract)", async () => {
      const close = createSpy();
      const end = createSpy();
      await bootAndClose({ db: {}, client: { close, end } });
      expect(close.calledOnce).toBe(true);
      expect(end.notCalled).toBe(true);
    });

    it("should call close() on embedded clients", async () => {
      const close = createSpy();
      await bootAndClose({ db: {}, client: { close } });
      expect(close.calledOnce).toBe(true);
    });

    it("should support callable function clients with attached end() (e.g. postgres.js)", async () => {
      const end = createSpy();
      const client = Object.assign(() => undefined, { end });
      await bootAndClose({ db: {}, client });
      expect(end.calledOnce).toBe(true);
    });

    it("should await async client end() before moduleRef.close() resolves", async () => {
      let finished = false;
      const end = createSpy(async () => {
        await Bun.sleep(10);
        finished = true;
      });
      await bootAndClose({ db: {}, client: { end } });
      expect(end.calledOnce).toBe(true);
      expect(finished).toBe(true);
    });

    it("should skip clients that hold nothing open", async () => {
      await expect(
        bootAndClose({ db: {}, client: {} }),
      ).resolves.toBeUndefined();
      await expect(bootAndClose({ db: {} })).resolves.toBeUndefined();
    });

    it("should not close the client when autoClose is false", async () => {
      const end = createSpy();
      await bootAndClose({
        db: {},
        client: { end },
        autoClose: false,
      });
      expect(end.notCalled).toBe(true);
    });

    it("should invoke onDestroy hook before closing client and still close client if onDestroy throws", async () => {
      const order: string[] = [];
      const close = createSpy(() => {
        order.push("client.close");
      });
      const onDestroy = createSpy(() => {
        order.push("onDestroy");
      });

      await bootAndClose({ db: {}, client: { close }, onDestroy });
      expect(order).toEqual(["onDestroy", "client.close"]);

      // Throwing onDestroy still executes client.close() in finally
      const closeAfterThrow = createSpy();
      const svc = new DrizzleService({
        db: {},
        client: { close: closeAfterThrow },
        onDestroy: () => {
          throw new Error("onDestroy failed");
        },
      });
      await expect(svc.close()).rejects.toThrow("onDestroy failed");
      expect(svc.isClosed).toBe(true);
      expect(closeAfterThrow.calledOnce).toBe(true);
    });

    it("should make DrizzleService.close() idempotent across repeated calls", async () => {
      const close = createSpy();
      const onDestroy = createSpy();
      const svc = new DrizzleService({
        db: {},
        client: { close },
        onDestroy,
      });

      await svc.close();
      await svc.close();

      expect(close.calledOnce).toBe(true);
      expect(onDestroy.calledOnce).toBe(true);
      expect(svc.isClosed).toBe(true);
    });

    it("should close a shared client once when secondary registration sets autoClose: false", async () => {
      const closeSpy = createSpy();
      const { db, client } = createRealSqliteDrizzlePair();
      const wrappedClient: DrizzleClosableClient = {
        close: () => {
          closeSpy();
          client.close?.();
        },
      };

      await bootAndClose(
        { db, client: wrappedClient },
        { name: "analytics", db, client: wrappedClient, autoClose: false },
      );

      expect(client.isClosed).toBe(true);
      expect(closeSpy.calledOnce).toBe(true);
    });

    it("should support Symbol.asyncDispose for scoped cleanup", async () => {
      const { db, client } = createRealSqliteDrizzlePair();
      let ref!: DrizzleService<
        DrizzleDatabaseLike & { readonly isClosed: boolean }
      >;
      {
        await using svc = new DrizzleService({ db, client });
        ref = svc;
        expect(svc.isClosed).toBe(false);
      }
      expect(ref.isClosed).toBe(true);
      expect(client.isClosed).toBe(true);
    });

    describe("application lifecycle", () => {
      it("should create a new database for every application with forRootAsync()", async () => {
        @Module({
          imports: [
            DrizzleModule.forRootAsync({
              useFactory: () => createRealSqliteDrizzlePair(),
            }),
          ],
        })
        class AppModule {}

        const boot = async () => {
          const mod = await Test.createTestingModule({
            imports: [AppModule],
          }).compile({ logger: false });
          await mod.init();
          return mod;
        };

        const first = await boot();
        const firstDb = first.get<
          DrizzleDatabaseLike & { readonly isClosed: boolean }
        >(getDrizzleToken());
        await first.close();
        expect(firstDb.isClosed).toBe(true);

        const second = await boot();
        const secondDb = second.get<
          DrizzleDatabaseLike & { readonly isClosed: boolean }
        >(getDrizzleToken());
        expect(secondDb).not.toBe(firstDb);
        expect(secondDb.isClosed).toBe(false);
        await second.close();
        expect(secondDb.isClosed).toBe(true);
      });
    });
  },
);
