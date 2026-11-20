import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { join } from "node:path";
import { Injectable, Module } from "../../../../../packages/common/src";
import { ConditionalModule, ConfigModule } from "../../../../../packages/config/src";
import { describeConformance, Test } from "../../../_helpers/index";
import { fixturesDir } from "../_fixtures/app.module";

const envConditionalPath = join(fixturesDir, ".env.conditional");

@Injectable()
class FooService {}

@Injectable()
class FooDynamicService {}

@Module({
  providers: [FooService],
  exports: [FooService],
})
class FooModule {
  static forRoot() {
    return {
      module: FooModule,
      providers: [FooDynamicService],
      exports: [FooDynamicService],
    };
  }
}

@Injectable()
class BarService {}

@Module({
  providers: [BarService],
  exports: [BarService],
})
class BarModule {}

@Module({
  providers: [
    {
      provide: "quu",
      useValue: 42,
    },
  ],
  exports: ["quu"],
})
class QuuModule {}

@Module({
  imports: [ConditionalModule.registerWhen(QuuModule, "QUU")],
  exports: [ConditionalModule],
})
class FooBarModule {}

describeConformance(
  "ConditionalModule",
  {
    upstreamPath: "config/tests/e2e/conditional.module.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      originalEnv = { ...process.env };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("it should work for a regular module", async () => {
      const modRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            envFilePath: envConditionalPath,
          }),
          ConditionalModule.registerWhen(FooModule, "FOO", { debug: false }),
        ],
      }).compile();
      expect(modRef.get(FooService, { strict: false })).toBeDefined();
      await modRef.close();
    });

    it("should work for a dynamic module", async () => {
      const modRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            envFilePath: envConditionalPath,
          }),
          ConditionalModule.registerWhen(FooModule.forRoot(), "FOO_DYNAMIC", {
            debug: false,
          }),
        ],
      }).compile();
      expect(modRef.get(FooDynamicService, { strict: false })).toBeDefined();
      await modRef.close();
    });

    it("should not register when the value is false", async () => {
      const modRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            envFilePath: envConditionalPath,
          }),
          ConditionalModule.registerWhen(FooModule, "FOO_FALSE", {
            debug: false,
          }),
        ],
      }).compile();
      expect(() => modRef.get(FooService, { strict: false })).toThrow();
      await modRef.close();
    });

    it("should work for a custom condition", async () => {
      const modRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            envFilePath: envConditionalPath,
          }),
          ConditionalModule.registerWhen(
            FooModule,
            (env) => env.FOO_CUSTOM === "yeah!",
            { debug: false },
          ),
        ],
      }).compile();
      expect(modRef.get(FooService, { strict: false })).toBeDefined();
      await modRef.close();
    });

    it("should handle two conditional modules", async () => {
      const modRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            envFilePath: envConditionalPath,
          }),
          ConditionalModule.registerWhen(FooModule, "FOO", { debug: false }),
          ConditionalModule.registerWhen(BarModule, "BAR", { debug: false }),
        ],
      }).compile();
      expect(modRef.get(FooService, { strict: false })).toBeDefined();
      expect(modRef.get(BarService, { strict: false })).toBeDefined();
      await modRef.close();
    });

    it("should handle nested conditional module", async () => {
      const modRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            envFilePath: envConditionalPath,
          }),
          ConditionalModule.registerWhen(FooBarModule, "FOOBAR", {
            debug: false,
          }),
        ],
      }).compile();
      expect(modRef.get("quu", { strict: false })).toBeDefined();
      await modRef.close();
    });
  },
);
