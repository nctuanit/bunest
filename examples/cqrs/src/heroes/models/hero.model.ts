import { AggregateRoot } from "@bunest/messaging/cqrs";
import {
  HeroFoundItemEvent,
  HeroKilledDragonEvent,
} from "../events/hero.events";

export class Hero extends AggregateRoot {
  public readonly slainDragons: string[] = [];
  public readonly inventory: string[] = [];

  constructor(
    public readonly id: string,
    public readonly name: string,
  ) {
    super();
  }

  killEnemy(dragonId: string): void {
    this.slainDragons.push(dragonId);
    this.apply(new HeroKilledDragonEvent(this.id, dragonId));
  }

  addItem(itemId: string): void {
    this.inventory.push(itemId);
    this.apply(new HeroFoundItemEvent(this.id, itemId));
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      slainDragons: [...this.slainDragons],
      inventory: [...this.inventory],
    };
  }
}
