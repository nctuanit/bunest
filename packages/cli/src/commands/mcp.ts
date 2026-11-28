import {
  BUNEST_ERROR_CATALOG,
  formatAgentErrorTrace,
  getErrorCatalogEntry,
  getErrorDocsUrl,
  indexOfLine,
  join,
  readAgentErrorTracesFromFile,
  resolve,
} from "@bunest/core";
import type { CliIO } from "../types";
import { CLI_VERSION } from "../version";
import { runCheckCommand } from "./check";
import { runExplainRouteCommand } from "./explain";
import { runGraphCommand } from "./graph";
import { formatVerifyResult, runVerifyCommand } from "./verify";

export interface McpServerOptions {
  readonly cwd?: string;
  /** Path to runtime error trace JSONL file (default: `.bunest/errors.jsonl`). */
  readonly traceFile?: string;
  /** Optional running dev server base URL (e.g. `http://127.0.0.1:3000`). */
  readonly serverUrl?: string;
  /** Optional input byte stream overriding `Bun.stdin.stream()` (primarily for testing). */
  readonly input?: ReadableStream<Uint8Array>;
}

export interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
  };
}

export const BUNEST_MCP_TOOLS = [
  {
    name: "bunest_explain_error",
    description:
      "Look up a Bunest error code (e.g. BUNEST_E001..BUNEST_E103) and return ordered remediation fixes, code example, and docs URL. Omit `code` to list all codes.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Optional BUNEST_E* error code (e.g. BUNEST_E001).",
        },
      },
    },
  },
  {
    name: "bunest_recent_errors",
    description:
      "Return the most recent runtime HTTP/pipeline error traces (with requestId, stage, controller.handler, filtered appFrames, details, and fixes) from `.bunest/errors.jsonl` or a running dev server's `/__bunest/errors` endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of traces to return (default: 10).",
        },
        format: {
          type: "string",
          enum: ["agent", "json"],
          description: "Output format: compact agent text or JSON (default: agent).",
        },
        serverUrl: {
          type: "string",
          description: "Optional dev server URL (e.g. http://127.0.0.1:3000).",
        },
        traceFile: {
          type: "string",
          description: "Optional override path to errors.jsonl.",
        },
      },
    },
  },
  {
    name: "bunest_inspect_diagnostics",
    description:
      "Inspect a Bunest project's static diagnostics (`static`), or query a running dev server's compiled routes (`routes`) or DI module graph (`graph`).",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: ["static", "routes", "graph"],
          description: "Diagnostic target (default: static).",
        },
        serverUrl: {
          type: "string",
          description: "Dev server URL required for `routes` or `graph`.",
        },
        sourceRoot: {
          type: "string",
          description: "Optional source root for static diagnostics.",
        },
      },
    },
  },
  {
    name: "bunest_explain_route",
    description:
      "Explain a Bunest HTTP route (e.g. 'POST /orders'): traces owning module, controller, handler, guards/pipes/interceptors/filters pipeline, recursive DI dependencies, unknowns, and deterministic quick fixes. Queries a running dev server when serverUrl is provided, falling back to static-only if unreachable or bootstrap failed.",
    inputSchema: {
      type: "object",
      properties: {
        route: {
          type: "string",
          description: "Route query, e.g. 'POST /orders' or '/orders/:id'.",
        },
        format: {
          type: "string",
          enum: ["json", "agent"],
          description:
            "Output format: JSON (RouteExplainReport schemaVersion 1.0) or compact agent text (default: json).",
        },
        serverUrl: {
          type: "string",
          description: "Optional dev server URL (e.g. http://127.0.0.1:3000).",
        },
        sourceRoot: {
          type: "string",
          description: "Optional source root for static analysis.",
        },
        version: {
          type: "string",
          description: "Optional route version filter (e.g. '1').",
        },
      },
      required: ["route"],
    },
  },
  {
    name: "bunest_verify",
    description:
      "Run the Bunest verification loop (typecheck -> static diagnostics -> tests) and return a compact AI-agent report.",
    inputSchema: {
      type: "object",
      properties: {
        testFilter: {
          type: "array",
          items: { type: "string" },
          description: "Optional bun test path/name filters.",
        },
        skipTypecheck: { type: "boolean" },
        skipCheck: { type: "boolean" },
        skipTests: { type: "boolean" },
      },
    },
  },
  {
    name: "bunest_graph",
    description:
      "Query the project's offline static module/provider/controller DI dependency graph (including provider cycles BUNEST002 and module import cycles BUNEST010) without booting the application.",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["json", "mermaid", "dot"],
          description: "Output format: json, mermaid, or dot (default: json).",
        },
        module: {
          type: "string",
          description:
            "Optional module class name to filter the subgraph and its dependencies.",
        },
        cyclesOnly: {
          type: "boolean",
          description:
            "When true, return only modules, providers, and edges involved in circular dependencies (BUNEST002 / BUNEST010).",
        },
        sourceRoot: {
          type: "string",
          description: "Optional source root for static analysis.",
        },
      },
    },
  },
] as const;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  options: McpServerOptions,
): Promise<unknown> {
  const cwd = options.cwd ?? process.cwd();

  switch (name) {
    case "bunest_explain_error": {
      const code = typeof args.code === "string" ? args.code.trim().toUpperCase() : "";
      if (!code) {
        const list = Object.values(BUNEST_ERROR_CATALOG)
          .map((e) => `${e.code} (${e.name}): ${e.title}`)
          .join("\n");
        return textResult(list);
      }
      const entry = getErrorCatalogEntry(code);
      if (!entry) {
        return textResult(
          `Unknown Bunest error code "${code}". Available codes: ${Object.keys(BUNEST_ERROR_CATALOG).join(", ")}`,
          true,
        );
      }
      const lines = [
        `[${entry.code}] ${entry.name} — ${entry.title}`,
        entry.summary,
        "",
        "Ordered fixes:",
        ...entry.fixes.map((f, i) => `${i + 1}. ${f}`),
        ...(entry.example ? ["", "Example:", entry.example] : []),
        "",
        `Docs: ${getErrorDocsUrl(entry.code)}`,
      ];
      return textResult(lines.join("\n"));
    }

    case "bunest_recent_errors": {
      const limit =
        typeof args.limit === "number" && args.limit > 0 ? args.limit : 10;
      const format = args.format === "json" ? "json" : "agent";
      const serverUrl =
        typeof args.serverUrl === "string"
          ? args.serverUrl
          : options.serverUrl;

      if (serverUrl) {
        const base = serverUrl.replace(/\/+$/, "");
        const res = await fetch(
          `${base}/__bunest/errors?limit=${limit}&format=${format}`,
        );
        if (!res.ok) {
          return textResult(
            `Failed to fetch ${base}/__bunest/errors (HTTP ${res.status}). Ensure app.enableDevDiagnostics() is enabled.`,
            true,
          );
        }
        return textResult(await res.text());
      }

      const traceFile =
        typeof args.traceFile === "string"
          ? resolve(cwd, args.traceFile)
          : options.traceFile
            ? resolve(cwd, options.traceFile)
            : join(cwd, ".bunest", "errors.jsonl");
      const traces = await readAgentErrorTracesFromFile(traceFile, limit);
      if (format === "json") {
        return textResult(JSON.stringify({ count: traces.length, errors: traces }, null, 2));
      }
      if (traces.length === 0) {
        return textResult(`No runtime error traces found in ${traceFile}.`);
      }
      return textResult(traces.map(formatAgentErrorTrace).join("\n\n"));
    }

    case "bunest_inspect_diagnostics": {
      const target =
        args.target === "routes" || args.target === "graph"
          ? args.target
          : "static";
      const serverUrl =
        typeof args.serverUrl === "string"
          ? args.serverUrl
          : options.serverUrl;

      if (target === "routes" || target === "graph") {
        if (!serverUrl) {
          return textResult(
            `serverUrl is required to inspect "${target}" (e.g. http://127.0.0.1:3000).`,
            true,
          );
        }
        const base = serverUrl.replace(/\/+$/, "");
        const res = await fetch(`${base}/__bunest/${target}`);
        if (!res.ok) {
          return textResult(
            `Failed to fetch ${base}/__bunest/${target} (HTTP ${res.status}). Ensure app.enableDevDiagnostics() is enabled.`,
            true,
          );
        }
        return textResult(await res.text());
      }

      const checkRes = await runCheckCommand(
        {
          cwd,
          format: "json",
          sourceRoot:
            typeof args.sourceRoot === "string" ? args.sourceRoot : undefined,
        },
        { stdout: () => {}, stderr: () => {} },
      );
      return textResult(JSON.stringify(checkRes, null, 2));
    }

    case "bunest_explain_route": {
      const route = typeof args.route === "string" ? args.route.trim() : "";
      if (!route) {
        return textResult(
          'route argument is required (e.g. "POST /orders").',
          true,
        );
      }
      const format = args.format === "agent" ? "agent" : "json";
      const serverUrl =
        typeof args.serverUrl === "string"
          ? args.serverUrl
          : options.serverUrl;
      const result = await runExplainRouteCommand(
        {
          route,
          cwd,
          format,
          serverUrl,
          sourceRoot:
            typeof args.sourceRoot === "string" ? args.sourceRoot : undefined,
          version:
            typeof args.version === "string" ? args.version : undefined,
          silent: true,
        },
        { stdout: () => {}, stderr: () => {} },
      );
      return textResult(result.formatted);
    }

    case "bunest_verify": {
      const testFilter = Array.isArray(args.testFilter)
        ? args.testFilter.map(String)
        : undefined;
      const result = await runVerifyCommand(
        {
          cwd,
          reporter: "agent",
          testFilter,
          skipTypecheck: args.skipTypecheck === true,
          skipCheck: args.skipCheck === true,
          skipTests: args.skipTests === true,
        },
        { stdout: () => {}, stderr: () => {} },
      );
      return textResult(
        formatVerifyResult(result, "agent"),
        !result.ok,
      );
    }

    case "bunest_graph": {
      const format =
        args.format === "mermaid" || args.format === "dot" || args.format === "json"
          ? args.format
          : "json";
      const moduleFilter =
        typeof args.module === "string" && args.module.trim().length > 0
          ? args.module.trim()
          : undefined;
      const cyclesOnly = args.cyclesOnly === true;
      const sourceRoot =
        typeof args.sourceRoot === "string" && args.sourceRoot.trim().length > 0
          ? args.sourceRoot.trim()
          : undefined;
      const result = await runGraphCommand(
        {
          cwd,
          format,
          module: moduleFilter,
          cyclesOnly,
          sourceRoot,
          silent: true,
        },
        { stdout: () => {}, stderr: () => {} },
      );
      if (result.exitCode !== 0) {
        return textResult(
          result.error ?? "Failed to build static DI graph.",
          true,
        );
      }
      return textResult(result.output);
    }

    default:
      return textResult(`Unknown tool "${name}".`, true);
  }
}

