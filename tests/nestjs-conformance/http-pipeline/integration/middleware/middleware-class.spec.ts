import { afterEach, beforeEach, it } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  Module,
  RequestMethod,
  type BunestMiddleware,
  type BunestModule,
  type MiddlewareConsumer,
  type NextFunction,
  type ResponseContext,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

const INCLUDED_VALUE = "test_included";
const RETURN_VALUE = "test";
const WILDCARD_VALUE = "test_wildcard";

@Injectable()
class Middleware implements BunestMiddleware {
  use(_req: Request, _res: ResponseContext, _next: NextFunction) {
    return new Response(WILDCARD_VALUE);
  }
}

@Controller("hello")
class HelloController {
  @Get()
  greeting() {
    return "Hello world!";
  }
}

@Module({
  controllers: [HelloController],
})
class HelloModule {}

@Controller()
class TestController {
  @Get("test")
  test() {
    return RETURN_VALUE;
  }
}

@Module({
  imports: [HelloModule],
  controllers: [TestController],
})
class TestModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(
        (_req, _res, _next) => new Response(INCLUDED_VALUE, { status: 201 }),
      )
      .forRoutes({ path: "tests/included", method: RequestMethod.POST })
      .apply(Middleware)
      .forRoutes("*");
  }
}

describeConformance(
  "Middleware (class)",
  {
    upstreamPath: "integration/hello-world/e2e/middleware-class.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010"],
    notes:
      "Adapted Express middleware res.send()/res.status().end() to Bunest BunestMiddleware returning native Web Response.",
  },
  () => {
    let app: BunestApplication | undefined;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [TestModule],
      }).compile({ logger: false });
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    it(`forRoutes(*)`, async () => {
      await request(app!).get("/hello").expect(200, WILDCARD_VALUE);
    });

    it(`/test forRoutes(*)`, async () => {
      await request(app!).get("/test").expect(200, WILDCARD_VALUE);
    });

    it(`GET forRoutes(POST tests/included)`, async () => {
      await request(app!).get("/tests/included").expect(200, WILDCARD_VALUE);
    });

    it(`POST forRoutes(POST tests/included)`, async () => {
      await request(app!).post("/tests/included").expect(201, INCLUDED_VALUE);
    });
  },
);
