import {
  CommandHandler,
  EventPublisher,
  type ICommandHandler,
} from "@bunest/messaging/cqrs";
import {
  DropAncientItemCommand,
  KillDragonCommand,
} from "./hero.commands";
import { HeroRepository } from "../repository/hero.repository";

@CommandHandler(KillDragonCommand)
export class KillDragonHandler implements ICommandHandler<
  KillDragonCommand,
  { heroId: string; dragonId: string }
> {
  constructor(
    private readonly repository: HeroRepository,
    private readonly publisher: EventPublisher,
  ) {}

  async execute(command: KillDragonCommand) {
    const hero = this.publisher.mergeObjectContext(
      this.repository.findOneById(command.heroId),
    );
    hero.killEnemy(command.dragonId);
    await hero.commit();
    return { heroId: command.heroId, dragonId: command.dragonId };
  }
}

@CommandHandler(DropAncientItemCommand)
export class DropAncientItemHandler implements ICommandHandler<
  DropAncientItemCommand,
  void
> {
  constructor(
    private readonly repository: HeroRepository,
    private readonly publisher: EventPublisher,
  ) {}

  async execute(command: DropAncientItemCommand): Promise<void> {
    const hero = this.publisher.mergeObjectContext(
      this.repository.findOneById(command.heroId),
    );
    hero.addItem(command.itemId);
    await hero.commit();
  }
}
