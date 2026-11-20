import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Module,
  NotFoundException,
  UseGuards,
} from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import {
  McpExecutionContext,
  McpHttpService,
  McpModule,
  McpRegistry,
  McpStdioLogger,
  McpStdioServer,
  Prompt,
  Resource,
  ResourceTemplate,
  Tool,
  type McpContext,
  type McpSchema,
  type McpTokenVerifier,
} from "../src/index";
import { connectMcpClient } from "../src/testing/index";

function createObjectSchema<T extends Record<string, unknown>>(
  requiredFields: Array<keyof T & string>,
  properties: Record<string, { type: string; description?: string }>,
): McpSchema<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "bunest-test",
      validate(value: unknown) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return { issues: [{ message: "Expected an object" }] };
        }
        const rec = value as Record<string, unknown>;
        const issues: Array<{ message: string; path: string[] }> = [];
        for (const field of requiredFields) {
          const prop = properties[field];
          if (rec[field] === undefined) {
            issues.push({ message: "Required", path: [field] });
          } else if (prop && typeof rec[field] !== prop.type) {
            issues.push({
              message: `Expected ${prop.type}`,
              path: [field],
            });
          }
        }
        if (issues.length > 0) {
          return { issues };
        }
        return { value: rec as T };
      },
      jsonSchema: {
        input: () => ({
          type: "object",
          properties,
          required: requiredFields,
        }),
        output: () => ({
          type: "object",
          properties,
          required: requiredFields,
        }),
      },
    },
  };
}

