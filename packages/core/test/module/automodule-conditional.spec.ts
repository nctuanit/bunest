import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  DecoratorRegistry,
  ensureDir,
  join,
  removePath,
  type DecoratorRegistrySnapshot,
} from "../../src/common/index";
import {
  AutoModule,
  BunestFactory,
  Controller,
  Get,
  Inject,
  Injectable,
  InvalidExportException,
  Module,
  Profile,
  RegisterIf,
  RegisterIfEnv,
  RegisterIfMissing,
  evaluateProviderConditions,
  getProviderConditions,
  resolveActiveProfiles,
  type InjectionToken,
} from "../../src";

const TEST_ENV_KEYS = [
  "BUNEST_TEST_FEATURE_FLAG",
  "BUNEST_TEST_CACHE_DRIVER",
  "BUNEST_TEST_REDIS_URL",
  "BUNEST_PROFILES",
  "BUNEST_PROFILE",
  "NODE_ENV",
] as const;

describe("Smart @AutoModule (Glob Scan + Static Manifest) & Conditional Beans (@RegisterIf*, @Profile)", () => {
  let savedSnapshot: DecoratorRegistrySnapshot;
  const savedEnv = new Map<string, string | undefined>();
  const tempDirs: string[] = [];

  beforeEach(() => {
    savedSnapshot = DecoratorRegistry.snapshot();
    DecoratorRegistry.clear();
    savedEnv.clear();
    for (const key of TEST_ENV_KEYS) {
      savedEnv.set(key, Bun.env[key]);
      delete Bun.env[key];
    }
  });

  afterEach(async () => {
    DecoratorRegistry.restore(savedSnapshot);
    for (const [key, val] of savedEnv.entries()) {
      if (val === undefined) {
        delete Bun.env[key];
      } else {
        Bun.env[key] = val;
      }
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      await removePath(dir, { recursive: true, force: true });
    }
  });

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = join(
      "/tmp",
      `bunest-${prefix}-${crypto.randomUUID()}`,
    );
    await ensureDir(dir, { recursive: true });
    tempDirs.push(dir);
    return dir;
  }

  describe("Conditional decorators unit helpers", () => {
    it("evaluates @RegisterIf, @RegisterIfEnv, @Profile, and @RegisterIfMissing via evaluateProviderConditions", () => {
      const CACHE_TOKEN = Symbol("CACHE_TOKEN");

      @RegisterIf((ctx) => ctx.env.MODE === "fast" && ctx.target === FastBean)
      @RegisterIfEnv("API_KEY")
      @RegisterIfEnv("REGION", /^us-(east|west)-\d$/)
      @RegisterIfEnv("TIER", (v) => v === "pro" || v === "enterprise")
      @Profile("production", "!canary")
      @RegisterIfMissing(CACHE_TOKEN)
      class FastBean {}

      expect(getProviderConditions(FastBean)).toHaveLength(6);

      const passingCtx = {
        env: {
          MODE: "fast",
          API_KEY: "secret",
          REGION: "us-east-1",
          TIER: "pro",
        },
        profiles: new Set(["production"]),
        registeredTokens: new Set<InjectionToken>(),
      };
      expect(evaluateProviderConditions(FastBean, passingCtx)).toBe(true);

      // Fails when negated profile is active
      expect(
        evaluateProviderConditions(FastBean, {
          ...passingCtx,
          profiles: new Set(["production", "canary"]),
        }),
      ).toBe(false);

      // Fails when required env var is empty
      expect(
        evaluateProviderConditions(FastBean, {
          ...passingCtx,
          env: { ...passingCtx.env, API_KEY: "" },
        }),
      ).toBe(false);

      // Fails when regex env matcher does not match
      expect(
        evaluateProviderConditions(FastBean, {
          ...passingCtx,
          env: { ...passingCtx.env, REGION: "eu-central-1" },
        }),
      ).toBe(false);

      // Fails when token is already registered
      expect(
        evaluateProviderConditions(FastBean, {
          ...passingCtx,
          registeredTokens: new Set([CACHE_TOKEN]),
        }),
      ).toBe(false);
    });

    it("resolves active profiles with strict precedence: options > AutoModule > BUNEST_PROFILES > BUNEST_PROFILE > NODE_ENV", () => {
      expect([
        ...resolveActiveProfiles({
          explicitProfiles: ["custom"],
          moduleProfiles: ["module-prof"],
          env: {
            BUNEST_PROFILES: "env-a,env-b",
            BUNEST_PROFILE: "env-single",
            NODE_ENV: "production",
          },
        }),
      ]).toEqual(["custom"]);

      expect([
        ...resolveActiveProfiles({
          moduleProfiles: ["staging", "metrics"],
          env: { BUNEST_PROFILES: "env-a", NODE_ENV: "production" },
        }),
      ]).toEqual(["staging", "metrics"]);

      expect([
        ...resolveActiveProfiles({
          env: {
            BUNEST_PROFILES: " prod , tracing ",
            BUNEST_PROFILE: "ignored",
            NODE_ENV: "test",
          },
        }),
      ]).toEqual(["prod", "tracing"]);

      expect([
        ...resolveActiveProfiles({
          env: { BUNEST_PROFILE: "staging", NODE_ENV: "test" },
        }),
      ]).toEqual(["staging"]);

      expect([
        ...resolveActiveProfiles({
          env: { NODE_ENV: "development" },
        }),
      ]).toEqual(["development"]);
    });
  });

  describe("Conditional Beans in ModuleScanner & BunestFactory", () => {
    it("evaluates @Profile, @RegisterIfEnv, and @RegisterIf on providers and controllers across passes", async () => {
      Bun.env.BUNEST_TEST_FEATURE_FLAG = "enabled";
      Bun.env.BUNEST_TEST_CACHE_DRIVER = "redis-v7";

      @Injectable()
      @Profile("production")
      class ProdOnlyService {
        readonly env = "prod";
      }

      @Injectable()
      @Profile("!test")
      class NonTestService {
        readonly active = true;
      }

      @Injectable()
      @RegisterIfEnv("BUNEST_TEST_FEATURE_FLAG", "enabled")
      class FlaggedService {
        readonly enabled = true;
      }

      @Injectable()
      @RegisterIfEnv("BUNEST_TEST_CACHE_DRIVER", /^redis-/)
      class RegexEnvService {
        readonly driver = "redis";
      }

      @Injectable()
      @RegisterIfEnv("BUNEST_TEST_REDIS_URL")
      class MissingEnvService {
        readonly active = true;
      }

      @Injectable()
      @RegisterIf((ctx) => ctx.profiles.has("production"))
      class PredicateProdService {
        readonly matched = true;
      }

      @Controller("debug")
      @Profile("development", "staging")
      class DebugController {
        @Get()
        info() {
          return { debug: true };
        }
      }

      @Controller("status")
      @Profile("!test")
      class StatusController {
        @Get()
        ok() {
          return { ok: true };
        }
      }

      @Module({
        controllers: [DebugController, StatusController],
        providers: [
          ProdOnlyService,
          NonTestService,
          FlaggedService,
          RegexEnvService,
          MissingEnvService,
          PredicateProdService,
        ],
        // Exporting conditionally skipped providers must not fail bootstrap
        exports: [ProdOnlyService, MissingEnvService, FlaggedService],
      })
      class ConditionalAppModule {}

      // 1. Production profile
      const prodApp = await BunestFactory.create(ConditionalAppModule, {
        logger: false,
        profiles: ["production"],
      });
      try {
        expect(prodApp.get(ProdOnlyService).env).toBe("prod");
        expect(prodApp.get(NonTestService).active).toBe(true);
        expect(prodApp.get(FlaggedService).enabled).toBe(true);
        expect(prodApp.get(RegexEnvService).driver).toBe("redis");
        expect(prodApp.get(PredicateProdService).matched).toBe(true);
        expect(() => prodApp.get(MissingEnvService)).toThrow();

        expect((await prodApp.inject("/status")).statusCode).toBe(200);
        expect((await prodApp.inject("/debug")).statusCode).toBe(404);
      } finally {
        await prodApp.close();
      }

      // 2. Test profile (excludes @Profile("!test") and @Profile("production"))
      const testApp = await BunestFactory.create(ConditionalAppModule, {
        logger: false,
        profiles: ["test"],
      });
      try {
        expect(() => testApp.get(ProdOnlyService)).toThrow();
        expect(() => testApp.get(NonTestService)).toThrow();
        expect(() => testApp.get(PredicateProdService)).toThrow();
        expect(testApp.get(FlaggedService).enabled).toBe(true);
        expect((await testApp.inject("/status")).statusCode).toBe(404);
        expect((await testApp.inject("/debug")).statusCode).toBe(404);
      } finally {
        await testApp.close();
      }

      // 3. Staging profile enables DebugController & StatusController
      const stagingApp = await BunestFactory.create(ConditionalAppModule, {
        logger: false,
        profiles: ["staging"],
      });
      try {
        expect((await stagingApp.inject("/debug")).json()).toEqual({
          debug: true,
        });
        expect((await stagingApp.inject("/status")).json()).toEqual({
          ok: true,
        });
      } finally {
        await stagingApp.close();
      }
    });

    it("evaluates @RegisterIfMissing in pass 2 so fallback beans yield to unconditional, imported, or earlier providers", async () => {
      abstract class CacheStore {
        abstract kind(): string;
      }

      @Injectable()
      @RegisterIfMissing(CacheStore)
      class InMemoryCacheStore extends CacheStore {
        kind() {
          return "memory";
        }
      }

      @Injectable()
      @RegisterIfMissing(CacheStore)
      class SecondaryFallbackCacheStore extends CacheStore {
        kind() {
          return "secondary-fallback";
        }
      }

      @Injectable()
      class RedisCacheStore extends CacheStore {
        kind() {
          return "redis";
        }
      }

      @Injectable()
      @RegisterIfMissing()
      class DefaultMailer {
        readonly provider = "smtp-default";
      }

      // Case 1: Fallback listed BEFORE unconditional override -> override wins without DuplicateProviderException!
      @Module({
        providers: [
          { provide: CacheStore, useClass: InMemoryCacheStore },
          { provide: CacheStore, useClass: RedisCacheStore },
          DefaultMailer,
          { provide: DefaultMailer, useValue: { provider: "mock-mailer" } },
        ],
      })
      class OverrideWinsModule {}

      const ctx1 = await BunestFactory.createApplicationContext(
        OverrideWinsModule,
        { logger: false },
      );
      try {
        expect(ctx1.get(CacheStore).kind()).toBe("redis");
        expect(ctx1.get(DefaultMailer).provider).toBe("mock-mailer");
      } finally {
        await ctx1.close();
      }

      // Case 2: No unconditional override -> first @RegisterIfMissing wins, second cleanly yields!
      @Module({
        providers: [
          { provide: CacheStore, useClass: InMemoryCacheStore },
          { provide: CacheStore, useClass: SecondaryFallbackCacheStore },
          DefaultMailer,
        ],
      })
      class FallbackActiveModule {}

      const ctx2 = await BunestFactory.createApplicationContext(
        FallbackActiveModule,
        { logger: false },
      );
      try {
        expect(ctx2.get(CacheStore).kind()).toBe("memory");
        expect(ctx2.get(DefaultMailer).provider).toBe("smtp-default");
      } finally {
        await ctx2.close();
      }

      // Case 3: Override exported by an imported module -> local fallback yields!
      @Module({
        providers: [{ provide: CacheStore, useClass: RedisCacheStore }],
        exports: [CacheStore],
      })
      class RedisCacheModule {}

      @Module({
        imports: [RedisCacheModule],
        providers: [{ provide: CacheStore, useClass: InMemoryCacheStore }],
      })
      class ImportedOverrideModule {}

      const ctx3 = await BunestFactory.createApplicationContext(
        ImportedOverrideModule,
        { logger: false },
      );
      try {
        expect(ctx3.get(CacheStore).kind()).toBe("redis");
      } finally {
        await ctx3.close();
      }

      // Case 4: Still throws InvalidExportException for genuinely undeclared export tokens
      const NEVER_DECLARED = Symbol("NEVER_DECLARED");
      @Module({
        exports: [NEVER_DECLARED],
      })
      class BrokenExportModule {}

      await expect(
        BunestFactory.createApplicationContext(BrokenExportModule, {
          logger: false,
        }),
      ).rejects.toThrow(InvalidExportException);
    });

    it("resolves profiles from BUNEST_PROFILES and NODE_ENV when options.profiles is omitted", async () => {
      @Injectable()
      @Profile("analytics")
      class AnalyticsService {
        readonly ok = true;
      }

      @Injectable()
      @Profile("staging")
      class StagingService {
        readonly ok = true;
      }

      @Module({ providers: [AnalyticsService, StagingService] })
      class EnvProfileModule {}

      Bun.env.BUNEST_PROFILES = "web, analytics";
      const ctxA = await BunestFactory.createApplicationContext(
        EnvProfileModule,
        { logger: false },
      );
      try {
        expect(ctxA.get(AnalyticsService).ok).toBe(true);
        expect(() => ctxA.get(StagingService)).toThrow();
      } finally {
        await ctxA.close();
      }

      delete Bun.env.BUNEST_PROFILES;
      Bun.env.NODE_ENV = "staging";
      const ctxB = await BunestFactory.createApplicationContext(
        EnvProfileModule,
        { logger: false },
      );
      try {
        expect(() => ctxB.get(AnalyticsService)).toThrow();
        expect(ctxB.get(StagingService).ok).toBe(true);
      } finally {
        await ctxB.close();
      }
    });
  });

  describe("Smart @AutoModule (Bun.Glob scan, exclude, filter, profiles & static manifest)", () => {
    it("scans files via Bun.Glob, excludes spec/test/d.ts by default, applies filter & profiles, and never leaks unrelated globals", async () => {
      const rootDir = await makeTempDir("automodule-scan");
      const coreSrcEntry = join(import.meta.dir, "..", "..", "src", "index.ts");

      await ensureDir(join(rootDir, "features", "orders"), { recursive: true });
      await ensureDir(join(rootDir, "features", "legacy"), { recursive: true });

      await Bun.write(
        join(rootDir, "features", "orders", "orders.service.ts"),
        `
import { Injectable } from ${JSON.stringify(coreSrcEntry)};

@Injectable()
export class ScannedOrdersService {
  getSummary() {
    return "orders-ok";
  }
}

@Injectable()
export class InternalSkippedService {
  readonly skipped = true;
}
`,
      );

      await Bun.write(
        join(rootDir, "features", "orders", "orders.controller.ts"),
        `
import { Controller, Get } from ${JSON.stringify(coreSrcEntry)};
import { ScannedOrdersService } from "./orders.service";

@Controller("scanned-orders")
export class ScannedOrdersController {
  constructor(private readonly orders: ScannedOrdersService) {}

  @Get()
  index() {
    return { summary: this.orders.getSummary() };
  }
}
`,
      );

      await Bun.write(
        join(rootDir, "features", "orders", "orders.conditional.ts"),
        `
import { Injectable, Profile, RegisterIfMissing } from ${JSON.stringify(coreSrcEntry)};

export const SCANNED_STORE_TOKEN = Symbol.for("bunest:test:scanned_store");

@Injectable()
@Profile("eu")
export class EuComplianceService {
  readonly region = "eu";
}

@Injectable()
@Profile("us")
export class UsComplianceService {
  readonly region = "us";
}

@Injectable()
@RegisterIfMissing(SCANNED_STORE_TOKEN)
export class FallbackScannedStore {
  readonly source = "fallback";
}
`,
      );

      // Default excluded files: .spec.ts, .test.ts, .d.ts (would throw if imported!)
      await Bun.write(
        join(rootDir, "features", "orders", "orders.spec.ts"),
        `throw new Error("spec file must not be imported by @AutoModule scan!");`,
      );
      await Bun.write(
        join(rootDir, "features", "orders", "orders.test.ts"),
        `throw new Error("test file must not be imported by @AutoModule scan!");`,
      );
      await Bun.write(
        join(rootDir, "features", "orders", "orders.d.ts"),
        `export type OrderId = string;`,
      );

      // Custom excluded legacy directory
      await Bun.write(
        join(rootDir, "features", "legacy", "old.service.ts"),
        `throw new Error("legacy file must be excluded!");`,
      );

      // Register unrelated global classes in DecoratorRegistry BEFORE creating the app
      @Injectable()
      class RogueGlobalService {
        readonly rogue = true;
      }

      @Controller("rogue-global")
      class RogueGlobalController {
        @Get()
        leak() {
          return { leaked: true };
        }
      }
      expect(DecoratorRegistry.getControllers()).toContain(
        RogueGlobalController,
      );
      expect(DecoratorRegistry.getInjectables()).toContain(RogueGlobalService);

      const SCANNED_STORE_TOKEN = Symbol.for("bunest:test:scanned_store");

      @AutoModule({
        scan: "./features/**/*.ts",
        cwd: rootDir,
        exclude: [
          "**/*.spec.ts",
          "**/*.test.ts",
          "**/*.d.ts",
          "**/legacy/**",
        ],
        filter: (target) => !target.name.startsWith("Internal"),
        profiles: ["eu"],
        providers: [
          {
            provide: SCANNED_STORE_TOKEN,
            useValue: { source: "explicit-override" },
          },
        ],
      })
      class ScannedRootModule {}

      const app = await BunestFactory.create(ScannedRootModule, {
        logger: false,
      });
      try {
        // Scanned controller & service are active
        const res = await app.inject("/scanned-orders");
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ summary: "orders-ok" });

        // Unrelated global controller/service did NOT leak into the scanned module!
        expect((await app.inject("/rogue-global")).statusCode).toBe(404);
        expect(() => app.get(RogueGlobalService)).toThrow();

        // Import the fixture classes to inspect container resolution directly
        const ordersSvcMod = await import(
          join(rootDir, "features", "orders", "orders.service.ts")
        );
        const condMod = await import(
          join(rootDir, "features", "orders", "orders.conditional.ts")
        );

        expect(
          app
            .get<{ getSummary(): string }>(ordersSvcMod.ScannedOrdersService)
            .getSummary(),
        ).toBe("orders-ok");
        // Filtered out by `filter`
        expect(() => app.get(ordersSvcMod.InternalSkippedService)).toThrow();

        // @AutoModule({ profiles: ["eu"] }) activated EuComplianceService and skipped UsComplianceService
        expect(
          app.get<{ readonly region: string }>(condMod.EuComplianceService)
            .region,
        ).toBe("eu");
        expect(() => app.get(condMod.UsComplianceService)).toThrow();

        // @RegisterIfMissing(SCANNED_STORE_TOKEN) yielded to explicit override
        expect(app.get(SCANNED_STORE_TOKEN)).toEqual({
          source: "explicit-override",
        });
        expect(() => app.get(condMod.FallbackScannedStore)).toThrow();
      } finally {
        await app.close();
      }
    });

    it("supports static build-time manifest (taking precedence over scan) and BunestFactory.createAuto({ manifest, scan })", async () => {
      @Injectable()
      class ManifestGreeterService {
        hello(who: string) {
          return `manifest:${who}`;
        }
      }

      @Controller("manifest")
      class ManifestGreeterController {
        constructor(
          @Inject(ManifestGreeterService)
          private readonly greeter: ManifestGreeterService,
        ) {}

        @Get("ping")
        ping() {
          return { msg: this.greeter.hello("bunest") };
        }
      }

      @Injectable()
      class UnrelatedGlobalBean {}

      // Manifest takes precedence over `scan` even when `scan` points to a non-existent dir
      // (the exact behavior needed for `bun build --compile` single-file executables!)
      const app = await BunestFactory.createAuto({
        logger: false,
        scan: "./does-not-exist-in-compiled-binary/**/*.ts",
        cwd: "/tmp/bunest-nonexistent-dir-12345",
        manifest: [
          async () => ({ ManifestGreeterService }),
          async () => ({ ManifestGreeterController }),
        ],
      });
      try {
        const res = await app.inject("/manifest/ping");
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ msg: "manifest:bunest" });
        expect(app.get(ManifestGreeterService)).toBeInstanceOf(
          ManifestGreeterService,
        );
        // Unrelated global bean did NOT leak!
        expect(() => app.get(UnrelatedGlobalBean)).toThrow();
      } finally {
        await app.close();
      }
    });

    it("applies default exclude (**/*.spec.ts, **/*.test.ts, **/*.d.ts) automatically via BunestFactory.createAuto({ scan }) and activates @RegisterIfMissing when unoverridden", async () => {
      const rootDir = await makeTempDir("automodule-default-exclude");
      const coreSrcEntry = join(import.meta.dir, "..", "..", "src", "index.ts");

      await Bun.write(
        join(rootDir, "default-cache.service.ts"),
        `
import { Injectable, RegisterIfMissing } from ${JSON.stringify(coreSrcEntry)};

export const DEFAULT_ONLY_TOKEN = Symbol.for("bunest:test:default_only_token");

@Injectable()
@RegisterIfMissing(DEFAULT_ONLY_TOKEN)
export class FallbackMemoryService {
  readonly kind = "fallback-memory";
}
`,
      );
      await Bun.write(
        join(rootDir, "ping.controller.ts"),
        `
import { Controller, Get } from ${JSON.stringify(coreSrcEntry)};
import { FallbackMemoryService } from "./default-cache.service";

@Controller("default-scan")
export class DefaultScanController {
  constructor(private readonly fallback: FallbackMemoryService) {}

  @Get()
  check() {
    return { kind: this.fallback.kind };
  }
}
`,
      );
      // Should be skipped automatically by default excludes!
      await Bun.write(
        join(rootDir, "broken.spec.ts"),
        `throw new Error("default exclude must skip *.spec.ts");`,
      );
      await Bun.write(
        join(rootDir, "broken.test.ts"),
        `throw new Error("default exclude must skip *.test.ts");`,
      );
      await Bun.write(
        join(rootDir, "types.d.ts"),
        `export interface SampleType { id: string }`,
      );

      const app = await BunestFactory.createAuto({
        logger: false,
        scan: "**/*.ts",
        cwd: rootDir,
      });
      try {
        const res = await app.inject("/default-scan");
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ kind: "fallback-memory" });
      } finally {
        await app.close();
      }
    });

    it("preserves 100% backward-compatible zero-arg @AutoModule() behavior while respecting @Profile and @RegisterIf*", async () => {
      @Injectable()
      @Profile("active-prof")
      class ActiveAutoService {
        readonly name = "active";
      }

      @Injectable()
      @Profile("inactive-prof")
      class InactiveAutoService {
        readonly name = "inactive";
      }

      @Controller("zero-arg-auto")
      class ZeroArgAutoController {
        constructor(private readonly svc: ActiveAutoService) {}

        @Get()
        get() {
          return { name: this.svc.name };
        }
      }

      @AutoModule()
      class LegacyAutoModule {}

      const app = await BunestFactory.create(LegacyAutoModule, {
        logger: false,
        profiles: ["active-prof"],
      });
      try {
        const res = await app.inject("/zero-arg-auto");
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ name: "active" });
        expect(app.get(ActiveAutoService).name).toBe("active");
        expect(() => app.get(InactiveAutoService)).toThrow();
      } finally {
        await app.close();
      }
    });
  });
});
