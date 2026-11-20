export class OidcError extends Error {
  /**
   * `request`: bad or forged callback (400). `verification`: the IdP's
   * answer failed checks (401). `unavailable`: the IdP is down or
   * misconfigured (502).
   */
  readonly kind: "request" | "verification" | "unavailable";

  constructor(
    message: string,
    kind: "request" | "verification" | "unavailable",
  ) {
    super(message);
    this.kind = kind;
    this.name = "OidcError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
