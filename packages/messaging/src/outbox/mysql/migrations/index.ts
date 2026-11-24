import { StoreSchema } from "@bunest/orm/mysql";
import { OutboxSchemaError } from "../../sql/outbox-schema.error";
import { initialMigration } from "./initial.migration";

/**
 * MySqlOutboxStore's schema: every version of it, in order, and what the store, its statics and `nest-outbox` do with them.
 */
export const mysqlOutboxSchema = new StoreSchema({
  packageName: "@bunest/messaging/outbox",
  storeName: "MySqlOutboxStore",
  command: "nest-outbox",
  defaultSchema: "nest_outbox",
  migrations: [initialMigration],
  createError: (message, details) => new OutboxSchemaError(message, details),
  mariadb: true,
});
