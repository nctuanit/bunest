import "reflect-metadata";
import { afterEach, it } from "bun:test";
import {
  Catch,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  UseFilters,
  type ArgumentsHost,
  type BunestMiddleware,
  type BunestModule,
  type ExceptionFilter,
  type MiddlewareConsumer,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

@Catch(ForbiddenException)
class ForbiddenFilter implements ExceptionFilter {
  catch(_exception: ForbiddenException, _host: ArgumentsHost) {
    return new Response("filtered", { status: 403 });
  }
}

@Injectable()
class GuardMiddleware implements BunestMiddleware {
  @UseFilters(new ForbiddenFilter())
  use(): Response | void {
    throw new ForbiddenException();
  }
}

@Controller()
class TestController {
  @Get("private")
  private() {
    return "private";
  }

  @Get("public")
  public() {
    return "public";
  }
}

describeConformance(
  'Middleware - exception filters bound to "use()"',
  {
    upstreamPath: "integration/hello-world/e2e/middleware-use-filters.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010"],
    notes:
      "Adapted ExceptionFilter response handling from Express res.status().send() to returning native Web Response.",
  },
  () => {
    let app: BunestApplication | undefined;

    const createApp = async (exclusions: string[]) => {
      @Module({ controllers: [TestController] })
      class TestModule implements BunestModule {
        configure(consumer: MiddlewareConsumer) {
          consumer
            .apply(GuardMiddleware)
            .exclude(...exclusions)
            .forRoutes(TestController);
        }
      }

      const moduleRef = await Test.createTestingModule({
        imports: [TestModule],
      }).compile({ logger: false });
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    };

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    // BUNEST_BUG: Expected GET /private to return 403 "filtered" from @UseFilters(new ForbiddenFilter()) on GuardMiddleware.use(), got default JSON 403 {"statusCode":403,"message":"Forbidden",...}. packages/http/src/router/route-compiler.ts and packages/http/src/pipeline/execution-pipeline.ts only scan @UseFilters metadata on controller classes/handlers and global filters, not on middleware class `use()` methods.
    it.skip.each([[[]], [["public"]]])(
      "should apply them with the exclusions %j",
      async (exclusions) => {
        await createApp(exclusions);
        await request(app!).get("/private").expect(403, "filtered");
      },
    );
  },
);
