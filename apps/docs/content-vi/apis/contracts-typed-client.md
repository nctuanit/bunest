# Contracts & Typed RPC Client

Chia sẻ **một contract schema duy nhất** cho cả server Bunest, tài liệu OpenAPI 3.1 tự động, RPC client phía frontend/service và bộ kiểm thử E2E không mở socket — **không cần codegen** và **0 phụ thuộc runtime ngoài**.

Tương thích hoàn toàn với schema builder tích hợp `s.*` (`@bunest/validation/schema`) cũng như mọi thư viện chuẩn [Standard Schema v1](https://standardschema.dev/) (Zod, Valibot, ArkType).

## 1. Định nghĩa Contract dùng chung

Tạo một file contract có thể import trực tiếp ở cả backend và frontend/SDK:

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

## 2. Triển khai Contract phía Server

Dùng `implementContract()` hoặc `FunctionalModule.forContract()` để gắn handler đã được kiểm tra kiểu chặt chẽ trực tiếp vào contract. Toàn bộ `params`, `query`, `body` và kiểu trả về được suy luận tự động từ contract, được validate lúc runtime và tự xuất metadata cho `@bunest/swagger`.

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
          summary: "Tạo tác vụ mới",
          handler: ({ body }, app) => app.get(TasksService).create(body.title),
        },
      },
    }),
  ],
  providers: [TasksService, ApiKeyGuard],
})
export class AppModule {}
```

### Enhancers & Metadata theo từng Route

Mỗi endpoint trong contract chấp nhận một hàm handler thuần hoặc một object cấu hình chi tiết:

| Thuộc tính | Mô tả |
| --- | --- |
| `handler` | `(ctx: { req, res, params, query, body, headers }, app) => Promise<TRes> \| TRes` |
| `guards` | Mảng class hoặc instance `CanActivate` |
| `pipes` | Mảng class hoặc instance `PipeTransform` |
| `interceptors` | Mảng class hoặc instance `BunestInterceptor` |
| `filters` | Mảng class hoặc instance `ExceptionFilter` |
| `httpCode` | Mã trạng thái HTTP tường minh (mặc định `200`, hoặc `201` cho `POST`) |
| `headers` | Tập header phản hồi tĩnh |
| `version` | Chuỗi/mảng phiên bản API cho `enableVersioning()` |
| `summary`, `description`, `tags`, `operationId`, `deprecated` | Metadata ghi đè cho đặc tả OpenAPI 3.1 |

## 3. Tự động sinh OpenAPI 3.1 & Swagger UI

Do `implementContract()` tự xuất metadata Standard Schema cho `params`, `query`, `body`, `response` kèm tag theo nhóm (ví dụ `tasks`) và `operationId` (`tasks.create`), `@bunest/swagger` tạo ra tài liệu OpenAPI 3.1 hoàn chỉnh mà **không cần thêm bất kỳ decorator Swagger nào**:

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

## 4. Gọi API bằng Typed Runtime Client

Import `tasksContract` vào frontend TypeScript, CLI hoặc microservice khác rồi truyền vào `createContractClient()`:

```ts
import { createContractClient } from "@bunest/core/client";
import { tasksContract } from "./shared/tasks.contract";

const client = createContractClient(tasksContract, {
  baseUrl: "http://localhost:3000",
  headers: { "x-api-key": "secret-key" },
});

// Toàn bộ input và kết quả trả về đều được kiểm tra type tự động!
const created = await client.tasks.create({
  body: { title: "Triển khai contract-first RPC" },
});
const fetched = await client.tasks.get({ params: { id: created.id } });
```

## 5. Kiểm thử E2E không mở Socket với Type đầy đủ

`@bunest/testing` tích hợp trực tiếp với contract qua `mod.createContractClient()` hoặc `createContractTestClient(app, contract)`. Request chạy nội bộ qua `app.fetch()` mà không cần mở cổng TCP:

```ts
import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { AppModule } from "../src/app.module";
import { tasksContract } from "../src/shared/tasks.contract";

describe("Tasks Contract API", () => {
  it("validate và chạy E2E hoàn chỉnh không cần mở socket", async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();

    const client = await mod.createContractClient(tasksContract, app, {
      headers: { "x-api-key": "demo-key" },
    });

    try {
      const task = await client.tasks.create({ body: { title: "Viết test" } });
      expect(task.title).toBe("Viết test");

      const list = await client.tasks.list({ query: {} });
      expect(list.some((item) => item.id === task.id)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
```

> [!TIP]
> Xem dự án chạy được hoàn chỉnh tại [`examples/fullstack-contract-rpc`](https://github.com/nctuanit/bunest/tree/main/examples/fullstack-contract-rpc).
