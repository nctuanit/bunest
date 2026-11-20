import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Injectable,
  InternalServerErrorException,
  Module,
  Param,
  Post,
  Put,
  Redirect,
  Res,
  Sse,
  StreamableFile,
  type ResponseContext,
} from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  IdempotencyEvents,
  IdempotencyModule,
  IdempotencyStorage,
  IdempotencyStoreTimeoutError,
  Idempotent,
  InMemoryIdempotencyStore,
  type IdempotencyAcquireResult,
  type IdempotencyEvent,
  type IdempotencyModuleOptions,
  type IdempotencyOptionsFactory,
  type IdempotencyStore,
  type IdempotencyStoredPayload,
} from "../src/index";

describe("HTTP E2E via BunestFactory & app.inject()", () => {
  it("executes once and replays stored body, status, and headers with Idempotent-Replayed: true", async () => {
    let calls = 0;

    @Controller("payments")
    class PaymentsController {
      @Post()
      @Idempotent()
      @Header("Location", "/payments/static-loc")
      create(@Body() body: { amount: number }, @Res() res: ResponseContext) {
        calls++;
        res.header("ETag", `"v${calls}"`);
        res.header("X-Trace", `trace-${calls}`);
        return { receiptId: `rcpt_${calls}`, amount: body.amount };
      }

      @Post("accepted")
      @HttpCode(202)
      @Idempotent()
      accepted(@Body() body: { task: string }) {
        calls++;
        return { queued: true, task: body.task, run: calls };
      }

      @Post("redirect")
      @Redirect("/done", 303)
      @Idempotent()
      redirectRoute() {
        calls++;
        return { url: `/done/${calls}`, statusCode: 303 };
      }
    }

    @Module({
      imports: [
        IdempotencyModule.forRoot({
          replayHeaders: ["x-trace"],
        }),
      ],
      controllers: [PaymentsController],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    const events = app.get(IdempotencyEvents);
    const seenEvents: IdempotencyEvent[] = [];
    events.events$.subscribe((e) => seenEvents.push(e));

    // 1. First request runs handler
    const r1 = await app.inject({
      method: "POST",
      url: "/payments",
      headers: { "Idempotency-Key": "pay-1" },
      payload: { amount: 100 },
    });
    expect(r1.statusCode).toBe(201);
    expect(r1.json()).toEqual({ receiptId: "rcpt_1", amount: 100 });
    expect(r1.headers["idempotent-replayed"]).toBeUndefined();
    expect(r1.headers["etag"]).toBe('"v1"');
    expect(r1.headers["x-trace"]).toBe("trace-1");
    expect(r1.headers["location"]).toBe("/payments/static-loc");
    expect(calls).toBe(1);

    // 2. Retry with same key & semantically identical payload (quoted sf-string accepted)
    const r2 = await app.inject({
      method: "POST",
      url: "/payments",
      headers: { "Idempotency-Key": '"pay-1"' },
      payload: { amount: 100 },
    });
    expect(r2.statusCode).toBe(201);
    expect(r2.json()).toEqual({ receiptId: "rcpt_1", amount: 100 });
    expect(r2.headers["idempotent-replayed"]).toBe("true");
    expect(r2.headers["etag"]).toBe('"v1"');
    expect(r2.headers["x-trace"]).toBe("trace-1");
    expect(r2.headers["location"]).toBe("/payments/static-loc");
    expect(calls).toBe(1);

    // 3. @HttpCode(202) replay preserves status 202
    const a1 = await app.inject({
      method: "POST",
      url: "/payments/accepted",
      headers: { "Idempotency-Key": "acc-1" },
      payload: { task: "sync" },
    });
    expect(a1.statusCode).toBe(202);
    const a2 = await app.inject({
      method: "POST",
      url: "/payments/accepted",
      headers: { "Idempotency-Key": "acc-1" },
      payload: { task: "sync" },
    });
    expect(a2.statusCode).toBe(202);
    expect(a2.headers["idempotent-replayed"]).toBe("true");
    expect(a2.json()).toEqual(a1.json());

    // 4. @Redirect() captures and replays status & Location
    const red1 = await app.inject({
      method: "POST",
      url: "/payments/redirect",
      headers: { "Idempotency-Key": "red-1" },
    });
    expect(red1.statusCode).toBe(303);
    expect(red1.headers["location"]).toBe("/done/3");
    const red2 = await app.inject({
      method: "POST",
      url: "/payments/redirect",
      headers: { "Idempotency-Key": "red-1" },
    });
    expect(red2.statusCode).toBe(303);
    expect(red2.headers["location"]).toBe("/done/3");
    expect(red2.headers["idempotent-replayed"]).toBe("true");

    // 5. Missing key passes through when required: false
    const noKey1 = await app.inject({
      method: "POST",
      url: "/payments",
      payload: { amount: 50 },
    });
    const noKey2 = await app.inject({
      method: "POST",
      url: "/payments",
      payload: { amount: 50 },
    });
    expect(noKey1.json<{ receiptId: string }>().receiptId).not.toBe(
      noKey2.json<{ receiptId: string }>().receiptId,
    );

    expect(seenEvents.filter((e) => e.type === "replayed")).toHaveLength(3);
    await app.close();
  });

  it("enforces required keys (400), key validation (400), and fingerprint mismatch (422)", async () => {
    let calls = 0;

    @Controller("orders")
    class OrdersController {
      @Post(":id/refund")
      @Idempotent({ required: true })
      refund(@Param("id") id: string, @Body() body: { amount: number; reason?: string }) {
        calls++;
        return { orderId: id, amount: body.amount, calls };
      }

      @Post("custom-fp")
      @Idempotent({
        required: true,
        fingerprint: (payload: { amount: number; timestamp?: number }) => ({
          amount: payload?.amount,
        }),
      })
      customFp(@Body() body: { amount: number; timestamp?: number }) {
        calls++;
        return { amount: body.amount, calls };
      }
    }

    @Module({
      imports: [IdempotencyModule.forRoot()],
      controllers: [OrdersController],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });

    // Missing required key -> 400 IDEMPOTENCY_KEY_REQUIRED
    const missing = await app.inject({
      method: "POST",
      url: "/orders/1/refund",
      payload: { amount: 10 },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json<{ code: string }>().code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    // Invalid key (too long / non-printable) -> 400 IDEMPOTENCY_KEY_INVALID
    const tooLong = await app.inject({
      method: "POST",
      url: "/orders/1/refund",
      headers: { "Idempotency-Key": "a".repeat(256) },
      payload: { amount: 10 },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json<{ code: string }>().code).toBe("IDEMPOTENCY_KEY_INVALID");

    const nonAscii = await app.inject({
      method: "POST",
      url: "/orders/1/refund",
      headers: { "Idempotency-Key": "key-\u00e9" },
      payload: { amount: 10 },
    });
    expect(nonAscii.statusCode).toBe(400);
    expect(nonAscii.json<{ code: string }>().code).toBe("IDEMPOTENCY_KEY_INVALID");

    // First valid call
    const ok = await app.inject({
      method: "POST",
      url: "/orders/1/refund",
      headers: { "Idempotency-Key": "ref-1" },
      body: JSON.stringify({ b: 2, amount: 10 }),
    });
    // Wait: set content-type application/json properly
    const okJson = await app.inject({
      method: "POST",
      url: "/orders/1/refund",
      headers: { "Idempotency-Key": "ref-json-1" },
      payload: { reason: "dup", amount: 10 },
    });
    expect(okJson.statusCode).toBe(201);
    expect(ok.statusCode).toBe(201);

    // Same key with reordered JSON keys -> replay!
    const reordered = await app.inject({
      method: "POST",
      url: "/orders/1/refund",
      headers: {
        "Idempotency-Key": "ref-json-1",
        "content-type": "application/json",
      },
      body: '{"amount":10,"reason":"dup"}',
    });
    expect(reordered.statusCode).toBe(201);
    expect(reordered.headers["idempotent-replayed"]).toBe("true");

    // Same key with different body -> 422 IDEMPOTENCY_KEY_REUSED
    const diffBody = await app.inject({
      method: "POST",
      url: "/orders/1/refund",
      headers: { "Idempotency-Key": "ref-json-1" },
      payload: { reason: "dup", amount: 99 },
    });
    expect(diffBody.statusCode).toBe(422);
    expect(diffBody.json<{ code: string }>().code).toBe("IDEMPOTENCY_KEY_REUSED");

    // Same key with different URL -> 422 IDEMPOTENCY_KEY_REUSED
    const diffUrl = await app.inject({
      method: "POST",
      url: "/orders/2/refund",
      headers: { "Idempotency-Key": "ref-json-1" },
      payload: { reason: "dup", amount: 10 },
    });
    expect(diffUrl.statusCode).toBe(422);
    expect(diffUrl.json<{ code: string }>().code).toBe("IDEMPOTENCY_KEY_REUSED");

    // Custom fingerprint ignores timestamp
    const fp1 = await app.inject({
      method: "POST",
      url: "/orders/custom-fp",
      headers: { "Idempotency-Key": "fp-key" },
      payload: { amount: 50, timestamp: 111 },
    });
    const fp2 = await app.inject({
      method: "POST",
      url: "/orders/custom-fp",
      headers: { "Idempotency-Key": "fp-key" },
      payload: { amount: 50, timestamp: 999 },
    });
    expect(fp2.headers["idempotent-replayed"]).toBe("true");
    expect(fp2.json()).toEqual(fp1.json());

    await app.close();
  });

  it("returns 409 IDEMPOTENCY_KEY_IN_USE + Retry-After for concurrent in-flight requests and renews locks", async () => {
    let releaseHandler!: () => void;
    const gate = new Promise<void>((r) => {
      releaseHandler = r;
    });
    let calls = 0;

    @Controller("slow")
    class SlowController {
      @Post()
      @Idempotent({ lockTtl: "60ms", retryAfter: "2500ms" })
      async process(@Body() body: { id: string }) {
        calls++;
        await gate;
        return { processed: body.id, calls };
      }
    }

    @Module({
      imports: [IdempotencyModule.forRoot()],
      controllers: [SlowController],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });

    const firstPromise = app.inject({
      method: "POST",
      url: "/slow",
      headers: { "Idempotency-Key": "slow-1" },
      payload: { id: "job-1" },
    });

    // Wait longer than lockTtl (60ms) to verify heartbeat extend() keeps lock alive!
    await new Promise((r) => setTimeout(r, 110));

    const conflict = await app.inject({
      method: "POST",
      url: "/slow",
      headers: { "Idempotency-Key": "slow-1" },
      payload: { id: "job-1" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ code: string }>().code).toBe("IDEMPOTENCY_KEY_IN_USE");
    expect(conflict.headers["retry-after"]).toBe("3"); // ceil(2500/1000)

    releaseHandler();
    const first = await firstPromise;
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ processed: "job-1", calls: 1 });

    // Now replay succeeds
    const replayed = await app.inject({
      method: "POST",
      url: "/slow",
      headers: { "Idempotency-Key": "slow-1" },
      payload: { id: "job-1" },
    });
    expect(replayed.statusCode).toBe(201);
    expect(replayed.headers["idempotent-replayed"]).toBe("true");
    expect(replayed.json()).toEqual({ processed: "job-1", calls: 1 });
    expect(calls).toBe(1);

    await app.close();
  });

  it("handles 4xx replay vs 5xx release, class-level @Idempotent(), and per-user scopes", async () => {
    let getCalls = 0;
    let putCalls = 0;
    let errCalls = 0;
    let fail500Calls = 0;

    @Controller("items")
    @Idempotent({ scope: (req: Request) => req.headers.get("x-user-id") })
    class ItemsController {
      @Get()
      list() {
        getCalls++;
        return { getCalls };
      }

      @Put()
      update(@Body() body: { name: string }) {
        putCalls++;
        return { name: body.name, putCalls };
      }

      @Post("bad")
      bad() {
        errCalls++;
        throw new BadRequestException(`bad-${errCalls}`);
      }

      @Post("crash")
      crash() {
        fail500Calls++;
        if (fail500Calls === 1) {
          throw new InternalServerErrorException("temporary failure");
        }
        return { recovered: true, attempt: fail500Calls };
      }
    }

    @Module({
      imports: [IdempotencyModule.forRoot()],
      controllers: [ItemsController],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });

    // GET is safe -> class-level @Idempotent() does NOT intercept it
    const g1 = await app.inject({
      method: "GET",
      url: "/items",
      headers: { "Idempotency-Key": "g-1" },
    });
    const g2 = await app.inject({
      method: "GET",
      url: "/items",
      headers: { "Idempotency-Key": "g-1" },
    });
    expect(g1.json<{ getCalls: number }>().getCalls).toBe(1);
    expect(g2.json<{ getCalls: number }>().getCalls).toBe(2);

    // PUT is covered by class-level @Idempotent() + scoped by x-user-id
    const u1a = await app.inject({
      method: "PUT",
      url: "/items",
      headers: { "Idempotency-Key": "same-key", "x-user-id": "alice" },
      payload: { name: "alice-item" },
    });
    const u2a = await app.inject({
      method: "PUT",
      url: "/items",
      headers: { "Idempotency-Key": "same-key", "x-user-id": "bob" },
      payload: { name: "bob-item" },
    });
    expect(u1a.json()).toEqual({ name: "alice-item", putCalls: 1 });
    expect(u2a.json()).toEqual({ name: "bob-item", putCalls: 2 });

    const u1b = await app.inject({
      method: "PUT",
      url: "/items",
      headers: { "Idempotency-Key": "same-key", "x-user-id": "alice" },
      payload: { name: "alice-item" },
    });
    expect(u1b.headers["idempotent-replayed"]).toBe("true");
    expect(u1b.json()).toEqual({ name: "alice-item", putCalls: 1 });

    // 4xx error is stored and replayed with Idempotent-Replayed: true
    const bad1 = await app.inject({
      method: "POST",
      url: "/items/bad",
      headers: { "Idempotency-Key": "bad-1" },
    });
    const bad2 = await app.inject({
      method: "POST",
      url: "/items/bad",
      headers: { "Idempotency-Key": "bad-1" },
    });
    expect(bad1.statusCode).toBe(400);
    expect(bad2.statusCode).toBe(400);
    expect(bad2.headers["idempotent-replayed"]).toBe("true");
    expect(bad2.json<{ message: string }>().message).toBe("bad-1");
    expect(errCalls).toBe(1);

    // 5xx error releases key so retry runs handler again and succeeds
    const c1 = await app.inject({
      method: "POST",
      url: "/items/crash",
      headers: { "Idempotency-Key": "crash-1" },
    });
    expect(c1.statusCode).toBe(500);
    const c2 = await app.inject({
      method: "POST",
      url: "/items/crash",
      headers: { "Idempotency-Key": "crash-1" },
    });
    expect(c2.statusCode).toBe(201);
    expect(c2.json()).toEqual({ recovered: true, attempt: 2 });

    await app.close();
  });

  it("seals records at rest with AES-256-GCM encryption and fails closed on tampered records", async () => {
    const rawStore = new InMemoryIdempotencyStore();
    const key = randomBytes(32);

    @Injectable()
    class CustomStoreProvider implements IdempotencyStore {
      constructor(storage: IdempotencyStorage) {
        storage.registerSource(this);
      }
      acquire(k: string, o: string, fp: string, ttl: number) {
        return rawStore.acquire(k, o, fp, ttl);
      }
      complete(k: string, o: string, r: IdempotencyStoredPayload, ttl: number) {
        return rawStore.complete(k, o, r, ttl);
      }
      release(k: string, o: string) {
        return rawStore.release(k, o);
      }
      extend(k: string, o: string, ttl: number) {
        return rawStore.extend(k, o, ttl);
      }
    }

    @Controller("secrets")
    class SecretsController {
      @Post()
      @Idempotent()
      issue() {
        return { secret: "top-secret-token" };
      }
    }

    @Module({
      imports: [
        IdempotencyModule.forRoot({
          encryption: { keys: [key] },
        }),
      ],
      controllers: [SecretsController],
      providers: [CustomStoreProvider],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });

    const r1 = await app.inject({
      method: "POST",
      url: "/secrets",
      headers: { "Idempotency-Key": "sec-1" },
    });
    expect(r1.statusCode).toBe(201);
    expect(r1.json()).toEqual({ secret: "top-secret-token" });

    // Verify stored payload is encrypted (sealed) and plaintext is not present
    const entry = rawStore.peek("sec-1");
    expect(entry?.state).toBe("completed");
    if (entry?.state === "completed") {
      expect("sealed" in entry.response).toBe(true);
      expect(JSON.stringify(entry.response)).not.toContain("top-secret-token");
    }

    // Replay decrypts transparently
    const r2 = await app.inject({
      method: "POST",
      url: "/secrets",
      headers: { "Idempotency-Key": "sec-1" },
    });
    expect(r2.statusCode).toBe(201);
    expect(r2.headers["idempotent-replayed"]).toBe("true");
    expect(r2.json()).toEqual({ secret: "top-secret-token" });

    // Tamper with stored sealed envelope -> fails closed with 500 IDEMPOTENCY_RECORD_UNREADABLE
    const acquired = await rawStore.acquire("sec-2", "o1", "fp", 10_000);
    expect(acquired.state).toBe("acquired");
    await rawStore.complete(
      "sec-2",
      "o1",
      { sealed: "v1.badkeyid.aaaa.bbbb.cccc" },
      10_000,
    );
    // Replace fingerprint on sec-1 directly by using a second corrupted entry via tampering entry in-place?
    // Even simpler: replace entry in rawStore via clear + re-seed with exact matching fingerprint from sec-1!
    const validEntry = rawStore.peek("sec-1");
    if (validEntry?.state === "completed") {
      rawStore.clear();
      await rawStore.acquire("sec-1", "tamper", validEntry.fingerprint, 10_000);
      await rawStore.complete(
        "sec-1",
        "tamper",
        { sealed: "v1.tampered.aaaa.bbbb.cccc" },
        10_000,
      );
    }

    const r3 = await app.inject({
      method: "POST",
      url: "/secrets",
      headers: { "Idempotency-Key": "sec-1" },
    });
    expect(r3.statusCode).toBe(500);
    expect(r3.json<{ code: string }>().code).toBe(
      "IDEMPOTENCY_RECORD_UNREADABLE",
    );

    await app.close();
  });

  it("supports forRootAsync (useFactory, useClass, useExisting), StreamableFile release, @Sse passthrough, and storeTimeout", async () => {
    const CONFIG_TOKEN = "CUSTOM_IDEM_CONFIG";

    @Injectable()
    class OptionsFactory implements IdempotencyOptionsFactory {
      createIdempotencyOptions(): IdempotencyModuleOptions {
        return { header: "X-Custom-Key", required: true };
      }
    }

    @Controller("async")
    class AsyncController {
      @Post("echo")
      @Idempotent()
      echo(@Body() body: { v: number }) {
        return { v: body.v };
      }

      @Post("file")
      @Idempotent()
      file() {
        return new StreamableFile(Buffer.from("binary-data"));
      }

      @Sse("stream")
      @Idempotent()
      async *stream() {
        yield { data: "hello" };
      }
    }

    // Test useClass
    @Module({
      imports: [
        IdempotencyModule.forRootAsync({
          useClass: OptionsFactory,
        }),
      ],
      controllers: [AsyncController],
    })
    class UseClassAppModule {}

    const app1 = await BunestFactory.create(UseClassAppModule, { logger: false });
    const missing = await app1.inject({
      method: "POST",
      url: "/async/echo",
      payload: { v: 1 },
    });
    expect(missing.statusCode).toBe(400);

    const ok1 = await app1.inject({
      method: "POST",
      url: "/async/echo",
      headers: { "X-Custom-Key": "k-async" },
      payload: { v: 7 },
    });
    expect(ok1.statusCode).toBe(201);

    const ok2 = await app1.inject({
      method: "POST",
      url: "/async/echo",
      headers: { "X-Custom-Key": "k-async" },
      payload: { v: 7 },
    });
    expect(ok2.headers["idempotent-replayed"]).toBe("true");
    expect(ok2.json()).toEqual({ v: 7 });

    // StreamableFile releases key cleanly without corrupting response
    const fileRes = await app1.inject({
      method: "POST",
      url: "/async/file",
      headers: { "X-Custom-Key": "file-1" },
    });
    expect(fileRes.statusCode).toBe(201);
    expect(fileRes.body).toBe("binary-data");

    // @Sse passes through untouched
    const sseRes = await app1.inject({
      method: "GET",
      url: "/async/stream",
    });
    expect(sseRes.statusCode).toBe(200);
    expect(sseRes.body).toContain("data: hello");

    await app1.close();

    // Test useFactory + hanging store -> IdempotencyStoreTimeoutError
    @Injectable()
    class HangingStore implements IdempotencyStore {
      constructor(storage: IdempotencyStorage) {
        storage.registerSource(this);
      }
      acquire(): Promise<IdempotencyAcquireResult> {
        return new Promise(() => {});
      }
      complete(): Promise<boolean> {
        return Promise.resolve(false);
      }
      release(): Promise<boolean> {
        return Promise.resolve(true);
      }
      extend(): Promise<boolean> {
        return Promise.resolve(false);
      }
    }

    @Module({
      providers: [{ provide: CONFIG_TOKEN, useValue: { storeTimeout: "25ms" } }],
      exports: [CONFIG_TOKEN],
    })
    class ConfigMod {}

    @Module({
      imports: [
        IdempotencyModule.forRootAsync({
          imports: [ConfigMod],
          inject: [CONFIG_TOKEN],
          useFactory: (cfg: IdempotencyModuleOptions) => cfg,
        }),
      ],
      controllers: [AsyncController],
      providers: [HangingStore],
    })
    class TimeoutAppModule {}

    const app2 = await BunestFactory.create(TimeoutAppModule, { logger: false });
    const timedOut = await app2.inject({
      method: "POST",
      url: "/async/echo",
      headers: { "Idempotency-Key": "hang-1" },
      payload: { v: 1 },
    });
    expect(timedOut.statusCode).toBe(500);
    await app2.close();
  });

  it("rejects forbidden replayHeaders and misconfigured options at startup", async () => {
    @Module({
      imports: [
        IdempotencyModule.forRoot({
          replayHeaders: ["set-cookie"],
        }),
      ],
    })
    class BadHeadersModule {}

    await expect(
      BunestFactory.create(BadHeadersModule, { logger: false }),
    ).rejects.toThrow(/set-cookie/);

    // Verify IdempotencyStoreTimeoutError is exported and constructible
    expect(new IdempotencyStoreTimeoutError("complete", 100).method).toBe(
      "complete",
    );
  });

  it("supports forRootAsync({ useExisting }) and emits lock-lost events when store loses the lock", async () => {
    @Injectable()
    class SharedOptionsFactory implements IdempotencyOptionsFactory {
      createIdempotencyOptions(): IdempotencyModuleOptions {
        return { lockTtl: "30ms", maxLockHold: "60ms" };
      }
    }

    @Module({
      providers: [SharedOptionsFactory],
      exports: [SharedOptionsFactory],
    })
    class SharedConfigModule {}

    const backing = new InMemoryIdempotencyStore();

    @Injectable()
    class DroppingStore implements IdempotencyStore {
      constructor(storage: IdempotencyStorage) {
        storage.registerSource(this);
      }
      acquire(k: string, o: string, fp: string, ttl: number) {
        return backing.acquire(k, o, fp, ttl);
      }
      complete(k: string, o: string, r: IdempotencyStoredPayload, ttl: number) {
        return backing.complete(k, o, r, ttl);
      }
      release(k: string, o: string) {
        return backing.release(k, o);
      }
      extend() {
        // Simulate lost lock on heartbeat
        return Promise.resolve(false);
      }
    }

    @Controller("lock-test")
    class LockController {
      @Post()
      @Idempotent()
      async work() {
        await new Promise((r) => setTimeout(r, 40));
        return { ok: true };
      }
    }

    @Module({
      imports: [
        IdempotencyModule.forRootAsync({
          imports: [SharedConfigModule],
          useExisting: SharedOptionsFactory,
        }),
      ],
      controllers: [LockController],
      providers: [DroppingStore],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    const events = app.get(IdempotencyEvents);
    const lockLost: IdempotencyEvent[] = [];
    events.events$.subscribe((ev) => {
      if (ev.type === "lock-lost") {
        lockLost.push(ev);
      }
    });

    const res = await app.inject({
      method: "POST",
      url: "/lock-test",
      headers: { "Idempotency-Key": "drop-1" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true });
    expect(lockLost).toHaveLength(1);
    expect(lockLost[0]).toMatchObject({
      type: "lock-lost",
      phase: "extend",
      context: "http",
      key: "drop-1",
    });

    await app.close();
  });
});
