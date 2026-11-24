import { describe, expect, it } from "bun:test";
import {
  APP_GUARD,
  Controller,
  Get,
  Injectable,
  Module,
  TooManyRequestsException,
  type ExecutionContext,
} from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  DEFAULT_IPV6_SUBNET_PREFIX,
  DEFAULT_SWEEP_INTERVAL,
  InjectThrottlerOptions,
  InjectThrottlerStorage,
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
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerOptionsFactory,
} from "../src";

describe("@nestjs/throttler v6.8 Parity (Helpers, IPv6 /64, DI, Protected Guard Hooks)", () => {
  it("exports accurate time helper functions and constants", () => {
    expect(seconds(5)).toBe(5_000);
    expect(minutes(2)).toBe(120_000);
    expect(hours(1)).toBe(3_600_000);
    expect(days(1)).toBe(86_400_000);
    expect(weeks(1)).toBe(604_800_000);
    expect(DEFAULT_IPV6_SUBNET_PREFIX).toBe(64);
    expect(DEFAULT_SWEEP_INTERVAL).toBe(60_000);
    expect(throttlerMessage).toBe("ThrottlerException: Too Many Requests");

    const err = new ThrottlerException();
    expect(err).toBeInstanceOf(ThrottlerException);
    expect(err).toBeInstanceOf(TooManyRequestsException);
    expect(err.getStatus()).toBe(429);
    expect(err.message).toBe(throttlerMessage);
  });

  it("normalizes IPv4, IPv6 loopback, IPv4-mapped IPv6, NAT64, zone IDs, and masks IPv6 /64 subnets", () => {
    // IPv4 unchanged
    expect(normalizeIp("203.0.113.42")).toBe("203.0.113.42");

    // Loopback canonicalized
    expect(normalizeIp("::1")).toBe("::1");
    expect(normalizeIp("0:0:0:0:0:0:0:1")).toBe("::1");

    // IPv4-mapped IPv6 unwrapped to IPv4
    expect(normalizeIp("::ffff:192.0.2.128")).toBe("192.0.2.128");
    expect(normalizeIp("::ffff:c000:0280")).toBe("192.0.2.128");
    expect(normalizeIp("0:0:0:0:0:ffff:192.0.2.128")).toBe("192.0.2.128");

    // NAT64 well-known prefix unwrapped to IPv4
    expect(normalizeIp("64:ff9b::192.0.2.33")).toBe("192.0.2.33");

    // IPv6 /64 rotation bypass protection: distinct hosts in same /64 map to identical key
    const hostA = normalizeIp("2001:db8:abcd:0012:1111:2222:3333:4444");
    const hostB = normalizeIp("2001:db8:abcd:0012:ffff:eeee:dddd:cccc");
    expect(hostA).toBe("2001:db8:abcd:12::/64");
    expect(hostB).toBe("2001:db8:abcd:12::/64");

    // Zone ID stripped
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80::/64");

    // Custom subnet prefix (/48, /128, clamped out-of-range)
    expect(normalizeIp("2001:db8:abcd:0012::1", 48)).toBe("2001:db8:abcd::/48");
    expect(normalizeIp("2001:db8::1", 128)).toBe("2001:db8::1/128");
    expect(normalizeIp("2001:db8::1", 999)).toBe("2001:db8::1/128");
    expect(normalizeIp("2001:db8::1", -5)).toBe("::/0");

    // Non-IP strings returned unchanged
    expect(normalizeIp("")).toBe("");
    expect(normalizeIp("tenant:acme")).toBe("tenant:acme");
    expect(normalizeIp("999.0.0.1")).toBe("999.0.0.1");
    expect(normalizeIp("1:2:3:4:5:6:7::8")).toBe("1:2:3:4:5:6:7::8");
  });

  it("prevents IPv6 /64 rotation bypass, respects ignoreUserAgents, dynamic Resolvable limits, and function errorMessage", async () => {
    @Controller("/v6")
    class V6Controller {
      @Get("ping")
      ping() {
        return { ok: true };
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          ignoreUserAgents: [/HealthProbe/gi],
          ipv6SubnetPrefix: 64,
          errorMessage: (_ctx, detail) =>
            `Rate limit (${detail.limit}) exceeded for ${detail.tracker}`,
          throttlers: [
            {
              name: "default",
              ttl: () => seconds(5),
              limit: (ctx) => {
                const req = ctx.switchToHttp().getRequest<Request>();
                return req.headers.get("x-tier") === "pro" ? 3 : 1;
              },
            },
          ],
        }),
      ],
      controllers: [V6Controller],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();

    const client = mod.createTestClient();
    try {
      // Request 1 from IPv6 host A passes
      const r1 = await client.get("/v6/ping", {
        headers: { "x-forwarded-for": "2001:db8:cafe:0001::1001" },
      });
      expect(r1.status).toBe(200);

      // Request 2 from DIFFERENT IPv6 host B in the SAME /64 subnet is BLOCKED!
      const r2 = await client.get("/v6/ping", {
        headers: { "x-forwarded-for": "2001:db8:cafe:0001::9999" },
      });
      expect(r2.status).toBe(429);
      const body2 = await r2.json<{ message: string }>();
      expect(body2.message).toBe(
        "Rate limit (1) exceeded for 2001:db8:cafe:1::/64",
      );

      // Matching ignoreUserAgents bypasses throttling (tested twice to verify /g regex reset)
      for (let i = 0; i < 3; i++) {
        const probe = await client.get("/v6/ping", {
          headers: {
            "x-forwarded-for": "2001:db8:cafe:0001::aaaa",
            "user-agent": "HealthProbe/2.0",
          },
        });
        expect(probe.status).toBe(200);
      }

      // Dynamic Resolvable limit increases to 3 for x-tier: pro on another subnet
      for (let i = 0; i < 3; i++) {
        expect(
          (
            await client.get("/v6/ping", {
              headers: {
                "x-forwarded-for": "2001:db8:beef:0002::1",
                "x-tier": "pro",
              },
            })
          ).status,
        ).toBe(200);
      }
      expect(
        (
          await client.get("/v6/ping", {
            headers: {
              "x-forwarded-for": "2001:db8:beef:0002::2",
              "x-tier": "pro",
            },
          })
        ).status,
      ).toBe(429);
    } finally {
      await mod.close();
    }
  });

  it("supports custom ThrottlerGuard subclasses overriding protected hooks and array-shorthand ThrottlerModule.forRoot([...])", async () => {
    const capturedDetails: ThrottlerLimitDetail[] = [];

    @Injectable()
    class TenantThrottlerGuard extends ThrottlerGuard {
      protected override async shouldSkip(
        context: ExecutionContext,
      ): Promise<boolean> {
        const req = context.switchToHttp().getRequest<Request>();
        return req.headers.get("x-skip-throttle") === "yes";
      }

      protected override async getTracker(
        req: Record<string, any>,
      ): Promise<string> {
        const tenant =
          typeof req.headers?.get === "function"
            ? req.headers.get("x-tenant")
            : undefined;
        return tenant ?? (await super.getTracker(req));
      }

      protected override generateKey(
        context: ExecutionContext,
        suffix: string,
        name: string,
      ): string {
        return `custom:${name}:${context.getHandler().name}:${suffix}`;
      }

      protected override async throwThrottlingException(
        context: ExecutionContext,
        detail: ThrottlerLimitDetail,
      ): Promise<void> {
        capturedDetails.push(detail);
        throw new ThrottlerException(`Tenant ${detail.tracker} throttled`);
      }
    }

    @Controller("/tenant-rate")
    class TenantController {
      @Get("data")
      data() {
        return { data: 1 };
      }
    }

    // Array shorthand forRoot([{ ttl, limit }])
    const mod = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: seconds(10), limit: 1 }])],
      controllers: [TenantController],
      providers: [{ provide: APP_GUARD, useClass: TenantThrottlerGuard }],
    }).compile();

    const client = mod.createTestClient();
    try {
      // Tenant A: 1st succeeds, 2nd triggers custom throwThrottlingException
      expect(
        (
          await client.get("/tenant-rate/data", {
            headers: { "x-tenant": "acme" },
          })
        ).status,
      ).toBe(200);
      const blocked = await client.get("/tenant-rate/data", {
        headers: { "x-tenant": "acme" },
      });
      expect(blocked.status).toBe(429);
      expect((await blocked.json<{ message: string }>()).message).toBe(
        "Tenant acme throttled",
      );
      expect(capturedDetails.length).toBe(1);
      expect(capturedDetails[0]?.key).toBe("custom:default:data:acme");
      expect(capturedDetails[0]?.tracker).toBe("acme");

      // Tenant B has independent bucket
      expect(
        (
          await client.get("/tenant-rate/data", {
            headers: { "x-tenant": "beta" },
          })
        ).status,
      ).toBe(200);

      // shouldSkip hook bypasses even for already-throttled Tenant A
      expect(
        (
          await client.get("/tenant-rate/data", {
            headers: { "x-tenant": "acme", "x-skip-throttle": "yes" },
          })
        ).status,
      ).toBe(200);
    } finally {
      await mod.close();
    }
  });

  it("supports ThrottlerStorageService, InjectThrottlerOptions/Storage, and forRootAsync with useClass/useExisting", async () => {
    const storageSvc = new ThrottlerStorageService(0);
    const rec = storageSvc.increment("k-inspect", 5000, 2, 0, "short");
    expect(rec.totalHits).toBe(1);
    expect(storageSvc.storage.get("k-inspect")?.totalHits.get("short")).toBe(1);
    storageSvc.onApplicationShutdown();
    expect(storageSvc.storage.size).toBe(0);

    @Injectable()
    class ThrottlerConfigFactory implements ThrottlerOptionsFactory {
      createThrottlerOptions(): ThrottlerModuleOptions {
        return [{ name: "api", ttl: minutes(1), limit: 5 }];
      }
    }

    @Injectable()
    class ThrottlerInspector {
      constructor(
        @InjectThrottlerOptions() public readonly opts: ThrottlerModuleOptions,
        @InjectThrottlerStorage() public readonly storage: ThrottlerStorage,
      ) {}
    }

    const modClass = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRootAsync({
          useClass: ThrottlerConfigFactory,
        }),
      ],
      providers: [ThrottlerInspector],
    }).compile();

    const inspector = modClass.get(ThrottlerInspector);
    expect(Array.isArray(inspector.opts)).toBe(true);
    expect(inspector.storage).toBe(modClass.get(getStorageToken()));
    expect(modClass.get(getOptionsToken())).toBe(inspector.opts);
    expect(modClass.get(ThrottlerStorage)).toBe(inspector.storage);
    await modClass.close();

    @Module({
      providers: [ThrottlerConfigFactory],
      exports: [ThrottlerConfigFactory],
    })
    class SharedThrottlerCfgModule {}

    const modExisting = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRootAsync({
          imports: [SharedThrottlerCfgModule],
          useExisting: ThrottlerConfigFactory,
        }),
      ],
    }).compile();

    expect(Array.isArray(modExisting.get(getOptionsToken()))).toBe(true);
    await modExisting.close();
  });

  it("isolates per-request X-RateLimit-* header state across concurrent async requests on singleton ThrottlerGuard", async () => {
    const counts = new Map<string, number>();
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const delayedStorage: ThrottlerStorage = {
      async increment(key, ttl) {
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        if (key.includes("slow-user")) {
          await slowGate;
        }
        return {
          totalHits: next,
          timeToExpire: ttl,
          isBlocked: false,
          timeToBlockExpire: 0,
        };
      },
    };

    const guard = new ThrottlerGuard(
      {
        throttlers: [
          { name: "short", ttl: 10_000, limit: 10 },
          { name: "long", ttl: 60_000, limit: 100 },
        ],
        getTracker: (req) => String(req.headers["x-user"]),
      },
      delayedStorage,
    );
    await guard.onModuleInit();

    const makeCtx = (user: string) => {
      const headersOut: Record<string, string> = {};
      const res = {
        header(name: string, value: string) {
          headersOut[name] = value;
        },
      };
      const req = { headers: { "x-user": user } };
      const ctx = {
        getHandler: () => function endpoint() {},
        getClass: () => class TestCtrl {},
        switchToHttp: () => ({
          getRequest: () => req,
          getResponse: () => res,
        }),
      } as unknown as ExecutionContext;
      return { ctx, headersOut };
    };

    // Pre-consume 5 hits for fast-user so fast-user has remaining=4 on next hit, while slow-user has remaining=9
    for (let i = 0; i < 5; i++) {
      await guard.canActivate(makeCtx("fast-user").ctx);
    }

    const slow = makeCtx("slow-user");
    const fast = makeCtx("fast-user");

    // Start slow-user (pauses inside async storage.increment)
    const slowPromise = guard.canActivate(slow.ctx);
    // Run fast-user to completion while slow-user is still mid-flight!
    expect(await guard.canActivate(fast.ctx)).toBe(true);
    // Now let slow-user finish
    releaseSlow();
    expect(await slowPromise).toBe(true);

    // Neither request clobbered the other's primary X-RateLimit-Remaining header!
    expect(fast.headersOut["X-RateLimit-Remaining"]).toBe("4");
    expect(slow.headersOut["X-RateLimit-Remaining"]).toBe("9");
  });
});
