# Model Context Protocol (MCP)

**`@bunest/ai/mcp`** biến bất kỳ ứng dụng Bunest nào thành máy chủ **Model Context Protocol (MCP)** không dependency runtime bên ngoài—phơi bày các handler `@Tool()`, `@Resource()`, `@ResourceTemplate()` và `@Prompt()` qua các transport JSON-RPC 2.0 native gồm **Streamable HTTP**, **SSE** và **stdio**.

## Cài đặt

```bash
bun add @bunest/ai/mcp
```

## Thiết lập Module

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

## Định nghĩa Tool, Resource & Prompt

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

## Kiểm thử (`@bunest/ai/mcp/testing`)

Import `@bunest/ai/mcp/testing` để gọi trực tiếp các tool, resource và prompt ngay trong tiến trình qua JSON-RPC 2.0 bên trong `bun:test`.
