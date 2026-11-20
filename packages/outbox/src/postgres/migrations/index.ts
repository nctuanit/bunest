import { StoreSchema } from "@bunest/store-kit/postgres";
import { OutboxSchemaError } from "../../sql/outbox-schema.error";
import { initialMigration } from "./initial.migration";

/**
 * PostgresOutboxStore's schema: every version of it, in order, and what the store, its statics and `nest-outbox` do with them.
 */
export const postgresOutboxSchema = new StoreSchema({
  packageName: "@bunest/outbox",
  storeName: "PostgresOutboxStore",
  command: "nest-outbox",
  defaultSchema: "nest_outbox",
  migrations: [initialMigration],
  createError: (message, details) => new OutboxSchemaError(message, details),
});
