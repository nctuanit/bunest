import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  type ResponseContext,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  nestCompatibleValidationPipe,
  request,
} from "../../../_helpers";

class CrudController {
  @Post()
  create(@Body() dto: unknown) {
    return { dto };
  }

  @Get(":id")
  find(@Query("page", ParseIntPipe) page: unknown): object {
    return { page };
  }

  @Get("report/latest")
  report(@Res({ passthrough: true }) _res: ResponseContext): object {
    return { from: "parent" };
  }
}

@Controller("items")
class ItemsController extends CrudController {
  @Post()
  override create(@Req() req: Request, @Body() dto?: unknown) {
    return { hasRequest: typeof req?.headers === "object", dto };
  }

  @Get(":id")
  override find(@Param("id") id: unknown) {
    return { id };
  }

  // Under ADR-010, @Res() injects ResponseContext and handlers return values or Web Response asynchronously.
  @Get("report/latest")
  override async report(@Res() res: ResponseContext): Promise<object> {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    res.status(200);
    return { from: "child" };
  }
}

async function createApp(): Promise<BunestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [ItemsController],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalPipes(nestCompatibleValidationPipe());
  await app.init();
  return app;
}

describeConformance(
  "Overriding method with its own param decorators",
  {
    upstreamPath: "integration/hello-world/e2e/overriding-route-params.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-006", "ADR-009", "ADR-010"],
    notes:
      "Adapts Express & Fastify sub-suites to Bunest request(app) & app.inject() with async ResponseContext under ADR-010 and NestJS-compatible ValidationPipe options under ADR-009.",
  },
  () => {
    describe("(request(app) supertest client)", () => {
      let app: BunestApplication;

      beforeEach(async () => {
        app = await createApp();
      });

      afterEach(async () => {
        await app.close();
      });

      it("should pass the request to @Req() rather than the inherited @Body()", async () => {
        await request(app)
          .post("/items")
          .send({ name: "x" })
          .expect(201)
          .expect({ hasRequest: true, dto: { name: "x" } });
      });

      it("should not run the inherited @Query() pipe", async () => {
        await request(app).get("/items/42").expect(200).expect({ id: "42" });
      });

      it("should not let the inherited @Query() overwrite @Param()", async () => {
        await request(app)
          .get("/items/42?page=7")
          .expect(200)
          .expect({ id: "42" });
      });

      itAdapted(
        "ADR-010",
        "should leave the response to the overridden handler with @Res()",
        async () => {
          await request(app)
            .get("/items/report/latest")
            .expect(200)
            .expect({ from: "child" });
        },
        "Async handler with ResponseContext replaces callback res.send()",
      );
    });

    describe("(app.inject() in-memory)", () => {
      let app: BunestApplication;

      beforeEach(async () => {
        app = await createApp();
      });

      afterEach(async () => {
        await app.close();
      });

      it("should pass the request to @Req() rather than the inherited @Body()", async () => {
        const { statusCode, body } = await app.inject({
          method: "POST",
          url: "/items",
          payload: { name: "x" },
        });
        expect(statusCode).toBe(201);
        expect(JSON.parse(body)).toEqual({
          hasRequest: true,
          dto: { name: "x" },
        });
      });

      it("should not run the inherited @Query() pipe", async () => {
        const { statusCode, body } = await app.inject({
          method: "GET",
          url: "/items/42",
        });
        expect(statusCode).toBe(200);
        expect(JSON.parse(body)).toEqual({ id: "42" });
      });

      it("should not let the inherited @Query() overwrite @Param()", async () => {
        const { statusCode, body } = await app.inject({
          method: "GET",
          url: "/items/42?page=7",
        });
        expect(statusCode).toBe(200);
        expect(JSON.parse(body)).toEqual({ id: "42" });
      });

      itAdapted(
        "ADR-010",
        "should leave the response to the overridden handler with @Res()",
        async () => {
          const { statusCode, body } = await app.inject({
            method: "GET",
            url: "/items/report/latest",
          });
          expect(statusCode).toBe(200);
          expect(JSON.parse(body)).toEqual({ from: "child" });
        },
        "Async handler with ResponseContext replaces callback res.send()",
      );
    });
  },
);
