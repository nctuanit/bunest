import { mysqlOutboxSchema } from "../mysql/migrations/index";
import { postgresOutboxSchema } from "../postgres/migrations/index";

/** PostgresOutboxStore's schema and MySqlOutboxStore's: the command picks one by the URL's scheme, or `--dialect`. */
export const outboxSchemas = [postgresOutboxSchema, mysqlOutboxSchema];
