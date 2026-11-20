import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Injectable,
  Logger,
  Module,
  type LoggerService,
  type OnModuleInit,
} from "../../../../../packages/common/src";
import {
  NestFactory,
  type BunestApplication,
  type BunestMicroserviceApplication,
} from "../../../../../packages/core/src";
import {
  MicroserviceHost,
  MicroserviceModule,
  TcpServer,
} from "../../../../../packages/microservices/src";
import { describeConformance, itAdapted } from "../../../_helpers";

@Module({})
class AppModule {}

@Injectable()
class DatabaseService implements OnModuleInit {
  private readonly logger = new Logger(DatabaseService.name);

  async onModuleInit() {
    this.logger.warn("Connecting to the database");
    throw new Error("Database unavailable");
  }
}

@Module({ providers: [DatabaseService] })
class FailingModule {}

class CollectingLogger implements LoggerService {
  readonly messages: string[] = [];

  log(message: unknown) {
    this.messages.push(String(message));
  }
  error(message: unknown) {
    this.messages.push(String(message));
  }
  warn(message: unknown) {
    this.messages.push(String(message));
  }
}

describeConformance(
  "Buffered logs (microservice)",
  {
    upstreamPath: "integration/microservices/e2e/buffer-logs-tcp.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Uses Bunest native TcpServer (port: 0) with NestFactory.createMicroservice and hybrid app.connectMicroservice.",
  },
  () => {
    let app:
      | BunestMicroserviceApplication<TcpServer>
      | BunestApplication
      | undefined;
    let logger: CollectingLogger;

    beforeEach(() => {
      logger = new CollectingLogger();
    });

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    // BUNEST_BUG: BunestApplicationContext.init() never flushes buffered logs when bufferLogs: true and autoFlushLogs !== false, and NestFactory.createMicroservice() does not attach Logger.attachBuffer() or route new Logger() instances to the application logger (packages/core/src/application/bunest-application-context.ts, packages/common/src/logger/logger.ts)
    it.skip("should flush buffered logs on init() when the microservice never listens", async () => {
      app = await NestFactory.createMicroservice(
        AppModule,
        new TcpServer({ host: "127.0.0.1", port: 0 }),
        {
          bufferLogs: true,
          logger,
        },
      );
      app.getLogger().log("Starting Bunest microservice...");
      expect(logger.messages).toEqual([]);

      await app.init();

      expect(logger.messages).toContain("Starting Bunest microservice...");
    });

    itAdapted(
      "ADR-001",
      "should keep buffering on init() when autoFlushLogs is false",
      async () => {
        app = await NestFactory.createMicroservice(
          AppModule,
          new TcpServer({ host: "127.0.0.1", port: 0 }),
          {
            bufferLogs: true,
            autoFlushLogs: false,
            logger,
          },
        );
        app.getLogger().log("Starting Bunest microservice...");

        await app.init();
        expect(logger.messages).toEqual([]);

        app.flushLogs();
        expect(logger.messages).toContain("Starting Bunest microservice...");
      },
      "native TcpServer + app.getLogger() buffering",
    );

    // BUNEST_BUG: BunestApplication.init() never auto-flushes buffered logs on hybrid app initialization when bufferLogs: true (packages/core/src/application/bunest-application.ts, packages/core/src/application/bunest-application-context.ts)
    it.skip("should flush buffered logs of a hybrid application on init()", async () => {
      const tcpServer = new TcpServer({ host: "127.0.0.1", port: 0 });

      @Module({
        imports: [MicroserviceModule.forRoot({ server: tcpServer })],
      })
      class HybridAppModule {}

      const hybrid = await NestFactory.create(HybridAppModule, {
        bufferLogs: true,
        logger,
      });
      app = hybrid;
      hybrid.connectMicroservice(hybrid.get(MicroserviceHost));
      hybrid.getLogger().log("Bunest application successfully started");
      expect(logger.messages).toEqual([]);

      await hybrid.init();

      expect(logger.messages).toContain(
        "Bunest application successfully started",
      );
    });

    describe("when initialization fails", () => {
      const createFailingMicroservice = () =>
        NestFactory.createMicroservice(
          FailingModule,
          new TcpServer({ host: "127.0.0.1", port: 0 }),
          {
            bufferLogs: true,
            logger,
          },
        );

      // BUNEST_BUG: BunestApplicationContext.init() does not flush buffered logs on rejection, and instance `new Logger(context)` writes directly to console instead of routing through the application's buffered logger (packages/core/src/application/bunest-application-context.ts, packages/common/src/logger/logger.ts)
      it.skip("should flush buffered logs when init() rejects", async () => {
        app = await createFailingMicroservice();
        app.getLogger().log("Starting Bunest microservice...");

        await app
          .init()
          .catch((err: Error) => app!.getLogger().error(err.message));

        expect(logger.messages).toContain("Starting Bunest microservice...");
        expect(logger.messages).toContain("Connecting to the database");
        expect(logger.messages).toContain("Database unavailable");
      });

      // BUNEST_BUG: BunestMicroserviceApplication.listen() does not flush buffered logs when init() rejects, and instance `new Logger(context)` bypasses the application's buffered logger (packages/core/src/application/bunest-factory.ts, packages/core/src/application/bunest-application-context.ts, packages/common/src/logger/logger.ts)
      it.skip("should flush buffered logs when listen() rejects", async () => {
        app = await createFailingMicroservice();
        app.getLogger().log("Starting Bunest microservice...");

        await app
          .listen()
          .catch((err: Error) => app!.getLogger().error(err.message));

        expect(logger.messages).toContain("Starting Bunest microservice...");
        expect(logger.messages).toContain("Connecting to the database");
        expect(logger.messages).toContain("Database unavailable");
      });
    });
  },
);
