import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BadGatewayException } from "../src/common/index";
import type { StandardSchemaV1 } from "../src/common/interfaces/standard-schema.interface";
import {
  HttpClient,
  HttpClientError,
  HttpClientValidationError,
  HttpResponseError,
  createRpcClient,
  createTypedClient,
  toHttpException,
  type RouteDefinition,
  type RouteRegistryLike,
} from "../src/client/index";

// ============================================================================
// Test Helpers: Minimal Zero-Dep Standard Schema v1 Validators & Mock Fetch
// ============================================================================

function makeSchema<TOut>(
  validate: (
    value: unknown,
  ) =>
    | { readonly value: TOut; readonly issues?: undefined }
    | {
        readonly issues: ReadonlyArray<{
          readonly message: string;
          readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
        }>;
      }
    | Promise<
        | { readonly value: TOut; readonly issues?: undefined }
        | {
            readonly issues: ReadonlyArray<{
              readonly message: string;
              readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
            }>;
          }
      >,
): StandardSchemaV1<unknown, TOut> {
  return {
    "~standard": {
      version: 1,
      vendor: "bunest-test",
      validate,
    },
  };
}

function mockFetch(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      input instanceof URL
        ? input
        : typeof input === "string"
          ? new URL(input)
          : new URL(input.url);
    return handler(url, init);
  }) as typeof globalThis.fetch;
}

// ============================================================================
// Sample Standalone AppRoutes (matches `bunest typegen --client-types` shape)
// ============================================================================

interface CreateOrderDto {
  sku: string;
  quantity: number;
}

interface UpdateOrderDto {
  quantity: number;
}

interface PatchOrderDto {
  note?: string;
}

interface OrderResult {
  id: string;
  sku: string;
  quantity: number;
  expanded?: boolean;
  note?: string;
}

interface AppRoutes {
  "GET /health": {
    readonly method: "GET";
    readonly path: "/health";
    readonly params: Record<string, never>;
    readonly query: Record<string, unknown>;
    readonly body: never;
    readonly response: { ok: boolean };
    readonly controller: "HealthController";
    readonly handler: "check";
  };
  "GET /orders": {
    readonly method: "GET";
    readonly path: "/orders";
    readonly params: Record<string, never>;
    readonly query: { page: number; status?: "open" | "paid"; tags?: string[] };
    readonly body: never;
    readonly response: OrderResult[];
    readonly controller: "OrdersController";
    readonly handler: "list";
  };
  "GET /orders/:id": {
    readonly method: "GET";
    readonly path: "/orders/:id";
    readonly params: { id: string };
    readonly query: { expand?: boolean };
    readonly body: never;
    readonly response: OrderResult;
    readonly controller: "OrdersController";
    readonly handler: "findOne";
  };
  "POST /orders": {
    readonly method: "POST";
    readonly path: "/orders";
    readonly params: Record<string, never>;
    readonly query: Record<string, unknown>;
    readonly body: CreateOrderDto;
    readonly response: OrderResult;
    readonly controller: "OrdersController";
    readonly handler: "create";
  };
  "PUT /orders/:id": {
    readonly method: "PUT";
    readonly path: "/orders/:id";
    readonly params: { id: string };
    readonly query: Record<string, unknown>;
    readonly body: UpdateOrderDto;
    readonly response: OrderResult;
    readonly controller: "OrdersController";
    readonly handler: "replace";
  };
  "PATCH /orders/:id": {
    readonly method: "PATCH";
    readonly path: "/orders/:id";
    readonly params: { id: string };
    readonly query: Record<string, unknown>;
    readonly body: PatchOrderDto;
    readonly response: OrderResult;
    readonly controller: "OrdersController";
    readonly handler: "patch";
  };
  "DELETE /orders/:id": {
    readonly method: "DELETE";
    readonly path: "/orders/:id";
    readonly params: { id: string };
    readonly query: Record<string, unknown>;
    readonly body: never;
    readonly response: void;
    readonly controller: "OrdersController";
    readonly handler: "remove";
  };
  "HEAD /orders/:id": {
    readonly method: "HEAD";
    readonly path: "/orders/:id";
    readonly params: { id: string };
    readonly query: Record<string, unknown>;
    readonly body: never;
    readonly response: void;
    readonly controller: "OrdersController";
    readonly handler: "exists";
  };
  "OPTIONS /orders": {
    readonly method: "OPTIONS";
    readonly path: "/orders";
    readonly params: Record<string, never>;
    readonly query: Record<string, unknown>;
    readonly body: never;
    readonly response: string;
    readonly controller: "OrdersController";
    readonly handler: "cors";
  };
  "ALL /echo": {
    readonly method: "ALL";
    readonly path: "/echo";
    readonly params: Record<string, never>;
    readonly query: Record<string, unknown>;
    readonly body: { message: string } | undefined;
    readonly response: { method: string; body?: { message: string } };
    readonly controller: "EchoController";
    readonly handler: "echo";
  };
}

