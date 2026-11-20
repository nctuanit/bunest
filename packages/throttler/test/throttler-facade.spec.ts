import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { APP_GUARD, Controller, Get, Injectable } from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  DEFAULT_IPV6_SUBNET_PREFIX,
  DEFAULT_SWEEP_INTERVAL,
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  MemoryThrottlerStorage,
  SkipThrottle,
  Throttle,
  ThrottlerException,
  ThrottlerGuard,
  ThrottlerModule,
  ThrottlerStorage,
  ThrottlerStorageService,
  days,
  getOptionsToken,
  getStorageToken,
  hours,
  minutes,
  normalizeIp,
  seconds,
  throttlerMessage,
  weeks,
  type ThrottlerAsyncOptions,
  type ThrottlerModuleOptions,
  type ThrottlerOptionsFactory,
} from "../src";

describe("@bunest/throttler drop-in facade (@nestjs/throttler v6.8 parity)", () => {
  it("exports all 20 @nestjs/throttler@6.8.0 runtime values and helpers", () => {
    expect(DEFAULT_IPV6_SUBNET_PREFIX).toBe(64);
    expect(DEFAULT_SWEEP_INTERVAL).toBe(60_000);
    expect(seconds(3)).toBe(3_000);
    expect(minutes(1)).toBe(60_000);
    expect(hours(1)).toBe(3_600_000);
    expect(days(1)).toBe(86_400_000);
    expect(weeks(1)).toBe(604_800_000);
    expect(normalizeIp("2001:db8:abcd:0001::1234")).toBe("2001:db8:abcd:1::/64");
    expect(throttlerMessage).toBe("ThrottlerException: Too Many Requests");
    expect(new ThrottlerException().getStatus()).toBe(429);
    expect(typeof getOptionsToken()).toBe("symbol");
    expect(getStorageToken()).toBe(ThrottlerStorage);
    expect(typeof InjectThrottlerOptions).toBe("function");
    expect(typeof InjectThrottlerStorage).toBe("function");
    expect(typeof Throttle).toBe("function");
    expect(typeof SkipThrottle).toBe("function");
    expect(ThrottlerGuard).toBeDefined();
    expect(ThrottlerModule).toBeDefined();
    expect(ThrottlerStorageService).toBeDefined();
    expect(MemoryThrottlerStorage).toBeDefined();
  });

  it("enforces @Throttle, @SkipThrottle, and ThrottlerGuard via ThrottlerModule.forRoot()", async () => {
    @Controller("/rate")
    class RateController {
      @Get("limited")
      @Throttle({ default: { ttl: seconds(10), limit: 2 } })
      limited() {
        return { ok: true };
      }

      @Get("open")
      @SkipThrottle()
      open() {
        return { open: true };
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          { name: "default", ttl: seconds(10), limit: 2 },
        ]),
      ],
      controllers: [RateController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();

    const client = mod.createTestClient();
    try {
      const headers = { "x-forwarded-for": "198.51.100.10" };
      expect((await client.get("/rate/limited", { headers })).status).toBe(200);
      expect((await client.get("/rate/limited", { headers })).status).toBe(200);
      expect((await client.get("/rate/limited", { headers })).status).toBe(429);

      // @SkipThrottle bypasses limit
      expect((await client.get("/rate/open", { headers })).status).toBe(200);
    } finally {
      await mod.close();
    }
  });

  it("supports ThrottlerModule.forRootAsync() with @InjectThrottlerOptions and @InjectThrottlerStorage", async () => {
    @Injectable()
    class ThrottlerFactory implements ThrottlerOptionsFactory {
      createThrottlerOptions(): ThrottlerModuleOptions {
        return [{ ttl: minutes(1), limit: 10 }];
      }
    }

    @Injectable()
    class Inspector {
      constructor(
        @InjectThrottlerOptions() public readonly options: ThrottlerModuleOptions,
        @InjectThrottlerStorage() public readonly storage: ThrottlerStorage,
      ) {}
    }

    const asyncOpts: ThrottlerAsyncOptions = { useClass: ThrottlerFactory };
    const mod = await Test.createTestingModule({
      imports: [ThrottlerModule.forRootAsync(asyncOpts)],
      providers: [Inspector],
    }).compile();

    try {
      const inspector = mod.get(Inspector);
      expect(Array.isArray(inspector.options)).toBe(true);
      expect(typeof inspector.storage.increment).toBe("function");
    } finally {
      await mod.close();
    }
  });
});
