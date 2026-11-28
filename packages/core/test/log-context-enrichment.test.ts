import { describe, expect, it } from "bun:test";
import {
  ClsModule,
  ClsService,
  ConsoleLogger,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  registerLogContextProvider,
} from "../src/index";
import { BunestFactory } from "../src/index";

describe("Structured Log Context Enrichment (requestId + CLS)", () => {
  it("automatically enriches Logger(json: true) with active HTTP requestId and ClsService fields", async () => {
    const lines: string[] = [];
    const logger = new Logger("OrdersService", {
      json: true,
      redactKeys: ["apiSecret"],
      writer: (line) => lines.push(line),
    });

    @Injectable()
    class OrdersService {
      constructor(private readonly cls: ClsService) {}

      createOrder(): { ok: boolean } {
        this.cls.set("tenantId", "tenant-42");
        this.cls.set("apiSecret", "super-secret-token");
        logger.log("Order created", { orderId: "ord-1" });
        return { ok: true };
      }
    }

    @Controller("orders")
    class OrdersController {
      constructor(private readonly orders: OrdersService) {}

      @Get()
      create() {
        return this.orders.createOrder();
      }
    }

    @Module({
      imports: [
        ClsModule.forRoot({
          global: true,
          middleware: { mount: true },
          enrichLogs: ["clsId", "tenantId", "apiSecret"],
        }),
      ],
      controllers: [OrdersController],
      providers: [OrdersService],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    await app.init();

    try {
      const res = await app.fetch(
        new Request("http://localhost/orders", {
          headers: { "x-request-id": "req-abc-123" },
        }),
      );
      expect(res.status).toBe(200);
      expect(lines).toHaveLength(1);

      const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(parsed.message).toBe("Order created");
      expect(parsed.context).toBe("OrdersService");
      expect(parsed.requestId).toBe("req-abc-123");
      expect(parsed.clsId).toBe("req-abc-123");
      expect(parsed.tenantId).toBe("tenant-42");
      expect(parsed.apiSecret).toBe("[REDACTED]");
      expect(parsed.meta).toEqual({ orderId: "ord-1" });
    } finally {
      await app.close();
    }
  });

  it("supports ConsoleLogger(json: true), custom enrichContext provider, and enrichContext: false", () => {
    const unregister = registerLogContextProvider(() => ({
      correlationId: "corr-99",
    }));

    try {
      const enrichedLogger = new ConsoleLogger("TestCtx", {
        json: true,
        flattenParams: true,
      });
      const jsonObj = (
        enrichedLogger as unknown as {
          getJsonLogObject(
            msg: unknown,
            opts: {
              context: string;
              logLevel: "log";
              params?: Record<string, unknown>;
            },
          ): Record<string, unknown>;
        }
      ).getJsonLogObject("hello", {
        context: "TestCtx",
        logLevel: "log",
        params: { correlationId: "explicit-override", extra: 1 },
      });

      // Explicit params override auto-enriched fields
      expect(jsonObj.correlationId).toBe("explicit-override");
      expect(jsonObj.extra).toBe(1);

      const disabledLines: string[] = [];
      const disabledLogger = new Logger("Quiet", {
        json: true,
        enrichContext: false,
        writer: (line) => disabledLines.push(line),
      });
      disabledLogger.log("no-enrich");
      const disabledObj = JSON.parse(disabledLines[0]!) as Record<
        string,
        unknown
      >;
      expect(disabledObj.correlationId).toBeUndefined();

      const customLines: string[] = [];
      const customLogger = new Logger("Custom", {
        json: true,
        enrichContext: () => ({ serviceVersion: "1.2.3" }),
        writer: (line) => customLines.push(line),
      });
      customLogger.log("with-custom");
      const customObj = JSON.parse(customLines[0]!) as Record<string, unknown>;
      expect(customObj.serviceVersion).toBe("1.2.3");
      expect(customObj.correlationId).toBeUndefined();

      // Throwing custom enrichContext callback must not crash logging
      const throwingLines: string[] = [];
      const throwingLogger = new Logger("Safe", {
        json: true,
        enrichContext: () => {
          throw new Error("provider boom");
        },
        writer: (line) => throwingLines.push(line),
      });
      throwingLogger.log("still-logs");
      expect(JSON.parse(throwingLines[0]!).message).toBe("still-logs");

      const throwingConsole = new ConsoleLogger("SafeConsole", {
        json: true,
        enrichContext: () => {
          throw new Error("console boom");
        },
      });
      const safeObj = (
        throwingConsole as unknown as {
          getJsonLogObject(
            msg: unknown,
            opts: { context: string; logLevel: "log" },
          ): Record<string, unknown>;
        }
      ).getJsonLogObject("safe", { context: "SafeConsole", logLevel: "log" });
      expect(safeObj.message).toBe("safe");
    } finally {
      unregister();
    }
  });
});
