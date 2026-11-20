import "reflect-metadata";

export { McpModule } from "./mcp.module";
export {
  MCP_MODULE_OPTIONS,
  type McpModuleAsyncOptions,
  type McpModuleRootOptions,
  type McpOptionsFactory,
} from "./mcp.module-definition";
export type {
  McpAuthOptions,
  McpCallKind,
  McpContext,
  McpContextType,
  McpHttpOptions,
  McpModuleOptions,
  McpModuleStructure,
  McpProtocolEra,
  McpSchema,
  McpStdioListenOptions,
  McpStdioOptions,
  McpTokenVerifier,
  PromptOptions,
  ResourceOptions,
  ResourceTemplateOptions,
  ToolOptions,
} from "./interfaces/mcp-types";
export {
  Prompt,
  Resource,
  ResourceTemplate,
  Tool,
} from "./decorators/primitives";
export { McpExecutionContext } from "./context/mcp-execution-context";
export { McpHttpService } from "./http/mcp-http.service";
export { McpStdioLogger } from "./stdio/mcp-stdio.logger";
export { McpStdioServer } from "./stdio/mcp-stdio.server";
export { McpRegistry } from "./services/mcp-registry.service";