const appRouteManifest = {
  "GET /health": {
    method: "GET",
    path: "/health",
    controller: "HealthController",
    handler: "check",
  },
  "GET /orders": {
    method: "GET",
    path: "/orders",
    controller: "OrdersController",
    handler: "list",
  },
  "GET /orders/:id": {
    method: "GET",
    path: "/orders/:id",
    controller: "OrdersController",
    handler: "findOne",
  },
  "POST /orders": {
    method: "POST",
    path: "/orders",
    controller: "OrdersController",
    handler: "create",
  },
  "PUT /orders/:id": {
    method: "PUT",
    path: "/orders/:id",
    controller: "OrdersController",
    handler: "replace",
  },
  "PATCH /orders/:id": {
    method: "PATCH",
    path: "/orders/:id",
    controller: "OrdersController",
    handler: "patch",
  },
  "DELETE /orders/:id": {
    method: "DELETE",
    path: "/orders/:id",
    controller: "OrdersController",
    handler: "remove",
  },
  "HEAD /orders/:id": {
    method: "HEAD",
    path: "/orders/:id",
    controller: "OrdersController",
    handler: "exists",
  },
  "OPTIONS /orders": {
    method: "OPTIONS",
    path: "/orders",
    controller: "OrdersController",
    handler: "cors",
  },
  "ALL /echo": {
    method: "ALL",
    path: "/echo",
    controller: "EchoController",
    handler: "echo",
  },
} as const;

// ============================================================================
// Compile-Time Type Assertions (verified by `bun check`)
// ============================================================================

type AssertEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends <
  T,
>() => T extends B ? 1 : 2
  ? true
  : false;

function _assertType<T extends true>(_?: T): void {}

