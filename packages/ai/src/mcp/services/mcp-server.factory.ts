import { Inject, Injectable, Logger } from "@bunest/core";
import type {
  CallToolResult,
  GetPromptResult,
  InputRequiredResult,
  McpAuthInfo,
  McpCallKind,
  McpContext,
  McpModuleOptions,
  McpProtocolEra,
  McpServerContext,
  ReadResourceResult,
} from "../interfaces/mcp-types";
import { MCP_MODULE_OPTIONS } from "../mcp.constants";
import {
  InsufficientScopeError,
  JSON_RPC_ERROR_CODES,
  ProtocolError,
  toolErrorResult,
  toProtocolError,
} from "../utils/errors.util";
import {
  toCallToolResult,
  toGetPromptResult,
  toReadResourceResult,
} from "../utils/results.util";
import { getSchemaJson, validateWithSchema } from "../utils/schema.util";
import {
  McpRegistry,
  type McpPromptEntry,
  type McpResourceEntry,
  type McpResourceTemplateEntry,
  type McpToolEntry,
} from "./mcp-registry.service";

export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const LEGACY_PROTOCOL_VERSION = "2025-11-25";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export interface McpServing {
  era: McpProtocolEra;
  transport: "http" | "stdio";
  authInfo?: McpAuthInfo;
  requestInfo?: Request;
  request?: unknown;
  signal?: AbortSignal;
  onNotify?: (notification: JsonRpcNotification) => Promise<void> | void;
}

export interface McpServerInstance {
  handleMessage(message: unknown): Promise<JsonRpcResponse | null>;
}

function derivePromptArguments(
  entry: McpPromptEntry,
): Array<{ name: string; description?: string; required?: boolean }> {
  if (!entry.argsSchema) return [];
  const json = getSchemaJson(entry.argsSchema, "input");
  const props = json.properties as
    Record<string, { description?: string }> | undefined;
  const requiredSet = new Set(
    Array.isArray(json.required) ? (json.required as string[]) : [],
  );
  if (!props || typeof props !== "object") {
    return [];
  }
  return Object.entries(props).map(([name, schema]) => ({
    name,
    ...(typeof schema?.description === "string"
      ? { description: schema.description }
      : {}),
    ...(requiredSet.has(name) ? { required: true } : {}),
  }));
}

@Injectable()
export class McpServerFactory {
  private readonly logger = new Logger(McpServerFactory.name);

  constructor(
    private readonly registry: McpRegistry,
    @Inject(MCP_MODULE_OPTIONS) private readonly options: McpModuleOptions,
  ) {}

