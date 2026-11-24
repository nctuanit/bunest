#!/usr/bin/env bun
import { runStoreCli } from "@bunest/orm/store";
import { outboxSchemas } from "./outbox-schemas";

process.exitCode = await runStoreCli(outboxSchemas, Bun.argv.slice(2));
