import * as vscode from "vscode";
import { runCli, type CliIO, type CliResult } from "@bunest/cli";

/**
 * Delegates all disk-writing generation & check operations (`typegen`, `check`,
 * `generate`, `generate repository`, `codemod`) through `@bunest/cli`'s
 * single-source-of-truth command dispatcher, streaming logs to the Bunest OutputChannel.
 */
export async function runBunestCliCommand(
  cwd: string,
  argv: readonly string[],
  outputChannel: vscode.OutputChannel,
  options: { readonly revealOutput?: boolean } = {},
): Promise<CliResult> {
  if (options.revealOutput) {
    outputChannel.show(true);
  }
  outputChannel.appendLine(`\n$ bunest ${argv.join(" ")}`);

  const io: CliIO = {
    cwd,
    stdout(msg: string) {
      outputChannel.appendLine(msg);
    },
    stderr(msg: string) {
      outputChannel.appendLine(`[stderr] ${msg}`);
    },
  };

  return runCli(argv, io);
}
