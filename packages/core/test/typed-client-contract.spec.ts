import { describe, expect, it } from "bun:test";
import {
  Body,
  BunestFactory,
  Controller,
  Get,
  Module,
  Param,
  Post,
  Query,
  dirname,
  existsSyncPath,
  join,
  relative,
  resolve,
  statSyncPath,
  type StandardSchemaV1,
} from "../src/index";
import {
  CONTRACT_MARKER,
  CONTRACT_ROUTE_MARKER,
  HttpClient,
  HttpClientValidationError,
  HttpValidationError,
  createContractClient,
  createRpcClient,
  createTypedClient,
  defineContract,
  defineRoute,
  isContractDefinition,
  isContractRoute,
} from "../src/client/typed-client-entry";

function makeSchema<TIn, TOut>(
  validate: (value: unknown) => { value: TOut } | { issues: Array<{ message: string; path?: PropertyKey[] }> },
): StandardSchemaV1<TIn, TOut> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate,
    },
  };
}

const tsTranspiler = new Bun.Transpiler({ loader: "ts" });

function resolveLocalImport(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSyncPath(candidate) && statSyncPath(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

describe("Browser-safe @bunest/core/typed-client & Contract-First RPC", () => {
  it("typed-client-entry.ts has ZERO transitive imports of reflect-shim, ModuleRef, Bun, Buffer, node:*, or server DI", async () => {
    const coreSrcDir = resolve(import.meta.dir, "../src");
    const entryFile = join(coreSrcDir, "client", "typed-client-entry.ts");

    const visited = new Set<string>();
    const queue: string[] = [entryFile];
    const violations: string[] = [];

    while (queue.length > 0) {
      const file = queue.shift()!;
      if (visited.has(file)) continue;
      visited.add(file);

      const rel = relative(coreSrcDir, file).replace(/\\/g, "/");
      const source = await Bun.file(file).text();

      // Check runtime imports via Bun.Transpiler
      for (const imp of tsTranspiler.scanImports(source)) {
        const spec = imp.path;
        if (spec.startsWith("node:")) {
          violations.push(`${rel}: forbidden node:* import "${spec}"`);
        }
        if (
          spec.includes("reflect-shim") ||
          spec.includes("module-ref") ||
          spec.includes("di-container")
        ) {
          violations.push(`${rel}: forbidden server/reflect import "${spec}"`);
        }
        if (spec.startsWith(".")) {
          const target = resolveLocalImport(file, spec);
          if (target) {
            const targetRel = relative(coreSrcDir, target).replace(/\\/g, "/");
            if (
              targetRel === "index.ts" ||
              targetRel === "common/index.ts" ||
              targetRel.startsWith("di/") ||
              targetRel.startsWith("module/") ||
              targetRel.startsWith("application/") ||
              targetRel.startsWith("http/") ||
              targetRel.startsWith("ws/") ||
              targetRel.includes("reflect-shim") ||
              targetRel.includes("common/runtime/")
            ) {
              violations.push(
                `${rel}: forbidden transitive runtime dependency on "${targetRel}"`,
              );
            }
            queue.push(target);
          }
        }
      }

      // Strip comments and check for forbidden server globals (`Bun.`, `Buffer.`)
      const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
      if (/\bBun\s*\./.test(stripped)) {
        violations.push(`${rel}: references Bun.* runtime global`);
      }
      if (/\bBuffer\s*\./.test(stripped)) {
        violations.push(`${rel}: references Buffer.* global`);
      }
    }

    expect(visited.size).toBeGreaterThan(5);
    expect(violations).toEqual([]);

    // Also verify Bun.build targeting the browser succeeds cleanly
    const built = await Bun.build({
      entrypoints: [entryFile],
      target: "browser",
      format: "esm",
      minify: false,
    });
    expect(built.success).toBe(true);
    const code = await built.outputs[0]!.text();
    expect(code).not.toContain("node:");
    expect(code).not.toContain("reflect-shim");
    expect(code).not.toContain("ModuleRef");
  });

  it("exports HttpValidationError as alias for HttpClientValidationError alongside createTypedClient & createRpcClient", () => {
    expect(HttpValidationError).toBe(HttpClientValidationError);
    expect(typeof createTypedClient).toBe("function");
    expect(typeof createRpcClient).toBe("function");
    expect(typeof defineRoute).toBe("function");
    expect(typeof defineContract).toBe("function");
    expect(typeof createContractClient).toBe("function");
  });

  it("supports end-to-end typed contract RPC with Standard Schema input & response validation", async () => {
    const idParamsSchema = makeSchema<{ id: string | number }, { id: number }>(
      (v) => {
        const rec = (v ?? {}) as Record<string, unknown>;
        const n = Number(rec.id);
        if (!Number.isInteger(n) || n <= 0) {
          return { issues: [{ message: "id must be a positive integer", path: ["id"] }] };
        }
        return { value: { id: n } };
      },
    );

    const searchQuerySchema = makeSchema<
      { q?: string; limit?: number },
      { q: string; limit: number }
    >((v) => {
      const rec = (v ?? {}) as Record<string, unknown>;
      const limit = rec.limit === undefined ? 10 : Number(rec.limit);
      if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
        return { issues: [{ message: "limit out of range", path: ["limit"] }] };
      }
      return { value: { q: String(rec.q ?? ""), limit } };
    });

    const createUserBodySchema = makeSchema<
      { name: string; email: string },
      { name: string; email: string }
    >((v) => {
      const rec = (v ?? {}) as Record<string, unknown>;
      if (typeof rec.name !== "string" || rec.name.trim().length < 2) {
        return { issues: [{ message: "name too short", path: ["name"] }] };
      }
      if (typeof rec.email !== "string" || !rec.email.includes("@")) {
        return { issues: [{ message: "invalid email", path: ["email"] }] };
      }
      return { value: { name: rec.name.trim(), email: rec.email.toLowerCase() } };
    });

    const userResponseSchema = makeSchema<
      unknown,
      { id: number; name: string; email: string }
    >((v) => {
      const rec = (v ?? {}) as Record<string, unknown>;
      if (
        typeof rec.id !== "number" ||
        typeof rec.name !== "string" ||
        typeof rec.email !== "string"
      ) {
        return { issues: [{ message: "invalid user response payload" }] };
      }
      return { value: { id: rec.id, name: rec.name, email: rec.email } };
    });

    const contract = defineContract(
      {
        health: defineRoute({
          method: "GET",
          path: "/health",
        }),
        users: {
          list: defineRoute({
            method: "GET",
            path: "/users",
            query: searchQuerySchema,
          }),
          get: defineRoute({
            method: "GET",
            path: "/users/:id",
            params: idParamsSchema,
            response: userResponseSchema,
          }),
          create: defineRoute({
            method: "POST",
            path: "/users",
            body: createUserBodySchema,
            response: userResponseSchema,
          }),
          badResponse: defineRoute({
            method: "GET",
            path: "/users/corrupt",
            response: userResponseSchema,
          }),
        },
      },
      { basePath: "/api", headers: { "x-contract-client": "web" } },
    );

    expect(isContractDefinition(contract)).toBe(true);
    expect(contract[CONTRACT_MARKER]).toBe(true);
    expect(isContractRoute(contract.users.get)).toBe(true);
    expect(contract.users.get[CONTRACT_ROUTE_MARKER]).toBe(true);
    expect(contract.users.get.path).toBe("/api/users/:id");

    @Controller("api")
    class ApiController {
      @Get("health")
      health() {
        return { status: "ok" };
      }

      @Get("users")
      list(@Query() q: Record<string, string>) {
        return { q: q.q ?? "", limit: Number(q.limit ?? 10) };
      }

      @Get("users/corrupt")
      corrupt() {
        return { id: "not-a-number" };
      }

      @Get("users/:id")
      getOne(@Param("id") id: string) {
        return { id: Number(id), name: "Alice", email: "alice@example.com" };
      }

      @Post("users")
      create(@Body() body: { name: string; email: string }) {
        return { id: 42, ...body };
      }
    }

    @Module({ controllers: [ApiController] })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    await app.init();

    try {
      const seenHeaders: string[] = [];
      let fetchCalls = 0;
      const customFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        fetchCalls++;
        const req =
          input instanceof Request
            ? input
            : new Request(input instanceof URL ? input.href : input, init);
        seenHeaders.push(req.headers.get("x-contract-client") ?? "");
        return app.fetch(req);
      }) as typeof globalThis.fetch;

      const client = createContractClient(contract, {
        baseUrl: "http://localhost",
        fetch: customFetch,
      });

      expect(client.$http).toBeInstanceOf(HttpClient);

      // 0-arg GET route
      const h = await client.health();
      expect(h.status).toBe(200);
      expect(h.data).toEqual({ status: "ok" });
      expect(seenHeaders[0]).toBe("web");

      // Params schema coercion + response schema validation
      const user = await client.users.get({ params: { id: "7" } });
      expect(user.data).toEqual({
        id: 7,
        name: "Alice",
        email: "alice@example.com",
      });

      // Body schema transform + response validation
      const created = await client.users.create({
        body: { name: "  Bob  ", email: "BOB@EXAMPLE.COM" },
      });
      expect(created.data).toEqual({
        id: 42,
        name: "Bob",
        email: "bob@example.com",
      });

      // Query schema validation
      const listed = await client.users.list({ query: { q: "bun", limit: 25 } });
      expect(listed.data).toEqual({ q: "bun", limit: 25 });

      // Invalid client input throws HttpValidationError BEFORE calling fetch!
      const callsBefore = fetchCalls;
      await expect(
        client.users.create({ body: { name: "A", email: "bad" } }),
      ).rejects.toBeInstanceOf(HttpValidationError);
      expect(fetchCalls).toBe(callsBefore);

      await expect(
        client.users.get({ params: { id: -1 } }),
      ).rejects.toBeInstanceOf(HttpValidationError);
      expect(fetchCalls).toBe(callsBefore);

      // Invalid server response throws HttpValidationError
      await expect(client.users.badResponse()).rejects.toBeInstanceOf(
        HttpValidationError,
      );
    } finally {
      await app.close();
    }
  });

  it("validates omitted query/params against {} for strict object schemas while rejecting missing required keys", async () => {
    const assertPlainObject = (
      value: unknown,
    ):
      | { ok: true; record: Record<string, unknown> }
      | { ok: false; issues: Array<{ message: string; path?: PropertyKey[] }> } => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return {
          ok: false,
          issues: [{ message: `Expected object, received ${typeof value}` }],
        };
      }
      return { ok: true, record: value as Record<string, unknown> };
    };

    const strictOptionalQuerySchema = makeSchema<
      { verbose?: boolean; limit?: number },
      { verbose?: boolean; limit: number }
    >((v) => {
      const obj = assertPlainObject(v);
      if (!obj.ok) return { issues: obj.issues };
      const limit =
        obj.record.limit === undefined ? 20 : Number(obj.record.limit);
      if (!Number.isInteger(limit) || limit < 1) {
        return {
          issues: [{ message: "limit must be a positive integer", path: ["limit"] }],
        };
      }
      const out: { verbose?: boolean; limit: number } = { limit };
      if (obj.record.verbose !== undefined) {
        out.verbose = Boolean(obj.record.verbose);
      }
      return { value: out };
    });

    const strictRequiredQuerySchema = makeSchema<{ q: string }, { q: string }>(
      (v) => {
        const obj = assertPlainObject(v);
        if (!obj.ok) return { issues: obj.issues };
        if (typeof obj.record.q !== "string" || obj.record.q.length === 0) {
          return {
            issues: [{ message: "q is required", path: ["q"] }],
          };
        }
        return { value: { q: obj.record.q } };
      },
    );

    const strictOptionalParamsSchema = makeSchema<
      { scope?: string },
      { scope: string }
    >((v) => {
      const obj = assertPlainObject(v);
      if (!obj.ok) return { issues: obj.issues };
      const scope =
        obj.record.scope === undefined ? "default" : String(obj.record.scope);
      return { value: { scope } };
    });

    const strictRequiredParamsSchema = makeSchema<
      { id: string | number },
      { id: number }
    >((v) => {
      const obj = assertPlainObject(v);
      if (!obj.ok) return { issues: obj.issues };
      const id = Number(obj.record.id);
      if (!Number.isInteger(id) || id <= 0) {
        return {
          issues: [{ message: "id is required", path: ["id"] }],
        };
      }
      return { value: { id } };
    });

    const contract = defineContract({
      listOptional: defineRoute({
        method: "GET",
        path: "/items",
        query: strictOptionalQuerySchema,
      }),
      listRequired: defineRoute({
        method: "GET",
        path: "/items/search",
        query: strictRequiredQuerySchema,
      }),
      scopedOptional: defineRoute({
        method: "GET",
        path: "/scoped/:scope",
        params: strictOptionalParamsSchema,
        query: strictOptionalQuerySchema,
      }),
      getRequired: defineRoute({
        method: "GET",
        path: "/items/:id",
        params: strictRequiredParamsSchema,
        query: strictOptionalQuerySchema,
      }),
    });

    const requestedUrls: string[] = [];
    const mockFetch = (async (input: string | URL | Request) => {
      const url =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input;
      requestedUrls.push(url);
      return new Response(JSON.stringify({ url }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const client = createContractClient(contract, {
      baseUrl: "http://localhost",
      fetch: mockFetch,
    });

    // Omitted optional query passes `{}` and applies defaults
    const r1 = await client.listOptional();
    expect(r1.status).toBe(200);
    expect(requestedUrls[0]).toBe("http://localhost/items?limit=20");

    // Required params supplied while optional query is omitted
    const r2 = await client.getRequired({ params: { id: 42 } });
    expect(r2.status).toBe(200);
    expect(requestedUrls[1]).toBe("http://localhost/items/42?limit=20");

    // Both optional params and optional query omitted -> defaults applied
    const r3 = await client.scopedOptional();
    expect(r3.status).toBe(200);
    expect(requestedUrls[2]).toBe("http://localhost/scoped/default?limit=20");

    // Missing required query or required params still throws HttpClientValidationError without calling fetch
    const callsBefore = requestedUrls.length;
    await expect(
      (client.listRequired as (opts?: unknown) => Promise<unknown>)(),
    ).rejects.toBeInstanceOf(HttpClientValidationError);
    await expect(
      (client.listRequired as (opts?: unknown) => Promise<unknown>)({}),
    ).rejects.toBeInstanceOf(HttpClientValidationError);
    await expect(
      (client.getRequired as (opts?: unknown) => Promise<unknown>)(),
    ).rejects.toBeInstanceOf(HttpClientValidationError);
    await expect(
      (client.getRequired as (opts?: unknown) => Promise<unknown>)({}),
    ).rejects.toBeInstanceOf(HttpClientValidationError);
    expect(requestedUrls.length).toBe(callsBefore);
  });
});
