import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  Logger,
  type OnModuleInit,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  CapturingLogger,
  Test,
  describeConformance,
  request,
} from "../../../_helpers";

@Injectable()
class OrdersService implements OnModuleInit {
  private readonly logger = new Logger(OrdersService.name);

  onModuleInit() {
    this.logger.log("Orders service ready", { region: "eu" });
  }

  findAll() {
    this.logger.debug("Listing orders");
    return [];
  }

  fail(): never {
    throw new Error("Database unavailable");
  }
}

@Controller("orders")
class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  findAll() {
    return this.ordersService.findAll();
  }

  @Get("broken")
  broken() {
    return this.ordersService.fail();
  }
}

describeConformance(
  "CapturingLogger (integration)",
  {
    upstreamPath: "integration/hello-world/e2e/capturing-logger.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let app: BunestApplication;
    let logger: CapturingLogger;

    beforeEach(() => {
      logger = new CapturingLogger();
    });

    afterEach(async () => {
      await app?.close();
      Logger.overrideLogger(true);
    });

    describe("when set on the testing module builder", () => {
      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          controllers: [OrdersController],
          providers: [OrdersService],
        })
          .setLogger(logger)
          .compile();

        app = moduleRef.createNestApplication();
        await app.init();
      });

      it("should capture the framework startup logs", () => {
        logger.assertLogged(/orders/, "log");
      });

      it('should capture the logs of "Logger" instances in providers', async () => {
        logger.assertLogged("Orders service ready", "log");
        await request(app).get("/orders").expect(200);
        logger.assertLogged("Listing orders", "debug");
      });

      it("should capture unhandled exceptions via default exception filter", async () => {
        logger.clear();

        await request(app).get("/orders/broken").expect(500);

        const entry = logger.assertLogged(/Database unavailable/, "error");
        expect(entry.level).toBe("error");
      });
    });

    describe('when set with "useLogger"', () => {
      it("should attach custom CapturingLogger and capture runtime error logs", async () => {
        const moduleRef = await Test.createTestingModule({
          controllers: [OrdersController],
          providers: [OrdersService],
        }).compile();

        app = moduleRef.createNestApplication();
        app.useLogger(logger);
        await app.init();

        await request(app).get("/orders/broken").expect(500);
        logger.assertLogged(/Database unavailable/, "error");
      });
    });
  },
);
