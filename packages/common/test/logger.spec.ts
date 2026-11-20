import { describe, expect, it } from "bun:test";
import { Logger, type LogLevel } from "../src";

describe("Logger", () => {
  it("filters output by configured log levels and includes context", () => {
    const captured: Array<{ line: string; level: LogLevel }> = [];
    const logger = new Logger("AuthService", {
      levels: ["error", "warn"],
      timestamp: false,
      writer: (line, level) => captured.push({ line, level }),
    });

    logger.debug("should not appear");
    logger.log("should not appear");
    logger.warn("rate limit nearing");
    logger.error("token expired");

    expect(captured).toHaveLength(2);
    expect(captured[0]).toEqual({
      level: "warn",
      line: "[Bunest] WARN [AuthService] rate limit nearing",
    });
    expect(captured[1]).toEqual({
      level: "error",
      line: "[Bunest] ERROR [AuthService] token expired",
    });

    logger.setLogLevels(["debug"]);
    logger.debug("now visible");
    expect(captured).toHaveLength(3);
    expect(captured[2]?.level).toBe("debug");
  });

  it("emits valid structured JSON and redacts secret keys deeply without mutating input", () => {
    const lines: string[] = [];
    const logger = new Logger("HttpPipeline", {
      json: true,
      redactKeys: ["x-internal-pin"],
      writer: (line) => lines.push(line),
    });

    const headers = new Headers({
      "content-type": "application/json",
      authorization: "Bearer super-secret-jwt",
      "x-api-key": "sk_live_12345",
    });

    const circular: Record<string, unknown> = {
      user: "alice",
      password: "my-password",
      nested: {
        refresh_token: "rt_999",
        clientSecret: "cs_888",
        "X-Internal-Pin": "9999",
        safe: "ok",
      },
      headers,
    };
    circular.self = circular;

    logger.log("request received", circular);

    // Caller's object MUST NOT be mutated
    expect(circular.password).toBe("my-password");
    expect((circular.nested as Record<string, unknown>).refresh_token).toBe(
      "rt_999",
    );

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, any>;
    expect(parsed.level).toBe("log");
    expect(parsed.context).toBe("HttpPipeline");
    expect(parsed.message).toBe("request received");
    expect(typeof parsed.timestamp).toBe("string");

    expect(parsed.meta.user).toBe("alice");
    expect(parsed.meta.password).toBe("[REDACTED]");
    expect(parsed.meta.nested.refresh_token).toBe("[REDACTED]");
    expect(parsed.meta.nested.clientSecret).toBe("[REDACTED]");
    expect(parsed.meta.nested["X-Internal-Pin"]).toBe("[REDACTED]");
    expect(parsed.meta.nested.safe).toBe("ok");
    expect(parsed.meta.headers["content-type"]).toBe("application/json");
    expect(parsed.meta.headers.authorization).toBe("[REDACTED]");
    expect(parsed.meta.headers["x-api-key"]).toBe("[REDACTED]");
    expect(parsed.meta.self).toBe("[Circular]");
  });

  it("supports static overrideLogger", () => {
    const entries: string[] = [];
    Logger.overrideLogger({
      log: (m) => entries.push(`log:${String(m)}`),
      error: (m) => entries.push(`error:${String(m)}`),
      warn: (m) => entries.push(`warn:${String(m)}`),
    });

    Logger.log("booted");
    Logger.warn("careful");
    Logger.error("boom");
    expect(entries).toEqual(["log:booted", "warn:careful", "error:boom"]);

    // Restore default
    Logger.overrideLogger(true);
  });

  it("preserves shared non-circular sibling references and safely serializes BigInt values", () => {
    const lines: string[] = [];
    const logger = new Logger("SqlService", {
      json: true,
      timestamp: false,
      writer: (line) => lines.push(line),
    });

    const shared = { id: 123n, password: "secret", label: "ok" };
    const payload = {
      first: shared,
      second: shared,
      rowCount: 9007199254740993n,
    };

    logger.log("query completed", payload);

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, any>;
    expect(parsed.meta.first).toEqual({
      id: "123",
      password: "[REDACTED]",
      label: "ok",
    });
    expect(parsed.meta.second).toEqual({
      id: "123",
      password: "[REDACTED]",
      label: "ok",
    });
    expect(parsed.meta.rowCount).toBe("9007199254740993");
  });
});