async function _compileTimeTypeChecks() {
  // AppRoutes satisfies RouteRegistryLike<AppRoutes>
  const _registryCheck: RouteRegistryLike<AppRoutes> = {} as AppRoutes;
  void _registryCheck;

  const _defCheck: RouteDefinition = {
    method: "GET",
    path: "/ping",
    response: "pong",
  };
  void _defCheck;

  const client = createTypedClient<AppRoutes>({
    baseUrl: "https://api.example.com",
    manifest: appRouteManifest,
  });

  // 1. Optional options when no params/query/body are required
  const healthRes = await client.get("/health");
  _assertType<AssertEqual<typeof healthRes.data, { ok: boolean }>>(true);
  await client.get("/health", { headers: { "x-trace": "1" } });

  // 2. Required params + optional query
  const orderRes = await client.get("/orders/:id", { params: { id: "ord_1" } });
  _assertType<AssertEqual<typeof orderRes.data, OrderResult>>(true);
  await client.get("/orders/:id", {
    params: { id: "ord_1" },
    query: { expand: true },
  });

  // 3. Required query
  const listRes = await client.get("/orders", {
    query: { page: 1, status: "open" },
  });
  _assertType<AssertEqual<typeof listRes.data, OrderResult[]>>(true);

  // 4. Required body
  const createdRes = await client.post("/orders", {
    body: { sku: "WIDGET", quantity: 2 },
  });
  _assertType<AssertEqual<typeof createdRes.data, OrderResult>>(true);

  // 5. Required params AND body
  const updatedRes = await client.put("/orders/:id", {
    params: { id: "ord_1" },
    body: { quantity: 5 },
  });
  _assertType<AssertEqual<typeof updatedRes.data, OrderResult>>(true);

  // 6. DELETE / HEAD / OPTIONS / ALL
  const deletedRes = await client.delete("/orders/:id", {
    params: { id: "ord_1" },
  });
  _assertType<AssertEqual<typeof deletedRes.data, void>>(true);
  await client.head("/orders/:id", { params: { id: "ord_1" } });
  await client.options("/orders");
  await client.get("/echo");
  await client.post("/echo", { body: { message: "hi" } });

  // 7. responseSchema override narrows response type
  const strictOrderSchema = makeSchema((raw) => ({
    value: raw as { id: string; totalCents: number },
  }));
  const validatedRes = await client.get("/orders/:id", {
    params: { id: "ord_1" },
    responseSchema: strictOrderSchema,
  });
  _assertType<
    AssertEqual<typeof validatedRes.data, { id: string; totalCents: number }>
  >(true);

  // 8. RPC proxy type inference
  const rpcHealth = await client.$rpc.HealthController.check();
  _assertType<AssertEqual<typeof rpcHealth.data, { ok: boolean }>>(true);
  const rpcOrder = await client.$rpc.OrdersController.findOne({
    params: { id: "ord_1" },
    query: { expand: true },
  });
  _assertType<AssertEqual<typeof rpcOrder.data, OrderResult>>(true);
  const rpcValidated = await client.$rpc.OrdersController.findOne({
    params: { id: "ord_1" },
    responseSchema: strictOrderSchema,
  });
  _assertType<
    AssertEqual<typeof rpcValidated.data, { id: string; totalCents: number }>
  >(true);

  // 9. Concise hand-written RouteDefinition infers :id params from path
  interface ConciseRoutes {
    "GET /items/:itemId": {
      readonly method: "GET";
      readonly path: "/items/:itemId";
      readonly response: { itemId: string };
    };
  }
  const concise = createTypedClient<ConciseRoutes>({
    baseUrl: "https://api.example.com",
  });
  const item = await concise.get("/items/:itemId", {
    params: { itemId: 42 },
  });
  _assertType<AssertEqual<typeof item.data, { itemId: string }>>(true);

  // --- Negative compile-time checks (@ts-expect-error) ---

  // @ts-expect-error invalid path for GET
  await client.get("/nonexistent");

  // @ts-expect-error POST-only route cannot be called on DELETE
  await client.delete("/health");

  // @ts-expect-error missing required params on GET /orders/:id
  await client.get("/orders/:id");

  // @ts-expect-error wrong param type (number instead of string)
  await client.get("/orders/:id", { params: { id: 123 } });

  // @ts-expect-error wrong query type (string instead of boolean)
  await client.get("/orders/:id", { params: { id: "1" }, query: { expand: "yes" } });

  // @ts-expect-error missing required query on GET /orders
  await client.get("/orders");

  // @ts-expect-error missing required body on POST /orders
  await client.post("/orders");

  // @ts-expect-error wrong body field type
  await client.post("/orders", { body: { sku: "X", quantity: "two" } });

  // @ts-expect-error missing body on PUT /orders/:id
  await client.put("/orders/:id", { params: { id: "1" } });

  // @ts-expect-error body disallowed on GET route with body: never
  await client.get("/health", { body: { bad: true } });

  // @ts-expect-error missing required params on $rpc call
  await client.$rpc.OrdersController.findOne();

  // @ts-expect-error missing required body on $rpc call
  await client.$rpc.OrdersController.create();

  // @ts-expect-error missing required path param on concise route
  await concise.get("/items/:itemId");
}
void _compileTimeTypeChecks;

