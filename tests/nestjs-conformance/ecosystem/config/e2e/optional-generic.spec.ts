import { afterEach, beforeEach, expect, it } from "bun:test";
import type { BunestApplication } from "../../../../../packages/core/src";
import { ConfigService } from "../../../../../packages/core/src/config";
import {
  describeConformance,
  Test,
  type TestingModule,
} from "../../../_helpers/index";
import { AppModule } from "../_fixtures/app.module";

describeConformance(
  "Optional Generic()",
  {
    upstreamPath: "config/tests/e2e/optional-generic.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication;
    let moduleRef: TestingModule;
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(async () => {
      originalEnv = { ...process.env };
      moduleRef = await Test.createTestingModule({
        imports: [AppModule.withEnvVars()],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    it("should allow a key of the interface", () => {
      const configService =
        moduleRef.get<ConfigService<{ PORT: string }>>(ConfigService);
      const port = configService.get("PORT");
      expect(port).toBeTruthy();
    });

    it("should infer type from a dot notation", () => {
      const configService =
        moduleRef.get<
          ConfigService<{ obj: { test: boolean; test2?: boolean } }>
        >(ConfigService);

      const obj = configService.get("obj", { infer: true });
      const test = configService.get("obj.test", { infer: true });
      const testWithDefaultValue = configService.get("obj.test2", true, {
        infer: true,
      });
      expect(obj?.test as unknown).toEqual("true");
      expect(test as unknown).toEqual("true");
      expect(testWithDefaultValue).toBeTruthy();
    });

    it("should infer type from a dot notation (getOrThrow)", () => {
      const configService =
        moduleRef.get<
          ConfigService<{ obj: { test: boolean; test2?: boolean } }>
        >(ConfigService);

      const obj = configService.getOrThrow("obj", { infer: true });
      const test = configService.getOrThrow("obj.test", { infer: true });
      const testWithDefaultValue = configService.getOrThrow("obj.test2", true, {
        infer: true,
      });
      expect(obj?.test as unknown).toEqual("true");
      expect(test as unknown).toEqual("true");
      expect(testWithDefaultValue).toBeTruthy();
    });

    it("should allow any key without a generic", () => {
      const configService = moduleRef.get<ConfigService>(ConfigService);
      const port = configService.get("PORT");

      expect(port).toBeTruthy();
    });

    it("should allow any key without a generic and with the default value", () => {
      const configService = moduleRef.get(ConfigService);
      const port = configService.get("PORT2", "default");

      expect(port).toEqual("default");
    });

    it("should compile error when return wrong type", () => {
      const configService =
        moduleRef.get<ConfigService<{ PORT: string }>>(ConfigService);

      // @ts-expect-error: PORT is a string, not a number. Should throw an error
      const port: number | undefined = configService.get("PORT", {
        infer: true,
      });

      // @ts-expect-error: PORT is a string, not a number. Should throw an error
      const portWithDefaultValue: number = configService.get("PORT", "", {
        infer: true,
      });

      expect(port).toBeDefined();
      expect(portWithDefaultValue).toBeDefined();
    });

    it("should compile error when return wrong type (getOrThrow)", () => {
      const configService =
        moduleRef.get<ConfigService<{ PORT: string }>>(ConfigService);

      // @ts-expect-error: PORT is a string, not a number. Should throw an error
      const port: number = configService.getOrThrow("PORT", {
        infer: true,
      });

      // @ts-expect-error: PORT is a string, not a number. Should throw an error
      const portWithDefaultValue: number = configService.getOrThrow(
        "PORT",
        "",
        {
          infer: true,
        },
      );

      expect(port).toBeDefined();
      expect(portWithDefaultValue).toBeDefined();
    });

    afterEach(async () => {
      await app.close();
      process.env = originalEnv;
    });
  },
);
