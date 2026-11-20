import { keyColumn, type StoreMigration } from "@bunest/store-kit/mysql";
import { KEY_LENGTH } from "../mysql-outbox-keys.util";

const key = keyColumn(KEY_LENGTH);

/**
 * The store's tables, in the connection's database next to the kit's `<schema>_migrations` and `<schema>_locks`.
 */
export const initialMigration: StoreMigration = {
  version: 1,
  name: "initial",
  up: (t) => [
    `CREATE TABLE ${t("messages")} (
  seq bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  id ${key} NOT NULL,
  topic ${key} NOT NULL,
  payload json,
  headers json NOT NULL,
  \`key\` ${key},
  created_at bigint NOT NULL,
  available_at bigint NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  last_error mediumtext,
  history json NOT NULL DEFAULT (JSON_ARRAY()),
  lease_owner ${key},
  lease_until bigint,
  UNIQUE KEY messages_id (id),
  KEY messages_key_seq (\`key\`, seq)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`,
    `CREATE TABLE ${t("dead_letters")} (
  id ${key} NOT NULL PRIMARY KEY,
  seq bigint NOT NULL,
  topic ${key} NOT NULL,
  payload json,
  headers json NOT NULL,
  \`key\` ${key},
  created_at bigint NOT NULL,
  attempts int NOT NULL,
  last_error mediumtext,
  history json NOT NULL,
  reason varchar(32) NOT NULL,
  failed_at bigint NOT NULL,
  KEY dead_letters_topic_failed_at (topic, failed_at)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`,
    `CREATE TABLE ${t("inbox")} (
  consumer ${key} NOT NULL,
  message_id ${key} NOT NULL,
  processed_at bigint NOT NULL,
  PRIMARY KEY (consumer, message_id),
  KEY inbox_processed_at (processed_at)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`,
  ],
};
