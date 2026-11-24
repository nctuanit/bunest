import { afterEach, describe, expect, it } from "bun:test";
import {
  Inject,
  Injectable,
  join,
  mkdirSyncPath,
  Module,
  removePath,
  writeTextSync,
  type StandardSchemaV1,
} from "../../src/common/index";
import { BunestFactory } from "../../src/index";
import {
  ConditionalModule,
  ConfigModule,
  ConfigService,
  getConfigToken,
  getDefaultParser,
  registerAs,
  type ConfigChangeEvent,
  type ConfigGetOptions,
  type ConfigType,
  type NoInferType,
  type Parser,
  type Path,
  type PathImpl,
  type PathImpl2,
  type PathValue,
} from "../../src/config/index";

describe("@bunest/config NestJS v12 parity features", () => {
  const tempDirs: string[] = [];
  const touchedEnvKeys = new Set<string>();

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await removePath(dir, { recursive: true, force: true });
      }
    }
    for (const key of touchedEnvKeys) {
      delete process.env[key];
    }
    touchedEnvKeys.clear();
  });

  function writeTempEnv(filename: string, content: string): string {
    const dir = join(
      Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
      `bunest-config-v12-${crypto.randomUUID()}`,
    );
    mkdirSyncPath(dir, { recursive: true });
    tempDirs.push(dir);
    const full = join(dir, filename);
    writeTextSync(full, content);
    return full;
  }

  function setProcessEnv(key: string, value: string): void {
    touchedEnvKeys.add(key);
    process.env[key] = value;
  }

  it("supports getConfigToken(), registerAs() with string/symbol tokens, and ConfigType<T>", async () => {
    const dbConfig = registerAs("database", () => ({
      host: "pg.local",
      port: 5432,
      ssl: true,
    }));

    const asyncCacheConfig = registerAs("cache", async () => ({
      ttl: 120,
      prefix: "app:",
    }));

    type DbConfig = ConfigType<typeof dbConfig>;
    type CacheConfig = ConfigType<typeof asyncCacheConfig>;

    expect(getConfigToken("database")).toBe("CONFIGURATION(database)");
    expect(dbConfig.KEY).toBe(getConfigToken("database"));

    const sym = Symbol("metrics");
    expect(getConfigToken(sym)).toBe(`CONFIGURATION(${sym.toString()})`);

    @Injectable()
    class ConsumerService {
      constructor(
        @Inject(getConfigToken("database"))
        public readonly db: DbConfig,
        @Inject(asyncCacheConfig.KEY)
        public readonly cache: CacheConfig,
      ) {}
    }

    @Module({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          ignoreEnvVars: true,
          load: [dbConfig, asyncCacheConfig],
        }),
      ],
      providers: [ConsumerService],
      exports: [ConsumerService],
    })
    class AppModule {}

    const ctx = await BunestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    try {
      const consumer = ctx.get(ConsumerService);
      expect(consumer.db.host).toBe("pg.local");
      expect(consumer.db.port).toBe(5432);
      expect(consumer.db.ssl).toBe(true);
      expect(consumer.cache.ttl).toBe(120);
      expect(consumer.cache.prefix).toBe("app:");
    } finally {
      await ctx.close();
    }
  });

  it("supports Path/PathValue types, { infer: true } overloads, WasValidated=true, and getOrThrow defaults", () => {
    interface AppSchema {
      PORT: number;
      APP_NAME: string;
      OPTIONAL_FLAG?: boolean;
      database: {
        host: string;
        port: number;
        pool: {
          max: number;
        };
      };
    }

    // Type-level compile checks for exported path utility types
    type AppPath = Path<AppSchema>;
    type _CheckImpl = PathImpl<AppSchema, "database">;
    type _CheckImpl2 = PathImpl2<AppSchema>;
    type PoolMaxType = PathValue<AppSchema, "database.pool.max">;
    type _NoInferCheck = NoInferType<number>;
    const inferOpts: ConfigGetOptions = { infer: true };
    const samplePath: AppPath = "database.pool.max";
    const sampleMax: PoolMaxType = 16;
    expect(samplePath).toBe("database.pool.max");
    expect(sampleMax).toBe(16);

    const cfg = new ConfigService<AppSchema>(
      {
        PORT: 3000,
        APP_NAME: "bunest",
        database: {
          host: "db.internal",
          port: 5432,
          pool: { max: 20 },
        },
      },
      { ignoreEnvVars: true },
    );

    const inferredPort: number | undefined = cfg.get(
      "database.port",
      inferOpts,
    );
    const inferredMax: number | undefined = cfg.get("database.pool.max", {
      infer: true,
    });
    const withDefault: boolean = cfg.get("OPTIONAL_FLAG", true, {
      infer: true,
    });
    const missingInferred: boolean | undefined = cfg.get("OPTIONAL_FLAG", {
      infer: true,
    });

    expect(inferredPort).toBe(5432);
    expect(inferredMax).toBe(20);
    expect(withDefault).toBe(true);
    expect(missingInferred).toBeUndefined();

    // getOrThrow overloads including defaultValue and { infer: true }
    const thrownHost: string = cfg.getOrThrow("database.host", { infer: true });
    const thrownWithDefault: boolean = cfg.getOrThrow("OPTIONAL_FLAG", false, {
      infer: true,
    });
    const thrownUntypedDefault: string = cfg.getOrThrow<string>(
      "OPTIONAL_FLAG",
      "fallback",
    );
    expect(thrownHost).toBe("db.internal");
    expect(thrownWithDefault).toBe(false);
    expect(thrownUntypedDefault).toBe("fallback");

    expect(() => cfg.getOrThrow("OPTIONAL_FLAG", { infer: true })).toThrow(
      TypeError,
    );
    expect(() =>
      cfg.getOrThrow<boolean | undefined>("OPTIONAL_FLAG", undefined),
    ).toThrow(TypeError);

    // WasValidated = true narrows return type to non-undefined
    const validatedCfg = new ConfigService<AppSchema, true>(
      {
        PORT: 8080,
        APP_NAME: "prod",
        database: { host: "prod-db", port: 5432, pool: { max: 50 } },
      },
      { ignoreEnvVars: true },
    );
    const nonOptionalPort: number = validatedCfg.get("PORT", { infer: true });
    const nonOptionalHost: string = validatedCfg.get("database.host", {
      infer: true,
    });
    expect(nonOptionalPort).toBe(8080);
    expect(nonOptionalHost).toBe("prod-db");
  });

  it("supports set(), dot-path mutation, zero-RxJS changes$ subscriptions, and cache invalidation", () => {
    setProcessEnv("BUNEST_CACHED_KEY", "initial-proc");

    const cfg = new ConfigService(
      {
        APP_MODE: "dev",
        database: { host: "db1.local", port: 5432 },
      },
      { cache: true },
    );

    const eventsFn: ConfigChangeEvent[] = [];
    const eventsObserver: ConfigChangeEvent[] = [];

    const sub1 = cfg.changes$.subscribe((evt) => eventsFn.push(evt));
    const sub2 = cfg.changes$.subscribe({
      next: (evt) => eventsObserver.push(evt),
    });

    // Caching: reads process.env once and caches it
    expect(cfg.get<string>("BUNEST_CACHED_KEY")).toBe("initial-proc");
    process.env.BUNEST_CACHED_KEY = "mutated-outside";
    expect(cfg.get<string>("BUNEST_CACHED_KEY")).toBe("initial-proc");

    // set() updates store, invalidates/updates cache, and notifies listeners
    cfg.set("BUNEST_CACHED_KEY", "set-via-api");
    expect(cfg.get<string>("BUNEST_CACHED_KEY")).toBe("set-via-api");

    // Cache parent & nested child, then mutate nested child via dot-path
    expect(cfg.get<{ host: string; port: number }>("database")?.host).toBe(
      "db1.local",
    );
    expect(cfg.get<string>("database.host")).toBe("db1.local");

    cfg.set("database.host", "db2.local");
    expect(cfg.get<string>("database.host")).toBe("db2.local");
    expect(cfg.get<{ host: string; port: number }>("database")?.host).toBe(
      "db2.local",
    );

    // Unsubscribe sub1; only sub2 receives subsequent events
    sub1.unsubscribe();
    cfg.set("APP_MODE", "prod");
    sub2.unsubscribe();

    // Prototype pollution guard
    cfg.set("__proto__", "bad");
    cfg.set("database.__proto__", "bad");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    expect(eventsFn).toEqual([
      {
        path: "BUNEST_CACHED_KEY",
        oldValue: "initial-proc",
        newValue: "set-via-api",
      },
      {
        path: "database.host",
        oldValue: "db1.local",
        newValue: "db2.local",
      },
    ]);
    expect(eventsObserver).toHaveLength(3);
    expect(eventsObserver[2]).toEqual({
      path: "APP_MODE",
      oldValue: "dev",
      newValue: "prod",
    });
  });

  it("supports getDefaultParser(), custom parser option, setEnvFilePaths(), and setParser()", async () => {
    const defaultParser = getDefaultParser();
    expect(defaultParser("FOO=bar\nNUM=42\n")).toEqual({
      FOO: "bar",
      NUM: "42",
    });

    const jsonEnvPath = writeTempEnv(
      "config.json",
      JSON.stringify({ SERVICE_NAME: "billing", RETRIES: 3, ENABLED: true }),
    );
    const jsonParser: Parser = (content) => JSON.parse(content);

    @Module({
      imports: [
        ConfigModule.forRoot({
          envFilePath: jsonEnvPath,
          ignoreEnvVars: true,
          parser: jsonParser,
        }),
      ],
    })
    class CustomParserModule {}

    const ctx = await BunestFactory.createApplicationContext(
      CustomParserModule,
      { logger: false },
    );
    try {
      const cfg = ctx.get(ConfigService);
      expect(cfg.get<string>("SERVICE_NAME")).toBe("billing");
      expect(cfg.get<number>("RETRIES")).toBe(3);
      expect(cfg.get<boolean>("ENABLED")).toBe(true);
    } finally {
      await ctx.close();
    }

    // Legacy compatibility methods on standalone ConfigService
    const standalone = new ConfigService({}, { ignoreEnvVars: true });
    standalone.setParser(jsonParser);
    standalone.setEnvFilePaths([jsonEnvPath]);
    expect(standalone.get<string>("SERVICE_NAME")).toBe("billing");
    expect(standalone.get<number>("RETRIES")).toBe(3);
  });

  it("supports override, skipProcessEnv, and validatePredefined in ConfigModule.forRoot()", async () => {
    const envFile = writeTempEnv(
      ".env",
      "SHARED=from_file\nFILE_ONLY=yes\nEXPANDED=prefix_${SHARED}\n",
    );

    // 1. override: true lets .env values beat predefined envSource (including expansion)
    @Module({
      imports: [
        ConfigModule.forRoot({
          envFilePath: envFile,
          override: true,
          expandVariables: true,
          envSource: { SHARED: "from_env", ENV_ONLY: "runtime" },
        }),
      ],
    })
    class OverrideModule {}

    const overrideCtx = await BunestFactory.createApplicationContext(
      OverrideModule,
      { logger: false },
    );
    try {
      const cfg = overrideCtx.get(ConfigService);
      expect(cfg.get("SHARED")).toBe("from_file");
      expect(cfg.get("EXPANDED")).toBe("prefix_from_file");
      expect(cfg.get("ENV_ONLY")).toBe("runtime");
    } finally {
      await overrideCtx.close();
    }

    // 2. skipProcessEnv: true hides undeclared process.env keys while still serving schema-declared & file keys
    setProcessEnv("BUNEST_SKIP_UNDECLARED", "secret-host-var");
    setProcessEnv("BUNEST_SKIP_DECLARED", "9090");

    const declaredSchema: StandardSchemaV1<
      Record<string, unknown>,
      { BUNEST_SKIP_DECLARED: number }
    > = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate(raw: unknown) {
          const rec = (raw ?? {}) as Record<string, unknown>;
          return {
            value: { BUNEST_SKIP_DECLARED: Number(rec.BUNEST_SKIP_DECLARED) },
          };
        },
      },
    };

    @Module({
      imports: [
        ConfigModule.forRoot({
          envFilePath: envFile,
          skipProcessEnv: true,
          validationSchema: declaredSchema,
        }),
      ],
    })
    class SkipProcessEnvModule {}

    const skipCtx = await BunestFactory.createApplicationContext(
      SkipProcessEnvModule,
      { logger: false },
    );
    try {
      const cfg = skipCtx.get(ConfigService);
      expect(cfg.get<number>("BUNEST_SKIP_DECLARED")).toBe(9090);
      expect(cfg.get<string>("FILE_ONLY")).toBe("yes");
      expect(cfg.get("BUNEST_SKIP_UNDECLARED")).toBeUndefined();
    } finally {
      await skipCtx.close();
    }

    // 3. validatePredefined: false excludes predefined env vars from validate() while still exposing them
    const seenByValidator: string[] = [];
    @Module({
      imports: [
        ConfigModule.forRoot({
          envFilePath: envFile,
          validatePredefined: false,
          envSource: { SHARED: "predef_shared", PREDEF_ONLY: "keep_me" },
          validate: (raw) => {
            seenByValidator.push(...Object.keys(raw));
            return { ...raw, VALIDATED_FILE: "ok" };
          },
        }),
      ],
    })
    class ValidatePredefinedFalseModule {}

    const predefCtx = await BunestFactory.createApplicationContext(
      ValidatePredefinedFalseModule,
      { logger: false },
    );
    try {
      const cfg = predefCtx.get(ConfigService);
      expect(seenByValidator).not.toContain("PREDEF_ONLY");
      expect(seenByValidator).toContain("FILE_ONLY");
      expect(cfg.get("PREDEF_ONLY")).toBe("keep_me");
      expect(cfg.get("SHARED")).toBe("predef_shared");
      expect(cfg.get("VALIDATED_FILE")).toBe("ok");
    } finally {
      await predefCtx.close();
    }
  });

  it("supports ConditionalModule.registerWhen() with string flag, predicate, and ConfigModule.envVariablesLoaded", async () => {
    const envPath = writeTempEnv(
      ".env",
      "BUNEST_COND_ENABLED=true\nBUNEST_COND_DISABLED=false\nBUNEST_COND_TIER=enterprise\n",
    );
    touchedEnvKeys.add("BUNEST_COND_ENABLED");
    touchedEnvKeys.add("BUNEST_COND_DISABLED");
    touchedEnvKeys.add("BUNEST_COND_TIER");

    @Injectable()
    class EnabledFeatureService {
      readonly status = "enabled";
    }

    @Module({
      providers: [EnabledFeatureService],
      exports: [EnabledFeatureService],
    })
    class EnabledFeatureModule {}

    @Injectable()
    class DisabledFeatureService {
      readonly status = "disabled";
    }

    @Module({
      providers: [DisabledFeatureService],
      exports: [DisabledFeatureService],
    })
    class DisabledFeatureModule {}

    @Injectable()
    class EnterpriseFeatureService {
      readonly tier = "enterprise";
    }

    @Module({
      providers: [EnterpriseFeatureService],
      exports: [EnterpriseFeatureService],
    })
    class EnterpriseFeatureModule {}

    @Module({
      imports: [
        ConfigModule.forRoot({ envFilePath: envPath, override: true }),
        ConditionalModule.registerWhen(
          EnabledFeatureModule,
          "BUNEST_COND_ENABLED",
          { debug: false },
        ),
        ConditionalModule.registerWhen(
          DisabledFeatureModule,
          "BUNEST_COND_DISABLED",
          { debug: false },
        ),
        ConditionalModule.registerWhen(
          EnterpriseFeatureModule,
          (env) => env.BUNEST_COND_TIER === "enterprise",
          { debug: false },
        ),
      ],
    })
    class ConditionalAppModule {}

    await expect(ConfigModule.envVariablesLoaded).resolves.toBeUndefined();

    const ctx = await BunestFactory.createApplicationContext(
      ConditionalAppModule,
      { logger: false },
    );
    try {
      expect(ctx.get(EnabledFeatureService).status).toBe("enabled");
      expect(ctx.get(EnterpriseFeatureService).tier).toBe("enterprise");
      expect(() => ctx.get(DisabledFeatureService)).toThrow();
    } finally {
      await ctx.close();
    }
  });
});
