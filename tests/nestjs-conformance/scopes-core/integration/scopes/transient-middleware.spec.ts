import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  Module,
  Scope,
  type BunestMiddleware,
  type BunestModule,
  type MiddlewareConsumer,
  type NextFunction,
  type ResponseContext,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

@Injectable()
class TokenService {
  isValid(token: string | null | undefined) {
    return token === "secret";
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class TransientAuthMiddleware implements BunestMiddleware {
  static COUNTER = 0;

  constructor(private readonly tokenService: TokenService) {
    TransientAuthMiddleware.COUNTER++;
  }

  async use(req: Request, _res: ResponseContext, next: NextFunction) {
    if (!this.tokenService.isValid(req.headers.get("x-token"))) {
      return new Response("unauthorized", { status: 401 });
    }
    return await next();
  }
}

@Controller("cats")
class CatsController {
  @Get()
  findAll() {
    return "cats";
  }
}

@Module({
  controllers: [CatsController],
  providers: [TokenService],
})
class CatsModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TransientAuthMiddleware).forRoutes(CatsController);
  }
}

describeConformance(
  "Transient scope (middleware)",
  {
    upstreamPath: "integration/scopes/e2e/transient-middleware.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010"],
    notes:
      "Adapted from Express/Fastify adapter matrix to Bunest BunHttpAdapter and RequestContext middleware signature.",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      TransientAuthMiddleware.COUNTER = 0;
      const module = await Test.createTestingModule({
        imports: [CatsModule],
      }).compile();

      app = module.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it("should run the middleware", async () => {
      await request(app).get("/cats").expect(401, "unauthorized");
      await request(app)
        .get("/cats")
        .set("x-token", "secret")
        .expect(200, "cats");
    });

    it("should create the middleware for each request", async () => {
      await request(app).get("/cats").expect(401);
      await request(app).get("/cats").expect(401);

      expect(TransientAuthMiddleware.COUNTER).toBe(2);
    });
  },
);
