import { Injectable } from "@bunest/core";
import {
  EventsHandler,
  type IEventHandler,
} from "@bunest/messaging/cqrs";
import { HeroFoundItemEvent, HeroKilledDragonEvent } from "./hero.events";

@Injectable()
export class HeroEventJournal {
  public readonly entries: string[] = [];
}

@EventsHandler(HeroKilledDragonEvent)
export class HeroKilledDragonHandler implements IEventHandler<HeroKilledDragonEvent> {
  constructor(private readonly journal: HeroEventJournal) {}

  handle(event: HeroKilledDragonEvent): void {
    this.journal.entries.push(
      `Hero ${event.heroId} slew dragon ${event.dragonId}`,
    );
  }
}

@EventsHandler(HeroFoundItemEvent)
export class HeroFoundItemHandler implements IEventHandler<HeroFoundItemEvent> {
  constructor(private readonly journal: HeroEventJournal) {}

  handle(event: HeroFoundItemEvent): void {
    this.journal.entries.push(
      `Hero ${event.heroId} obtained ${event.itemId}`,
    );
  }
}
