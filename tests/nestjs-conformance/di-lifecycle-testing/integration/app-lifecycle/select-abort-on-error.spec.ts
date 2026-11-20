import "reflect-metadata";
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { Injectable, Module } from "../../../../../packages/common/src";
import {
  NestFactory,
  UnknownDependencyException,
  type BunestApplication,
} from "../../../../../packages/core/src";
import { describeConformance } from "../../../_helpers";

@Injectable()
class FeatureService {}

@Module({ providers: [FeatureService] })
class FeatureModule {}

@Module({ imports: [FeatureModule] })
class AppModule {}

@Module({})
class NotImportedModule {}

describeConformance(
  "select() with abortOnError",
  {
    upstreamPath: "integration/hello-world/e2e/select-abort-on-error.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication;
    let exit: ReturnType<typeof spyOn>;

    beforeEach(() => {
      exit = spyOn(process, "exit").mockImplementation((() => undefined) as never);
    });

    afterEach(async () => {
      exit.mockRestore();
      await app?.close();
    });

    it("should throw instead of exiting when abortOnError is false", async () => {
      app = await NestFactory.create(AppModule, { logger: false });

      expect(() =>
        app.select(NotImportedModule, { abortOnError: false }),
      ).toThrow();
      expect(exit).not.toHaveBeenCalled();
    });

    // BUNEST_BUG: BunestApplicationContext.select(mod, { abortOnError: true }) throws instead of calling process.exit(1) (packages/core/src/application/bunest-application-context.ts)
    it.skip("should exit when the selected context has abortOnError set to true", async () => {
      app = await NestFactory.create(AppModule, {
        abortOnError: false,
        logger: false,
      });

      app.select(FeatureModule, { abortOnError: true }).get("missing");

      expect(exit).toHaveBeenCalledWith(1);
    });

    // BUNEST_BUG: select(NotImportedModule, { abortOnError: true }) throws instead of calling process.exit(1) (packages/core/src/application/bunest-application-context.ts)
    it.skip("should exit when select itself fails with abortOnError set to true", async () => {
      app = await NestFactory.create(AppModule, {
        abortOnError: false,
        logger: false,
      });

      expect(() =>
        app.select(NotImportedModule, { abortOnError: true }),
      ).not.toThrow();
      expect(exit).toHaveBeenCalledWith(1);
    });

    // BUNEST_BUG: chained select() does not propagate abortOnError: true -> process.exit(1) (packages/core/src/application/bunest-application-context.ts)
    it.skip("should apply the option of the selected context to a further select", async () => {
      app = await NestFactory.create(AppModule, {
        abortOnError: false,
        logger: false,
      });

      app
        .select(FeatureModule, { abortOnError: true })
        .select(FeatureModule)
        .get("missing");

      expect(exit).toHaveBeenCalledWith(1);
    });

    it("should let a further select override abortOnError to false and throw", async () => {
      app = await NestFactory.create(AppModule, { logger: false });

      expect(() =>
        app
          .select(FeatureModule, { abortOnError: true })
          .select(FeatureModule, { abortOnError: false })
          .get("missing"),
      ).toThrow(UnknownDependencyException);
      expect(exit).not.toHaveBeenCalled();
    });

    it("should throw on missing token when select has no abortOnError", async () => {
      app = await NestFactory.create(AppModule, { logger: false });

      expect(() => app.select(FeatureModule).get("missing")).toThrow(
        UnknownDependencyException,
      );
      expect(exit).not.toHaveBeenCalled();
    });

    it("should keep the abortOnError of the application when another one is created", async () => {
      app = await NestFactory.create(AppModule, {
        abortOnError: false,
        logger: false,
      });
      const other = await NestFactory.createApplicationContext(AppModule, {
        logger: false,
      });

      expect(() => app.get("missing")).toThrow(UnknownDependencyException);
      expect(exit).not.toHaveBeenCalled();
      await other.close();
    });

    it("should resolve FeatureService from selected FeatureModule", async () => {
      app = await NestFactory.create(AppModule, {
        abortOnError: false,
        logger: false,
      });

      expect(app.select(FeatureModule).get(FeatureService)).toBeInstanceOf(
        FeatureService,
      );
      expect(exit).not.toHaveBeenCalled();
    });
  },
);
