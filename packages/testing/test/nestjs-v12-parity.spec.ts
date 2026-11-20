import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { ConsoleLogger, Injectable } from "@bunest/common";
import {
  CapturingLogger,
  Test,
  type CapturedLog,
  type CapturedLogFilter,
  type CapturedLogMatcher,
  type CapturingLoggerOptions,
  type OverrideByFactoryOptions,
} from "../src";

describe("@bunest/testing NestJS v12 Parity Suite", () => {
  it("CapturingLogger extends ConsoleLogger, supports ConsoleLoggerOptions, structured params/error/stack/args, and deep-equal params filtering", () => {
    const opts: CapturingLoggerOptions = {
      context: "DefaultCtx",
      prefix: "TestApp",
      json: false,
      colors: false,
      timestamp: false,
      structuredParams: true,
      print: false,
    };
    const logger = new CapturingLogger(opts);

    expect(logger).toBeInstanceOf(ConsoleLogger);
    expect(logger.isLevelEnabled("log")).toBe(true);
    expect(logger.isLevelEnabled("debug")).toBe(true);

    // Context management inherited from ConsoleLogger
    logger.setContext("PaymentsService");
    logger.warn("Retrying payment", { orderId: 42, meta: { attempt: 2 } }, { region: "us-east" });
    logger.resetContext();
    logger.log(() => "Lazy evaluated message");

    const boom = new Error("gateway timeout");
    logger.error(boom, "GatewayClient");
    logger.fatal("Fatal crash", new Error("oom"), "FatalCtx");

    const entries: CapturedLog[] = logger.entries;
    expect(entries).toHaveLength(4);

    // Entry 0: merged structured params & context from setContext
    expect(entries[0]).toMatchObject({
      level: "warn",
      message: "Retrying payment",
      context: "PaymentsService",
      params: { orderId: 42, meta: { attempt: 2 }, region: "us-east" },
    });
    expect(entries[0]!.args.length).toBe(3);

    // Entry 1: lazy message evaluated + resetContext restored DefaultCtx
    expect(entries[1]).toMatchObject({
      level: "log",
      message: "Lazy evaluated message",
      context: "DefaultCtx",
    });

    // Entry 2: Error logged as message -> message is error.message, error is Error instance
    expect(entries[2]!.message).toBe("gateway timeout");
    expect(entries[2]!.error).toBe(boom);
    expect(entries[2]!.context).toBe("GatewayClient");

    // Entry 3: trailing Error captured alongside message
    expect(entries[3]!.error).toBeInstanceOf(Error);
    expect(entries[3]!.error?.message).toBe("oom");
    expect(entries[3]!.context).toBe("FatalCtx");

    // NestJS v12 CapturedLogFilter & CapturedLogMatcher with deep-equal params matching
    const filter: CapturedLogFilter = {
      level: "warn",
      context: "PaymentsService",
      message: /Retrying/,
      params: { orderId: 42, meta: { attempt: 2 } },
    };
    const matcher: CapturedLogMatcher = filter;
    expect(logger.filter(matcher)).toHaveLength(1);
    expect(logger.find(matcher)?.params?.region).toBe("us-east");
    expect(logger.assertLogged(matcher).context).toBe("PaymentsService");

    // Non-matching deep param fails match
    logger.assertNotLogged({
      level: "warn",
      params: { meta: { attempt: 999 } },
    });
    expect(() =>
      logger.assertLogged({ level: "warn", params: { orderId: 999 } }),
    ).toThrow(/Expected a log entry/);

    // Predicate matcher in filter/find/assertLogged/assertNotLogged
    expect(logger.filter((e) => e.error !== undefined)).toHaveLength(2);
    expect(logger.find((e) => e.level === "fatal")?.context).toBe("FatalCtx");

    // Log levels filtering (`logLevels` and legacy `levels` alias)
    logger.setLogLevels(["error"]);
    expect(logger.isLevelEnabled("warn")).toBe(false);
    expect(logger.isLevelEnabled("error")).toBe(true);
    logger.warn("filtered-out-warn");
    expect(logger.entries).toHaveLength(4);

    const legacyLevelsLogger = new CapturingLogger({ levels: ["warn"] });
    expect(legacyLevelsLogger.isLevelEnabled("warn")).toBe(true);
    expect(legacyLevelsLogger.isLevelEnabled("log")).toBe(false);
  });

  it("exports OverrideByFactoryOptions and TestingModule inherits flushLogsOnOverride() & selectContextModule()", async () => {
    @Injectable()
    class TokenService {
      getValue() {
        return "real";
      }
    }

    const factoryOverride: OverrideByFactoryOptions<{ getValue(): string }> = {
      factory: () => ({ getValue: () => "from-override-by-factory-options" }),
      inject: [],
    };

    const mod = await Test.createTestingModule({
      providers: [TokenService],
    })
      .overrideProvider(TokenService)
      .useFactory(factoryOverride)
      .compile();

    try {
      expect(mod.get(TokenService).getValue()).toBe(
        "from-override-by-factory-options",
      );
      expect(typeof mod.flushLogsOnOverride).toBe("function");
      expect(typeof mod.selectContextModule).toBe("function");
      mod.flushLogsOnOverride();
      mod.selectContextModule();
    } finally {
      await mod.close();
    }
  });
});