describe("@bunest/mcp", () => {
  it("executes tools, resources, RFC 6570 resource templates, prompts, guards, and progress notifications end-to-end", async () => {
    const seenContexts: Array<{ type: string; name?: string; kind?: string }> = [];

    @Injectable()
    class AuditGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const mcp = McpExecutionContext.create(context);
        seenContexts.push({
          type: mcp.getType(),
          name: mcp.getName(),
          kind: mcp.getKind(),
        });
        return true;
      }
    }

    const addInput = createObjectSchema<{ a: number; b: number }>(["a", "b"], {
      a: { type: "number", description: "Left operand" },
      b: { type: "number", description: "Right operand" },
    });
    const addOutput = createObjectSchema<{ sum: number }>(["sum"], {
      sum: { type: "number" },
    });
    const reviewArgs = createObjectSchema<{ code: string }>(["code"], {
      code: { type: "string", description: "Code snippet to review" },
    });

    const notes = new Map<string, string>([
      ["1", "Buy milk"],
      ["2", "Ship Bunest MCP"],
    ]);

    @Injectable()
    class NotesMcpProvider {
      @Tool({
        name: "add_numbers",
        description: "Add two numbers",
        inputSchema: addInput,
        outputSchema: addOutput,
      })
      @UseGuards(AuditGuard)
      async add(
        input: { a: number; b: number },
        ctx: McpContext,
      ): Promise<{ sum: number }> {
        await ctx.reportProgress(1, 2, "Adding");
        await ctx.reportProgress(2, 2, "Done");
        return { sum: input.a + input.b };
      }

      @Resource({
        uri: "config://app",
        name: "app_config",
        mimeType: "application/json",
        description: "Application configuration",
      })
      getConfig() {
        return { env: "test", version: "1.0.0" };
      }

      @ResourceTemplate({
        uriTemplate: "notes://{id}",
        name: "note_by_id",
        mimeType: "text/plain",
        description: "Read a note by ID",
      })
      getNote({ id }: { id: string }) {
        const found = notes.get(id);
        if (!found) {
          throw new NotFoundException(`Note ${id} not found`);
        }
        return found;
      }

      @Prompt({
        name: "review_code",
        description: "Review TypeScript code",
        argsSchema: reviewArgs,
      })
      review({ code }: { code: string }) {
        return `Please review:\n${code}`;
      }
    }

    @Module({
      imports: [
        McpModule.forRoot({
          name: "notes-server",
          version: "1.2.3",
          instructions: "Use add_numbers and notes resources.",
        }),
      ],
      providers: [AuditGuard, NotesMcpProvider],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    await app.init();

    const registry = app.get(McpRegistry);
    expect(registry.size).toBe(4);

    // 1. Legacy era client (with initialize handshake)
    const legacyClient = await connectMcpClient(app, { era: "legacy" });
    expect(legacyClient.getServerInfo()?.name).toBe("notes-server");
    expect(legacyClient.getInstructions()).toBe(
      "Use add_numbers and notes resources.",
    );

    const tools = await legacyClient.listTools();
    expect(tools.tools).toHaveLength(1);
    expect(tools.tools[0]?.name).toBe("add_numbers");
    expect(tools.tools[0]?.inputSchema.required).toEqual(["a", "b"]);

    // Tool call with progress token -> SSE stream with notifications + structuredContent
    const addRes = await legacyClient.callTool({
      name: "add_numbers",
      arguments: { a: 7, b: 35 },
      _meta: { progressToken: "tok-1" },
    });
    expect(addRes.isError).toBeUndefined();
    expect(addRes.structuredContent).toEqual({ sum: 42 });
    expect(legacyClient.getNotifications()).toHaveLength(2);
    expect(legacyClient.getNotifications()[0]?.method).toBe(
      "notifications/progress",
    );

    // Schema validation error -> isError: true tool result
    const badRes = await legacyClient.callTool({
      name: "add_numbers",
      arguments: { a: "not-a-number", b: 2 },
    });
    expect(badRes.isError).toBe(true);
    expect(badRes.content[0]?.text).toContain("Expected number");

    // Static resource read
    const resources = await legacyClient.listResources();
    expect(resources.resources[0]?.uri).toBe("config://app");
    const cfg = await legacyClient.readResource({ uri: "config://app" });
    expect(JSON.parse(cfg.contents[0]!.text!)).toEqual({
      env: "test",
      version: "1.0.0",
    });

    // RFC 6570 resource template read + 404 mapping to -32002
    const templates = await legacyClient.listResourceTemplates();
    expect(templates.resourceTemplates[0]?.uriTemplate).toBe("notes://{id}");
    const note = await legacyClient.readResource({ uri: "notes://2" });
    expect(note.contents[0]?.text).toBe("Ship Bunest MCP");
    await expect(
      legacyClient.readResource({ uri: "notes://999" }),
    ).rejects.toMatchObject({ code: -32002 });

    // Prompts list + get
    const prompts = await legacyClient.listPrompts();
    expect(prompts.prompts[0]?.name).toBe("review_code");
    expect(prompts.prompts[0]?.arguments?.[0]?.name).toBe("code");
    const prompt = await legacyClient.getPrompt({
      name: "review_code",
      arguments: { code: "const x = 1;" },
    });
    expect(prompt.messages[0]?.role).toBe("user");
    expect(prompt.messages[0]?.content.text).toContain("const x = 1;");

    // Guard saw McpExecutionContext with type 'mcp'
    expect(seenContexts[0]).toEqual({
      type: "mcp",
      name: "add_numbers",
      kind: "tool",
    });

    await legacyClient.close();

    // 2. Direct HTTP endpoint test via app.inject('/mcp')
    const httpRes = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "add_numbers", arguments: { a: 10, b: 20 } },
      },
    });
    expect(httpRes.statusCode).toBe(200);
    expect(
      httpRes.json<{ result: { structuredContent: { sum: number } } }>().result
        .structuredContent,
    ).toEqual({ sum: 30 });

    // 3. Stdio server end-to-end over PassThrough streams
    const stdioServer = app.get(McpStdioServer);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let outText = "";
    stdout.on("data", (chunk: Buffer) => {
      outText += chunk.toString("utf8");
    });

    const listenPromise = stdioServer.listen({ stdin, stdout });
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`,
    );
    stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "add_numbers", arguments: { a: 2, b: 3 } },
      })}\n`,
    );
    stdin.end();
    await listenPromise;

    const lines = outText
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(lines[1].result.structuredContent).toEqual({ sum: 5 });

    await app.close();
  });

  it("enforces OAuth 2.1 Bearer tokens, step-up scopes, Host/Origin checks, and well-known metadata", async () => {
    const verifier: McpTokenVerifier = {
      verifyAccessToken(token: string) {
        if (token === "read-token") {
          return {
            token,
            clientId: "client-1",
            scopes: ["notes:read"],
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            resource: "https://api.example.com/mcp",
          };
        }
        if (token === "admin-token") {
          return {
            token,
            clientId: "client-1",
            scopes: ["notes:read", "notes:write"],
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            resource: "https://api.example.com/mcp",
          };
        }
        return null;
      },
    };

    @Injectable()
    class SecureTools {
      @Tool({ name: "write_note", scopes: ["notes:write"] })
      writeNote(_input: unknown, ctx: McpContext) {
        return { by: ctx.authInfo?.clientId };
      }
    }

    @Module({
      imports: [
        McpModule.forRoot({
          name: "secure-mcp",
          version: "1.0.0",
          http: {
            allowedHosts: ["localhost"],
            allowedOrigins: ["app.example.com"],
          },
          auth: {
            verifier,
            resource: "https://api.example.com/mcp",
            authorizationServers: ["https://auth.example.com"],
            requiredScopes: ["notes:read"],
            scopesSupported: ["notes:read", "notes:write"],
          },
        }),
      ],
      providers: [SecureTools],
    })
    class SecureAppModule {}

    const app = await BunestFactory.create(SecureAppModule, { logger: false });
    await app.init();

    // Well-known OAuth protected resource metadata
    const metaRes = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource/mcp",
    });
    expect(metaRes.statusCode).toBe(200);
    expect(
      metaRes.json<{ authorization_servers: string[] }>().authorization_servers,
    ).toEqual(["https://auth.example.com"]);

    const http = app.get(McpHttpService);

    // Bad Origin -> 403
    const badOrigin = await http.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          origin: "https://evil.example.com",
          authorization: "Bearer admin-token",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(badOrigin.status).toBe(403);

    // Missing token -> 401 + WWW-Authenticate
    const unauth = await http.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );

    // Step-up scope failure (read-token calling write_note) -> 403 insufficient_scope
    const readClient = await connectMcpClient(app, { token: "read-token" });
    await expect(
      readClient.callTool({ name: "write_note" }),
    ).rejects.toMatchObject({ status: 403 });
    await readClient.close();

    // Admin token succeeds
    const adminClient = await connectMcpClient(app, { token: "admin-token" });
    const ok = await adminClient.callTool({ name: "write_note" });
    expect(JSON.parse(ok.content[0]!.text!)).toEqual({ by: "client-1" });
    await adminClient.close();

    // McpStdioLogger inherits ConsoleLogger methods
    const stdioLogger = new McpStdioLogger("Test");
    expect(typeof stdioLogger.log).toBe("function");
    expect(stdioLogger.isLevelEnabled("error")).toBe(true);

    await app.close();
  });
});
