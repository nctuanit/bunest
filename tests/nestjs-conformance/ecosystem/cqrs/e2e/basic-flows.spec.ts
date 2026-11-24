import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { CommandBus, QueryBus } from "../../../../../packages/messaging/src/cqrs";
import {
  Test,
  describeConformance,
  itAdapted,
  type TestingModule,
} from "../../../_helpers";
import {
  ANCIENT_ITEM_ID,
  CqrsAppModule,
  DRAGON_ID,
  DragonDiedEvent,
  DragonDiedHandler,
  DropAncientItemCommand,
  DropAncientItemHandler,
  GetHeroQuery,
  GetHeroesQuery,
  HERO_ID,
  HeroFoundItemEvent,
  HeroFoundItemHandler,
  HeroKilledDragonEvent,
  HeroKilledDragonHandler,
  KillDragonCommand,
  KillDragonHandler,
  NoopHandler,
  sleepUnref,
  waitImmediate,
} from "../_fixtures/cqrs-fixtures";

describeConformance(
  "Basic flows",
  {
    upstreamPath: "nestjs/cqrs/test/e2e/basic-flows.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-008"],
    notes:
      "Adapts HeroesGameSagas from RxJS ofType/delay/map to Bunest zero-RxJS async @Saga() (ADR-008).",
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

    describe('when "KillDragonCommand" command is dispatched', () => {
      let killDragonExecuteSpy: ReturnType<typeof spyOn>;
      let heroKilledDragonHandleSpy: ReturnType<typeof spyOn>;
      let dragonDiedHandleSpy: ReturnType<typeof spyOn>;
      let noopEventHandleSpy: ReturnType<typeof spyOn>;
      let command: KillDragonCommand;

      beforeAll(async () => {
        const killDragonHandler = moduleRef.get(KillDragonHandler);
        const heroKilledDragonHandler = moduleRef.get(HeroKilledDragonHandler);
        const dragonDiedHandler = moduleRef.get(DragonDiedHandler);
        const noopHandler = moduleRef.get(NoopHandler);

        killDragonExecuteSpy = spyOn(killDragonHandler, "execute");
        heroKilledDragonHandleSpy = spyOn(heroKilledDragonHandler, "handle");
        dragonDiedHandleSpy = spyOn(dragonDiedHandler, "handle");
        noopEventHandleSpy = spyOn(noopHandler, "handle");

        const commandBus = moduleRef.get(CommandBus);
        command = new KillDragonCommand(HERO_ID, DRAGON_ID);
        await commandBus.execute(command);
        await waitImmediate();
      });

      afterAll(() => {
        killDragonExecuteSpy?.mockRestore();
        heroKilledDragonHandleSpy?.mockRestore();
        dragonDiedHandleSpy?.mockRestore();
        noopEventHandleSpy?.mockRestore();
      });

      it("should execute command handler", () => {
        expect(killDragonExecuteSpy).toHaveBeenCalledWith(command);
      });

      it('should handle "HeroKillDragonEvent" event', () => {
        const event = new HeroKilledDragonEvent(
          command.heroId,
          command.dragonId,
        );
        expect(heroKilledDragonHandleSpy).toHaveBeenCalledWith(event);
      });

      it('should handle "DragonDiedEvent" event from aggregate root', () => {
        const event = new DragonDiedEvent(DRAGON_ID);
        expect(dragonDiedHandleSpy).toHaveBeenCalledWith(event);
      });

      it('should not trigger "NoopHandler" event', () => {
        expect(noopEventHandleSpy).not.toHaveBeenCalled();
      });

      describe("when saga triggered", () => {
        let dropAncientExecuteSpy: ReturnType<typeof spyOn>;
        let heroFoundItemSpy: ReturnType<typeof spyOn>;

        beforeAll(async () => {
          const dropAncientItemHandler = moduleRef.get(DropAncientItemHandler);
          const heroFoundItemHandler = moduleRef.get(HeroFoundItemHandler);
          dropAncientExecuteSpy = spyOn(dropAncientItemHandler, "execute");
          heroFoundItemSpy = spyOn(heroFoundItemHandler, "handle");

          // Wait for async @Saga() delay (150ms) to settle
          await sleepUnref(300);
        });

        afterAll(() => {
          dropAncientExecuteSpy?.mockRestore();
          heroFoundItemSpy?.mockRestore();
        });

        itAdapted(
          "ADR-008",
          'should dispatch "DropAncientItemCommand" and execute its command handler',
          () => {
            expect(dropAncientExecuteSpy).toHaveBeenCalledWith(
              new DropAncientItemCommand(HERO_ID, ANCIENT_ITEM_ID),
            );
          },
          "zero-RxJS async @Saga()",
        );

        itAdapted(
          "ADR-008",
          'should handle "HeroFoundItemEvent" event',
          () => {
            expect(heroFoundItemSpy).toHaveBeenCalledWith(
              new HeroFoundItemEvent(HERO_ID, ANCIENT_ITEM_ID),
            );
          },
          "zero-RxJS async @Saga()",
        );
      });
    });

    describe('when "GetHeroesQuery" query is executed', () => {
      it("should return all heroes", async () => {
        const queryBus = moduleRef.get(QueryBus);
        const heroes = await queryBus.execute(new GetHeroesQuery());
        expect(heroes).toEqual([expect.objectContaining({ id: HERO_ID })]);
      });
    });

    describe('when "GetHeroQuery" query is executed', () => {
      it("should return a single hero", async () => {
        const queryBus = moduleRef.get(QueryBus);
        const hero = await queryBus.execute(new GetHeroQuery(1234));
        expect(hero).toEqual(expect.objectContaining({ id: HERO_ID }));
      });
    });
  },
);
