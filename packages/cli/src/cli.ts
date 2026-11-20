#!/usr/bin/env bun
import { runCli } from "./runner";

export { runCli };

if (import.meta.main) {
  const result = await runCli(process.argv.slice(2));
  process.exitCode = result.exitCode;
}