// ============================================================================
// Runtime Tests
// ============================================================================

describe("HttpClient optional runtime responseSchema validation", () => {
  const userSchema = makeSchema<{ id: number; name: string; normalized: true }>(
    (raw) => {
      if (
        typeof raw !== "object" ||
        raw === null ||
        typeof (raw as Record<string, unknown>).id !== "number" ||
        typeof (raw as Record<string, unknown>).name !== "string"
      ) {
        return {
          issues: [
            {
              message: "Expected object with numeric id and string name",
              path: [{ key: "user" }],
            },
          ],
        };
      }
      const u = raw as { id: number; name: string };
      return {
        value: { id: u.id, name: u.name.trim(), normalized: true as const },
      };
    },
  );

  it("validates and transforms parsed JSON response data via Standard Schema v1", async () => {
    const client = new HttpClient({
      baseUrl: "https://api.example.com",
      retry: false,
      fetch: mockFetch(
        () =>
          new Response(JSON.stringify({ id: 7, name: "  Ada  " }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    });

    const res = await client.get("/users/7", { responseSchema: userSchema });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ id: 7, name: "Ada", normalized: true });
  });

  it("supports asynchronous Standard Schema v1 validators", async () => {
    const asyncSchema = makeSchema<{ id: string }>(async (raw) => {
      await Promise.resolve();
      if (typeof (raw as { id?: unknown })?.id === "string") {
        return { value: { id: (raw as { id: string }).id.toUpperCase() } };
      }
      return { issues: [{ message: "id must be a string", path: ["id"] }] };
    });

    const client = new HttpClient({
      baseUrl: "https://api.example.com",
      retry: false,
      fetch: mockFetch(
        () =>
          new Response(JSON.stringify({ id: "abc" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    });

    const res = await client.post("/items", {
      json: { name: "x" },
      responseSchema: asyncSchema,
    });
    expect(res.data).toEqual({ id: "ABC" });
  });

  it("throws HttpClientValidationError (non-retryable, redacted URL, hidden body) on schema issues", async () => {
    let attempts = 0;
    const client = new HttpClient({
      baseUrl: "https://api.example.com",
      retry: { attempts: 3, backoff: { delay: 1, jitter: "none" } },
      fetch: mockFetch(() => {
        attempts += 1;
        return new Response(
          JSON.stringify({ id: "not-a-number", secret: "top-secret-token" }),
          {
            status: 200,
            statusText: "OK",
            headers: {
              "content-type": "application/json",
              "x-req-id": "req-1",
            },
          },
        );
      }),
    });

    let caught: unknown;
    try {
      await client.get("/users/1", {
        query: { apiKey: "s3cr3t" },
        responseSchema: userSchema,
      });
    } catch (err) {
      caught = err;
    }

    expect(attempts).toBe(1);
    expect(caught).toBeInstanceOf(HttpClientValidationError);
    expect(caught).toBeInstanceOf(HttpClientError);

    const valErr = caught as HttpClientValidationError;
    expect(valErr.name).toBe("HttpClientValidationError");
    expect(valErr.status).toBe(200);
    expect(valErr.statusText).toBe("OK");
    expect(valErr.method).toBe("GET");
    expect(valErr.issues).toHaveLength(1);
    expect(valErr.issues[0]!.message).toContain("numeric id");
    // Message redacts query values and omits raw payload body
    expect(valErr.message).toContain("apiKey=***");
    expect(valErr.message).not.toContain("s3cr3t");
    expect(valErr.message).not.toContain("top-secret-token");
    expect(valErr.message).toContain("user: Expected object");
    // Hidden fields are readable, yet omitted from JSON.stringify / Object.keys
    expect(valErr.data).toEqual({
      id: "not-a-number",
      secret: "top-secret-token",
    });
    expect(valErr.body).toEqual(valErr.data);
    expect(valErr.headers.get("x-req-id")).toBe("req-1");
    expect(Object.keys(valErr)).not.toContain("data");
    expect(Object.keys(valErr)).not.toContain("body");
    expect(Object.keys(valErr)).not.toContain("headers");

    // Maps cleanly via toHttpException to 502 BadGatewayException
    const httpEx = toHttpException(valErr, { log: false });
    expect(httpEx).toBeInstanceOf(BadGatewayException);
  });

  it("rejects non-StandardSchema responseSchema upfront without invoking fetch", async () => {
    let called = false;
    const client = new HttpClient({
      baseUrl: "https://api.example.com",
      retry: false,
      fetch: mockFetch(() => {
        called = true;
        return new Response("{}");
      }),
    });

    await expect(
      client.get("/users", { responseSchema: { invalid: true } as never }),
    ).rejects.toThrow(TypeError);
    expect(called).toBe(false);
  });

  it("skips responseSchema validation on non-2xx responses when throwOnHttpError is false", async () => {
    const client = new HttpClient({
      baseUrl: "https://api.example.com",
      retry: false,
      throwOnHttpError: false,
      fetch: mockFetch(
        () =>
          new Response(JSON.stringify({ error: "not_found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      ),
    });

    const res = await client.get("/users/404", { responseSchema: userSchema });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.data as unknown).toEqual({ error: "not_found" });
  });
});

describe("createTypedClient & createRpcClient against live Bun.serve", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const method = req.method;

        if (method === "GET" && url.pathname === "/health") {
          return Response.json({ ok: true });
        }

        if (method === "GET" && url.pathname === "/orders") {
          const page = Number(url.searchParams.get("page") ?? "0");
          const status = url.searchParams.get("status");
          const tags = url.searchParams.getAll("tags");
          return Response.json([
            {
              id: `page-${page}`,
              sku: status ?? "all",
              quantity: tags.length,
            },
          ]);
        }

        if (method === "POST" && url.pathname === "/orders") {
          const body = (await req.json()) as CreateOrderDto;
          return Response.json(
            {
              id: "ord_created",
              sku: body.sku,
              quantity: body.quantity,
            },
            { status: 201 },
          );
        }

        if (method === "OPTIONS" && url.pathname === "/orders") {
          return new Response("GET,POST,OPTIONS", {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        }

        if (url.pathname.startsWith("/orders/")) {
          const id = decodeURIComponent(url.pathname.slice("/orders/".length));
          if (id === "missing") {
            return Response.json({ message: "Not found" }, { status: 404 });
          }
          if (method === "GET") {
            const expand = url.searchParams.get("expand") === "true";
            return Response.json({
              id,
              sku: "SKU-1",
              quantity: 4,
              expanded: expand,
            });
          }
          if (method === "PUT") {
            const body = (await req.json()) as UpdateOrderDto;
            return Response.json({
              id,
              sku: "SKU-1",
              quantity: body.quantity,
            });
          }
          if (method === "PATCH") {
            const body = (await req.json()) as PatchOrderDto;
            return Response.json({
              id,
              sku: "SKU-1",
              quantity: 4,
              note: body.note,
            });
          }
          if (method === "DELETE") {
            return new Response(null, { status: 204 });
          }
          if (method === "HEAD") {
            return new Response(null, {
              status: 200,
              headers: { "x-order-id": id },
            });
          }
        }

        if (url.pathname === "/echo") {
          const body =
            method === "GET" || method === "HEAD"
              ? undefined
              : ((await req.json().catch(() => undefined)) as
                  | { message: string }
                  | undefined);
          return Response.json({ method, body });
        }

        return new Response("Not Found", { status: 404 });
      },
    });
    baseUrl = server.url.origin;
  });

  afterAll(() => {
    server.stop(true);
  });

  it("executes all typed HTTP verb methods with param interpolation, query serialization, and JSON bodies", async () => {
    const client = createTypedClient<AppRoutes>({
      baseUrl,
      retry: false,
    });

    const health = await client.get("/health");
    expect(health.status).toBe(200);
    expect(health.data).toEqual({ ok: true });

    const list = await client.get("/orders", {
      query: { page: 2, status: "paid", tags: ["vip", "rush"] },
    });
    expect(list.data).toEqual([{ id: "page-2", sku: "paid", quantity: 2 }]);

    // Encodes special characters inside :id path segment
    const one = await client.get("/orders/:id", {
      params: { id: "ord/42" },
      query: { expand: true },
    });
    expect(one.data).toEqual({
      id: "ord/42",
      sku: "SKU-1",
      quantity: 4,
      expanded: true,
    });

    const created = await client.post("/orders", {
      body: { sku: "LAPTOP", quantity: 3 },
    });
    expect(created.status).toBe(201);
    expect(created.data).toEqual({
      id: "ord_created",
      sku: "LAPTOP",
      quantity: 3,
    });

    const replaced = await client.put("/orders/:id", {
      params: { id: "ord_9" },
      body: { quantity: 10 },
    });
    expect(replaced.data).toEqual({
      id: "ord_9",
      sku: "SKU-1",
      quantity: 10,
    });

    const patched = await client.patch("/orders/:id", {
      params: { id: "ord_9" },
      body: { note: "leave at door" },
    });
    expect(patched.data.note).toBe("leave at door");

    const headRes = await client.head("/orders/:id", {
      params: { id: "ord_9" },
    });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("x-order-id")).toBe("ord_9");
    expect(headRes.data).toBeUndefined();

    const optRes = await client.options("/orders");
    expect(optRes.data).toBe("GET,POST,OPTIONS");

    const delRes = await client.delete("/orders/:id", {
      params: { id: "ord_9" },
    });
    expect(delRes.status).toBe(204);
    expect(delRes.data).toBeUndefined();

    // ALL route supports GET and POST
    const echoGet = await client.get("/echo");
    expect(echoGet.data).toEqual({ method: "GET" });
    const echoPost = await client.post("/echo", {
      body: { message: "hello" },
    });
    expect(echoPost.data).toEqual({ method: "POST", body: { message: "hello" } });

    // Non-2xx still rejects with HttpResponseError
    await expect(
      client.get("/orders/:id", { params: { id: "missing" } }),
    ).rejects.toBeInstanceOf(HttpResponseError);
  });

  it("supports per-call responseSchema validation override on TypedClient and $rpc", async () => {
    const orderValidator = makeSchema<{ id: string; quantity: number }>(
      (raw) => {
        const obj = raw as Record<string, unknown> | null;
        if (
          !obj ||
          typeof obj.id !== "string" ||
          typeof obj.quantity !== "number" ||
          obj.quantity < 10
        ) {
          return {
            issues: [
              { message: "quantity must be >= 10", path: ["quantity"] },
            ],
          };
        }
        return { value: { id: obj.id, quantity: obj.quantity } };
      },
    );

    const client = createTypedClient<AppRoutes>({
      baseUrl,
      retry: false,
      manifest: appRouteManifest,
    });

    const ok = await client.put("/orders/:id", {
      params: { id: "ord_big" },
      body: { quantity: 12 },
      responseSchema: orderValidator,
    });
    expect(ok.data).toEqual({ id: "ord_big", quantity: 12 });

    await expect(
      client.get("/orders/:id", {
        params: { id: "ord_small" },
        responseSchema: orderValidator,
      }),
    ).rejects.toBeInstanceOf(HttpClientValidationError);

    await expect(
      client.$rpc.OrdersController.findOne({
        params: { id: "ord_small" },
        responseSchema: orderValidator,
      }),
    ).rejects.toBeInstanceOf(HttpClientValidationError);
  });

  it("supports client.$rpc and createRpcClient across flat, array, and nested manifests", async () => {
    // 1. Flat manifest (default `appRouteManifest` shape)
    const client = createTypedClient<AppRoutes>({
      baseUrl,
      retry: false,
      manifest: appRouteManifest,
    });

    // Proxy must not be treated as a Promise/thenable when awaited
    const resolvedRpc = await Promise.resolve(client.$rpc);
    expect(resolvedRpc).toBe(client.$rpc);

    const health = await client.$rpc.HealthController.check();
    expect(health.data).toEqual({ ok: true });

    const one = await client.$rpc.OrdersController.findOne({
      params: { id: "rpc_1" },
      query: { expand: true },
    });
    expect(one.data).toEqual({
      id: "rpc_1",
      sku: "SKU-1",
      quantity: 4,
      expanded: true,
    });

    const created = await client.$rpc.OrdersController.create({
      body: { sku: "RPC-SKU", quantity: 5 },
    });
    expect(created.data).toEqual({
      id: "ord_created",
      sku: "RPC-SKU",
      quantity: 5,
    });

    const echoPost = await client.$rpc.EchoController.echo({
      body: { message: "via-rpc" },
    });
    expect(echoPost.data).toEqual({
      method: "POST",
      body: { message: "via-rpc" },
    });

    // 2. Standalone createRpcClient with array manifest
    const rpcFromArray = createRpcClient<AppRoutes>({
      baseUrl,
      retry: false,
      manifest: Object.values(appRouteManifest),
    });
    expect((await rpcFromArray.HealthController.check()).data).toEqual({
      ok: true,
    });

    // 3. Standalone createRpcClient with nested controller->handler manifest
    const rpcFromNested = createRpcClient<AppRoutes>({
      baseUrl,
      retry: false,
      manifest: {
        OrdersController: {
          findOne: { method: "GET", path: "/orders/:id" },
        },
      },
    });
    expect(
      (await rpcFromNested.OrdersController.findOne({ params: { id: "n1" } }))
        .data.id,
    ).toBe("n1");
  });

  it("throws actionable errors when $rpc is called without a manifest or for an unknown handler", () => {
    const noManifestClient = createTypedClient<AppRoutes>({
      baseUrl,
      retry: false,
    });
    expect(() => noManifestClient.$rpc.HealthController.check()).toThrow(
      /requires a route `manifest` option/,
    );

    const partialClient = createTypedClient<AppRoutes>({
      baseUrl,
      retry: false,
      manifest: {
        "GET /health": {
          method: "GET",
          path: "/health",
          controller: "HealthController",
          handler: "check",
        },
      },
    });
    expect(() =>
      partialClient.$rpc.OrdersController.findOne({ params: { id: "1" } }),
    ).toThrow(/Unknown RPC route "OrdersController\.findOne"/);
  });

  it("wraps an existing HttpClient instance and preserves raw Fetch bodies (FormData / string)", async () => {
    const seen: Array<{
      url: string;
      header: string | null;
      isFormData: boolean;
    }> = [];
    const underlying = new HttpClient({
      baseUrl: "https://uploads.example.com",
      headers: { "x-shared": "from-existing-client" },
      retry: false,
      fetch: mockFetch((url, init) => {
        const headers = new Headers(init?.headers);
        seen.push({
          url: url.href,
          header: headers.get("x-shared"),
          isFormData: init?.body instanceof FormData,
        });
        return Response.json({ uploaded: true });
      }),
    });

    interface UploadRoutes {
      "POST /upload": {
        readonly method: "POST";
        readonly path: "/upload";
        readonly params: Record<string, never>;
        readonly query: Record<string, unknown>;
        readonly body: FormData;
        readonly response: { uploaded: boolean };
      };
    }

    const typed = createTypedClient<UploadRoutes>({ client: underlying });
    expect(typed.http).toBe(underlying);

    const form = new FormData();
    form.set("file", "hello");
    const res = await typed.post("/upload", { body: form });
    expect(res.data).toEqual({ uploaded: true });
    expect(seen).toEqual([
      {
        url: "https://uploads.example.com/upload",
        header: "from-existing-client",
        isFormData: true,
      },
    ]);
  });
});
