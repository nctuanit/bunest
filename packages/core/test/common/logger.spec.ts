import { describe, expect, it } from "bun:test";
import { ConsoleLogger, Logger, type LogLevel } from "../../src/common";

describe("Logger", () => {
  it("filters output by configured log levels and includes context", () => {
    const captured: Array<{ line: string; level: LogLevel }> = [];
    const logger = new Logger("AuthService", {
      levels: ["error", "warn"],
      timestamp: false,
      colors: false,
      writer: (line, level) => captured.push({ line, level }),
    });

    logger.debug("should not appear");
    logger.log("should not appear");
    logger.warn("rate limit nearing");
    logger.error("token expired");

    expect(captured).toHaveLength(2);
    expect(captured[0]).toEqual({
      level: "warn",
      line: `[Bunest] ${process.pid}  -    WARN [AuthService] rate limit nearing`,
    });
    expect(captured[1]).toEqual({
      level: "error",
      line: `[Bunest] ${process.pid}  -   ERROR [AuthService] token expired`,
    });

    logger.setLogLevels(["debug"]);
    logger.debug("now visible");
    expect(captured).toHaveLength(3);
    expect(captured[2]?.level).toBe("debug");
  });

  it("renders NestJS-style ANSI colors for all log levels, yellow [Context], and yellow +Nms diff", () => {
    const captured: Array<{ line: string; level: LogLevel }> = [];
    const logger = new Logger("UsersService", {
      colors: true,
      timestamp: true,
      timestampDiff: true,
      writer: (line, level) => captured.push({ line, level }),
    });

    logger.log("Fetching all users");
    logger.warn("Cache miss");
    logger.error("Database failed");
    logger.debug("Query plan");
    logger.verbose("Raw payload");
    logger.fatal("Out of memory");

    expect(captured).toHaveLength(6);

    // LOG: green prefix/level/message, yellow [Context]
    expect(captured[0]!.line).toContain(`\x1b[32m[Bunest] ${process.pid}  - \x1b[39m`);
    expect(captured[0]!.line).toContain("\x1b[32m    LOG\x1b[39m");
    expect(captured[0]!.line).toContain("\x1b[33m[UsersService] \x1b[39m");
    expect(captured[0]!.line).toContain("\x1b[32mFetching all users\x1b[39m");

    // WARN: yellow prefix/level/message, yellow +Nms diff on subsequent logs
    expect(captured[1]!.line).toContain("\x1b[33m   WARN\x1b[39m");
    expect(captured[1]!.line).toContain("\x1b[33mCache miss\x1b[39m");
    expect(captured[1]!.line).toMatch(/\x1b\[33m \+\d+ms\x1b\[39m$/);

    // ERROR: red
    expect(captured[2]!.line).toContain("\x1b[31m  ERROR\x1b[39m");
    expect(captured[2]!.line).toContain("\x1b[31mDatabase failed\x1b[39m");

    // DEBUG: magentaBright
    expect(captured[3]!.line).toContain("\x1b[95m  DEBUG\x1b[39m");
    expect(captured[3]!.line).toContain("\x1b[95mQuery plan\x1b[39m");

    // VERBOSE: cyanBright
    expect(captured[4]!.line).toContain("\x1b[96mVERBOSE\x1b[39m");
    expect(captured[4]!.line).toContain("\x1b[96mRaw payload\x1b[39m");

    // FATAL: bold red
    expect(captured[5]!.line).toContain("\x1b[1m\x1b[31m  FATAL\x1b[0m");
    expect(captured[5]!.line).toContain("\x1b[1m\x1b[31mOut of memory\x1b[0m");

    // Stripping ANSI produces clean aligned NestJS text
    const plain = Bun.stripANSI(captured[1]!.line);
    expect(plain).toMatch(
      new RegExp(
        `^\\[Bunest\\] ${process.pid}  - .+    WARN \\[UsersService\\] Cache miss \\+\\d+ms$`,
      ),
    );
  });

  it("respects NO_COLOR and prints error stack traces on a separate line without treating them as context", () => {
    const prevNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const lines: string[] = [];
      const logger = new Logger(undefined, {
        timestamp: false,
        writer: (line) => lines.push(line),
      });

      const stack = "Error: boom\n    at UsersService.find (/app/users.ts:42:11)";
      logger.error("Request failed", stack);

      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain("\x1b[");
      expect(lines[0]).toBe(
        `[Bunest] ${process.pid}  -   ERROR Request failed\n${stack}`,
      );
    } finally {
      if (prevNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prevNoColor;
      }
    }
  });

  it("ConsoleLogger applies NestJS yellow to [Context] and +Nms diff and respects NO_COLOR", () => {
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const logger = new ConsoleLogger("OrdersService", {
        colors: true,
        timestamp: true,
      });
      logger.log("First");
      logger.debug("Second");

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toContain("\x1b[32m    LOG\x1b[39m");
      expect(chunks[0]).toContain("\x1b[33m[OrdersService] \x1b[39m");
      expect(chunks[1]).toContain("\x1b[95m  DEBUG\x1b[39m");
      expect(chunks[1]).toMatch(/\x1b\[33m \+\d+ms\x1b\[39m\n$/);
    } finally {
      process.stdout.write = origWrite;
    }
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
