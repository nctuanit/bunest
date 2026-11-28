import type { ICommand } from "@bunest/messaging/cqrs";

export class CreateOrderCommand implements ICommand {
  constructor(
    public readonly item: string,
    public readonly amount: number,
    public readonly failOnce: boolean = false,
  ) {}
}
