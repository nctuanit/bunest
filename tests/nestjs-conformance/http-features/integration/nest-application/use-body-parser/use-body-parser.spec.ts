import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Controller,
  Module,
  Post,
  RawBody,
} from "../../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../../_helpers";

@Controller()
class AppController {
  @Post()
  index(@RawBody() rawBody: Uint8Array | undefined) {
    return {
      raw: rawBody ? new TextDecoder().decode(rawBody) : undefined,
    };
  }
}

@Module({
  controllers: [AppController],
})
class AppModule {}

describeConformance(
  "Body Parser limit configuration E2E (BunHttpAdapter)",
  {
    upstreamPath:
      "integration/nest-application/use-body-parser/e2e/express.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-004"],
    notes:
      "Adapts NestJS app.useBodyParser() limit E2E tests to Bunest native bodyLimit application option / adapter.setBodyLimit() (ADR-001/ADR-004).",
  },
  () => {
    let app: BunestApplication;

    afterEach(async () => {
      await app?.close();
    });

    describe("application/json", () => {
      const stringLimit = '{ "msg": "Hello, World" }';
      const stringOverLimit = '{ "msg": "Hello, World!" }';

      beforeEach(async () => {
        const testFixture = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        app = testFixture.createNestApplication({
          rawBody: true,
          bodyLimit: Buffer.from(stringLimit).byteLength,
          logger: false,
        });
        await app.init();
      });

      itAdapted(
        ["ADR-001", "ADR-004"],
        "should allow request with matching body limit",
        async () => {
          const response = await request(app)
            .post("/")
            .set("Content-Type", "application/json")
            .send(stringLimit)
            .expect(201);

          expect(response.body).toEqual({
            raw: stringLimit,
          });
        },
        "Configured via BunestApplicationOptions.bodyLimit",
      );

      itAdapted(
        ["ADR-001", "ADR-004"],
        "should fail if post body is larger than limit",
        async () => {
          await request(app)
            .post("/")
            .set("Content-Type", "application/json")
            .send(stringOverLimit)
            .expect(413);
        },
        "Bunest returns 413 PayloadTooLargeException when exceeding bodyLimit",
      );
    });

    describe("application/x-www-form-urlencoded", () => {
      const stringLimit = "msg=Hello, World";
      const stringOverLimit = "msg=Hello, World!";

      beforeEach(async () => {
        const testFixture = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        app = testFixture.createNestApplication({
          rawBody: true,
          bodyLimit: Buffer.from(stringLimit).byteLength,
          logger: false,
        });
        await app.init();
      });

      itAdapted(
        ["ADR-001", "ADR-004"],
        "should allow request with matching body limit",
        async () => {
          const response = await request(app)
            .post("/")
            .set("Content-Type", "application/x-www-form-urlencoded")
            .send(stringLimit)
            .expect(201);

          expect(response.body).toEqual({
            raw: stringLimit,
          });
        },
        "Configured via BunestApplicationOptions.bodyLimit",
      );

      itAdapted(
        ["ADR-001", "ADR-004"],
        "should fail if post body is larger than limit",
        async () => {
          await request(app)
            .post("/")
            .set("Content-Type", "application/x-www-form-urlencoded")
            .send(stringOverLimit)
            .expect(413);
        },
        "Bunest returns 413 PayloadTooLargeException when exceeding bodyLimit",
      );
    });
  },
);
