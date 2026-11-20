import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { TestingLogger, describeConformance } from "../../../_helpers";

describeConformance(
  "TestingLogger",
  {
    upstreamPath: "packages/testing/test/testing-logger.service.spec.ts",
    category: "DIRECT_PORT",
    notes: "Bunest TestingLogger emits errors via console.error and silences log/warn/debug/verbose by default.",
  },
  () => {
    let logger: TestingLogger;
    let consoleErrorSpy: ReturnType<typeof spyOn>;
    let consoleLogSpy: ReturnType<typeof spyOn>;
    let consoleWarnSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      logger = new TestingLogger();
      consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
      consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
      consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    });

    describe("log", () => {
      it("should be a no-op", () => {
        expect(() => logger.log("message")).not.toThrow();
        expect(consoleLogSpy).not.toHaveBeenCalled();
      });
    });

    describe("warn", () => {
      it("should be a no-op", () => {
        expect(() => logger.warn("message")).not.toThrow();
        expect(consoleWarnSpy).not.toHaveBeenCalled();
      });
    });

    describe("debug", () => {
      it("should be a no-op", () => {
        expect(() => logger.debug("message")).not.toThrow();
        expect(consoleLogSpy).not.toHaveBeenCalled();
      });
    });

    describe("verbose", () => {
      it("should be a no-op", () => {
        expect(() => logger.verbose("message")).not.toThrow();
        expect(consoleLogSpy).not.toHaveBeenCalled();
      });
    });

    describe("error", () => {
      it("should emit error output", () => {
        logger.error("something went wrong");
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        expect(consoleErrorSpy.mock.calls[0]).toContain("something went wrong");
      });

      it("should pass optional params when logging error", () => {
        logger.error("error message", "stack trace");
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        expect(consoleErrorSpy.mock.calls[0]).toContain("error message");
        expect(consoleErrorSpy.mock.calls[0]).toContain("stack trace");
      });
    });
  },
);
