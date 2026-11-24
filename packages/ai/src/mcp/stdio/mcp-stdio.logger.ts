import { ConsoleLogger, type LogLevel } from "@bunest/core";

/**
 * `ConsoleLogger` writing every log level to `stderr` so `stdout` stays clean for stdio JSON-RPC.
 */
export class McpStdioLogger extends ConsoleLogger {
  protected override printMessages(
    messages: unknown[],
    context?: string,
    logLevel?: LogLevel,
    _writeStreamType?: "stdout" | "stderr",
    errorStack?: unknown,
    params?: Record<string, any>,
  ): void {
    super.printMessages(
      messages,
      context,
      logLevel,
      "stderr",
      errorStack,
      params,
    );
  }
}
