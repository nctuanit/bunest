import {
  ConfigurableModuleBuilder,
  type ConfigurableModuleAsyncOptions,
} from "@bunest/core";
import type {
  McpModuleOptions,
  McpModuleStructure,
  McpOptionsFactory,
} from "./interfaces/mcp-types";
import { MCP_MODULE_OPTIONS } from "./mcp.constants";

export type McpModuleRootOptions = McpModuleOptions & McpModuleStructure;

export type McpModuleAsyncOptions = ConfigurableModuleAsyncOptions<
  McpModuleOptions,
  "createMcpOptions"
> &
  McpModuleStructure;

export type { McpOptionsFactory };
export { MCP_MODULE_OPTIONS };

export const { ConfigurableModuleClass, OPTIONS_TYPE, ASYNC_OPTIONS_TYPE } =
  new ConfigurableModuleBuilder<McpModuleOptions>({
    optionsInjectionToken: MCP_MODULE_OPTIONS,
  })
    .setClassMethodName("forRoot")
    .setFactoryMethodName("createMcpOptions")
    .setExtras<McpModuleStructure>(
      {
        path: undefined,
        endpointVersion: undefined,
        decorators: undefined,
        imports: undefined,
      },
      (definition) => definition,
    )
    .build();
