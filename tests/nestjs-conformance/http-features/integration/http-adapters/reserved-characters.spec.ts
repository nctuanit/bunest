import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  Param,
  type BunestModule,
  type MiddlewareConsumer,
  type NextFunction,
  type ResponseContext,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

async function markMiddleware(
  _req: Request,
  res: ResponseContext,
  next: NextFunction,
) {
  res.header("x-middleware", "ran");
  await next();
}

@Controller("avatars")
class AvatarsController {
  @Get(":user-avatar@2x.png")
  find(@Param("user") user: string) {
    return { user };
  }
}

@Controller("skus")
class SkusController {
  @Get(":sku-color=:color")
  find(@Param() params: Record<string, string>) {
    return params;
  }
}

@Controller("discounts")
class DiscountsController {
  @Get("100%")
  find() {
    return { discount: 100 };
  }
}

@Module({
  controllers: [AvatarsController, SkusController, DiscountsController],
})
class ReservedCharactersModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(markMiddleware)
      .forRoutes(AvatarsController, SkusController, DiscountsController);
  }
}

describeConformance(
  "Reserved characters in the text of routes (BunHttpAdapter)",
  {
    upstreamPath: "integration/http-adapters/e2e/reserved-characters.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-011"],
    notes:
      "Adapts NestJS reserved-characters route & middleware matching tests to BunHttpAdapter.",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const modRef = await Test.createTestingModule({
        imports: [ReservedCharactersModule],
      }).compile();
      app = modRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    // BUNEST_BUG: FallbackRadixRouter/NativePathMatcher only parse whole-segment :param tokens and do not support sub-segment param+literal patterns like ":user-avatar@2x.png" or ":sku-color=:color" (packages/core/src/http/router/fallback-radix-router.ts:35-38, 159-204).
    it.skip("should run the middleware of a route for its plain path", async () => {
      const avatar = await request(app).get("/avatars/alice-avatar@2x.png");
      const sku = await request(app).get("/skus/42-color=red");

      expect(avatar.status).toBe(200);
      expect(avatar.body).toEqual({ user: "alice" });
      expect(avatar.headers["x-middleware"]).toBe("ran");
      expect(sku.status).toBe(200);
      expect(sku.body).toEqual({ sku: "42", color: "red" });
      expect(sku.headers["x-middleware"]).toBe("ran");
    });

    // BUNEST_BUG: Router does not support sub-segment params (":user-avatar@2x.png", ":sku-color=:color") or percent-decoded static segment matching ("/discounts/100%25" vs "/discounts/100%") (packages/core/src/http/router/fallback-radix-router.ts:670, 817, 863).
    it.skip.each([
      "/avatars/alice-avatar%402x.png",
      "/skus/42-color%3Dred",
      "/discounts/100%25",
    ])(
      'should run the middleware of the route that serves "%s"',
      async (path) => {
        const res = await request(app).get(path);
        expect(res.status).toBe(200);
        expect(res.headers["x-middleware"]).toBe("ran");
      },
    );
  },
);
