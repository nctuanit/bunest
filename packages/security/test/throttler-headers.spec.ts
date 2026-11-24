import { describe, expect, it } from "bun:test";
import {
  APP_GUARD,
  Controller,
  Get,
  Module,
  type BunestModule,
  type MiddlewareConsumer,
} from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  MemoryThrottlerStorage,
  SECURITY_HEADERS_OPTIONS,
  SecurityHeadersMiddleware,
  SkipThrottle,
  Throttle,
  ThrottlerGuard,
  ThrottlerModule,
  createSecurityHeadersMiddleware,
} from "../src";

describe("ThrottlerModule / ThrottlerGuard & SecurityHeadersMiddleware", () => {
  it("enforces rate limits with X-RateLimit-* & Retry-After headers, @Throttle overrides, @SkipThrottle, and sliding window reset", async () => {
    @Controller("/rate")
    class RateController {
      @Get("default")
      defaultRoute() {
        return { ok: true };
      }

      @Throttle({ short: { limit: 1, ttl: 80 } })
      @Get("strict")
      strictRoute() {
        return { strict: true };
      }

      @SkipThrottle()
      @Get("unlimited")
      unlimitedRoute() {
        return { unlimited: true };
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [
            { name: "short", ttl: 100, limit: 2 },
            { name: "long", ttl: 60_000, limit: 100 },
          ],
        }),
      ],
      controllers: [RateController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();

    const client = moduleRef.createTestClient();

    try {
      // Request 1 & 2 pass with decreasing X-RateLimit-Remaining
      const r1 = await client.get("/rate/default");
      expect(r1.status).toBe(200);
      expect(r1.headers.get("x-ratelimit-limit")).toBe("2");
      expect(r1.headers.get("x-ratelimit-remaining")).toBe("1");
      expect(r1.headers.get("x-ratelimit-reset")).toBeTruthy();

      const r2 = await client.get("/rate/default");
      expect(r2.status).toBe(200);
      expect(r2.headers.get("x-ratelimit-remaining")).toBe("0");

      // Request 3 hits 429 with Retry-After and X-RateLimit-Remaining: 0
      const r3 = await client.get("/rate/default");
      expect(r3.status).toBe(429);
      expect(r3.headers.get("x-ratelimit-remaining")).toBe("0");
      expect(Number(r3.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);

      // @Throttle({ short: { limit: 1, ttl: 80 } }) triggers 429 on 2nd request
      expect((await client.get("/rate/strict")).status).toBe(200);
      expect((await client.get("/rate/strict")).status).toBe(429);

      // @SkipThrottle() never triggers 429
      for (let i = 0; i < 5; i++) {
        expect((await client.get("/rate/unlimited")).status).toBe(200);
      }

      // After sliding window TTL passes, requests succeed again
      await Bun.sleep(115);
      const r4 = await client.get("/rate/default");
      expect(r4.status).toBe(200);
      expect(r4.headers.get("x-ratelimit-remaining")).toBe("1");
    } finally {
      await moduleRef.close();
    }
  });

  it("supports ThrottlerModule.forRootAsync and MemoryThrottlerStorage blockDuration + sweepExpired", async () => {
    const storage = new MemoryThrottlerStorage(0);
    const first = storage.increment("k1", 50, 1, 120);
    expect(first.totalHits).toBe(1);
    expect(first.isBlocked).toBe(false);

    const blocked = storage.increment("k1", 50, 1, 120);
    expect(blocked.isBlocked).toBe(true);
    expect(blocked.timeToBlockExpire).toBe(120);

    storage.reset("k1");
    expect(storage.increment("k1", 50, 1).totalHits).toBe(1);
    storage.sweepExpired(Date.now() + 1000);
    storage.onModuleDestroy();

    // Regression: rejected 429 hits MUST NOT pollute sliding window after allowed hits expire
    const slideStorage = new MemoryThrottlerStorage(0);
    expect(slideStorage.increment("slide-k", 100, 2).totalHits).toBe(1);
    expect(slideStorage.increment("slide-k", 100, 2).totalHits).toBe(2);
    await Bun.sleep(60);
    // Two rejected hits at t=60ms MUST NOT extend window past t=100ms
    expect(slideStorage.increment("slide-k", 100, 2).totalHits).toBe(3);
    expect(slideStorage.increment("slide-k", 100, 2).totalHits).toBe(3);
    await Bun.sleep(55); // t=115ms -> original t=0 hits have expired
    expect(slideStorage.increment("slide-k", 100, 2).totalHits).toBe(1);
    slideStorage.onModuleDestroy();

    @Controller("/async-rate")
    class AsyncRateCtrl {
      @Get()
      ping() {
        return "ok";
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRootAsync({
          useFactory: async () => ({
            throttlers: [{ ttl: 1000, limit: 1 }],
          }),
        }),
      ],
      controllers: [AsyncRateCtrl],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();

    const client = mod.createTestClient();
    expect((await client.get("/async-rate")).status).toBe(200);
    expect((await client.get("/async-rate")).status).toBe(429);
    await mod.close();
  });

  it("applies default and custom security headers via SecurityHeadersMiddleware and createSecurityHeadersMiddleware", async () => {
    @Controller("/headers")
    class HeadersController {
      @Get()
      ping() {
        return { secure: true };
      }
    }

    @Module({
      controllers: [HeadersController],
      providers: [
        {
          provide: SECURITY_HEADERS_OPTIONS,
          useValue: {
            contentSecurityPolicy: {
              "default-src": ["'self'"],
              "img-src": ["'self'", "data:"],
            },
            strictTransportSecurity: {
              maxAge: 31536000,
              includeSubDomains: true,
              preload: true,
            },
            permissionsPolicy: "geolocation=()",
          },
        },
        SecurityHeadersMiddleware,
      ],
    })
    class HeadersAppModule implements BunestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(SecurityHeadersMiddleware).forRoutes(HeadersController);
      }
    }

    const mod = await Test.createTestingModule({
      imports: [HeadersAppModule],
    }).compile();

    const client = mod.createTestClient();
    try {
      const res = await client.get("/headers");
      expect(res.status).toBe(200);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(res.headers.get("cross-origin-resource-policy")).toBe(
        "same-origin",
      );
      expect(res.headers.get("x-dns-prefetch-control")).toBe("off");
      expect(res.headers.get("content-security-policy")).toBe(
        "default-src 'self'; img-src 'self' data:",
      );
      expect(res.headers.get("strict-transport-security")).toBe(
        "max-age=31536000; includeSubDomains; preload",
      );
      expect(res.headers.get("permissions-policy")).toBe("geolocation=()");
    } finally {
      await mod.close();
    }

    // Functional middleware helper
    const fnMod = await Test.createTestingModule({
      controllers: [HeadersController],
    }).compile();
    const app = fnMod.createBunestApplication();
    app.use(createSecurityHeadersMiddleware({ frameOptions: "SAMEORIGIN" }));
    const fnClient = fnMod.createTestClient(app);
    try {
      const res = await fnClient.get("/headers");
      expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      await fnMod.close();
    }
  });
});
