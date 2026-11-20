import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from "@bunest/common";
import type {
  McpModuleOptions,
  McpProtocolEra,
  McpStdioListenOptions,
} from "../interfaces/mcp-types";
import { MCP_MODULE_OPTIONS } from "../mcp.constants";
import {
  type JsonRpcNotification,
  McpServerFactory,
} from "../services/mcp-server.factory";
import { JSON_RPC_ERROR_CODES } from "../utils/errors.util";

/**
 * Serves the MCP server over newline-delimited JSON-RPC 2.0 on `stdin`/`stdout`.
 */
@Injectable()
export class McpStdioServer implements OnApplicationShutdown {
  private readonly logger = new Logger(McpStdioServer.name);
  private activeAbort?: AbortController;
  private onClose?: () => void;

  constructor(
    private readonly factory: McpServerFactory,
    @Inject(MCP_MODULE_OPTIONS) private readonly options: McpModuleOptions,
  ) {}

  async listen({
    stdin = process.stdin,
    stdout = process.stdout,
  }: McpStdioListenOptions = {}): Promise<void> {
    if (this.activeAbort) {
      throw new Error("McpStdioServer is already listening");
    }
    const abort = new AbortController();
    this.activeAbort = abort;

    let era: McpProtocolEra = "modern";
    const writeLine = (payload: unknown): void => {
      stdout.write(`${JSON.stringify(payload)}\n`);
    };

    const server = this.factory.create({
      era,
      transport: "stdio",
      signal: abort.signal,
      onNotify: (notif: JsonRpcNotification) => {
        writeLine(notif);
      },
    });

    await new Promise<void>((resolve) => {
      let buffer = "";
      let closed = false;
      let chain = Promise.resolve();

      const finish = () => {
        if (closed) return;
        closed = true;
        stdin.off("data", onData);
        stdin.off("end", onEnd);
        stdin.off("close", onEnd);
        stdin.off("error", onError);
        this.activeAbort = undefined;
        this.onClose = undefined;
        chain.finally(() => resolve());
      };

      this.onClose = finish;

      const processLine = async (line: string): Promise<void> => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          writeLine({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
              message: "Parse error: invalid JSON",
            },
          });
          return;
        }
        if (
          parsed &&
          typeof parsed === "object" &&
          (parsed as { method?: unknown }).method === "initialize"
        ) {
          era = "legacy";
        }
        const response = await server.handleMessage(parsed);
        if (response !== null) {
          writeLine(response);
        }
      };

      const onData = (chunk: Buffer | string) => {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          chain = chain.then(() => processLine(line));
        }
      };

      const onEnd = () => {
        if (buffer.trim().length > 0) {
          const rest = buffer;
          buffer = "";
          chain = chain.then(() => processLine(rest));
        }
        finish();
      };

      const onError = (err: Error) => {
        this.logger.error(`MCP stdio stream error: ${err.message}`);
        finish();
      };

      stdin.on("data", onData);
      stdin.on("end", onEnd);
      stdin.on("close", onEnd);
      stdin.on("error", onError);
    });
  }

  async close(): Promise<void> {
    if (this.activeAbort) {
      this.activeAbort.abort();
    }
    this.onClose?.();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }
}
