import type { ICommand } from "@bunest/messaging/cqrs";

export class KillDragonCommand implements ICommand {
  constructor(
    public readonly heroId: string,
    public readonly dragonId: string,
  ) {}
}

export class DropAncientItemCommand implements ICommand {
  constructor(
    public readonly heroId: string,
    public readonly itemId: string,
  ) {}
}
