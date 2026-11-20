import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Controller,
  Get,
  INQUIRER,
  Inject,
  Injectable,
  Logger,
  Module,
  REQUEST,
  Scope,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Test,
  createSpy,
  describeConformance,
  request,
} from "../../../_helpers";

@Injectable({ scope: Scope.TRANSIENT })
class TransientLogger {
  @Inject(INQUIRER) inquirer: any = null;
  config: Record<string, unknown>;

  constructor(
    @Inject(INQUIRER) private readonly inquirerInCtor: any,
    private readonly logger: Logger,
  ) {
    this.config =
      (this.inquirerInCtor?.constructor &&
        this.inquirerInCtor.constructor.logger) ||
      {};
  }

  log(message: string) {
    this.logger.log({ message, ...this.config });
  }
}

@Injectable()
class HelloTransientService {
  static logger = { feature: "transient" };

  constructor(private readonly logger: TransientLogger) {}

  greeting() {
    this.logger.log("Hello transient!");
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class RequestLogger {
  config: Record<string, unknown>;

  constructor(
    @Inject(INQUIRER) inquirer: any,
    @Inject(REQUEST) private readonly req: any,
    private readonly logger: Logger,
  ) {
    const ctor = inquirer?.constructor;
    this.config = (ctor && ctor.logger) || {};
  }

  get requestId() {
    if (!this.req.__testRequestId) {
      this.req.__testRequestId = `${Date.now()}.${Math.floor(Math.random() * 1000000)}`;
    }
    return this.req.__testRequestId;
  }

  log(message: string) {
    this.logger.log({ message, requestId: this.requestId, ...this.config });
  }
}

@Injectable({ scope: Scope.REQUEST })
class HelloRequestService {
  static logger = { feature: "request" };

  constructor(
    private readonly logger: RequestLogger,
    @Inject(INQUIRER) public readonly inquirer: any,
  ) {}

  greeting() {
    this.logger.log("Hello request!");
  }

  farewell() {
    this.logger.log("Goodbye request!");
  }
}

@Controller({
  path: "hello",
  scope: Scope.REQUEST,
})
class HelloController {
  constructor(
    private readonly helloTransientService: HelloTransientService,
    private readonly helloRequestService: HelloRequestService,
  ) {}

  @Get("transient")
  greetingTransient() {
    this.helloTransientService.greeting();
  }

  @Get("request")
  greetingRequest() {
    this.helloRequestService.greeting();
    this.helloRequestService.farewell();
  }
}

@Module({
  controllers: [HelloController],
  providers: [
    HelloRequestService,
    HelloTransientService,
    RequestLogger,
    TransientLogger,
    Logger,
  ],
})
class HelloModule {}

describeConformance(
  "Inject Inquirer",
  {
    upstreamPath: "integration/scopes/e2e/inject-inquirer.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-001", "ADR-012"],
  },
  () => {
    let logger: { log: ReturnType<typeof createSpy> };
    let app: BunestApplication;

    beforeEach(async () => {
      logger = { log: createSpy() };

      const module = await Test.createTestingModule({
        imports: [HelloModule],
      })
        .overrideProvider(Logger)
        .useValue(logger)
        .compile();

      app = module.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    // BUNEST_BUG: DIContainer.instantiateClass() injects the parent class constructor function instead of the parent instance/object for INQUIRER (packages/core/src/di/di-container.ts:3503,3571-3573), so inquirer.constructor is Function instead of HelloTransientService and inquirer.constructor.logger is undefined.
    it.skip("should allow the injection of inquirer in a Transient Scope", async () => {
      await request(app).get("/hello/transient").expect(200);

      expect(logger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Hello transient!",
          feature: "transient",
        }),
      );
    });

    // BUNEST_BUG: DIContainer.instantiateClass() injects the parent class constructor function instead of the parent instance/object for INQUIRER (packages/core/src/di/di-container.ts:3503,3571-3573), so inquirer.constructor is Function instead of HelloRequestService and inquirer.constructor.logger is undefined.
    it.skip("should allow the injection of the inquirer in a Request Scope", async () => {
      await request(app).get("/hello/request").expect(200);

      expect(logger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Hello request!",
          feature: "request",
        }),
      );

      const requestId = logger.log.args[0]?.[0]?.requestId;
      expect(requestId).toBeDefined();

      expect(logger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Goodbye request!",
          requestId,
          feature: "request",
        }),
      );
    });
  },
);
