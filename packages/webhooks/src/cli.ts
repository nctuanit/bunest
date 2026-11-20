#!/usr/bin/env bun
// The `nest-webhooks` command: the first-party stores' migrations from a shell or a CI step. A postgres:// or
// postgresql:// URL migrates PostgresWebhookStore's schema, a mysql:// one MySqlWebhookStore's tables; `sql` prints
// PostgreSQL's script, and MySQL's with `--dialect mysql`.
import { runStoreCli } from "@bunest/store-kit";
import { mysqlWebhookStoreSchema } from "./mysql/migrations/index";
import { webhookStoreSchema } from "./postgres/migrations/index";

process.exitCode = await runStoreCli(
  [webhookStoreSchema, mysqlWebhookStoreSchema],
  process.argv.slice(2),
);
