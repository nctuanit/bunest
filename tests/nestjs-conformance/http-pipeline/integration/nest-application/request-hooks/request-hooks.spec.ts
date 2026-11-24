import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Logger,
  Post,
  UnauthorizedException,
} from "../../../../../../packages/core/src/common";
import {
  ContextStorage,
  type BunestApplication,
} from "../../../../../../packages/core/src";
import { BunHttpAdapter } from "../../../../../../packages/core/src/http";
import {
  Test,
  describeConformance,
  request,
  stubMethod,
} from "../../../../_helpers";

const storage = new ContextStorage<string>();

@Controller()
class TestController {
  @Get()
  async get() {
    await new Promise((resolve) => setImmediate(resolve));
    return "ok";
  }

  @Post()
  post() {
    return storage.getStore();
  }
}

interface AdapterWithHooks {
  setOnRequestHook?(
    hook: (req: Request, res: unknown, done: () => void) => unknown,
  ): void;
  setOnResponseHook?(hook: (req: Request, res: unknown) => unknown): void;
}

describeConformance(
  "Request hooks (Bunest Application)",
  {
    upstreamPath:
      "integration/nest-application/request-hooks/e2e/express.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Tests adapter.setOnRequestHook() and adapter.setOnResponseHook() parity on BunHttpAdapter.",
  },
  () => {
    let app: BunestApplication;
    let adapter: AdapterWithHooks;

    beforeEach(async () => {
      adapter = new BunHttpAdapter({
        logger: false,
      }) as unknown as AdapterWithHooks;
      const moduleRef = await Test.createTestingModule({
        controllers: [TestController],
      }).compile();
      app = moduleRef.createNestApplication({
        logger: false,
      });
      await app.init();
      adapter = app.getHttpAdapter() as unknown as AdapterWithHooks;
    });

    afterEach(async () => {
      await app.close();
    });

    it("should send a request hook rejection to the exception filters", async () => {
      expect(typeof adapter.setOnRequestHook).toBe("function");
      adapter.setOnRequestHook!(async () => {
        throw new UnauthorizedException();
      });

      const res = await request(app).get("/").timeout(2000).expect(401);
      expect(res.body).toMatchObject({
        message: "Unauthorized",
        statusCode: 401,
      });
    });

    it("should log a request hook rejection after done() and keep the response", async () => {
      const error = new Error("Late hook failure");
      const logError = stubMethod(Logger.prototype, "error");
      try {
        expect(typeof adapter.setOnRequestHook).toBe("function");
        adapter.setOnRequestHook!(async (_req, _res, done) => {
          done();
          throw error;
        });

        await request(app).get("/").timeout(2000).expect(200, "ok");
        expect(logError.calledOnceWith(error)).toBe(true);
      } finally {
        logError.restore();
      }
    });

    it("should run a request with a body in the async context of the request hook", async () => {
      expect(typeof adapter.setOnRequestHook).toBe("function");
      expect(typeof adapter.setOnResponseHook).toBe("function");
      adapter.setOnRequestHook!((_req, _res, done) =>
        storage.run("hook", done),
      );
      const responseHookStore = new Promise<string | undefined>((resolve) =>
        adapter.setOnResponseHook!(() => resolve(storage.getStore())),
      );

      await request(app)
        .post("/")
        .send({ name: "nest" })
        .timeout(2000)
        .expect(201, "hook");
      expect(await responseHookStore).toBe("hook");
    });
  },
);
