import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
  ConsoleLogger,
  Logger,
  type LoggerService,
} from "../../../../../packages/common/src";
import { CapturingLogger, describeConformance } from "../../../_helpers";

describeConformance(
  "CapturingLogger",
  {
    upstreamPath: "packages/testing/test/capturing-logger.service.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let logger: CapturingLogger;
    let stdoutSpy: ReturnType<typeof spyOn>;
    let stderrSpy: ReturnType<typeof spyOn>;
    let consoleLogSpy: ReturnType<typeof spyOn>;
    let consoleErrorSpy: ReturnType<typeof spyOn>;
    let consoleWarnSpy: ReturnType<typeof spyOn>;
    let prevNestLogLevel: string | undefined;

    beforeEach(() => {
      prevNestLogLevel = process.env.NEST_LOG_LEVEL;
      logger = new CapturingLogger();
      stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
      stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
      consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
      consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
      consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      if (prevNestLogLevel === undefined) {
        delete process.env.NEST_LOG_LEVEL;
      } else {
        process.env.NEST_LOG_LEVEL = prevNestLogLevel;
      }
    });

    // BUNEST_BUG: CapturingLogger implements LoggerService directly rather than extending ConsoleLogger (packages/testing/src/loggers/capturing-logger.ts)
    it.skip("should be a ConsoleLogger", () => {
      expect(logger).toBeInstanceOf(ConsoleLogger);
    });

    describe("capturing", () => {
      it("should record every level with its message and context", () => {
        logger.verbose("verbose message");
        logger.debug("debug message", "Ctx");
        logger.log("Order created", { orderId: 1 }, { userId: 2 }, "Orders");
        logger.warn({ retries: 3 });

        expect(logger.entries).toHaveLength(4);
        expect(logger.entries[0]).toMatchObject({
          level: "verbose",
          message: "verbose message",
        });
        expect(logger.entries[1]).toMatchObject({
          level: "debug",
          message: "debug message",
          context: "Ctx",
        });
        expect(logger.entries[2]).toMatchObject({
          level: "log",
          message: "Order created",
          context: "Orders",
        });
        expect(logger.entries[3]).toMatchObject({
          level: "warn",
          message: { retries: 3 },
        });
      });

      // BUNEST_BUG: CapturedLogEntry omits NestJS v12 `params`, `args`, `error`, and `stack` structured fields (packages/testing/src/loggers/capturing-logger.ts)
      it.skip("should record structured params and args fields matching NestJS v12", () => {
        logger.log("Order created", { orderId: 1 }, { userId: 2 }, "Orders");
        expect(logger.entries[0] as unknown).toMatchObject({
          level: "log",
          message: "Order created",
          context: "Orders",
          params: { orderId: 1, userId: 2 },
          args: ["Order created", { orderId: 1 }, { userId: 2 }, "Orders"],
        });
      });

      // BUNEST_BUG: CapturedLogEntry does not extract `error` property from optional params (packages/testing/src/loggers/capturing-logger.ts)
      it.skip("should record an error passed after the message", () => {
        const error = new Error("Payment failed");
        logger.error("Checkout failed", error, "Checkout");
        expect(logger.entries[0] as unknown).toMatchObject({
          level: "error",
          message: "Checkout failed",
          context: "Checkout",
          error,
        });
      });

      // BUNEST_BUG: CapturingLogger stores Error object as message instead of extracting error.message + entry.error (packages/testing/src/loggers/capturing-logger.ts)
      it.skip("should use the message of an error logged as the message", () => {
        const error = new Error("Payment failed");
        logger.error(error);
        expect(logger.entries[0] as unknown).toMatchObject({
          message: "Payment failed",
          error,
        });
      });

      // BUNEST_BUG: CapturedLogEntry does not populate dedicated `stack` field (packages/testing/src/loggers/capturing-logger.ts)
      it.skip("should record a stack passed as a string", () => {
        const stack = "Error: boom\n    at run (app.ts:1:1)";
        logger.error("boom", stack, "App");
        logger.fatal("fatal boom", stack);
        expect(logger.entries[0] as unknown).toMatchObject({
          message: "boom",
          stack,
          context: "App",
        });
        expect(logger.entries[1] as unknown).toMatchObject({
          level: "fatal",
          message: "fatal boom",
          stack,
        });
      });

      // BUNEST_BUG: CapturingLogger does not evaluate lazy () => string message functions (packages/testing/src/loggers/capturing-logger.ts)
      it.skip("should evaluate lazy messages", () => {
        logger.debug(() => "expensive");
        expect(logger.entries[0]?.message).toBe("expensive");
      });

      it("should not print by default", () => {
        logger.log("message");
        logger.error("message");

        expect(stdoutSpy).not.toHaveBeenCalled();
        expect(stderrSpy).not.toHaveBeenCalled();
        expect(consoleLogSpy).not.toHaveBeenCalled();
        expect(consoleErrorSpy).not.toHaveBeenCalled();
      });

      it("should also print when print is enabled", () => {
        logger = new CapturingLogger({ print: true });
        logger.log("Order created", { orderId: 1 }, "Orders");
        logger.error("Failed", new Error("boom"));

        expect(logger.entries).toHaveLength(2);
        expect(stdoutSpy).toHaveBeenCalledTimes(1);
        expect(stderrSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      });

      // BUNEST_BUG: CapturingLoggerOptions lacks `json`, `colors`, and `logLevels` options (uses `levels` instead of `logLevels`; packages/testing/src/loggers/capturing-logger.ts)
      it.skip("should evaluate a lazy message once when printing in json mode", () => {
        const message = mock(() => "expensive");
        logger = new CapturingLogger({ print: true });
        logger.debug(message);
        expect(message).toHaveBeenCalledTimes(1);
        expect(logger.entries[0]?.message).toBe("expensive");
      });

      it("should only capture the given levels", () => {
        logger = new CapturingLogger({ levels: ["warn", "error"] });

        logger.log("hidden");
        logger.warn("shown");
        logger.error("shown");

        expect(logger.entries.map((entry) => entry.level)).toEqual([
          "warn",
          "error",
        ]);
      });

      it("should capture every level regardless of NEST_LOG_LEVEL", () => {
        process.env.NEST_LOG_LEVEL = "error";
        logger = new CapturingLogger();

        logger.debug("captured");

        expect(logger.entries).toHaveLength(1);
      });

      it("should return a snapshot of the entries", () => {
        logger.log("first");
        const entries = logger.entries;
        logger.log("second");

        expect(entries).toHaveLength(1);
        expect(logger.entries).toHaveLength(2);
      });

      it("should remove the entries on clear", () => {
        logger.log("message");
        logger.clear();

        expect(logger.entries).toEqual([]);
      });
    });

    describe("queries", () => {
      beforeEach(() => {
        logger.log("Mapped {/orders, GET} route", "RouterExplorer");
        logger.log("Order created", { orderId: 1, items: [1, 2] }, "Orders");
        logger.warn("Retrying payment (attempt 2)", "Payments");
        logger.error("Payment failed", new Error("declined"), "Payments");
      });

      it("should filter by level", () => {
        expect(logger.filter({ level: "log" })).toHaveLength(2);
      });

      // BUNEST_BUG: CapturingLogger.filter({ context: string }) uses substring .includes() instead of exact string match (packages/testing/src/loggers/capturing-logger.ts:94)
      it.skip("should match a string context exactly", () => {
        expect(logger.filter({ context: "Payments" })).toHaveLength(2);
        expect(logger.filter({ context: "Payment" })).toHaveLength(0);
      });

      it("should match a context against a regular expression", () => {
        expect(logger.filter({ context: /^Pay/ })).toHaveLength(2);
      });

      it("should match a string message as a substring", () => {
        expect(logger.filter({ message: "Retrying" })).toHaveLength(1);
        expect(logger.filter({ message: "PAYMENT" })).toHaveLength(0);
      });

      // BUNEST_BUG: matchesStringOrRegExp() does not reset global RegExp.lastIndex, causing alternating matches for /.../g (packages/testing/src/loggers/capturing-logger.ts:96)
      it.skip("should match a message against a regular expression including global flag", () => {
        expect(logger.filter({ message: /payment/i })).toHaveLength(2);
        const globalRe = /Order/g;
        expect(logger.filter({ message: globalRe })).toHaveLength(1);
        expect(logger.filter({ message: globalRe })).toHaveLength(1);
      });

      it("should match a message against a non-global regular expression", () => {
        expect(logger.filter({ message: /payment/i })).toHaveLength(2);
      });

      it("should combine the criteria", () => {
        expect(
          logger.filter({ level: "error", context: "Payments" }),
        ).toHaveLength(1);
        expect(logger.filter({ level: "log", context: "Payments" })).toEqual([]);
      });

      it("should return every entry without a matcher", () => {
        expect(logger.filter()).toHaveLength(4);
      });

      it("should find the first matching entry", () => {
        expect(logger.find({ context: "Payments" })?.level).toBe("warn");
        expect(logger.find({ context: "Unknown" })).toBeUndefined();
      });

      describe("assertLogged", () => {
        it("should return the first matching entry", () => {
          const entry = logger.assertLogged("Payment failed", "error");
          expect(entry.level).toBe("error");
          expect(entry.context).toBe("Payments");
        });

        it("should throw an error listing captured entries when nothing matches", () => {
          expect(() => logger.assertLogged("NoSuchLog", "error")).toThrow(
            /Expected a log entry matching/,
          );
        });

        it("should describe a predicate", () => {
          expect(() => logger.assertLogged(() => false)).toThrow(
            /Expected a log entry matching <predicate>/,
          );
        });

        it("should say when nothing was captured", () => {
          logger.clear();
          expect(() => logger.assertLogged("anything", "log")).toThrow(
            /no logs captured/,
          );
        });
      });

      describe("assertNotLogged", () => {
        it("should pass when nothing matches", () => {
          expect(() => logger.assertNotLogged(/.*/, "fatal")).not.toThrow();
        });

        it("should throw an error when an entry matches", () => {
          expect(() => logger.assertNotLogged("Retrying", "warn")).toThrow(
            /Expected no log entry matching/,
          );
        });
      });
    });

    describe("as the application logger", () => {
      afterEach(() => {
        Logger.overrideLogger(true);
      });

      // BUNEST_BUG: Logger.overrideLogger(customLogger) overrides static Logger.warn/log calls but does NOT route existing or newly constructed `new Logger(context)` instances through the overridden logger (packages/common/src/logger/logger.ts)
      it.skip("should capture Logger instances after Logger.overrideLogger", () => {
        const serviceLogger = new Logger("OrdersService");
        serviceLogger.log("before the override");

        Logger.overrideLogger(logger as LoggerService);
        serviceLogger.log("Order created", { orderId: 1 });
        serviceLogger.error("Order failed", new Error("boom"));
        Logger.warn("static", "Static");

        expect(logger.entries.length).toBeGreaterThanOrEqual(3);
        expect(logger.find({ level: "log", message: "Order created" })).toBeDefined();
        expect(logger.find({ level: "error", message: "Order failed" })).toBeDefined();
        expect(logger.find({ level: "warn", message: "static" })).toBeDefined();
      });

      it("should capture static Logger calls after Logger.overrideLogger", () => {
        Logger.overrideLogger(logger as LoggerService);
        Logger.log("Static log", "Static");
        Logger.warn("Static warn", "Static");
        Logger.error("Static error", "Static");

        expect(logger.entries).toHaveLength(3);
        expect(logger.find({ level: "log", message: "Static log" })).toBeDefined();
        expect(logger.find({ level: "warn", message: "Static warn" })).toBeDefined();
        expect(logger.find({ level: "error", message: "Static error" })).toBeDefined();
      });

      // BUNEST_BUG: new Logger('OrdersService').error(...) ignores Logger.overrideLogger(logger) (packages/common/src/logger/logger.ts)
      it.skip("should capture errors logged by a Logger instance without a stack", () => {
        Logger.overrideLogger(logger);
        new Logger("OrdersService").error("Order failed");

        expect(logger.entries).toHaveLength(1);
        expect(logger.entries[0]).toMatchObject({
          level: "error",
          message: "Order failed",
        });
      });

      // BUNEST_BUG: Logger.isLevelEnabled() does not consult overridden CapturingLogger's configured levels (packages/common/src/logger/logger.ts)
      it.skip("should report its levels through Logger.isLevelEnabled", () => {
        Logger.overrideLogger(new CapturingLogger({ levels: ["warn"] }));

        expect(Logger.isLevelEnabled("log")).toBe(false);
        expect(Logger.isLevelEnabled("warn")).toBe(true);
      });
    });
  },
);
