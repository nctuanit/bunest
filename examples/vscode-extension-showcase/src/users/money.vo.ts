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

export class UserNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserNotFoundError";
  }
}

export function slugifyText(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, "-");
}
