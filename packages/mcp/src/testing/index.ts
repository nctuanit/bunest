import type { INestApplicationContext } from "@bunest/common";
import { McpHttpService } from "../http/mcp-http.service";
import type {
  CallToolResult,
  GetPromptResult,
  McpProtocolEra,
  ReadResourceResult,
} from "../interfaces/mcp-types";
import {
  type JsonRpcResponse,
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
} from "../services/mcp-server.factory";
import { ProtocolError } from "../utils/errors.util";

export interface ConnectMcpClientOptions {
  /** `'modern'` (default, 2026-07-28) or `'legacy'` (2025 `initialize` handshake). */
  era?: McpProtocolEra;
  /** Bearer access token sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** Headers sent with every request. */
  headers?: Record<string, string>;
  /** The client's `clientInfo`. Default `{ name: 'nestjs-mcp-testing', version: '0.0.0' }`. */
  clientInfo?: {
    name: string;
    version: string;
  };
}

export interface McpTestClient {
  ping(): Promise<Record<string, unknown>>;
  listTools(): Promise<{ tools: Array<Record<string, any>> }>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }): Promise<CallToolResult>;
  listResources(): Promise<{ resources: Array<Record<string, any>> }>;
  listResourceTemplates(): Promise<{
    resourceTemplates: Array<Record<string, any>>;
  }>;
  readResource(params: {
    uri: string;
    _meta?: Record<string, unknown>;
  }): Promise<ReadResourceResult>;
  listPrompts(): Promise<{ prompts: Array<Record<string, any>> }>;
  getPrompt(params: {
    name: string;
    arguments?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }): Promise<GetPromptResult>;
  request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  getServerInfo(): Record<string, unknown> | undefined;
  getServerCapabilities(): Record<string, unknown> | undefined;
  getInstructions(): string | undefined;
  getNotifications(): Array<{ method: string; params?: Record<string, unknown> }>;
  close(): Promise<void>;
}

/**
 * Connects an in-memory MCP client to the application's `McpHttpService.fetch()` with no socket.
 */
export async function connectMcpClient(
  app: INestApplicationContext,
  {
    era = "modern",
    token,
    headers: extraHeaders,
    clientInfo = { name: "nestjs-mcp-testing", version: "0.0.0" },
  }: ConnectMcpClientOptions = {},
): Promise<McpTestClient> {
  const httpService = app.get(McpHttpService);
  let nextId = 1;
  let closed = false;
  let serverInfo: Record<string, unknown> | undefined;
  let serverCapabilities: Record<string, unknown> | undefined;
  let instructions: string | undefined;
  const receivedNotifications: Array<{
    method: string;
    params?: Record<string, unknown>;
  }> = [];

  const send = async <T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    isNotification = false,
  ): Promise<T> => {
    if (closed) {
      throw new Error("MCP test client is closed");
    }
    const reqHeaders = new Headers({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version":
        era === "modern" ? MODERN_PROTOCOL_VERSION : LEGACY_PROTOCOL_VERSION,
      ...(extraHeaders ?? {}),
    });
    if (token) {
      reqHeaders.set("authorization", `Bearer ${token}`);
    }
    const payload: Record<string, unknown> = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    };
    if (!isNotification) {
      payload.id = nextId++;
    }

    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify(payload),
    });

    const response = await httpService.fetch(request);
    if (response.status === 202) {
      return undefined as T;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const err = new Error(
        `MCP HTTP error ${response.status}: ${text || response.statusText}`,
      ) as Error & { status: number; headers: Headers };
      err.status = response.status;
      err.headers = response.headers;
      throw err;
    }

    const contentType = response.headers.get("content-type") ?? "";
    let rpcResponse: JsonRpcResponse | undefined;

    if (contentType.includes("text/event-stream")) {
      const sseText = await response.text();
      for (const block of sseText.split(/\r?\n\r?\n/)) {
        const dataLines = block
          .split(/\r?\n/)
          .filter((l: string) => l.startsWith("data:"))
          .map((l: string) => l.slice(5).trim());
        if (dataLines.length === 0) continue;
        const msg = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
        if ("id" in msg) {
          rpcResponse = msg as unknown as JsonRpcResponse;
        } else if (typeof msg.method === "string") {
          receivedNotifications.push({
            method: msg.method,
            params: msg.params as Record<string, unknown> | undefined,
          });
        }
      }
    } else {
      rpcResponse = (await response.json()) as JsonRpcResponse;
    }

    if (!rpcResponse) {
      throw new Error("MCP server returned no JSON-RPC response");
    }
    if ("error" in rpcResponse) {
      throw new ProtocolError(
        rpcResponse.error.code,
        rpcResponse.error.message,
        rpcResponse.error.data,
      );
    }
    return rpcResponse.result as T;
  };

  if (era === "legacy") {
    const init = await send<{
      serverInfo?: Record<string, unknown>;
      capabilities?: Record<string, unknown>;
      instructions?: string;
    }>("initialize", {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo,
    });
    serverInfo = init.serverInfo;
    serverCapabilities = init.capabilities;
    instructions = init.instructions;
    await send("notifications/initialized", undefined, true);
  }

  return {
    ping: () => send<Record<string, unknown>>("ping"),
    listTools: () => send<{ tools: Array<Record<string, any>> }>("tools/list"),
    callTool: ({ name, arguments: args, _meta }) =>
      send<CallToolResult>("tools/call", {
        name,
        ...(args !== undefined ? { arguments: args } : {}),
        ...(_meta !== undefined ? { _meta } : {}),
      }),
    listResources: () =>
      send<{ resources: Array<Record<string, any>> }>("resources/list"),
    listResourceTemplates: () =>
      send<{ resourceTemplates: Array<Record<string, any>> }>(
        "resources/templates/list",
      ),
    readResource: ({ uri, _meta }) =>
      send<ReadResourceResult>("resources/read", {
        uri,
        ...(_meta !== undefined ? { _meta } : {}),
      }),
    listPrompts: () =>
      send<{ prompts: Array<Record<string, any>> }>("prompts/list"),
    getPrompt: ({ name, arguments: args, _meta }) =>
      send<GetPromptResult>("prompts/get", {
        name,
        ...(args !== undefined ? { arguments: args } : {}),
        ...(_meta !== undefined ? { _meta } : {}),
      }),
    request: <T = unknown>(method: string, params?: Record<string, unknown>) =>
      send<T>(method, params),
    getServerInfo: () => serverInfo,
    getServerCapabilities: () => serverCapabilities,
    getInstructions: () => instructions,
    getNotifications: () => [...receivedNotifications],
    close: async () => {
      closed = true;
    },
  };
}
