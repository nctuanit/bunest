export class Money {
  constructor(
    public readonly amount: number,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  withAmount(amount: number): Money {
    return new Money(amount, this.currency);
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }
}

export function slugifyText(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, "-");
}
