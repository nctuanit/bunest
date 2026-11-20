export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretDecryptionError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
