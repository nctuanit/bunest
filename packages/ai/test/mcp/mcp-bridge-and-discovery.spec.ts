import { describe, expect, it } from "bun:test";
import {
  Body,
  BunestFactory,
  Controller,
  Delete,
  Get,
  Headers,
  Injectable,
  Module,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  type StandardSchemaV1,
} from "@bunest/core";
import { createSchemaDto, s } from "../../../validation/src/schema/index";
import { McpExpose as RootMcpExpose } from "../../src/index";
import {
  McpExpose,
  McpModule,
  McpRegistry,
  Prompt,
  Resource,
  ResourceTemplate,
  Tool,
  type McpContext,
} from "../../src/mcp/index";
import { connectMcpClient } from "../../src/mcp/testing/index";

const objSchema = <T extends Record<string, unknown>>(
  shape: Record<string, unknown>,
) =>
  s.object(shape as Record<string, any>) as unknown as StandardSchemaV1<T, T>;

const CreateTaskSchema = objSchema<{ title: string; priority: number }>({
  title: s.string().min(3),
  priority: s.coerce.number().int().min(1).max(5).default(3),
});

class CreateTaskDto extends createSchemaDto(CreateTaskSchema) {}

const TaskResultSchema = objSchema<{
  id: number;
  title: string;
  priority: number;
}>({
  id: s.number(),
  title: s.string(),
  priority: s.number(),
});

class TaskResultDto extends createSchemaDto(TaskResultSchema) {}

const PromptArgsSchema = objSchema<{ topic: string }>({
  topic: s.string().min(1),
});

class PromptArgsDto extends createSchemaDto(PromptArgsSchema) {}

const UpdateTaskBodySchema = objSchema<{ title: string }>({
  title: s.string().min(2),
});

