import "reflect-metadata";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";
import { EventBus } from "../../../../../packages/cqrs/src";
import {
  Test,
  describeConformance,
  itAdapted,
  type TestingModule,
} from "../../../_helpers";
import {
  AsyncHandlersAppModule,
  HeroFoundItemEvent,
  HeroFoundItemSlowHandler,
  HeroKilledDragon2SlowHandler,
  HeroKilledDragonEvent,
  HeroKilledDragonSlowHandler,
  SyncHandlersAppModule,
  waitImmediate,
} from "../_fixtures/cqrs-fixtures";

describeConformance(
  "Sync event handlers",
  {
    upstreamPath: "nestjs/cqrs/test/e2e/sync-event-handlers-app.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-008"],
    notes:
      "Under ADR-008 (zero-RxJS Promise EventBus), Bunest's default EventBus.publish() awaits all async event handlers natively (sync behavior without RxJS eventOperators), while a custom fire-and-forget DefaultPubSub publisher demonstrates non-blocking async dispatch.",
  },
  () => {
    describe("when event handlers are fully asynchronous (fire-and-forget publisher)", () => {
      let moduleRef: TestingModule;
      let eventBus: EventBus;
      let heroFoundItemEnded: ReturnType<typeof spyOn>;
      let heroKilledDragonEnded: ReturnType<typeof spyOn>;
      let heroKilledDragon2Ended: ReturnType<typeof spyOn>;

      beforeAll(async () => {
        moduleRef = await Test.createTestingModule({
          imports: [AsyncHandlersAppModule],
        }).compile();

        await moduleRef.init();
        eventBus = moduleRef.get(EventBus);
        heroFoundItemEnded = spyOn(
          moduleRef.get(HeroFoundItemSlowHandler),
          "end",
        );
        heroKilledDragonEnded = spyOn(
          moduleRef.get(HeroKilledDragonSlowHandler),
          "end",
        );
        heroKilledDragon2Ended = spyOn(
          moduleRef.get(HeroKilledDragon2SlowHandler),
          "end",
        );
      });

      beforeEach(() => {
        heroFoundItemEnded.mockClear();
        heroKilledDragonEnded.mockClear();
        heroKilledDragon2Ended.mockClear();
      });

      afterAll(async () => {
        await waitImmediate();
        heroFoundItemEnded?.mockRestore();
        heroKilledDragonEnded?.mockRestore();
        heroKilledDragon2Ended?.mockRestore();
        await moduleRef.close();
      });

      describe('when "HeroFoundItemEvent" event is published', () => {
        itAdapted(
          "ADR-008",
          "should not wait for the event handlers to complete",
          async () => {
            const event = new HeroFoundItemEvent("hero1", "item1");

            await eventBus.publish(event);

            expect(heroFoundItemEnded).not.toHaveBeenCalled();
            expect(heroKilledDragonEnded).not.toHaveBeenCalled();
            expect(heroKilledDragon2Ended).not.toHaveBeenCalled();

            // Let background handler settle before teardown
            await waitImmediate();
            expect(heroFoundItemEnded).toHaveBeenCalledTimes(1);
          },
          "custom fire-and-forget DefaultPubSub publisher",
        );
      });

      describe('when "HeroKilledDragonEvent" event is published', () => {
        itAdapted(
          "ADR-008",
          "should not wait for the event handlers to complete",
          async () => {
            const event = new HeroKilledDragonEvent("hero1", "dragon1");

            await eventBus.publish(event);

            expect(heroFoundItemEnded).not.toHaveBeenCalled();
            expect(heroKilledDragonEnded).not.toHaveBeenCalled();
            expect(heroKilledDragon2Ended).not.toHaveBeenCalled();

            await waitImmediate();
            expect(heroKilledDragonEnded).toHaveBeenCalledTimes(1);
            expect(heroKilledDragon2Ended).toHaveBeenCalledTimes(1);
          },
          "custom fire-and-forget DefaultPubSub publisher",
        );
      });
    });

    describe("when event handlers are synchronous (awaitable EventBus.publish)", () => {
      let moduleRef: TestingModule;
      let eventBus: EventBus;
      let heroFoundItemEnded: ReturnType<typeof spyOn>;
      let heroKilledDragonEnded: ReturnType<typeof spyOn>;
      let heroKilledDragon2Ended: ReturnType<typeof spyOn>;

      beforeAll(async () => {
        moduleRef = await Test.createTestingModule({
          imports: [SyncHandlersAppModule],
        }).compile();

        await moduleRef.init();
        eventBus = moduleRef.get(EventBus);
        heroFoundItemEnded = spyOn(
          moduleRef.get(HeroFoundItemSlowHandler),
          "end",
        );
        heroKilledDragonEnded = spyOn(
          moduleRef.get(HeroKilledDragonSlowHandler),
          "end",
        );
        heroKilledDragon2Ended = spyOn(
          moduleRef.get(HeroKilledDragon2SlowHandler),
          "end",
        );
      });

      beforeEach(() => {
        heroFoundItemEnded.mockClear();
        heroKilledDragonEnded.mockClear();
        heroKilledDragon2Ended.mockClear();
      });

      afterAll(async () => {
        heroFoundItemEnded?.mockRestore();
        heroKilledDragonEnded?.mockRestore();
        heroKilledDragon2Ended?.mockRestore();
        await moduleRef.close();
      });

      describe('when "HeroFoundItemEvent" event is published', () => {
        it("should wait for the event handlers to complete", async () => {
          const event = new HeroFoundItemEvent("hero1", "item1");

          await eventBus.publish(event);

          expect(heroFoundItemEnded).toHaveBeenCalledTimes(1);
          expect(heroKilledDragonEnded).not.toHaveBeenCalled();
          expect(heroKilledDragon2Ended).not.toHaveBeenCalled();
        });
      });

      describe('when "HeroKilledDragonEvent" event is published', () => {
        it("should wait for the event handlers to complete", async () => {
          const event = new HeroKilledDragonEvent("hero1", "dragon1");

          await eventBus.publish(event);

          expect(heroFoundItemEnded).not.toHaveBeenCalled();
          expect(heroKilledDragonEnded).toHaveBeenCalledTimes(1);
          expect(heroKilledDragon2Ended).toHaveBeenCalledTimes(1);
        });
      });

      describe("when an unknown event is published", () => {
        it("should return directly", async () => {
          await eventBus.publish({ id: "unknown event" });

          expect(heroFoundItemEnded).not.toHaveBeenCalled();
          expect(heroKilledDragonEnded).not.toHaveBeenCalled();
          expect(heroKilledDragon2Ended).not.toHaveBeenCalled();
        });
      });
    });
  },
);
