export interface AuthenticationErrorOptions {
  /** `WWW-Authenticate` challenge sent with the 401 over HTTP, e.g. `ApiKey header="x-api-key"`. */
  challenge?: string;
  /** Machine-readable reason (`mfa_required`), sent as `errorCode` and `error`. */
  code?: string;
  /** Machine-readable data for the client, sent as `details`. */
  details?: Record<string, unknown>;
  /** The error behind this one, for logs. Never sent. */
  cause?: unknown;
}