describe("@bunest/ai/mcp Controller Discovery, createSchemaDto Support & REST-to-MCP Bridge", () => {
  it("exports McpExpose from both @bunest/ai/mcp and @bunest/ai root", () => {
    expect(RootMcpExpose).toBe(McpExpose);
  });

  it("discovers @Tool, @Resource, @ResourceTemplate, and @Prompt on @Controller classes and unwraps createSchemaDto schemas", async () => {
    @Injectable()
    class CounterService {
      private next = 1;
      allocate(): number {
        return this.next++;
      }
    }

    @Controller("/mcp-ctrl")
    class TasksMcpController {
      constructor(private readonly counter: CounterService) {}

      @Tool({
        name: "create_task_dto",
        description: "Create task using createSchemaDto input & output schemas",
        inputSchema: CreateTaskDto,
        outputSchema: TaskResultDto,
      })
      createTask(input: CreateTaskDto) {
        return {
          id: this.counter.allocate(),
          title: input.title,
          priority: input.priority,
        };
      }

      @Tool({
        name: "create_task_inferred",
        description: "Auto-infers createSchemaDto from parameter type",
      })
      createTaskInferred(input: CreateTaskDto) {
        return {
          id: this.counter.allocate(),
          title: input.title,
          priority: input.priority,
        };
      }

      @Resource({
        uri: "tasks://summary",
        name: "tasks_summary",
        mimeType: "application/json",
      })
      getSummary() {
        return { status: "ready" };
      }

      @ResourceTemplate({
        uriTemplate: "tasks://{taskId}",
        name: "task_by_id",
        mimeType: "text/plain",
      })
      getTaskResource({ taskId }: { taskId: string }) {
        return `Task #${taskId}`;
      }

      @Prompt({
        name: "plan_task",
        description: "Plan work on a topic",
        argsSchema: PromptArgsDto,
      })
      planTask(args: PromptArgsDto) {
        return `Create a plan for: ${args.topic}`;
      }
    }

    @Module({
      imports: [
        McpModule.forRoot({
          name: "controller-mcp-test",
          version: "1.0.0",
        }),
      ],
      controllers: [TasksMcpController],
      providers: [CounterService],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    await app.init();

    try {
      const registry = app.get(McpRegistry);
      expect(registry.tools.map((t) => t.name).sort()).toEqual([
        "create_task_dto",
        "create_task_inferred",
      ]);
      expect(registry.resources).toHaveLength(1);
      expect(registry.resourceTemplates).toHaveLength(1);
      expect(registry.prompts).toHaveLength(1);

      const client = await connectMcpClient(app);

      // tools/list emits full JSON Schema from createSchemaDto
      const listedTools = await client.listTools();
      const createTool = listedTools.tools.find(
        (t) => t.name === "create_task_dto",
      );
      expect(createTool?.inputSchema?.type).toBe("object");
      expect(createTool?.inputSchema?.properties?.title).toMatchObject({
        type: "string",
        minLength: 3,
      });
      expect(createTool?.inputSchema?.required).toEqual(["title"]);
      expect(createTool?.outputSchema?.required).toEqual([
        "id",
        "title",
        "priority",
      ]);

      // Valid call with coercion + default from createSchemaDto
      const ok = await client.callTool({
        name: "create_task_dto",
        arguments: { title: "Ship REST-to-MCP" },
      });
      expect(ok.isError).toBeUndefined();
      expect(ok.structuredContent).toEqual({
        id: 1,
        title: "Ship REST-to-MCP",
        priority: 3,
      });

      // Invalid call rejected by createSchemaDto validation
      const bad = await client.callTool({
        name: "create_task_dto",
        arguments: { title: "ab", priority: 99 },
      });
      expect(bad.isError).toBe(true);
      expect(bad.content[0]?.text).toContain("title");

      // Inferred createSchemaDto param works identically
      const inferredRes = await client.callTool({
        name: "create_task_inferred",
        arguments: { title: "Auto inferred", priority: "4" },
      });
      expect(inferredRes.isError).toBeUndefined();
      expect(JSON.parse(inferredRes.content[0]!.text!)).toEqual({
        id: 2,
        title: "Auto inferred",
        priority: 4,
      });

      // Resource, ResourceTemplate, and Prompt on @Controller work cleanly
      const summary = await client.readResource({ uri: "tasks://summary" });
      expect(JSON.parse(summary.contents[0]!.text!)).toEqual({
        status: "ready",
      });

      const tplRes = await client.readResource({ uri: "tasks://42" });
      expect(tplRes.contents[0]?.text).toBe("Task #42");

      const promptRes = await client.getPrompt({
        name: "plan_task",
        arguments: { topic: "OpenAPI Generics" },
      });
      expect(promptRes.messages[0]?.content.text).toBe(
        "Create a plan for: OpenAPI Generics",
      );

      await client.close();
    } finally {
      await app.close();
    }
  });

  it("bridges @McpExpose HTTP controller routes into MCP tools reusing DI, Guards, Pipes, Interceptors, and Standard Schema / DTO validation", async () => {
    const interceptorLog: string[] = [];

    @Injectable()
    class ApiKeyGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest<Request>();
        return req?.headers?.get("x-api-key") === "top-secret";
      }
    }

    @Injectable()
    class AuditInterceptor implements BunestInterceptor {
      async intercept(
        context: ExecutionContext,
        next: CallHandler,
      ): Promise<unknown> {
        interceptorLog.push(
          `${context.getType()}:${context.getClass().name}.${context.getHandler().name}`,
        );
        const result = await next.handle();
        if (result && typeof result === "object" && !Array.isArray(result)) {
          return { ...(result as Record<string, unknown>), audited: true };
        }
        return result;
      }
    }

    @Injectable()
    class TasksStore {
      readonly items = new Map<
        number,
        { id: number; title: string; priority: number }
      >([[1, { id: 1, title: "Seed task", priority: 2 }]]);
      private nextId = 2;

      create(title: string, priority: number) {
        const item = { id: this.nextId++, title, priority };
        this.items.set(item.id, item);
        return item;
      }
    }

    @Controller("/tasks")
    @McpExpose()
    @UseGuards(ApiKeyGuard)
    @UseInterceptors(AuditInterceptor)
    @UsePipes(new ValidationPipe())
    class TasksController {
      constructor(private readonly store: TasksStore) {}

      @Get(":id")
      getById(
        @Param("id", ParseIntPipe) id: number,
        @Query("verbose") verbose?: string,
        @Headers("x-trace") trace?: string,
      ) {
        const found = this.store.items.get(id);
        return {
          found: found ?? null,
          verbose: verbose === "true",
          trace: trace ?? null,
        };
      }

      @Post()
      @McpExpose({ description: "Create a new tracked task" })
      create(@Body() dto: CreateTaskDto) {
        return {
          created: this.store.create(dto.title, dto.priority),
          isInstance: dto instanceof CreateTaskDto,
        };
      }

      @Patch(":id")
      update(
        @Param("id", ParseIntPipe) id: number,
        @Body(UpdateTaskBodySchema) body: { title: string },
      ) {
        const existing = this.store.items.get(id);
        if (!existing) {
          return { updated: false };
        }
        existing.title = body.title;
        return { updated: true, item: existing };
      }

      @Delete(":id")
      remove(@Param("id", ParseIntPipe) id: number) {
        return { deleted: this.store.items.delete(id), id };
      }

      @Get("internal/debug")
      @McpExpose({ include: false })
      internalDebug() {
        return { secret: true };
      }
    }

    // Separate controller with only ONE opted-in method
    @Controller("/misc")
    class MiscController {
      @Get("public-ping")
      @McpExpose({ name: "misc_ping", description: "Health check ping" })
      ping() {
        return { pong: true };
      }

      @Get("hidden")
      hiddenRoute() {
        return { hidden: true };
      }
    }

    @Module({
      imports: [
        McpModule.forRoot({
          name: "rest-bridge-test",
          version: "1.0.0",
        }),
      ],
      controllers: [TasksController, MiscController],
      providers: [ApiKeyGuard, AuditInterceptor, TasksStore],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    await app.init();

    try {
      const unauthClient = await connectMcpClient(app);

      // tools/list contains exposed routes only (no internalDebug, no MiscController.hidden, no /mcp endpoint)
      const listed = await unauthClient.listTools();
      const toolNames = listed.tools.map((t) => t.name).sort();
      expect(toolNames).toEqual([
        "misc_ping",
        "tasks_create",
        "tasks_get_by_id",
        "tasks_remove",
        "tasks_update",
      ]);

      // Verify synthesized schemas & HTTP annotations
      const createTool = listed.tools.find((t) => t.name === "tasks_create");
      expect(createTool?.description).toBe("Create a new tracked task");
      expect(createTool?.inputSchema?.properties?.title).toMatchObject({
        type: "string",
        minLength: 3,
      });

      const getTool = listed.tools.find((t) => t.name === "tasks_get_by_id");
      expect(getTool?.annotations?.readOnlyHint).toBe(true);
      expect(getTool?.inputSchema?.required).toEqual(["id"]);
      expect(getTool?.inputSchema?.properties?.verbose).toBeDefined();

      const deleteTool = listed.tools.find((t) => t.name === "tasks_remove");
      expect(deleteTool?.annotations?.destructiveHint).toBe(true);

      const updateTool = listed.tools.find((t) => t.name === "tasks_update");
      expect(updateTool?.inputSchema?.required).toEqual(
        expect.arrayContaining(["id", "body"]),
      );

      // Guard blocks unauthenticated calls BEFORE validation / handler
      const blocked = await unauthClient.callTool({
        name: "tasks_create",
        arguments: { title: "x" },
      });
      expect(blocked.isError).toBe(true);
      expect(blocked.content[0]?.text).toContain("Forbidden");

      // Unprotected method-level @McpExpose works without key
      const pingRes = await unauthClient.callTool({ name: "misc_ping" });
      expect(pingRes.isError).toBeUndefined();
      expect(JSON.parse(pingRes.content[0]!.text!)).toEqual({ pong: true });
      await unauthClient.close();

      // Authenticated MCP client carrying `x-api-key` header passes ApiKeyGuard!
      const authClient = await connectMcpClient(app, {
        headers: { "x-api-key": "top-secret", "x-trace": "trace-99" },
      });

      // ValidationPipe + createSchemaDto rejects invalid body
      const invalidCreate = await authClient.callTool({
        name: "tasks_create",
        arguments: { title: "no" },
      });
      expect(invalidCreate.isError).toBe(true);
      expect(invalidCreate.content[0]?.text).toContain("Validation failed");

      // Valid POST creates task, hydrates DTO instance, and runs AuditInterceptor
      const created = await authClient.callTool({
        name: "tasks_create",
        arguments: { title: "Build MCP Bridge", priority: "5" },
      });
      expect(created.isError).toBeUndefined();
      expect(JSON.parse(created.content[0]!.text!)).toEqual({
        created: { id: 2, title: "Build MCP Bridge", priority: 5 },
        isInstance: true,
        audited: true,
      });

      // GET :id runs ParseIntPipe + extracts @Param, @Query, and @Headers (falling back to HTTP header!)
      const fetched = await authClient.callTool({
        name: "tasks_get_by_id",
        arguments: { id: "2", verbose: "true" },
      });
      expect(fetched.isError).toBeUndefined();
      expect(JSON.parse(fetched.content[0]!.text!)).toEqual({
        found: { id: 2, title: "Build MCP Bridge", priority: 5 },
        verbose: true,
        trace: "trace-99",
        audited: true,
      });

      // ParseIntPipe rejects non-integer id
      const badId = await authClient.callTool({
        name: "tasks_get_by_id",
        arguments: { id: "not-an-int" },
      });
      expect(badId.isError).toBe(true);

      // PATCH :id validates inline @Body(UpdateTaskBodySchema) + @Param("id", ParseIntPipe)
      const badPatch = await authClient.callTool({
        name: "tasks_update",
        arguments: { id: "2", body: { title: "x" } },
      });
      expect(badPatch.isError).toBe(true);
      expect(badPatch.content[0]?.text).toContain("Validation failed");

      const okPatch = await authClient.callTool({
        name: "tasks_update",
        arguments: { id: "2", body: { title: "Updated Title" } },
      });
      expect(okPatch.isError).toBeUndefined();
      expect(JSON.parse(okPatch.content[0]!.text!)).toEqual({
        updated: true,
        item: { id: 2, title: "Updated Title", priority: 5 },
        audited: true,
      });

      // DELETE :id works
      const removed = await authClient.callTool({
        name: "tasks_remove",
        arguments: { id: "2" },
      });
      expect(removed.isError).toBeUndefined();
      expect(JSON.parse(removed.content[0]!.text!)).toEqual({
        deleted: true,
        id: 2,
        audited: true,
      });

      // Interceptor observed real controller class & handler method names under 'mcp' context
      expect(interceptorLog).toContain("mcp:TasksController.create");
      expect(interceptorLog).toContain("mcp:TasksController.getById");

      await authClient.close();
    } finally {
      await app.close();
    }
  });

  it("supports McpModule.forRoot({ exposeControllers: true | Type[] }) while skipping internal /mcp controller", async () => {
    @Controller("/alpha")
    class AlphaController {
      @Get("status")
      status() {
        return { service: "alpha" };
      }

      @Get("secret")
      @McpExpose({ include: false })
      secret() {
        return { secret: true };
      }
    }

    @Controller("/beta")
    class BetaController {
      @Get("info")
      info(_ctx?: McpContext) {
        return { service: "beta" };
      }
    }

    // 1. exposeControllers: true exposes both controllers (skipping /mcp & include: false)
    @Module({
      imports: [
        McpModule.forRoot({
          name: "expose-all",
          version: "1.0.0",
          exposeControllers: true,
        }),
      ],
      controllers: [AlphaController, BetaController],
    })
    class ExposeAllModule {}

    const appAll = await BunestFactory.create(ExposeAllModule, {
      logger: false,
    });
    await appAll.init();
    try {
      const client = await connectMcpClient(appAll);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "alpha_status",
        "beta_info",
      ]);
      const res = await client.callTool({ name: "alpha_status" });
      expect(JSON.parse(res.content[0]!.text!)).toEqual({ service: "alpha" });
      await client.close();
    } finally {
      await appAll.close();
    }

    // 2. exposeControllers: [BetaController] exposes ONLY BetaController
    @Module({
      imports: [
        McpModule.forRoot({
          name: "expose-beta",
          version: "1.0.0",
          exposeControllers: [BetaController],
        }),
      ],
      controllers: [AlphaController, BetaController],
    })
    class ExposeBetaModule {}

    const appBeta = await BunestFactory.create(ExposeBetaModule, {
      logger: false,
    });
    await appBeta.init();
    try {
      const client = await connectMcpClient(appBeta);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["beta_info"]);
      await client.close();
    } finally {
      await appBeta.close();
    }
  });
});
