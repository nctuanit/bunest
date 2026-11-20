# @bunest/mcp

Zero-dependency, Bun-native Model Context Protocol (MCP) server for **Bunest** with full `@nestjs/mcp` API parity. Expose `@Tool`, `@Resource`, `@ResourceTemplate`, and `@Prompt` handlers over native Streamable HTTP, SSE, and stdio JSON-RPC 2.0.

## Features

- **Declarative MCP Primitives**: Define tools, static resources, RFC 6570 URI resource templates, and prompts with `@Tool()`, `@Resource()`, `@ResourceTemplate()`, and `@Prompt()`.
- **Full Bunest Execution Pipeline**: Automatic discovery via `McpRegistry` with Guards, Interceptors, Pipes, and Exception Filters using `McpExecutionContext`.
- **Multiple Transports**: Native Streamable HTTP / SSE (`McpHttpService`) with Host/Origin validation and stdio JSON-RPC 2.0 (`McpStdioServer` + `McpStdioLogger`).
- **OAuth 2.1 Resource Server**: Built-in `McpTokenVerifier`, RFC 9728 protected resource metadata, and step-up scope enforcement.
- **In-Memory Testing Client**: Test tools, resources, and prompts without opening a socket using `@bunest/mcp/testing`.

## Installation

```bash
bun add @bunest/mcp
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import { McpModule, Tool, Resource, Prompt, type McpContext } from "@bunest/mcp";

@Injectable()
export class WeatherTools {
  @Tool({
    name: "get_weather",
    description: "Get the current weather for a city",
  })
  async getWeather(args: { city: string }, _ctx: McpContext) {
    return {
      content: [{ type: "text", text: `Sunny in ${args.city}` }],
    };
  }

  @Resource({
    uri: "weather://status",
    name: "Weather Service Status",
  })
  status() {
    return { contents: [{ uri: "weather://status", text: "ok" }] };
  }

  @Prompt({
    name: "forecast_summary",
    description: "Summarize a city forecast",
  })
  forecastSummary(args: { city: string }) {
    return {
      messages: [
        { role: "user", content: { type: "text", text: `Summarize weather for ${args.city}` } },
      ],
    };
  }
}

@Module({
  imports: [
    McpModule.forRoot({
      name: "weather-mcp",
      version: "1.0.0",
    }),
  ],
  providers: [WeatherTools],
})
export class AppModule {}
```

## Key Exports

- **Module & Tokens**: `McpModule` (`forRoot`, `forRootAsync`), `MCP_MODULE_OPTIONS`
- **Decorators**: `Tool`, `Resource`, `ResourceTemplate`, `Prompt`
- **Runtime & Services**: `McpRegistry`, `McpExecutionContext`, `McpHttpService`, `McpStdioServer`, `McpStdioLogger`
- **Types**: `McpModuleOptions`, `McpModuleAsyncOptions`, `McpContext`, `McpAuthOptions`, `McpTokenVerifier`, `ToolOptions`, `ResourceOptions`, `ResourceTemplateOptions`, `PromptOptions`

## Subpath Exports

- `@bunest/mcp/testing` — In-memory test client (`connectMcpClient`, `McpTestClient`, `ConnectMcpClientOptions`) that invokes `McpHttpService.fetch()` directly with no socket.

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
