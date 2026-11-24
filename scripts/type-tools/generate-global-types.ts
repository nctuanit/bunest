/**
 * generate-global-types.ts
 *
 * Convenience script invoking `@bunest/cli`'s native AST global type generator
 * for any Bunest application directory (defaults to `process.cwd()`).
 *
 * Usage:
 *   bun run type:gen -- --cwd examples/rest-crud
 *   bun run type:gen -- --cwd examples/rest-crud --watch
 *   bun run type:gen -- --cwd examples/rest-crud --check
 */

import { runTypegenCommand } from "../../packages/cli/src/commands/typegen";
import { parseCliArgs } from "../../packages/cli/src/parser";

const parsed = parseCliArgs(["typegen", ...process.argv.slice(2)]);
const cwdFlag =
  typeof parsed.flags.cwd === "string"
    ? parsed.flags.cwd
    : (parsed.positionals[0] ?? process.cwd());

const res = await runTypegenCommand(
  {
    cwd: cwdFlag,
    sourceRoot:
      typeof parsed.flags.sourceRoot === "string"
        ? parsed.flags.sourceRoot
        : undefined,
    outdir:
      typeof parsed.flags.outdir === "string" ? parsed.flags.outdir : undefined,
    tsconfig:
      typeof parsed.flags.tsconfig === "string"
        ? parsed.flags.tsconfig
        : undefined,
    config:
      typeof parsed.flags.config === "string" ? parsed.flags.config : undefined,
    watch: parsed.flags.watch === true,
    check: parsed.flags.check === true,
    dryRun: parsed.flags["dry-run"] === true,
    silent: parsed.flags.silent === true,
  },
  {
    cwd: cwdFlag,
    stdout: (msg) => console.log(msg),
    stderr: (msg) => console.error(msg),
  },
);

process.exitCode = res.exitCode;
