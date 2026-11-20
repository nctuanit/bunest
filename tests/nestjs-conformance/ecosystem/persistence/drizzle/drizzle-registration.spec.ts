import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  Injectable,
  Module,
  type INestApplicationContext,
  type Type,
} from "../../../../../packages/common/src";
import { NestFactory } from "../../../../../packages/core/src";
import {
  DrizzleModule,
  getDrizzleOptionsToken,
  getDrizzleServiceToken,
  getDrizzleToken,
  type DrizzleDatabaseLike,
  type DrizzleModuleOptions,
  type DrizzleOptionsFactory,
} from "../../../../../packages/sql/src";
import {
  Test,
  createSpy,
  describeConformance,
} from "../../../_helpers/index";

describeConformance(
  "Persistence (drizzle) - registration & token derivation",
  {
    upstreamPath: "drizzle/tests/e2e/drizzle-registration.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts DrizzleModule token derivation, non-serialization of DB instances in module graph/snapshot, DrizzleOptionsFactory invocation, and missing async strategy validation to @bunest/sql DrizzleModule.",
  },
  () => {
    it("should derive connection, service, and options tokens from the connection name", () => {
      expect(getDrizzleToken()).toBe("bunest:drizzle:connection:default");
      expect(getDrizzleToken("default")).toBe(
        "bunest:drizzle:connection:default",
      );
      expect(getDrizzleToken("analytics")).toBe(
        "bunest:drizzle:connection:analytics",
      );
      expect(getDrizzleServiceToken()).toBe("bunest:drizzle:service:default");
      expect(getDrizzleServiceToken("analytics")).toBe(
        "bunest:drizzle:service:analytics",
      );
      expect(getDrizzleOptionsToken()).toBe("bunest:drizzle:options:default");
      expect(getDrizzleOptionsToken("analytics")).toBe(
        "bunest:drizzle:options:analytics",
      );
    });

    it.each<[string, (mod: Type) => Promise<INestApplicationContext>]>([
      [
        "default Test.createTestingModule",
        (mod) =>
          Test.createTestingModule({ imports: [mod] }).compile({
            logger: false,
          }),
      ],
      [
        "NestFactory.createApplicationContext (snapshot: true)",
        (mod) =>
          NestFactory.createApplicationContext(mod, {
            snapshot: true,
            logger: false,
            abortOnError: false,
          }),
      ],
    ])(
      "should never serialize the database instance (%s)",
      async (_, createContext) => {
        const db: DrizzleDatabaseLike & { toJSON: () => never } = {
          toJSON() {
            throw new Error("The database instance was serialized");
          },
        };

        @Module({
          imports: [
            DrizzleModule.forRoot({ db }),
            DrizzleModule.forRootAsync({
              name: "created",
              useFactory: () => ({ db }),
            }),
          ],
        })
        class AppModule {}

        const context = await createContext(AppModule);
        try {
          expect(context.get(getDrizzleToken())).toBe(db);
          expect(context.get(getDrizzleToken("created"))).toBe(db);
        } finally {
          await context.close();
        }
      },
    );

    it("should invoke createDrizzleOptions() for default and named useClass registrations", async () => {
      const defaultDb: DrizzleDatabaseLike = {};
      const analyticsDb: DrizzleDatabaseLike = {};
      let callIndex = 0;

      const factorySpy = createSpy((): DrizzleModuleOptions => {
        const db = callIndex === 0 ? defaultDb : analyticsDb;
        callIndex++;
        return { db };
      });

      @Injectable()
      class DrizzleConfigService implements DrizzleOptionsFactory {
        createDrizzleOptions(): DrizzleModuleOptions {
          return factorySpy();
        }
      }

      @Module({
        imports: [
          DrizzleModule.forRootAsync({ useClass: DrizzleConfigService }),
          DrizzleModule.forRootAsync({
            name: "analytics",
            useClass: DrizzleConfigService,
          }),
        ],
      })
      class AppModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile({ logger: false });
      try {
        expect(factorySpy.callCount).toBe(2);
        expect(moduleRef.get(getDrizzleToken())).toBeDefined();
        expect(moduleRef.get(getDrizzleToken("analytics"))).toBeDefined();
        expect(moduleRef.get(getDrizzleToken())).not.toBe(
          moduleRef.get(getDrizzleToken("analytics")),
        );
      } finally {
        await moduleRef.close();
      }
    });

    it("should throw when no async options strategy is provided", () => {
      expect(() => DrizzleModule.forRootAsync({})).toThrow(
        'DrizzleModule.forRootAsync("default") requires one of "useFactory", "useClass", or "useExisting".',
      );
      expect(() => DrizzleModule.forRootAsync({ name: "analytics" })).toThrow(
        'DrizzleModule.forRootAsync("analytics") requires one of "useFactory", "useClass", or "useExisting".',
      );
    });
  },
);
