import { AuthenticationError } from "./authentication.error";

/**
 * A link was presented in a browser other than the one that requested it
 * (see `magicLink.bindToBrowser`), or in that browser after it requested
 * five newer ones.
 */
export class MagicLinkError extends AuthenticationError {
  /** Why the link was refused: the only reason apps are told. */
  readonly reason = "not-this-browser" as const;

  constructor() {
    super(
      "Open the latest link in the browser you requested it from, or request a new one here",
      { code: "not_this_browser" },
    );
    this.name = "MagicLinkError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
