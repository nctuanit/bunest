import { describe, expect, it } from "bun:test";
import { Controller, Injectable, Logger, Module } from "../../src/common";

describe("Auto-injected logger on @Injectable(), @Controller(), and @Module()", () => {
  it("lazily provides a cached Logger scoped to the class name without polluting Object.keys", () => {
    @Injectable()
    class DemoService {
      getLogger(): Logger {
        return (this as unknown as { logger: Logger }).logger;
      }
    }

    @Controller("demo")
    class DemoController {
      getLogger(): Logger {
        return (this as unknown as { logger: Logger }).logger;
      }
    }

    @Module({})
    class DemoModule {
      getLogger(): Logger {
        return (this as unknown as { logger: Logger }).logger;
      }
    }

    for (const instance of [new DemoService(), new DemoController(), new DemoModule()]) {
      expect(Object.keys(instance)).toEqual([]);
      const logger1 = instance.getLogger();
      const logger2 = instance.getLogger();
      expect(logger1).toBeInstanceOf(Logger);
      expect(logger1).toBe(logger2);
      expect(Object.keys(instance)).toEqual([]);
    }
  });

  it("preserves explicit user-defined logger properties without conflict", () => {
    const customLogger = new Logger("CustomContext");

    @Injectable()
    class CustomLoggerService {
      readonly logger = customLogger;
    }

    const svc = new CustomLoggerService();
    expect(svc.logger).toBe(customLogger);
  });
});
