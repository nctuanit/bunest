import {
  Module,
  type DynamicModule,
  type Provider,
  type Type,
} from "@bunest/common";
import { DiscoveryModule } from "@bunest/core";
import { createMcpController } from "./http/mcp-http.controller";
import { McpHttpService } from "./http/mcp-http.service";
import type { McpTokenVerifier } from "./interfaces/mcp-types";
import {
  DEFAULT_MCP_PATH,
  MCP_HTTP_ENDPOINT,
  MCP_MODULE_OPTIONS,
  MCP_TOKEN_VERIFIER,
} from "./mcp.constants";
import {
  ConfigurableModuleClass,
  type McpModuleAsyncOptions,
  type McpModuleRootOptions,
} from "./mcp.module-definition";
import { McpRegistry } from "./services/mcp-registry.service";
import { McpServerFactory } from "./services/mcp-server.factory";
import { McpStdioServer } from "./stdio/mcp-stdio.server";

function buildMcpDefinition(
  base: DynamicModule,
  pathOption: string | false | undefined,
  endpointVersion: McpModuleRootOptions["endpointVersion"],
  decorators: ClassDecorator[] | undefined,
  extraImports: McpModuleRootOptions["imports"],
  verifierSpec?: McpTokenVerifier | Type<McpTokenVerifier>,
): DynamicModule {
  const endpointPath =
    pathOption === false ? null : (pathOption ?? DEFAULT_MCP_PATH);

  const providers: Provider[] = [
    ...(base.providers ?? []),
    {
      provide: MCP_HTTP_ENDPOINT,
      useValue: { path: endpointPath },
    },
    McpRegistry,
    McpServerFactory,
    McpHttpService,
    McpStdioServer,
  ];

  if (typeof verifierSpec === "function") {
    providers.push({
      provide: MCP_TOKEN_VERIFIER,
      useClass: verifierSpec,
    });
  } else if (verifierSpec && typeof verifierSpec === "object") {
    providers.push({
      provide: MCP_TOKEN_VERIFIER,
      useValue: verifierSpec,
    });
  } else {
    providers.push({
      provide: MCP_TOKEN_VERIFIER,
      useValue: null,
    });
  }

  const controllers =
    endpointPath !== null
      ? [createMcpController(endpointPath, endpointVersion, decorators ?? [])]
      : [];

  return {
    ...base,
    module: McpModule,
    imports: [
      DiscoveryModule,
      ...(base.imports ?? []),
      ...(extraImports ?? []),
    ],
    controllers,
    providers,
    exports: [
      MCP_MODULE_OPTIONS,
      McpRegistry,
      McpHttpService,
      McpStdioServer,
    ],
  };
}

/**
 * `McpModule.forRoot({ name, version, ... })` or `forRootAsync(...)`.
 */
@Module({})
export class McpModule extends ConfigurableModuleClass {
  static override forRoot(options: McpModuleRootOptions): DynamicModule {
    const { path, endpointVersion, decorators, imports, ...moduleOpts } =
      options;
    const base = super.forRoot(moduleOpts);
    return buildMcpDefinition(
      base,
      path,
      endpointVersion,
      decorators,
      imports,
      moduleOpts.auth?.verifier,
    );
  }

  static override forRootAsync(options: McpModuleAsyncOptions): DynamicModule {
    const { path, endpointVersion, decorators, imports, ...asyncOpts } =
      options;
    const base = super.forRootAsync({
      ...asyncOpts,
      ...(imports ? { imports } : {}),
    });
    return buildMcpDefinition(
      base,
      path,
      endpointVersion,
      decorators,
      undefined,
      undefined,
    );
  }
}
