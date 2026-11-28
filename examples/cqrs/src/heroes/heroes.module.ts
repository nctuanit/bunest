import { Module } from "@bunest/core";
import {
  DropAncientItemHandler,
  KillDragonHandler,
} from "./commands/hero-command.handlers";
import {
  HeroEventJournal,
  HeroFoundItemHandler,
  HeroKilledDragonHandler,
} from "./events/hero-event.handlers";
import { HeroesGameController } from "./heroes.controller";
import { GetHeroesHandler } from "./queries/get-heroes.handler";
import { HeroRepository } from "./repository/hero.repository";
import { HeroesGameSagas } from "./sagas/heroes.sagas";

@Module({
  controllers: [HeroesGameController],
  providers: [
    HeroRepository,
    HeroEventJournal,
    KillDragonHandler,
    DropAncientItemHandler,
    HeroKilledDragonHandler,
    HeroFoundItemHandler,
    GetHeroesHandler,
    HeroesGameSagas,
  ],
})
export class HeroesGameModule {}
