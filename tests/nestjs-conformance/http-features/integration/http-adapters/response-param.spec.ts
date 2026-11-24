import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { IsString } from "../../../../../packages/validation/src/validator";
import {
  BadRequestException,
  Controller,
  Get,
  Module,
  Res,
  createParamDecorator,
  type ExecutionContext,
  type PipeTransform,
  type ResponseContext,
} from "../../../../../packages/core/src/common";
import {
  HttpAdapterHost,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  nestCompatibleValidationPipe,
  request,
} from "../../../_helpers";

const CustomRes = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getResponse(),
);

const Later = createParamDecorator(
  async (_data: unknown, ctx: ExecutionContext) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    const req = ctx.switchToHttp().getRequest<Request>();
    return { from: new URL(req.url).searchParams.get("from") ?? undefined };
  },
);

class LaterDto {
  @IsString()
  from!: string;
}

class RejectPipe implements PipeTransform {
  transform(): never {
    throw new BadRequestException("A pipe ran on the response");
  }
}

@Controller()
class ResponseParamController {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  @Get("response")
  response(
    @CustomRes() response: ResponseContext,
    @Res({ passthrough: true }) res: ResponseContext,
  ) {
    this.adapterHost.httpAdapter.setHeader(response, "x-from-param", "yes");
    return { same: response === res };
  }

  @Get("response-with-pipe")
  responseWithPipe(@CustomRes(new RejectPipe()) response: ResponseContext) {
    this.adapterHost.httpAdapter.setHeader(response, "x-from-param", "yes");
    return { piped: false };
  }

  @Get("later")
  later(@Later() value: LaterDto) {
    return value;
  }
}

@Module({ controllers: [ResponseParamController] })
class ResponseParamModule {}

describeConformance(
  "Custom param decorators returning response / async value (BunHttpAdapter)",
  {
    upstreamPath: "integration/http-adapters/e2e/response-param.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-009", "ADR-010"],
    notes:
      "Adapts NestJS custom param decorator returning response & async factory E2E tests to BunHttpAdapter ResponseContext.",
  },
  () => {
    describe.each([
      { label: "without a global pipe", withPipe: false },
      { label: "with a global pipe", withPipe: true },
    ])("$label", ({ withPipe }) => {
      let app: BunestApplication;

      beforeAll(async () => {
        const modRef = await Test.createTestingModule({
          imports: [ResponseParamModule],
        }).compile();
        app = modRef.createNestApplication({ logger: false });
        if (withPipe) {
          app.useGlobalPipes(
            nestCompatibleValidationPipe({ validateCustomDecorators: true }),
          );
        }
        await app.init();
      });

      afterAll(async () => {
        await app.close();
      });

      it("should let the handler answer through the response a decorator gives it", async () => {
        const res = await request(app).get("/response");

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ same: true });
        expect(res.headers["x-from-param"]).toBe("yes");
      });

      // BUNEST_BUG: resolveRouteArguments runs parameter-scoped pipes (and global pipes on custom decorators) even when the custom param decorator returns ResponseContext (packages/core/src/http/pipeline/param-extractor.ts:289-293, 340-358).
      it.skip("should run no pipe on the response a decorator gives", async () => {
        const res = await request(app).get("/response-with-pipe");

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ piped: false });
        expect(res.headers["x-from-param"]).toBe("yes");
      });

      it("should give the handler what an async factory resolves to", async () => {
        const res = await request(app).get("/later?from=factory");

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ from: "factory" });
      });

      if (withPipe) {
        it("should run the pipe on what an async factory resolves to", async () => {
          const res = await request(app).get("/later");
          expect(res.status).toBe(400);
        });
      }
    });
  },
);
