import type { IEvent } from "@bunest/messaging/cqrs";

export class HeroKilledDragonEvent implements IEvent {
  constructor(
    public readonly heroId: string,
    public readonly dragonId: string,
  ) {}
}

export class HeroFoundItemEvent implements IEvent {
  constructor(
    public readonly heroId: string,
    public readonly itemId: string,
  ) {}
}
