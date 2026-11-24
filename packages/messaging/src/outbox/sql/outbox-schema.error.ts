import { OutboxError } from "../errors/outbox.error";

/**
 * A SQL store's schema can't serve this version of the package: it is behind the store's migrations (and `migrate` is
 * off), or applying them failed (`cause`). Exported by `@bunest/messaging/outbox/postgres` and `@bunest/messaging/outbox/mysql`.
 */
export class OutboxSchemaError extends OutboxError {
  override name = "OutboxSchemaError";
  readonly schema: string;
  readonly version: number;
  readonly requiredVersion: number;

  constructor(
    message: string,
    details: {
      schema: string;
      version: number;
      requiredVersion: number;
      cause?: unknown;
    },
  ) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.schema = details.schema;
    this.version = details.version;
    this.requiredVersion = details.requiredVersion;
  }
}
