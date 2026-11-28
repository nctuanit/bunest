import { describe, expect, it } from "bun:test";
import {
  BunestFactory,
  FunctionalModule,
  Injectable,
  Module,
  NotFoundException,
  Scope,
  defineRoutes,
  implementContract,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  type StandardSchemaV1,
} from "../src/index";
import {
  createContractClient,
  defineContract,
  defineRoute,
} from "../src/client/index";

function makeSchema<TIn, TOut = TIn>(
  validate: (
    value: unknown,
  ) =>
    | { value: TOut }
    | { issues: Array<{ message: string; path?: PropertyKey[] }> },
): StandardSchemaV1<TIn, TOut> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate,
    },
  };
}

describe("implementContract(), FunctionalModule.forContract(), and BunestFactory.createRoutes()", () => {
  const IdParamsSchema = makeSchema<{ id: string }, { id: number }>((raw) => {
    const rec = (raw ?? {}) as Record<string, unknown>;
    const id = Number(rec.id);
    if (!Number.isInteger(id) || id <= 0) {
      return { issues: [{ message: "id must be positive int", path: ["id"] }] };
    }
    return { value: { id } };
  });

  const ListQuerySchema = makeSchema<
    { limit?: number },
    { limit?: number }
  >((raw) => {
    const rec = (raw ?? {}) as Record<string, unknown>;
    if (rec.limit === undefined) return { value: {} };
    const limit = Number(rec.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return {
        issues: [{ message: "limit must be 1..50", path: ["limit"] }],
      };
    }
    return { value: { limit } };
  });

  const CreateItemSchema = makeSchema<{ title: string }>((raw) => {
    const rec = (raw ?? {}) as Record<string, unknown>;
    if (typeof rec.title !== "string" || rec.title.trim().length < 2) {
      return {
        issues: [{ message: "title min length 2", path: ["title"] }],
      };
    }
    return { value: { title: rec.title.trim() } };
  });

  const ItemResponseSchema = makeSchema<{ id: number; title: string }>((raw) => {
    const rec = (raw ?? {}) as Record<string, unknown>;
    if (typeof rec.id !== "number" || typeof rec.title !== "string") {
      return { issues: [{ message: "invalid item response" }] };
    }
    return { value: { id: rec.id, title: rec.title } };
  });

  const ItemListResponseSchema = makeSchema<Array<{ id: number; title: string }>>(
    (raw) => {
      if (!Array.isArray(raw)) {
        return { issues: [{ message: "expected array" }] };
      }
      return { value: raw as Array<{ id: number; title: string }> };
    },
  );

  const itemsContract = defineContract(
    {
      items: {
        list: defineRoute({
          method: "GET",
          path: "/items",
          query: ListQuerySchema,
          response: ItemListResponseSchema,
          summary: "List items",
        }),
        getById: defineRoute({
          method: "GET",
          path: "/items/:id",
          params: IdParamsSchema,
          response: ItemResponseSchema,
          summary: "Get item by id",
        }),
        create: defineRoute({
          method: "POST",
          path: "/items",
          body: CreateItemSchema,
          response: ItemResponseSchema,
          summary: "Create item",
        }),
      },
    },
    { basePath: "/api" },
  );

  it("mounts a shared defineContract() on server with DI, Guards, Interceptors, validation, and live createContractClient()", async () => {
    @Injectable()
    class ItemsStore {
      private readonly rows: Array<{ id: number; title: string }> = [
        { id: 1, title: "First" },
      ];
      private seq = 2;

      list(limit?: number) {
        return limit !== undefined ? this.rows.slice(0, limit) : [...this.rows];
      }

      get(id: number) {
        const found = this.rows.find((r) => r.id === id);
        if (!found) throw new NotFoundException(`Item ${id} not found`);
        return found;
      }

      create(title: string) {
        const item = { id: this.seq++, title };
        this.rows.push(item);
        return item;
      }
    }

    @Injectable()
    class ApiKeyGuard implements CanActivate {
      canActivate(ctx: ExecutionContext): boolean {
        const req = ctx.switchToHttp().getRequest<Request>();
        return req.headers.get("x-api-key") === "secret-123";
      }
    }

    @Injectable()
    class HeaderInterceptor implements BunestInterceptor {
      async intercept(ctx: ExecutionContext, next: CallHandler) {
        const res = ctx.switchToHttp().getResponse<{ header(k: string, v: string): void }>();
        res.header("x-contract-pipeline", "ok");
        return next.handle();
      }
    }

    @Module({
      imports: [
        FunctionalModule.forContract(
          itemsContract,
          {
            items: {
              list: ({ query, get }) => get(ItemsStore).list(query.limit),
              getById: ({ params, get }) => get(ItemsStore).get(params.id),
              create: {
                guards: [ApiKeyGuard],
                httpCode: 201,
                handler: ({ body, get }) => get(ItemsStore).create(body.title),
              },
            },
          },
          {
            interceptors: [HeaderInterceptor],
            providers: [ItemsStore, ApiKeyGuard, HeaderInterceptor],
          },
        ),
      ],
    })
    class ContractAppModule {}

    const app = await BunestFactory.create(ContractAppModule, { logger: false });
    await app.init();

    try {
      const client = createContractClient(itemsContract, {
        baseUrl: "http://localhost",
        fetch: ((input: string | URL | Request, init?: RequestInit) =>
          app.fetch(
            input instanceof Request
              ? init === undefined
                ? input
                : new Request(input, init)
              : new Request(String(input), init),
          )) as unknown as typeof globalThis.fetch,
      });

      // 1. Typed GET list + interceptor header
      const listRes = await client.items.list({ query: { limit: 10 } });
      expect(listRes.status).toBe(200);
      expect(listRes.headers.get("x-contract-pipeline")).toBe("ok");
      expect(listRes.data).toEqual([{ id: 1, title: "First" }]);

      // 2. Typed POST blocked without API key (403)
      const unauthRes = await app.fetch(
        new Request("http://localhost/api/items", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Blocked" }),
        }),
      );
      expect(unauthRes.status).toBe(403);

      // 3. Typed POST with API key succeeds + trims title via schema
      const createdRes = await client.items.create({
        body: { title: "  Second Item  " },
        headers: { "x-api-key": "secret-123" },
      });
      expect(createdRes.status).toBe(201);
      expect(createdRes.data).toEqual({ id: 2, title: "Second Item" });

      // 4. Typed GET by coerced numeric param
      const oneRes = await client.items.getById({ params: { id: "2" } });
      expect(oneRes.status).toBe(200);
      expect(oneRes.data).toEqual({ id: 2, title: "Second Item" });

      // 5. Server rejects invalid param with 400
      const badParamRes = await app.fetch(
        new Request("http://localhost/api/items/not-a-num"),
      );
      expect(badParamRes.status).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("throws descriptive TypeError when implementContract() misses a handler", () => {
    expect(() =>
      implementContract(
        itemsContract,
        {
          items: {
            list: () => [],
            // getById & create intentionally omitted
          },
        } as unknown as Parameters<typeof implementContract<typeof itemsContract>>[1],
      ),
    ).toThrow(/items\.getById/);
  });

  it("boots zero-boilerplate apps via BunestFactory.createRoutes() and BunestFactory.createAuto({ routes })", async () => {
    @Injectable({ scope: Scope.REQUEST })
    class RequestTagService {
      readonly tag = `req_${crypto.randomUUID().slice(0, 6)}`;
    }

    @Injectable()
    class GreeterService {
      greet(who: string) {
        return `Hello, ${who}!`;
      }
    }

    const pingRoutes = defineRoutes("/mini", (r) => {
      r.get("/greet/:name", async ({ params, get, resolve }) => {
        const reqTag = await resolve(RequestTagService);
        return {
          message: get(GreeterService).greet(params.name!),
          tag: reqTag.tag,
        };
      });
    });

    // 1. BunestFactory.createRoutes()
    const app1 = await BunestFactory.createRoutes(pingRoutes, {
      providers: [GreeterService, RequestTagService],
      logger: false,
    });
    await app1.init();
    try {
      const r1 = await app1.fetch(new Request("http://localhost/mini/greet/Ada"));
      expect(r1.status).toBe(200);
      const b1 = (await r1.json()) as { message: string; tag: string };
      expect(b1.message).toBe("Hello, Ada!");
      expect(b1.tag).toMatch(/^req_/);
    } finally {
      await app1.close();
    }

    // 2. BunestFactory.createAuto({ routes, providers })
    const app2 = await BunestFactory.createAuto({
      autoDiscover: false,
      routes: pingRoutes,
      providers: [GreeterService, RequestTagService],
      logger: false,
    });
    await app2.init();
    try {
      const r2 = await app2.fetch(
        new Request("http://localhost/mini/greet/Grace"),
      );
      expect(r2.status).toBe(200);
      const b2 = (await r2.json()) as { message: string; tag: string };
      expect(b2.message).toBe("Hello, Grace!");
    } finally {
      await app2.close();
    }
  });
});
