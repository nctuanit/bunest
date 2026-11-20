/**
 * WebSocket exception caught by `BaseWsExceptionFilter` (or custom `@UseFilters`)
 * and transmitted to the connected client as a structured error frame without
 * crashing the WebSocket connection.
 */
export class WsException extends Error {
  private readonly error: string | object;

  constructor(error: string | object) {
    super();
    this.error = error;
    this.initMessage();
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public initMessage(): void {
    if (typeof this.error === "string") {
      this.message = this.error;
    } else if (
      this.error &&
      typeof this.error === "object" &&
      "message" in this.error &&
      typeof (this.error as { message?: unknown }).message === "string"
    ) {
      this.message = (this.error as { message: string }).message;
    } else if (this.constructor) {
      this.message =
        this.constructor.name.match(/[A-Z][a-z]+|[0-9]+/g)?.join(" ") ??
        "WebSocket exception";
    }
  }

  public getError(): string | object {
    return this.error;
  }
}
