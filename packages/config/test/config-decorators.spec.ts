import "reflect-metadata";
import { describe, expect, test } from "bun:test";
import { Injectable, Module, Scope } from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import {
  ConfigModule,
  ConfigService,
  ConfigValue,
  InjectConfig,
  registerAs,
} from "../src";

describe("@bunest/config @InjectConfig & @ConfigValue Decorators", () => {
  test("@InjectConfig injects namespaces, flat keys, dot-paths, and distinct defaultValues on constructor parameters and properties", async () => {
    const dbConfig = registerAs("database", () => ({
      host: "db.internal",
      port: 5432,
      pool: { max: 20 },
    }));

    const featureCacheConfig = registerAs("featureCache", () => ({
      ttl: 600,
    }));

    @Injectable()
    class ServiceA {
      constructor(
        @InjectConfig("database")
        public readonly db: { host: string; port: number; pool: { max: number } },
        @InjectConfig("APP_NAME")
        public readonly appName: string,
        @InjectConfig("database.pool.max")
        public readonly maxPool: number,
        @InjectConfig("MISSING_PORT", 3000)
        public readonly port: number,
        @InjectConfig(featureCacheConfig)
        public readonly cacheCfg: { ttl: number },
      ) {}

      @InjectConfig("MAIL_HOST", "smtp.local")
      public readonly mailHost!: string;

      @InjectConfig("database.host", "localhost")
      public readonly dbHost!: string;
    }

    @Injectable()
    class ServiceB {
      constructor(
        // Different defaultValue for the SAME missing key MUST NOT collide with ServiceA!
        @InjectConfig("MISSING_PORT", 8080)
        public readonly port: number,
        @InjectConfig("APP_NAME", "fallback-app")
        public readonly appName: string,
      ) {}
    }

    @Module({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          envSource: {
            APP_NAME: "bunest-shop",
          },
          load: [dbConfig],
        }),
        ConfigModule.forFeature(featureCacheConfig),
      ],
      providers: [ServiceA, ServiceB],
    })
    class AppModule {}

    const ctx = await BunestFactory.createApplicationContext(AppModule, {
      logger: false,
    });

    try {
      const a = ctx.get(ServiceA);
      const b = ctx.get(ServiceB);

      expect(a.db).toEqual({
        host: "db.internal",
        port: 5432,
        pool: { max: 20 },
      });
      expect(a.appName).toBe("bunest-shop");
      expect(a.maxPool).toBe(20);
      expect(a.port).toBe(3000);
      expect(a.cacheCfg).toEqual({ ttl: 600 });
      expect(a.mailHost).toBe("smtp.local");
      expect(a.dbHost).toBe("db.internal");

      // ServiceB gets its own default (8080) and existing env value ("bunest-shop")
      expect(b.port).toBe(8080);
      expect(b.appName).toBe("bunest-shop");
    } finally {
      await ctx.close();
    }
  });

  test("@InjectConfig works even when ConfigModule.forRoot() is evaluated before the consumer class is declared", async () => {
    const prebuiltConfigModule = ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      envSource: { LATE_KEY: "late-value" },
    });

    @Injectable()
    class LateBoundService {
      constructor(
        @InjectConfig("LATE_KEY", "default")
        public readonly lateVal: string,
        @InjectConfig("UNSET_LATE_KEY", "late-fallback")
        public readonly fallbackVal: string,
      ) {}
    }

    @Module({
      imports: [prebuiltConfigModule],
      providers: [LateBoundService],
    })
    class LateAppModule {}

    const ctx = await BunestFactory.createApplicationContext(LateAppModule, {
      logger: false,
    });

    try {
      const svc = ctx.get(LateBoundService);
      expect(svc.lateVal).toBe("late-value");
      expect(svc.fallbackVal).toBe("late-fallback");
    } finally {
      await ctx.close();
    }
  });

  test("@ConfigValue binds live ConfigService values (flat, dot-path, defaults, live set() updates, inheritance, TRANSIENT scope, and plain new)", async () => {
    const dbConfig = registerAs("db", () => ({
      host: "pg.local",
      port: 5432,
    }));

    class BaseConfigConsumer {
      @ConfigValue("BASE_FLAG", false)
      readonly baseFlag!: boolean;
    }

    @Injectable({ scope: Scope.TRANSIENT })
    class LiveConfigService extends BaseConfigConsumer {
      @ConfigValue("APP_ENV", "development")
      readonly env!: string;

      @ConfigValue("db.host")
      readonly dbHost!: string;

      @ConfigValue("db.timeout", 5000)
      timeout?: number;

      @ConfigValue("OPTIONAL_WITH_INIT")
      retries = 3;
    }

    // Plain unit-test instantiation without DI returns defaults cleanly
    const standalone = new LiveConfigService();
    expect(standalone.env).toBe("development");
    expect(standalone.baseFlag).toBe(false);
    expect(standalone.dbHost).toBeUndefined();

    @Module({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          envSource: {
            APP_ENV: "production",
            BASE_FLAG: "true",
          },
          load: [dbConfig],
        }),
      ],
      providers: [LiveConfigService],
    })
    class AppModule {}

    const ctx = await BunestFactory.createApplicationContext(AppModule, {
      logger: false,
    });

    try {
      const config = ctx.get(ConfigService);
      const svc1 = await ctx.resolve(LiveConfigService);
      const svc2 = await ctx.resolve(LiveConfigService);

      expect(svc1).not.toBe(svc2);
      expect(svc1.env).toBe("production");
      expect(svc1.baseFlag).toBe("true" as unknown as boolean);
      expect(svc1.dbHost).toBe("pg.local");
      expect(svc1.timeout).toBe(5000);
      expect(svc1.retries).toBe(3);

      // Live updates via ConfigService.set() immediately reflect through @ConfigValue getters!
      config.set("APP_ENV", "staging");
      config.set("db.host", "pg.replica");
      config.set("OPTIONAL_WITH_INIT", 9);

      expect(svc1.env).toBe("staging");
      expect(svc2.env).toBe("staging");
      expect(svc1.dbHost).toBe("pg.replica");
      expect(svc1.retries).toBe(9);
    } finally {
      await ctx.close();
    }
  });
});
