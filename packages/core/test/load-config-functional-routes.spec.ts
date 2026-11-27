import { afterEach, describe, expect, it } from "bun:test";
import {
  BunestFactory,
  FunctionalModule,
  Injectable,
  Module,
  Scope,
  defineRoutes,
  ensureDir,
  join,
  loadConfig,
  removePath,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  type PipeTransform,
  type StandardSchemaV1,
} from "../src/index";
import {
  ConfigModule,
  ConfigService,
  ConfigValidationError,
  registerAs,
} from "../src/config/index";

function makeSchema<TIn, TOut>(
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

describe("Bootstrap Typed Config (loadConfig) & Functional Routes (defineRoutes)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await removePath(dir, { recursive: true, force: true });
    }
  });

  it("loadConfig validates env/.env before BunestFactory.create() and ConfigModule.forRoot({ preloaded }) reuses it without double-loading", async () => {
    const tmpBase = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
    const tmpDir = join(tmpBase, `bunest-load-cfg-${crypto.randomUUID()}`);
    tempDirs.push(tmpDir);
    await ensureDir(tmpDir);

    const envFile = join(tmpDir, ".env.test");
    await Bun.write(
      envFile,
      "PORT=4567\nAPP_NAME=bunest-app\nAPI_SECRET=super-secret-value\nDEBUG=true\n",
    );

    let validateCalls = 0;
    const envSchema = makeSchema<
      Record<string, unknown>,
      { PORT: number; APP_NAME: string; API_SECRET: string; DEBUG: boolean }
    >((raw) => {
      validateCalls++;
      const rec = (raw ?? {}) as Record<string, unknown>;
      const port = Number(rec.PORT);
      if (!Number.isInteger(port) || port <= 0) {
        return { issues: [{ message: "PORT must be positive int", path: ["PORT"] }] };
      }
      if (typeof rec.APP_NAME !== "string" || rec.APP_NAME.length === 0) {
        return { issues: [{ message: "APP_NAME required", path: ["APP_NAME"] }] };
      }
      if (typeof rec.API_SECRET !== "string" || rec.API_SECRET.length < 4) {
        return { issues: [{ message: "API_SECRET required", path: ["API_SECRET"] }] };
      }
      return {
        value: {
          PORT: port,
          APP_NAME: rec.APP_NAME,
          API_SECRET: rec.API_SECRET,
          DEBUG: rec.DEBUG === "true" || rec.DEBUG === true,
        },
      };
    });

    const dbConfig = registerAs("database", () => ({
      host: "db.internal",
      poolSize: 12,
    }));

    const preloaded = await loadConfig(envSchema, {
      envFilePath: envFile,
      ignoreEnvVars: true,
      load: [dbConfig],
      secretKeys: ["API_SECRET"],
    });

    // Usable BEFORE BunestFactory.create()
    expect(validateCalls).toBe(1);
    expect(preloaded.values).toEqual({
      PORT: 4567,
      APP_NAME: "bunest-app",
      API_SECRET: "super-secret-value",
      DEBUG: true,
    });
    expect(preloaded.service.get("PORT")).toBe(4567);
    expect(preloaded.service.get("APP_NAME")).toBe("bunest-app");
    expect(preloaded.service.get("DEBUG")).toBe(true);
    expect(
      (
        preloaded.service as unknown as ConfigService<Record<string, unknown>>
      ).get("database.host"),
    ).toBe("db.internal");

    // Delete the .env file BEFORE creating the app to PROVE ConfigModule.forRoot({ preloaded })
    // does NOT re-read the file or re-run the validator!
    await removePath(envFile, { force: true });

    @Module({
      imports: [
        await ConfigModule.forRoot({
          isGlobal: true,
          preloaded,
        }),
      ],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    await app.init();

    try {
      expect(validateCalls).toBe(1);
      const cfgService = app.get(ConfigService);
      expect(cfgService.get("PORT")).toBe(4567);
      expect(cfgService.get("APP_NAME")).toBe("bunest-app");
      expect(cfgService.get("DEBUG")).toBe(true);
      expect(cfgService.get("database.poolSize")).toBe(12);
      expect(app.get(dbConfig.KEY)).toEqual({
        host: "db.internal",
        poolSize: 12,
      });

      const redacted = cfgService.getRedactedSnapshot();
      expect(redacted.API_SECRET).toBe("[REDACTED]");
    } finally {
      await app.close();
    }
  });

  it("loadConfig throws ConfigValidationError on invalid env and supports validator function", async () => {
    const badSchema = makeSchema<Record<string, unknown>, { PORT: number }>(
      () => ({
        issues: [{ message: "PORT is invalid", path: ["PORT"] }],
      }),
    );

    await expect(
      loadConfig(badSchema, {
        ignoreEnvFile: true,
        envSource: { PORT: "nope" },
      }),
    ).rejects.toBeInstanceOf(ConfigValidationError);

    const fnLoaded = await loadConfig(
      (raw) => ({
        host: String(raw.HOST ?? "127.0.0.1"),
        port: Number(raw.PORT ?? 3000),
      }),
      {
        ignoreEnvFile: true,
        envSource: { HOST: "0.0.0.0", PORT: "8080" },
      },
    );
    expect(fnLoaded.values).toEqual({ host: "0.0.0.0", port: 8080 });
    expect(fnLoaded.service.get("port")).toBe(8080);
  });

  it("defineRoutes + FunctionalModule.forRoutes integrates cleanly into the 11-stage HTTP pipeline with DI, guards, pipes, interceptors, and Standard Schemas", async () => {
    @Injectable()
    class UsersStore {
      private items = new Map<number, { id: number; name: string; secret: string }>([
        [1, { id: 1, name: "Ada", secret: "hidden" }],
      ]);

      findById(id: number) {
        return this.items.get(id);
      }

      create(name: string) {
        const id = this.items.size + 1;
        const entry = { id, name, secret: "internal-only" };
        this.items.set(id, entry);
        return entry;
      }

      update(id: number, name: string) {
        const existing = this.items.get(id);
        if (!existing) return undefined;
        existing.name = name;
        return existing;
      }

      remove(id: number) {
        return this.items.delete(id);
      }
    }

    @Injectable({ scope: Scope.REQUEST })
    class RequestTracker {
      readonly token = crypto.randomUUID();
    }

    class ApiKeyGuard implements CanActivate {
      canActivate(ctx: ExecutionContext): boolean {
        const req = ctx.switchToHttp().getRequest<Request>();
        return req.headers.get("x-api-key") === "secret";
      }
    }

    class AddHeaderInterceptor implements BunestInterceptor {
      async intercept(ctx: ExecutionContext, next: CallHandler) {
        const res = ctx.switchToHttp().getResponse<{ header(k: string, v: string): void }>();
        res.header("x-functional-intercepted", "yes");
        return await next.handle();
      }
    }

    class UpperPipe implements PipeTransform {
      transform(val: unknown) {
        if (val && typeof val === "object" && "tag" in val) {
          return {
            ...(val as Record<string, unknown>),
            tag: String((val as Record<string, unknown>).tag).toUpperCase(),
          };
        }
        return val;
      }
    }

    const idParams = makeSchema<unknown, { id: number }>((v) => {
      const n = Number((v as Record<string, unknown>)?.id);
      if (!Number.isInteger(n) || n <= 0) {
        return { issues: [{ message: "invalid id", path: ["id"] }] };
      }
      return { value: { id: n } };
    });

    const querySchema = makeSchema<unknown, { includeMeta: boolean }>((v) => ({
      value: {
        includeMeta: (v as Record<string, unknown>)?.includeMeta === "true",
      },
    }));

    const bodySchema = makeSchema<unknown, { name: string }>((v) => {
      const name = (v as Record<string, unknown>)?.name;
      if (typeof name !== "string" || name.trim().length < 2) {
        return { issues: [{ message: "name must be >= 2 chars", path: ["name"] }] };
      }
      return { value: { name: name.trim() } };
    });

    const publicUserResponse = makeSchema<
      unknown,
      { id: number; name: string }
    >((v) => {
      const rec = (v ?? {}) as Record<string, unknown>;
      if (typeof rec.id !== "number" || typeof rec.name !== "string") {
        return { issues: [{ message: "invalid response user" }] };
      }
      // Strips internal `secret` field!
      return { value: { id: rec.id, name: rec.name } };
    });

    const healthRoutes = defineRoutes("/health", (r) =>
      r.get("/", () => ({ status: "ok" })),
    );

    const userRoutes = defineRoutes("/users", (r) => {
      r.get(
        "/broken-response",
        { responseSchema: publicUserResponse },
        () => ({ wrong: true }) as unknown as { id: number; name: string },
      )
        .get(
          "/:id",
          {
            paramsSchema: idParams,
            querySchema,
            responseSchema: publicUserResponse,
            interceptors: [AddHeaderInterceptor],
          },
          async (ctx) => {
            const store = ctx.get(UsersStore);
            const tracker = await ctx.resolve(RequestTracker);
            expect(typeof tracker.token).toBe("string");
            const found = store.findById(ctx.params.id);
            return found ?? { id: 0, name: "missing" };
          },
        )
        .post(
          "/",
          {
            guards: [ApiKeyGuard],
            bodySchema,
            responseSchema: publicUserResponse,
            httpCode: 201,
          },
          (ctx) => ctx.get(UsersStore).create(ctx.body.name),
        )
        .put(
          "/:id",
          { paramsSchema: idParams, bodySchema, responseSchema: publicUserResponse },
          (ctx) => ctx.get(UsersStore).update(ctx.params.id, ctx.body.name)!,
        )
        .patch(
          "/:id/tag",
          { pipes: [UpperPipe] },
          (ctx) => ({ id: ctx.params.id, body: ctx.body }),
        )
        .delete("/:id", { paramsSchema: idParams }, (ctx) => ({
          deleted: ctx.get(UsersStore).remove(ctx.params.id),
        }));
    });

    @Module({
      imports: [
        FunctionalModule.forRoutes(healthRoutes),
        FunctionalModule.forRoutes(userRoutes),
      ],
      providers: [UsersStore, RequestTracker],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    await app.init();

    try {
      // GET /health
      const healthRes = await app.inject("/health");
      expect(healthRes.statusCode).toBe(200);
      expect(healthRes.json()).toEqual({ status: "ok" });

      // GET /users/1 with params coercion + interceptor + responseSchema stripping secret
      const getRes = await app.inject("/users/1?includeMeta=true");
      expect(getRes.statusCode).toBe(200);
      expect(getRes.headers["x-functional-intercepted"]).toBe("yes");
      expect(getRes.json()).toEqual({ id: 1, name: "Ada" });

      // Invalid params -> 400
      const badIdRes = await app.inject("/users/not-a-num");
      expect(badIdRes.statusCode).toBe(400);

      // Guard blocks POST without api key -> 403
      const forbiddenRes = await app.inject({
        method: "POST",
        url: "/users",
        payload: { name: "Grace" },
      });
      expect(forbiddenRes.statusCode).toBe(403);

      // Invalid body with valid guard -> 400
      const badBodyRes = await app.inject({
        method: "POST",
        url: "/users",
        headers: { "x-api-key": "secret" },
        payload: { name: "X" },
      });
      expect(badBodyRes.statusCode).toBe(400);

      // Valid POST -> 201 with stripped secret
      const createdRes = await app.inject({
        method: "POST",
        url: "/users",
        headers: { "x-api-key": "secret" },
        payload: { name: "  Grace  " },
      });
      expect(createdRes.statusCode).toBe(201);
      expect(createdRes.json()).toEqual({ id: 2, name: "Grace" });

      // PUT /users/2
      const putRes = await app.inject({
        method: "PUT",
        url: "/users/2",
        payload: { name: "Grace Hopper" },
      });
      expect(putRes.statusCode).toBe(200);
      expect(putRes.json()).toEqual({ id: 2, name: "Grace Hopper" });

      // PATCH /users/2/tag with pipe
      const patchRes = await app.inject({
        method: "PATCH",
        url: "/users/2/tag",
        payload: { tag: "pioneer" },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json()).toEqual({ id: "2", body: { tag: "PIONEER" } });

      // DELETE /users/2
      const delRes = await app.inject({ method: "DELETE", url: "/users/2" });
      expect(delRes.statusCode).toBe(200);
      expect(delRes.json()).toEqual({ deleted: true });

      // Broken responseSchema -> 500
      const brokenRes = await app.inject("/users/broken-response");
      expect(brokenRes.statusCode).toBe(500);
    } finally {
      await app.close();
    }
  });
});
