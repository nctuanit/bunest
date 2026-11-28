# Typed Contracts & RPC Client

Share a **single schema contract** across your Bunest server, automatic OpenAPI 3.1 Swagger docs, frontend/service RPC client, and zero-socket E2E tests — with **zero code generation** and **zero external runtime dependencies**.

Works with Bunest's built-in `s.*` schema builder (`@bunest/validation/schema`) as well as any [Standard Schema v1](https://standardschema.dev/) library (Zod, Valibot, ArkType).

## 1. Define the Shared Contract

Create a contract file importable by both backend and frontend/SDK packages:

@@filename(shared/tasks.contract.ts)

```ts
import { defineContract } from "@bunest/core/client";
import { s } from "@bunest/validation/schema";

const TaskSchema = s.object({
  id: s.string(),
  title: s.string(),
  completed: s.boolean(),
});

export const tasksContract = defineContract({
  tasks: {
    list: {
      method: "GET",
      path: "/api/tasks",
      query: s.object({ completed: s.optional(s.string()) }),
      response: s.array(TaskSchema),
    },
    get: {
      method: "GET",
      path: "/api/tasks/:id",
      params: s.object({ id: s.string().min(1) }),
      response: TaskSchema,
    },
    create: {
      method: "POST",
      path: "/api/tasks",
      body: s.object({ title: s.string().min(1).max(120) }),
      response: TaskSchema,
    },
  },
});
```

## 2. Implement the Contract on the Server

Use `implementContract()` or `FunctionalModule.forContract()` to bind type-checked handlers directly to the contract. Every `params`, `query`, `body`, and return type is inferred from the contract, validated automatically at runtime, and attached to `@bunest/swagger` metadata.

@@filename(app.module.ts)

```ts
import { FunctionalModule, Module } from "@bunest/core";
import { ApiKeyGuard } from "./api-key.guard";
import { tasksContract } from "./shared/tasks.contract";
import { TasksService } from "./tasks.service";

@Module({
  imports: [
    FunctionalModule.forContract(tasksContract, {
      tasks: {
        list: ({ query }, app) =>
          app.get(TasksService).list(query.completed),
        get: ({ params }, app) =>
          app.get(TasksService).getOrThrow(params.id),
        create: {
          guards: [ApiKeyGuard],
          httpCode: 201,
          summary: "Create a new task",
          handler: ({ body }, app) => app.get(TasksService).create(body.title),
        },
      },
    }),
  ],
  providers: [TasksService, ApiKeyGuard],
})
export class AppModule {}
```

### Per-Route Enhancers & Metadata

Each contract endpoint accepts either a plain handler function or a route configuration object:

| Property | Description |
| --- | --- |
| `handler` | `(ctx: { req, res, params, query, body, headers }, app) => Promise<TRes> \| TRes` |
| `guards` | Array of `CanActivate` classes or instances |
| `pipes` | Array of `PipeTransform` classes or instances |
| `interceptors` | Array of `BunestInterceptor` classes or instances |
| `filters` | Array of `ExceptionFilter` classes or instances |
| `httpCode` | Explicit HTTP status code (defaults to `200`, or `201` for `POST`) |
| `headers` | Static response headers map |
| `version` | API version string/array for `enableVersioning()` |
| `summary`, `description`, `tags`, `operationId`, `deprecated` | OpenAPI 3.1 operation metadata overrides |

## 3. Automatic OpenAPI 3.1 & Swagger UI

Because `implementContract()` emits Standard Schema metadata for `params`, `query`, `body`, and `response` along with clean group tags (e.g. `tasks`) and `operationId` (`tasks.create`), `@bunest/swagger` generates a complete OpenAPI 3.1 document with **zero extra decorators**:

```ts
import { BunestFactory } from "@bunest/core";
import { DocumentBuilder, SwaggerModule } from "@bunest/swagger";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);
const doc = SwaggerModule.createDocument(
  app,
  new DocumentBuilder().setTitle("Tasks API").setVersion("1.0.0").build(),
);
SwaggerModule.setup("/docs", app, doc);
await app.listen(3000);
```

## 4. Call with the Typed Runtime Client

Import `tasksContract` in any TypeScript frontend, CLI, or sibling microservice and pass it to `createContractClient()`:

```ts
import { createContractClient } from "@bunest/core/client";
import { tasksContract } from "./shared/tasks.contract";

const client = createContractClient(tasksContract, {
  baseUrl: "http://localhost:3000",
  headers: { "x-api-key": "secret-key" },
});

// Fully typed request inputs and response outputs!
const created = await client.tasks.create({
  body: { title: "Ship contract-first RPC" },
});
const fetched = await client.tasks.get({ params: { id: created.id } });
```

## 5. Zero-Socket Typed E2E Testing

`@bunest/testing` integrates directly with contracts via `mod.createContractClient()` or `createContractTestClient(app, contract)`. Requests dispatch directly through `app.fetch()` without opening a TCP port:

```ts
import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { AppModule } from "../src/app.module";
import { tasksContract } from "../src/shared/tasks.contract";

describe("Tasks Contract API", () => {
  it("validates and executes end-to-end without opening a socket", async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();

    const client = await mod.createContractClient(tasksContract, app, {
      headers: { "x-api-key": "demo-key" },
    });

    try {
      const task = await client.tasks.create({ body: { title: "Write tests" } });
      expect(task.title).toBe("Write tests");

      const list = await client.tasks.list({ query: {} });
      expect(list.some((item) => item.id === task.id)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
```

> [!TIP]
> Browse the complete runnable project in [`examples/fullstack-contract-rpc`](https://github.com/nctuanit/bunest/tree/main/examples/fullstack-contract-rpc).
