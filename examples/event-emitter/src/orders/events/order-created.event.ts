export class OrderCreatedEvent {
  constructor(
    public readonly id: number,
    public readonly name: string,
    public readonly description: string,
  ) {}
}
