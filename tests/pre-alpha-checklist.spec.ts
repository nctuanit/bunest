import { describe, expect, it } from "bun:test";
import {
  IsEmail,
  IsString,
  MinLength,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from "../packages/validation/src/validator";
import {
  Body,
  BunestFactory,
  Controller,
  DuplicateRouteException,
  Get,
  Headers,
  Inject,
  Injectable,
  MetadataRegistry,
  Module,
  Param,
  Post,
  Query,
  UnknownDependencyException,
  ValidationPipe,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type ValidationErrorResponse,
} from "../packages/core/src";
import { Test } from "../packages/testing/src";

describe("Pre-Alpha Release Gate Checklist (Implementation Plan §20.2)", () => {
  it("1. Route metadata inheritance safety: subclass never mutates parent class metadata", async () => {
    @Controller("/base-items")
    class BaseItemsController {
      @Get()
      list() {
        return { source: "base" };
      }
    }

    @Controller("/child-items")
    class ChildItemsController extends BaseItemsController {
      @Get("extra")
      extra() {
        return { source: "child-extra" };
      }

      @Get()
      override list() {
        return { source: "child" };
      }
    }

    const baseRoutes =
      MetadataRegistry.getControllerRoutes(BaseItemsController);
    const childRoutes =
      MetadataRegistry.getControllerRoutes(ChildItemsController);

    expect(baseRoutes.map((r) => String(r.handlerKey))).toEqual(["list"]);
    expect(childRoutes.map((r) => String(r.handlerKey)).sort()).toEqual([
      "extra",
      "list",
    ]);

    const mod = await Test.createTestingModule({
      controllers: [BaseItemsController, ChildItemsController],
    }).compile();
    const client = mod.createTestClient();

    try {
      expect(await (await client.get("/base-items")).json()).toEqual({
        source: "base",
      });
      (await client.get("/base-items/extra")).expectStatus(404);
      expect(await (await client.get("/child-items")).json()).toEqual({
        source: "child",
      });
      expect(await (await client.get("/child-items/extra")).json()).toEqual({
        source: "child-extra",
      });
    } finally {
      await mod.close();
    }
  });

  it("2. Out-of-order parameter decorators inject at exact parameter indices", async () => {
    @Controller("/params-order")
    class OutOfOrderController {
      @Post(":id")
      handle(
        @Query("tag") tag: string,
        @Body() body: { label: string },
        @Headers("x-client") clientHeader: string,
        @Param("id") id: string,
      ) {
        return { p0_tag: tag, p1_body: body, p2_hdr: clientHeader, p3_id: id };
      }
    }

    const mod = await Test.createTestingModule({
      controllers: [OutOfOrderController],
    }).compile();
    const client = mod.createTestClient();

    try {
      const res = await client.post("/params-order/item-99", {
        query: { tag: "alpha" },
        headers: { "x-client": "bun-cli" },
        json: { label: "ordered" },
      });
      res.expectStatus(201);
      expect(await res.json()).toEqual({
        p0_tag: "alpha",
        p1_body: { label: "ordered" },
        p2_hdr: "bun-cli",
        p3_id: "item-99",
      });
    } finally {
      await mod.close();
    }
  });

  it("3. Constructor DI resolves both Symbol tokens and class tokens", async () => {
    const APP_TAG = Symbol("APP_TAG");

    @Injectable()
    class GreeterRepo {
      prefix(): string {
        return "hi";
      }
    }

    @Injectable()
    class GreeterService {
      constructor(
        private readonly repo: GreeterRepo,
        @Inject(APP_TAG) private readonly tag: string,
      ) {}

      greet(name: string): string {
        return `${this.repo.prefix()}:${this.tag}:${name}`;
      }
    }

    @Controller("/di")
    class DiController {
      constructor(private readonly service: GreeterService) {}

      @Get(":name")
      hello(@Param("name") name: string) {
        return { message: this.service.greet(name) };
      }
    }

    const mod = await Test.createTestingModule({
      controllers: [DiController],
      providers: [
        GreeterRepo,
        GreeterService,
        { provide: APP_TAG, useValue: "bunest" },
      ],
    }).compile();

    try {
      const res = await mod.createTestClient().get("/di/alice");
      res.expectStatus(200);
      expect(await res.json()).toEqual({ message: "hi:bunest:alice" });
    } finally {
      await mod.close();
    }
  });

  it("4. Duplicate route and missing provider both fail fast BEFORE listen()", async () => {
    @Controller("/dup")
    class DupController {
      @Get(":id")
      byId(@Param("id") id: string) {
        return { id };
      }

      @Get(":userId")
      byUserId(@Param("userId") userId: string) {
        return { userId };
      }
    }

    @Module({ controllers: [DupController] })
    class DupModule {}

    await expect(
      BunestFactory.create(DupModule, { logger: false }),
    ).rejects.toThrow(DuplicateRouteException);

    class UnregisteredDependency {}

    @Injectable()
    class BrokenService {
      constructor(public readonly dep: UnregisteredDependency) {}
    }

    @Module({ providers: [BrokenService] })
    class MissingProviderModule {}

    await expect(
      BunestFactory.create(MissingProviderModule, { logger: false }),
    ).rejects.toThrow(UnknownDependencyException);
  });

  it("5 & 6. Invalid DTO NEVER invokes handler, and async custom validators are awaited before handler runs", async () => {
    const timeline: string[] = [];
    let handlerCalls = 0;

    @ValidatorConstraint({ name: "isAvailableUsername", async: true })
    class AvailableUsernameConstraint implements ValidatorConstraintInterface {
      async validate(value: unknown): Promise<boolean> {
        timeline.push("validator:start");
        await Bun.sleep(15);
        timeline.push("validator:end");
        return typeof value === "string" && value !== "taken";
      }

      defaultMessage(): string {
        return "username is already taken";
      }
    }

    class SignupDto {
      @IsEmail()
      email!: string;

      @IsString()
      @MinLength(3)
      @Validate(AvailableUsernameConstraint)
      username!: string;
    }

    @Controller("/signup")
    class SignupController {
      @Post()
      register(@Body() dto: SignupDto) {
        handlerCalls += 1;
        timeline.push("handler");
        return {
          registered: dto.username,
          isInstance: dto instanceof SignupDto,
        };
      }
    }

    @Module({ controllers: [SignupController] })
    class SignupModule {}

    const app = await BunestFactory.create(SignupModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe());

    try {
      // Invalid sync DTO -> 400, handler NOT called
      const badSync = await app.fetch(
        new Request("http://localhost/signup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "invalid", username: "a", extra: 1 }),
        }),
      );
      expect(badSync.status).toBe(400);
      expect(handlerCalls).toBe(0);

      // Invalid async validator -> 400, handler NOT called
      timeline.length = 0;
      const badAsync = await app.fetch(
        new Request("http://localhost/signup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "a@b.com", username: "taken" }),
        }),
      );
      expect(badAsync.status).toBe(400);
      const asyncErr = (await badAsync.json()) as ValidationErrorResponse;
      expect(asyncErr.details[0]?.field).toBe("username");
      expect(handlerCalls).toBe(0);
      expect(timeline).toEqual(["validator:start", "validator:end"]);

      // Valid DTO -> async validator awaited strictly before handler runs
      timeline.length = 0;
      const okRes = await app.fetch(
        new Request("http://localhost/signup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: "alice@example.com",
            username: "alice",
          }),
        }),
      );
      expect(okRes.status).toBe(201);
      expect(await okRes.json()).toEqual({
        registered: "alice",
        isInstance: true,
      });
      expect(handlerCalls).toBe(1);
      expect(timeline).toEqual(["validator:start", "validator:end", "handler"]);
    } finally {
      await app.close();
    }
  });

  it("7. Exception filter NEVER leaks stack traces or internal messages in NODE_ENV=production", async () => {
    @Controller("/fault")
    class FaultController {
      @Get()
      crash(): never {
        throw new Error(
          "FATAL postgres://admin:supersecret_pw@db.internal:5432",
        );
      }
    }

    @Module({ controllers: [FaultController] })
    class FaultModule {}

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const app = await BunestFactory.create(FaultModule, { logger: false });
    try {
      const res = await app.fetch(new Request("http://localhost/fault"));
      expect(res.status).toBe(500);
      const rawText = await res.text();
      expect(rawText).not.toContain("supersecret_pw");
      expect(rawText).not.toContain("FaultController");
      expect(rawText).not.toContain("stack");
      const json = JSON.parse(rawText) as {
        statusCode: number;
        message: string;
      };
      expect(json.statusCode).toBe(500);
      expect(json.message).toBe("Internal server error");
    } finally {
      await app.close();
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });

  it("8. Singleton controller NEVER leaks request state across 100 concurrent live requests", async () => {
    @Controller("/isolated")
    class SingletonController {
      @Post(":id")
      async echo(
        @Param("id") id: string,
        @Headers("x-req-id") reqId: string,
        @Body() body: { seq: number },
      ) {
        // Variable async jitter to force interleaving across all 100 requests
        await Bun.sleep(body.seq % 7);
        return { id, reqId, seq: body.seq };
      }
    }

    @Module({ controllers: [SingletonController] })
    class IsolationModule {}

    const app = await BunestFactory.create(IsolationModule, { logger: false });
    const info = await app.listen({ hostname: "127.0.0.1", port: 0 });

    try {
      const results = await Promise.all(
        Array.from({ length: 100 }, async (_, idx) => {
          const id = `u_${idx}`;
          const reqId = `req_${idx}`;
          const res = await fetch(`${info.url}/isolated/${id}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-req-id": reqId,
            },
            body: JSON.stringify({ seq: idx }),
          });
          expect(res.status).toBe(201);
          const data = (await res.json()) as {
            id: string;
            reqId: string;
            seq: number;
          };
          return { expected: { id, reqId, seq: idx }, actual: data };
        }),
      );

      for (const item of results) {
        expect(item.actual).toEqual(item.expected);
      }
    } finally {
      await app.close();
    }
  });

  it("9. Graceful shutdown releases resources and executes lifecycle hooks in order", async () => {
    const lifecycleEvents: string[] = [];

    @Injectable()
    class ResourceHolder
      implements
        OnModuleDestroy,
        BeforeApplicationShutdown,
        OnApplicationShutdown
    {
      onModuleDestroy() {
        lifecycleEvents.push("onModuleDestroy");
      }
      beforeApplicationShutdown(signal?: string) {
        lifecycleEvents.push(`beforeApplicationShutdown:${signal ?? "none"}`);
      }
      onApplicationShutdown(signal?: string) {
        lifecycleEvents.push(`onApplicationShutdown:${signal ?? "none"}`);
      }
    }

    @Controller("/shutdown")
    class ShutdownController {
      @Get()
      ping() {
        return { ok: true };
      }
    }

    @Module({
      controllers: [ShutdownController],
      providers: [ResourceHolder],
    })
    class ShutdownModule {}

    const app = await BunestFactory.create(ShutdownModule, { logger: false });
    const info = await app.listen({ hostname: "127.0.0.1", port: 0 });
    expect((await fetch(`${info.url}/shutdown`)).status).toBe(200);

    await app.close("SIGTERM");

    expect(app.getUrl()).toBeUndefined();
    expect(lifecycleEvents).toEqual([
      "onModuleDestroy",
      "beforeApplicationShutdown:SIGTERM",
      "onApplicationShutdown:SIGTERM",
    ]);
  });
});
