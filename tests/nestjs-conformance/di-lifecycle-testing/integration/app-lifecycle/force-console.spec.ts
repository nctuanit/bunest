import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  ConsoleLogger,
  Controller,
  Get,
  Module,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";

@Controller("hello")
class HelloController {
  @Get()
  getHello() {
    return "Hello world!";
  }
}

@Module({ controllers: [HelloController] })
class AppModule {}

describeConformance(
  "ForceConsole Option",
  {
    upstreamPath: "integration/hello-world/e2e/force-console.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
  },
  () => {
    let app: BunestApplication;

    describe("When forceConsole is true", () => {
      let consoleLogSpy: ReturnType<typeof spyOn>;
      let consoleErrorSpy: ReturnType<typeof spyOn>;

      beforeEach(async () => {
        consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
        consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});

        const moduleRef = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        app = moduleRef.createNestApplication({
          forceConsole: true,
          logger: ["log", "error"],
        });

        await app.init();
      });

      afterEach(async () => {
        consoleLogSpy.mockRestore();
        consoleErrorSpy.mockRestore();
        await app.close();
      });

      it("should use console.log instead of process.stdout.write", () => {
        const logger = new ConsoleLogger("TestContext", { forceConsole: true });
        logger.log("Test log message");

        expect(consoleLogSpy).toHaveBeenCalled();
        const calls = consoleLogSpy.mock.calls.filter((args: unknown[]) =>
          args.some((arg: unknown) => String(arg).includes("Test log message")),
        );
        expect(calls.length).toBeGreaterThan(0);
      });

      it("should use console.error instead of process.stderr.write", () => {
        const logger = new ConsoleLogger("TestContext", { forceConsole: true });
        logger.error("Test error message");

        expect(consoleErrorSpy).toHaveBeenCalled();
        const calls = consoleErrorSpy.mock.calls.filter((args: unknown[]) =>
          args.some((arg: unknown) => String(arg).includes("Test error message")),
        );
        expect(calls.length).toBeGreaterThan(0);
      });

      itAdapted(
        "ADR-001",
        "should handle GET request with forceConsole option enabled",
        async () => {
          await request(app).get("/hello").expect(200);
        },
      );
    });

    describe("When forceConsole is false (default)", () => {
      let consoleLogSpy: ReturnType<typeof spyOn>;
      let consoleErrorSpy: ReturnType<typeof spyOn>;
      let stdoutSpy: ReturnType<typeof spyOn>;
      let stderrSpy: ReturnType<typeof spyOn>;

      beforeEach(async () => {
        consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
        consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
        stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
        stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

        const moduleRef = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        app = moduleRef.createNestApplication({
          logger: ["log", "error"],
        });
        await app.init();
      });

      afterEach(async () => {
        consoleLogSpy.mockRestore();
        consoleErrorSpy.mockRestore();
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
        await app.close();
      });

      it("should not directly call console.log when forceConsole is false", () => {
        const logger = new ConsoleLogger("TestContext");
        consoleLogSpy.mockClear();

        logger.log("Test log message");
        expect(consoleLogSpy).not.toHaveBeenCalled();
      });

      it("should not directly call console.error when forceConsole is false", () => {
        const logger = new ConsoleLogger("TestContext");
        consoleErrorSpy.mockClear();

        logger.error("Test error message");
        expect(consoleErrorSpy).not.toHaveBeenCalled();
      });
    });

    describe("When forceConsole is set via application creation", () => {
      it("should apply forceConsole to ConsoleLogger", async () => {
        const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});

        const moduleRef = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        const testApp = moduleRef.createNestApplication({
          forceConsole: true,
        });
        await testApp.init();

        const logger = new ConsoleLogger("AppContext", { forceConsole: true });
        logger.log("Application started");

        expect(consoleLogSpy).toHaveBeenCalled();

        consoleLogSpy.mockRestore();
        await testApp.close();
      });
    });
  },
);
