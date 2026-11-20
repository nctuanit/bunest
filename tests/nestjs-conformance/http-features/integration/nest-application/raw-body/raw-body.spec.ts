import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Body,
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
class RawBodyController {
  @Post()
  getRawBody(
    @Body() parsed: unknown,
    @RawBody() rawBody: Uint8Array | undefined,
  ) {
    return {
      parsed: parsed ?? null,
      raw: rawBody ? new TextDecoder().decode(rawBody) : null,
    };
  }
}

@Module({
  controllers: [RawBodyController],
})
class RawBodyModule {}

describeConformance(
  "Raw body E2E (BunHttpAdapter)",
  {
    upstreamPath: "integration/nest-application/raw-body/e2e/express.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-004"],
    notes:
      "Adapts NestJS rawBody: true E2E tests to Bunest @RawBody() (Uint8Array) + @Body() single-read cached body parser.",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleFixture = await Test.createTestingModule({
        imports: [RawBodyModule],
      }).compile();

      app = moduleFixture.createNestApplication({
        rawBody: true,
        logger: false,
      });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    describe("application/json", () => {
      const body = '{ "amount":0.0 }';

      itAdapted(
        ["ADR-001", "ADR-004"],
        "should return exact post body",
        async () => {
          const response = await request(app)
            .post("/")
            .set("Content-Type", "application/json")
            .send(body)
            .expect(201);

          expect(response.body).toEqual({
            parsed: {
              amount: 0,
            },
            raw: body,
          });
        },
        "@RawBody() captures exact raw JSON bytes alongside parsed @Body()",
      );

      it("should work if post body is empty", async () => {
        await request(app)
          .post("/")
          .set("Content-Type", "application/json")
          .expect(201);
      });
    });

    describe("application/x-www-form-urlencoded", () => {
      const body = 'content=this is a post\'s content by "Nest"';

      itAdapted(
        ["ADR-001", "ADR-004"],
        "should return exact post body",
        async () => {
          const response = await request(app)
            .post("/")
            .set("Content-Type", "application/x-www-form-urlencoded")
            .send(body)
            .expect(201);

          expect(response.body).toEqual({
            parsed: {
              content: 'this is a post\'s content by "Nest"',
            },
            raw: body,
          });
        },
        "@RawBody() captures exact raw urlencoded bytes alongside parsed @Body()",
      );

      it("should work if post body is empty", async () => {
        await request(app)
          .post("/")
          .set("Content-Type", "application/x-www-form-urlencoded")
          .expect(201);
      });
    });
  },
);
