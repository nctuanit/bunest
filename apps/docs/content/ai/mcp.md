# Model Context Protocol (MCP)

**`@bunest/ai/mcp`** turns any Bunest application into a **Model Context Protocol (MCP)** server with zero external runtime dependencies—exposing `@Tool()`, `@Resource()`, `@ResourceTemplate()`, and `@Prompt()` handlers over native **Streamable HTTP**, **SSE**, and **stdio** JSON-RPC 2.0 transports.

## Installation

```bash
bun add @bunest/ai
```

## Module Setup

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { McpModule } from "@bunest/ai/mcp";
import { DocsMcpTools } from "./docs.mcp";

@Module({
  imports: [
    McpModule.forRoot({
      name: "bunest-mcp-server",
      version: "1.0.0",
      path: "/mcp",
    }),
  ],
  providers: [DocsMcpTools],
})
export class AppModule {}
```

## Defining Tools, Resources & Prompts

@@filename(docs.mcp.ts)

```ts
import { Injectable } from "@bunest/core";
import { Prompt, Resource, Tool } from "@bunest/ai/mcp";

@Injectable()
export class DocsMcpTools {
  @Tool({
    name: "search_docs",
    description: "Search Bunest documentation by keyword",
  })
  async searchDocs(args: { query: string }) {
    return { matches: [`Result for "${args.query}"`] };
  }

  @Resource({
    uri: "bunest://status",
    name: "Server Status",
    mimeType: "application/json",
  })
  getStatus() {
    return JSON.stringify({ status: "healthy" });
  }

  @Prompt({
    name: "review_controller",
    description: "Review a Bunest controller for best practices",
  })
  reviewController(args: { code: string }) {
    return `Review this Bunest controller:\n\n${args.code}`;
  }
}
```

## Testing (`@bunest/ai/mcp/testing`)

Import `@bunest/ai/mcp/testing` to invoke tools, resources, and prompts directly in-process over JSON-RPC 2.0 inside `bun:test`.
