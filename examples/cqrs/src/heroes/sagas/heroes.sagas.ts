import { Injectable } from "@bunest/core";
import { Saga, type IEvent } from "@bunest/messaging/cqrs";
import { DropAncientItemCommand } from "../commands/hero.commands";
import { HeroKilledDragonEvent } from "../events/hero.events";

export const ANCIENT_DRAGON_LOOT = "ancient-dragon-blade";

@Injectable()
export class HeroesGameSagas {
  @Saga()
  dragonKilled(event: IEvent) {
    if (event instanceof HeroKilledDragonEvent) {
      return new DropAncientItemCommand(event.heroId, ANCIENT_DRAGON_LOOT);
    }
    return undefined;
  }
}