  create(serving: McpServing): McpServerInstance {
    this.registry.scan();

    return {
      handleMessage: async (
        message: unknown,
      ): Promise<JsonRpcResponse | null> => {
        if (
          !message ||
          typeof message !== "object" ||
          (message as { jsonrpc?: unknown }).jsonrpc !== "2.0" ||
          typeof (message as { method?: unknown }).method !== "string"
        ) {
          return {
            jsonrpc: "2.0",
            id:
              message && typeof message === "object" && "id" in message
                ? ((message as { id: string | number | null }).id ?? null)
                : null,
            error: {
              code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
              message: "Invalid JSON-RPC 2.0 request",
            },
          };
        }

        const req = message as JsonRpcRequest;
        const isNotification = req.id === undefined;
        const id = req.id ?? null;

        try {
          const result = await this.dispatch(req, serving);
          if (isNotification) {
            return null;
          }
          return {
            jsonrpc: "2.0",
            id,
            result,
          };
        } catch (err) {
          if (err instanceof InsufficientScopeError) {
            throw err;
          }
          if (isNotification) {
            return null;
          }
          const protoErr =
            err instanceof ProtocolError
              ? err
              : new ProtocolError(
                  JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
                  err instanceof Error ? err.message : "Internal server error",
                );
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: protoErr.code,
              message: protoErr.message,
              ...(protoErr.data !== undefined ? { data: protoErr.data } : {}),
            },
          };
        }
      },
    };
  }

  private async dispatch(
    req: JsonRpcRequest,
    serving: McpServing,
  ): Promise<unknown> {
    const params = (req.params ?? {}) as Record<string, unknown>;

    switch (req.method) {
      case "initialize": {
        const rejectLegacy =
          serving.transport === "http"
            ? this.options.http?.legacy === "reject"
            : this.options.stdio?.legacy === "reject";
        if (rejectLegacy) {
          throw new ProtocolError(
            JSON_RPC_ERROR_CODES.INVALID_REQUEST,
            "Legacy initialize handshake is disabled on this server; use protocol revision 2026-07-28.",
          );
        }
        const clientVersion =
          typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : LEGACY_PROTOCOL_VERSION;
        return {
          protocolVersion: clientVersion,
          capabilities: {
            ...(this.registry.tools.length > 0 ? { tools: {} } : { tools: {} }),
            ...(this.registry.resources.length > 0 ||
            this.registry.resourceTemplates.length > 0
              ? { resources: {} }
              : {}),
            ...(this.registry.prompts.length > 0 ? { prompts: {} } : {}),
          },
          serverInfo: {
            name: this.options.name,
            version: this.options.version,
            ...(this.options.title ? { title: this.options.title } : {}),
            ...(this.options.description
              ? { description: this.options.description }
              : {}),
            ...(this.options.websiteUrl
              ? { websiteUrl: this.options.websiteUrl }
              : {}),
            ...(this.options.icons ? { icons: this.options.icons } : {}),
          },
          ...(this.options.instructions
            ? { instructions: this.options.instructions }
            : {}),
        };
      }

      case "notifications/initialized":
      case "notifications/cancelled":
        return {};

      case "ping":
        return {};

      case "tools/list":
        return {
          tools: this.registry.tools.map((tool) => ({
            name: tool.name,
            ...(tool.options.title ? { title: tool.options.title } : {}),
            ...(tool.options.description
              ? { description: tool.options.description }
              : {}),
            ...(tool.options.icons ? { icons: tool.options.icons } : {}),
            inputSchema: getSchemaJson(tool.inputSchema, "input"),
            ...(tool.outputSchema
              ? { outputSchema: getSchemaJson(tool.outputSchema, "output") }
              : {}),
            ...(tool.options.annotations
              ? { annotations: tool.options.annotations }
              : {}),
            ...(tool.options._meta ? { _meta: tool.options._meta } : {}),
          })),
        };

      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string" || !name) {
          throw new ProtocolError(
            JSON_RPC_ERROR_CODES.INVALID_PARAMS,
            "tools/call requires a string `name`",
          );
        }
        const entry = this.registry.tools.find((t) => t.name === name);
        if (!entry) {
          throw new ProtocolError(
            JSON_RPC_ERROR_CODES.INVALID_PARAMS,
            `Unknown tool: "${name}"`,
          );
        }
        return await this.callTool(entry, params.arguments ?? {}, req, serving);
      }

      case "resources/list":
        return {
          resources: this.registry.resources.map((res) => ({
            uri: res.uri,
            name: res.name,
            ...(res.options.title ? { title: res.options.title } : {}),
            ...(res.options.description
              ? { description: res.options.description }
              : {}),
            ...(res.options.mimeType ? { mimeType: res.options.mimeType } : {}),
            ...(res.options.size !== undefined
              ? { size: res.options.size }
              : {}),
            ...(res.options.annotations
              ? { annotations: res.options.annotations }
              : {}),
            ...(res.options.icons ? { icons: res.options.icons } : {}),
            ...(res.options._meta ? { _meta: res.options._meta } : {}),
          })),
        };

      case "resources/templates/list":
        return {
          resourceTemplates: this.registry.resourceTemplates.map((tpl) => ({
            uriTemplate: tpl.uriTemplate,
            name: tpl.name,
            ...(tpl.options.title ? { title: tpl.options.title } : {}),
            ...(tpl.options.description
              ? { description: tpl.options.description }
              : {}),
            ...(tpl.options.mimeType ? { mimeType: tpl.options.mimeType } : {}),
            ...(tpl.options.annotations
              ? { annotations: tpl.options.annotations }
              : {}),
            ...(tpl.options.icons ? { icons: tpl.options.icons } : {}),
            ...(tpl.options._meta ? { _meta: tpl.options._meta } : {}),
          })),
        };

      case "resources/read": {
        const uriStr = params.uri;
        if (typeof uriStr !== "string" || !uriStr) {
          throw new ProtocolError(
            JSON_RPC_ERROR_CODES.INVALID_PARAMS,
            "resources/read requires a string `uri`",
          );
        }
        return await this.readResource(uriStr, req, serving);
      }

      case "prompts/list":
        return {
          prompts: this.registry.prompts.map((prompt) => ({
            name: prompt.name,
            ...(prompt.options.title ? { title: prompt.options.title } : {}),
            ...(prompt.options.description
              ? { description: prompt.options.description }
              : {}),
            ...(prompt.options.icons ? { icons: prompt.options.icons } : {}),
            arguments: derivePromptArguments(prompt),
            ...(prompt.options._meta ? { _meta: prompt.options._meta } : {}),
          })),
        };

      case "prompts/get": {
        const name = params.name;
        if (typeof name !== "string" || !name) {
          throw new ProtocolError(
            JSON_RPC_ERROR_CODES.INVALID_PARAMS,
            "prompts/get requires a string `name`",
          );
        }
        const entry = this.registry.prompts.find((p) => p.name === name);
        if (!entry) {
          throw new ProtocolError(
            JSON_RPC_ERROR_CODES.INVALID_PARAMS,
            `Unknown prompt: "${name}"`,
          );
        }
        return await this.getPrompt(
          entry,
          params.arguments ?? {},
          req,
          serving,
        );
      }

      default:
        throw new ProtocolError(
          JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
          `Method not found: ${req.method}`,
        );
    }
  }

  private checkScopes(
    required: string[] | undefined,
    serving: McpServing,
  ): void {
    if (!required || required.length === 0 || serving.transport !== "http") {
      return;
    }
    const granted = new Set(serving.authInfo?.scopes ?? []);
    const missing = required.filter((s) => !granted.has(s));
    if (missing.length > 0) {
      throw new InsufficientScopeError(required);
    }
  }

  private createContext(
    kind: McpCallKind,
    name: string,
    req: JsonRpcRequest,
    serving: McpServing,
    uri?: URL,
  ): McpContext {
    const meta = (req.params?._meta ?? {}) as Record<string, unknown>;
    const progressToken = meta.progressToken;
    const signal = serving.signal ?? new AbortController().signal;

    const notify = async (
      method: string,
      params?: Record<string, unknown>,
    ): Promise<void> => {
      if (serving.onNotify) {
        await serving.onNotify({
          jsonrpc: "2.0",
          method,
          ...(params ? { params } : {}),
        });
      }
    };

    const server: McpServerContext = {
      mcpReq: {
        ...(req.id !== undefined && req.id !== null ? { id: req.id } : {}),
        method: req.method,
        _meta: meta,
        notify,
      },
    };

    return {
      kind,
      name,
      ...(uri ? { uri } : {}),
      transport: serving.transport,
      era: serving.era,
      ...(serving.authInfo ? { authInfo: serving.authInfo } : {}),
      ...(serving.request !== undefined ? { request: serving.request } : {}),
      ...(serving.requestInfo ? { requestInfo: serving.requestInfo } : {}),
      signal,
      server,
      async reportProgress(
        progress: number,
        total?: number,
        message?: string,
      ): Promise<void> {
        if (progressToken === undefined) {
          return;
        }
        await notify("notifications/progress", {
          progressToken,
          progress,
          ...(total !== undefined ? { total } : {}),
          ...(message !== undefined ? { message } : {}),
        });
      },
    };
  }

  private async callTool(
    entry: McpToolEntry,
    rawArgs: unknown,
    req: JsonRpcRequest,
    serving: McpServing,
  ): Promise<CallToolResult | InputRequiredResult> {
    this.checkScopes(entry.options.scopes, serving);

    let validatedInput: unknown = rawArgs;
    if (entry.inputSchema) {
      const check = await validateWithSchema(entry.inputSchema, rawArgs);
      if (!check.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: check.message }],
        };
      }
      validatedInput = check.value;
    }

    const ctx = this.createContext("tool", entry.name, req, serving);
    try {
      const rawResult = await entry.handler(validatedInput, ctx);
      const formatted = toCallToolResult(
        rawResult,
        entry.outputSchema !== undefined,
      );
      if (
        entry.outputSchema &&
        "structuredContent" in formatted &&
        formatted.structuredContent !== undefined &&
        formatted.isError !== true
      ) {
        const outCheck = await validateWithSchema(
          entry.outputSchema,
          formatted.structuredContent,
        );
        if (!outCheck.ok) {
          this.logger.error(
            `Tool "${entry.name}" output validation failed: ${outCheck.message}`,
          );
          return toolErrorResult(new Error(outCheck.message));
        }
        formatted.structuredContent = outCheck.value;
      }
      return formatted;
    } catch (err) {
      if (err instanceof InsufficientScopeError) {
        throw err;
      }
      return toolErrorResult(err);
    }
  }

  private async readResource(
    uriStr: string,
    req: JsonRpcRequest,
    serving: McpServing,
  ): Promise<ReadResourceResult | InputRequiredResult> {
    let uri: URL;
    try {
      uri = new URL(uriStr);
    } catch {
      throw new ProtocolError(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        `Invalid resource URI: "${uriStr}"`,
      );
    }

    let matchedResource: McpResourceEntry | undefined =
      this.registry.resources.find(
        (r) => r.uri === uriStr || r.uri === uri.href,
      );
    let matchedTemplate: McpResourceTemplateEntry | undefined;
    let variables: Record<string, string> = {};

    if (!matchedResource) {
      for (const tpl of this.registry.resourceTemplates) {
        const vars = tpl.compiled.match(uriStr) ?? tpl.compiled.match(uri.href);
        if (vars) {
          matchedTemplate = tpl;
          variables = vars;
          break;
        }
      }
    }

    const target = matchedResource ?? matchedTemplate;
    if (!target) {
      throw new ProtocolError(
        JSON_RPC_ERROR_CODES.RESOURCE_NOT_FOUND,
        `Resource not found: ${uriStr}`,
        { uri: uriStr },
      );
    }

    this.checkScopes(target.options.scopes, serving);
    const ctx = this.createContext("resource", target.name, req, serving, uri);

    try {
      const raw = await target.handler(variables, ctx);
      return toReadResourceResult(raw, uri, target.options.mimeType);
    } catch (err) {
      if (err instanceof InsufficientScopeError) {
        throw err;
      }
      throw toProtocolError(err, uri);
    }
  }

  private async getPrompt(
    entry: McpPromptEntry,
    rawArgs: unknown,
    req: JsonRpcRequest,
    serving: McpServing,
  ): Promise<GetPromptResult | InputRequiredResult> {
    this.checkScopes(entry.options.scopes, serving);

    let validatedArgs: unknown = rawArgs;
    if (entry.argsSchema) {
      const check = await validateWithSchema(entry.argsSchema, rawArgs);
      if (!check.ok) {
        throw new ProtocolError(
          JSON_RPC_ERROR_CODES.INVALID_PARAMS,
          check.message,
        );
      }
      validatedArgs = check.value;
    }

    const ctx = this.createContext("prompt", entry.name, req, serving);
    try {
      const raw = await entry.handler(validatedArgs, ctx);
      return toGetPromptResult(raw, entry.options.description);
    } catch (err) {
      if (err instanceof InsufficientScopeError) {
        throw err;
      }
      throw toProtocolError(err);
    }
  }
}
