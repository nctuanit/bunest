import { describe, expect, it } from "bun:test";
import {
  DEFAULT_REDACT_KEYS,
  Logger,
  type LogLevel,
} from "../../../../../packages/core/src/common";
import {
  OBSERVABILITY_LOGGER_OPTIONS,
  ObservabilityLogger,
  generateSpanId,
  generateTraceId,
  traceContextStorage,
} from "../../../../../packages/observability/src";
import { Test, describeConformance, itAdapted } from "../../../_helpers/index";

describeConformance(
  "Log Redaction & Correlated Structured Logging (ObservabilityLogger + Logger)",
  {
    upstreamPath: "observe/src/utils/log-redactor.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/observe LogRedactor security conformance to @bunest/observability ObservabilityLogger + @bunest/common Logger deep immutable key-based redaction engine (covering structured metadata, Headers, Map, Error, nested objects/arrays, circular references, custom keys/masks, and ALS trace correlation).",
  },
  () => {
    const logger = new Logger("TestContext");

    describe("default sensitive keys in structured attributes", () => {
      it.each([
        "password",
        "passwd",
        "secret",
        "token",
        "accessToken",
        "access_token",
        "refreshToken",
        "refresh-token",
        "apiKey",
        "api_key",
        "Api-Key",
        "authorization",
        "cookie",
        "setCookie",
        "set-cookie",
        "privateKey",
        "private_key",
        "clientSecret",
        "client_secret",
        "creditCard",
        "credit_card",
        "ssn",
        "jwt",
        "bearer",
        "sessionId",
        "session_id",
        "SESSIONID",
      ])(
        "masks sensitive key %s while preserving ordinary sibling fields",
        (key) => {
          const input = { userId: "u-1", [key]: "super-secret-value" };
          const output = logger.redact(input);

          expect(output).toEqual({ userId: "u-1", [key]: "[REDACTED]" });
          // Original object must not be mutated
          expect(input[key]).toBe("super-secret-value");
        },
      );

      it("exposes all canonical DEFAULT_REDACT_KEYS", () => {
        for (const expected of [
          "password",
          "passwd",
          "secret",
          "token",
          "accesstoken",
          "refreshtoken",
          "apikey",
          "authorization",
          "cookie",
          "setcookie",
          "privatekey",
          "clientsecret",
          "creditcard",
          "ssn",
          "jwt",
          "bearer",
          "sessionid",
        ]) {
          expect(DEFAULT_REDACT_KEYS).toContain(expected);
        }
      });

      it("is case-insensitive and normalizes hyphens, underscores, and spaces in keys", () => {
        const output = logger.redact({
          PASSWORD: "a",
          "Api-Key": "b",
          access_token: "c",
          "credit card": "4242-4242-4242-4242",
          SESSIONID: "d",
        });

        expect(output).toEqual({
          PASSWORD: "[REDACTED]",
          "Api-Key": "[REDACTED]",
          access_token: "[REDACTED]",
          "credit card": "[REDACTED]",
          SESSIONID: "[REDACTED]",
        });
      });

      it("masks a sensitive key holding a nested object or array wholesale without leaking inner keys", () => {
        const output: unknown = logger.redact({
          authorization: { scheme: "Bearer", raw: "abc123def" },
          secret: ["part1", "part2"],
          retries: 3,
        });

        expect(output).toEqual({
          authorization: "[REDACTED]",
          secret: "[REDACTED]",
          retries: 3,
        });
      });

      it("masks compound keys containing sensitive stems", () => {
        const output = logger.redact({
          dbPassword: "hunter2",
          passwordConfirmation: "hunter2",
          resetToken: "tok_999",
          clientSecret: "s3cr3t",
          user_jwt: "eyJhbGciOiJIUzI1NiJ9.payload.sig",
          "x-api-key": "sk_live_123",
          author: "bob",
          sortKey: "name",
        });

        expect(output).toEqual({
          dbPassword: "[REDACTED]",
          passwordConfirmation: "[REDACTED]",
          resetToken: "[REDACTED]",
          clientSecret: "[REDACTED]",
          user_jwt: "[REDACTED]",
          "x-api-key": "[REDACTED]",
          author: "bob",
          sortKey: "name",
        });
      });
    });

    describe("deep structures, Web Headers, Maps, Errors, and special JS types", () => {
      it("redacts secrets recursively inside nested objects and arrays", () => {
        const output = logger.redact({
          request: {
            method: "POST",
            headers: {
              authorization: "Bearer dXNlcjpwYXNzd29yZA==",
              "x-request-id": "req-1",
            },
            items: [
              { id: 1, token: "secret-1" },
              { id: 2, label: "harmless" },
            ],
          },
        });

        expect(output).toEqual({
          request: {
            method: "POST",
            headers: {
              authorization: "[REDACTED]",
              "x-request-id": "req-1",
            },
            items: [
              { id: 1, token: "[REDACTED]" },
              { id: 2, label: "harmless" },
            ],
          },
        });
      });

      it("redacts sensitive headers inside Web Headers instances", () => {
        const headers = new Headers({
          Authorization: "Bearer super-secret-token",
          Cookie: "connect.sid=s%3AQb2x; theme=dark",
          "Set-Cookie": "session=xyz; HttpOnly",
          "X-Api-Key": "sk_live_abc",
          "Content-Type": "application/json",
        });

        const output = logger.redact(headers) as unknown as Record<
          string,
          string
        >;

        expect(output.authorization).toBe("[REDACTED]");
        expect(output.cookie).toBe("[REDACTED]");
        expect(output["set-cookie"]).toBe("[REDACTED]");
        expect(output["x-api-key"]).toBe("[REDACTED]");
        expect(output["content-type"]).toBe("application/json");
      });

      it("redacts sensitive entries inside Map instances", () => {
        const map = new Map<string, unknown>([
          ["password", "7822abcd"],
          ["token", "abc123def"],
          ["user", "alice"],
          ["nested", { apiKey: "k-1", ok: true }],
        ]);

        const output = logger.redact(map) as unknown as Record<string, unknown>;

        expect(output).toEqual({
          password: "[REDACTED]",
          token: "[REDACTED]",
          user: "alice",
          nested: { apiKey: "[REDACTED]", ok: true },
        });
      });

      it("redacts enumerable secret properties attached to Error instances", () => {
        const err = Object.assign(new Error("DB connect failed"), {
          code: "ECONNREFUSED",
          password: "hunter2",
          config: { apiKey: "secret-key", host: "127.0.0.1" },
        });

        const output = logger.redact(err) as unknown as Record<string, unknown>;

        expect(output.name).toBe("Error");
        expect(output.message).toBe("DB connect failed");
        expect(typeof output.stack).toBe("string");
        expect(output.code).toBe("ECONNREFUSED");
        expect(output.password).toBe("[REDACTED]");
        expect(output.config).toEqual({
          apiKey: "[REDACTED]",
          host: "127.0.0.1",
        });
      });

      it("handles circular references without throwing and preserves shared non-cyclic references", () => {
        const shared = { ok: true, secret: "hide-me" };
        const cyclic: Record<string, unknown> = {
          name: "root",
          a: shared,
          b: shared,
        };
        cyclic.self = cyclic;

        const output = logger.redact(cyclic);

        expect(output.name).toBe("root");
        expect(output.self).toBe("[Circular]");
        expect(output.a).toEqual({ ok: true, secret: "[REDACTED]" });
        expect(output.b).toEqual({ ok: true, secret: "[REDACTED]" });
      });

      it("preserves primitive leaves and converts Date, RegExp, and bigint safely", () => {
        const now = new Date("2026-10-29T12:00:00.000Z");
        expect(logger.redact(undefined)).toBeUndefined();
        expect(logger.redact(null)).toBeNull();
        expect(logger.redact("GET /orders 200 in 12ms")).toBe(
          "GET /orders 200 in 12ms",
        );

        const output = logger.redact({
          count: 5,
          ok: true,
          missing: null,
          at: now,
          pattern: /abc/gi,
          big: 9007199254740993n,
        }) as unknown as Record<string, unknown>;

        expect(output).toEqual({
          count: 5,
          ok: true,
          missing: null,
          at: "2026-10-29T12:00:00.000Z",
          pattern: "/abc/gi",
          big: "9007199254740993",
        });
      });
    });

    describe("configuration (custom redactKeys & redactionMask)", () => {
      it("uses a custom redactionMask string", () => {
        const custom = new Logger("Custom", { redactionMask: "***" });

        expect(custom.redact({ password: "hunter2", user: "bob" })).toEqual({
          password: "***",
          user: "bob",
        });
      });

      it("accepts extra sensitive redactKeys merged with defaults", () => {
        const custom = new Logger("Custom", {
          redactKeys: ["nationalId", "tenant_ref", "credentials", "pwd"],
        });

        const output: unknown = custom.redact({
          nationalId: "123-45-6789",
          tenantRef: "acme-secret",
          credentials: { user: "root", pass: "123" },
          pwd: "abc",
          password: "still-redacted",
          other: "keep",
        });

        expect(output).toEqual({
          nationalId: "[REDACTED]",
          tenantRef: "[REDACTED]",
          credentials: "[REDACTED]",
          pwd: "[REDACTED]",
          password: "[REDACTED]",
          other: "keep",
        });
      });
    });

    describe("ObservabilityLogger structured JSON/text output & trace correlation", () => {
      itAdapted(
        ["ADR-001"],
        "redacts secrets in JSON log messages and metadata while injecting active trace correlation",
        () => {
          const lines: Array<{ line: string; level: LogLevel }> = [];
          const obsLogger = new ObservabilityLogger({
            serviceName: "payments-api",
            context: "CheckoutService",
            json: true,
            redactKeys: ["cvv"],
            writer: (line, level) => lines.push({ line, level }),
          });

          const traceId = generateTraceId();
          const spanId = generateSpanId();
          const parentSpanId = generateSpanId();

          traceContextStorage.run(
            {
              traceId,
              spanId,
              parentSpanId,
              traceFlags: 1,
              sampled: true,
              requestId: "req-77",
            },
            () => {
              obsLogger.log("charge completed", {
                orderId: "ord-1",
                password: "hunter2",
                apiKey: "sk_live_secret",
                cvv: "999",
              });
            },
          );

          expect(lines).toHaveLength(1);
          expect(lines[0]!.level).toBe("log");
          const parsed = JSON.parse(lines[0]!.line) as Record<string, any>;

          expect(parsed.level).toBe("log");
          expect(parsed.service).toBe("payments-api");
          expect(parsed.context).toBe("CheckoutService");
          expect(parsed.traceId).toBe(traceId);
          expect(parsed.spanId).toBe(spanId);
          expect(parsed.parentSpanId).toBe(parentSpanId);
          expect(parsed.requestId).toBe("req-77");
          expect(parsed.message).toBe("charge completed");
          expect(parsed.meta).toEqual({
            orderId: "ord-1",
            password: "[REDACTED]",
            apiKey: "[REDACTED]",
            cvv: "[REDACTED]",
          });
          expect(lines[0]!.line).not.toContain("hunter2");
          expect(lines[0]!.line).not.toContain("sk_live_secret");
          expect(lines[0]!.line).not.toContain("999");
        },
        "Bunest combines key-based redaction with W3C TraceContextStorage correlation in ObservabilityLogger",
      );

      it("redacts structured object messages and multi-argument metadata arrays", () => {
        const lines: string[] = [];
        const obsLogger = new ObservabilityLogger({
          context: "Auth",
          json: true,
          timestamp: false,
          writer: (line) => lines.push(line),
        });

        obsLogger.warn(
          { event: "login_failed", password: "secret-password" },
          { token: "tok-1" },
          { ip: "127.0.0.1", cookie: "sid=123" },
        );

        const parsed = JSON.parse(lines[0]!) as Record<string, any>;
        expect(parsed.timestamp).toBeUndefined();
        expect(parsed.message).toEqual({
          event: "login_failed",
          password: "[REDACTED]",
        });
        expect(parsed.meta).toEqual([
          { token: "[REDACTED]" },
          { ip: "127.0.0.1", cookie: "[REDACTED]" },
        ]);
      });

      it("supports text output mode, child() context inheritance, setContext(), trailing context, and includeCorrelation: false", () => {
        const lines: string[] = [];
        const parent = new ObservabilityLogger({
          serviceName: "api",
          json: false,
          timestamp: false,
          redactKeys: ["customSecret"],
          redactionMask: "[MASKED]",
          writer: (line) => lines.push(line),
        });

        // Trailing string param acts as context when logger has no context
        parent.log("hello", { customSecret: "top-secret" }, "InlineCtx");
        expect(lines[0]).toContain("[InlineCtx]");
        expect(lines[0]).toContain("[MASKED]");
        expect(lines[0]).not.toContain("top-secret");

        // child() preserves redaction options and overrides context
        const child = parent.child("ChildWorker");
        const traceId = generateTraceId();
        const spanId = generateSpanId();
        traceContextStorage.run(
          { traceId, spanId, traceFlags: 1, sampled: true, requestId: "r-1" },
          () => {
            child.error("worker failed", {
              password: "pw",
              customSecret: "cs",
            });
          },
        );
        expect(lines[1]).toContain("[ChildWorker]");
        expect(lines[1]).toContain(`[trace=${traceId} span=${spanId}]`);
        expect(lines[1]).toContain("[req=r-1]");
        expect(lines[1]).not.toContain("pw");
        expect(lines[1]).not.toContain("cs");

        // includeCorrelation: false suppresses trace/request correlation fields
        const noCorrLines: string[] = [];
        const noCorr = new ObservabilityLogger({
          json: true,
          includeCorrelation: false,
          writer: (line) => noCorrLines.push(line),
        });
        traceContextStorage.run(
          { traceId, spanId, traceFlags: 1, sampled: true, requestId: "r-1" },
          () => {
            noCorr.log("isolated");
          },
        );
        const parsed = JSON.parse(noCorrLines[0]!) as Record<string, unknown>;
        expect(parsed.traceId).toBeUndefined();
        expect(parsed.spanId).toBeUndefined();
        expect(parsed.requestId).toBeUndefined();
      });

      it("filters log levels via setLogLevels / isLevelEnabled and supports DI via OBSERVABILITY_LOGGER_OPTIONS", async () => {
        const emitted: LogLevel[] = [];
        const mod = await Test.createTestingModule({
          providers: [
            {
              provide: OBSERVABILITY_LOGGER_OPTIONS,
              useValue: {
                context: "Injected",
                levels: ["error", "fatal"] as LogLevel[],
                writer: (_line: string, level: LogLevel) => emitted.push(level),
              },
            },
            ObservabilityLogger,
          ],
        }).compile({ logger: false });

        try {
          const obs = mod.get(ObservabilityLogger);
          expect(obs.isLevelEnabled("error")).toBe(true);
          expect(obs.isLevelEnabled("debug")).toBe(false);

          obs.debug("ignored");
          obs.verbose("ignored");
          obs.log("ignored");
          obs.warn("ignored");
          obs.error("kept-error");
          obs.fatal("kept-fatal");

          expect(emitted).toEqual(["error", "fatal"]);

          obs.setContext("UpdatedCtx");
          obs.setLogLevels(["debug"]);
          expect(obs.isLevelEnabled("debug")).toBe(true);
          expect(obs.isLevelEnabled("error")).toBe(false);
          obs.debug("now-enabled");
          expect(emitted).toEqual(["error", "fatal", "debug"]);
        } finally {
          await mod.close();
        }
      });
    });
  },
);
