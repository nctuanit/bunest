#!/usr/bin/env bun
import { runStoreCli } from "@bunest/store-kit";
import { outboxSchemas } from "./outbox-schemas";

process.exitCode = await runStoreCli(outboxSchemas, process.argv.slice(2));
