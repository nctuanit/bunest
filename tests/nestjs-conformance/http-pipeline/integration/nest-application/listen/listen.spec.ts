import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  Module,
} from "../../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  type TestingModule,
} from "../../../../_helpers";

@Injectable()
class AppService {
  getHello(): string {
    return "Hello World!";
  }
}

@Controller()
class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}

@Module({
  controllers: [AppController],
  providers: [AppService],
})
class AppModule {}

describeConformance(
  "Listen (Bunest Application)",
  {
    upstreamPath: "integration/nest-application/listen/e2e/express.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts Express listen() tests to BunestApplication.listen() returning ListeningServerInfo using ephemeral port 0.",
  },
  () => {
    let testModule: TestingModule;
    let app: BunestApplication;

    beforeEach(async () => {
      testModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = testModule.createNestApplication({ logger: false });
    });

    afterEach(async () => {
      await app.close();
    });

    itAdapted(
      "ADR-001",
      "should resolve with ListeningServerInfo matching active server on success",
      async () => {
        const info = await app.listen(0, "127.0.0.1");
        expect(info.port).toBeGreaterThan(0);
        expect(app.getUrl()).toBe(info.url);
        expect(app.getHttpServer()).toBeDefined();
      },
      "Bunest listen() resolves with { port, hostname, url } instead of Node http.Server",
    );

    it("should reject if the port is not available", async () => {
      const info = await app.listen(0, "127.0.0.1");
      const secondApp = testModule.createNestApplication({ logger: false });
      try {
        await expect(
          secondApp.listen(info.port, "127.0.0.1"),
        ).rejects.toThrow();
      } finally {
        await secondApp.close();
      }
    });

    it("should reject if there is an invalid host", async () => {
      await expect(app.listen(0, "1")).rejects.toThrow();
    });
  },
);
