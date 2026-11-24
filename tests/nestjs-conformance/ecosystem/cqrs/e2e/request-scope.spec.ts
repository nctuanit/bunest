import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import {
  AsyncContext,
  CommandBus,
  EventBus,
  QueryBus,
} from "../../../../../packages/messaging/src/cqrs";
import {
  Test,
  describeConformance,
  itAdapted,
  type TestingModule,
} from "../../../_helpers";
import {
  ANCIENT_ITEM_ID,
  CqrsAppModule,
  HERO_ID,
  ScopedDropAncientItemCommand,
  ScopedDropAncientItemHandler,
  ScopedGetHeroesQuery,
  ScopedHeroFoundItemEvent,
  ScopedHeroFoundItemHandler,
  ScopedHeroKilledDragonEvent,
  ScopedHeroKilledDragonHandler,
  ScopedKillDragonCommand,
  ScopedKillDragonHandler,
  sleepUnref,
  waitImmediate,
} from "../_fixtures/cqrs-fixtures";

describeConformance(
  "Request scope",
  {
    upstreamPath: "nestjs/cqrs/test/e2e/request-scope.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-008", "ADR-012"],
    notes:
      "Adapts ScopedHeroesGameSagas from RxJS ofType/delay/map to Bunest zero-RxJS async @Saga() with AsyncContext.merge() (ADR-008).",
  },
  () => {
    let moduleRef: TestingModule;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [CqrsAppModule],
      }).compile();

      await moduleRef.init();
    });

    afterAll(async () => {
      await moduleRef.close();
    });

    describe('when "ScopedKillDragonCommand" command is dispatched', () => {
      const asyncContext = new AsyncContext();

      let killDragonExecuteSpy: ReturnType<typeof spyOn>;
      let heroKilledDragonHandleSpy: ReturnType<typeof spyOn>;
      let command: ScopedKillDragonCommand;

      beforeAll(async () => {
        moduleRef.registerRequestByContextId(asyncContext, asyncContext.id);

        const killDragonHandler = await moduleRef.resolve(
          ScopedKillDragonHandler,
          asyncContext.id,
        );
        const heroKilledDragonHandler = await moduleRef.resolve(
          ScopedHeroKilledDragonHandler,
          asyncContext.id,
        );

        killDragonExecuteSpy = spyOn(killDragonHandler, "execute");
        heroKilledDragonHandleSpy = spyOn(heroKilledDragonHandler, "handle");

        const commandBus = moduleRef.get(CommandBus);
        command = new ScopedKillDragonCommand(HERO_ID, "dragonId");
        await commandBus.execute(command, asyncContext);
        await waitImmediate();
      });

      afterAll(() => {
        killDragonExecuteSpy?.mockRestore();
        heroKilledDragonHandleSpy?.mockRestore();
      });

      it("should execute command handler", () => {
        expect(killDragonExecuteSpy).toHaveBeenCalledWith(command);
      });

      it('should handle "ScopedHeroKilledDragonEvent" event', () => {
        const event = new ScopedHeroKilledDragonEvent(
          command.heroId,
          command.dragonId,
        );
        expect(heroKilledDragonHandleSpy).toHaveBeenCalledWith(event);
      });

      describe("when saga triggered", () => {
        let dropAncientExecuteSpy: ReturnType<typeof spyOn>;
        let heroFoundItemSpy: ReturnType<typeof spyOn>;

        beforeAll(async () => {
          const dropAncientItemHandler = await moduleRef.resolve(
            ScopedDropAncientItemHandler,
            asyncContext.id,
          );
          const heroFoundItemHandler = await moduleRef.resolve(
            ScopedHeroFoundItemHandler,
            asyncContext.id,
          );
          dropAncientExecuteSpy = spyOn(dropAncientItemHandler, "execute");
          heroFoundItemSpy = spyOn(heroFoundItemHandler, "handle");

          await sleepUnref(300);
        });

        afterAll(() => {
          dropAncientExecuteSpy?.mockRestore();
          heroFoundItemSpy?.mockRestore();
        });

        itAdapted(
          "ADR-008",
          'should dispatch "ScopedDropAncientItemCommand" and execute its command handler',
          () => {
            expect(dropAncientExecuteSpy).toHaveBeenCalledWith(
              new ScopedDropAncientItemCommand(HERO_ID, ANCIENT_ITEM_ID),
            );
          },
          "zero-RxJS async @Saga() + AsyncContext.merge()",
        );

        itAdapted(
          "ADR-008",
          'should handle "ScopedHeroFoundItemEvent" event',
          () => {
            expect(heroFoundItemSpy).toHaveBeenCalledWith(
              new ScopedHeroFoundItemEvent(HERO_ID, ANCIENT_ITEM_ID),
            );
          },
          "zero-RxJS async @Saga() + AsyncContext.merge()",
        );
      });
    });

    describe('when "ScopedKillDragonCommand" command is dispatched and no async context is provided', () => {
      const heroId = HERO_ID;
      const dragonId = "dragonId";
      const command = new ScopedKillDragonCommand(heroId, dragonId);

      it("should generate a unique async context", async () => {
        const commandBus = moduleRef.get(CommandBus);
        const result = await commandBus.execute(command);
        expect(result).toEqual({ heroId, dragonId });
      });
    });

    describe('when "ScopedHeroFoundItemEvent" event is published with an async context', () => {
      it("should inject that async context as REQUEST into the event handler", async () => {
        const asyncContext = new AsyncContext();
        const eventBus = moduleRef.get(EventBus);

        await eventBus.publish(
          new ScopedHeroFoundItemEvent(HERO_ID, ANCIENT_ITEM_ID),
          asyncContext,
        );
        await waitImmediate();

        const handler = await moduleRef.resolve(
          ScopedHeroFoundItemHandler,
          asyncContext.id,
        );
        expect(handler.context).toBe(asyncContext);
      });
    });

    describe('when "ScopedGetHeroesQuery" query is executed', () => {
      it("should return all heroes", async () => {
        const asyncContext = new AsyncContext();
        const queryBus = moduleRef.get(QueryBus);
        const heroes = await queryBus.execute(
          new ScopedGetHeroesQuery(),
          asyncContext,
        );
        expect(heroes).toEqual([expect.objectContaining({ id: HERO_ID })]);
      });
    });

    describe('when "ScopedGetHeroesQuery" query is executed and no async context is provided', () => {
      it("should return all heroes", async () => {
        const queryBus = moduleRef.get(QueryBus);
        const heroes = await queryBus.execute(new ScopedGetHeroesQuery());
        expect(heroes).toEqual([expect.objectContaining({ id: HERO_ID })]);
      });
    });
  },
);