/**
 * Handles a single MCP JSON-RPC 2.0 request. Returns `null` for notifications.
 */
export async function handleMcpRequest(
  req: JsonRpcRequest,
  options: McpServerOptions = {},
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;

  // Notifications have no `id` and require no response
  if (req.id === undefined && req.method.startsWith("notifications/")) {
    return null;
  }

  try {
    switch (req.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
              name: "bunest-mcp",
              version: CLI_VERSION,
            },
          },
        };

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: BUNEST_MCP_TOOLS },
        };

      case "tools/call": {
        const params = req.params ?? {};
        const name = typeof params.name === "string" ? params.name : "";
        const args =
          params.arguments && typeof params.arguments === "object"
            ? (params.arguments as Record<string, unknown>)
            : {};
        const toolResult = await executeToolCall(name, args, options);
        return { jsonrpc: "2.0", id, result: toolResult };
      }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${req.method}`,
          },
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message },
    };
  }
}

/**
 * Starts the newline-delimited JSON-RPC 2.0 MCP server over stdin/stdout.
 */
export async function runMcpServer(
  options: McpServerOptions = {},
  io: CliIO = {
    stdout: (msg) => console.log(msg),
    stderr: (msg) => console.error(msg),
  },
): Promise<{ exitCode: number }> {
  const inputStream = options.input ?? Bun.stdin.stream();
  const reader = inputStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatchLine = async (rawLine: string): Promise<void> => {
    const line = rawLine.trim();
    if (!line) return;
    try {
      const parsed = JSON.parse(line) as JsonRpcRequest;
      const response = await handleMcpRequest(parsed, options);
      if (response) {
        io.stdout(JSON.stringify(response));
      }
    } catch (parseErr) {
      io.stdout(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: `Parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
          },
        }),
      );
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      let offset = 0;
      const len = value.byteLength;
      while (offset < len) {
        const nlIdx = indexOfLine(value, offset);
        if (nlIdx === -1) {
          buffer += decoder.decode(value.subarray(offset), { stream: true });
          break;
        }
        const segment = decoder.decode(value.subarray(offset, nlIdx));
        const rawLine = buffer.length > 0 ? buffer + segment : segment;
        buffer = "";
        offset = nlIdx + 1;

        await dispatchLine(rawLine);
      }
    }

    // Flush any final JSON-RPC message received before EOF without a trailing newline
    const trailing = buffer + decoder.decode();
    if (trailing.trim().length > 0) {
      await dispatchLine(trailing);
    }
  } finally {
    reader.releaseLock();
  }

  return { exitCode: 0 };
}
