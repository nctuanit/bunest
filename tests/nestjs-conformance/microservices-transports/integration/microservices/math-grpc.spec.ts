import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  Body,
  Catch,
  Controller,
  HttpCode,
  Post,
  Query,
  type ArgumentsHost,
  type ExceptionFilter,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  GrpcClientProxy,
  GrpcException,
  GrpcMethod,
  GrpcServer,
  GrpcStatus,
  GrpcStreamCall,
  GrpcStreamMethod,
  MICROSERVICE_SERVER,
  MicroserviceHost,
  MicroserviceModule,
  RpcException,
  Transport,
  type GrpcCallOptions,
} from "../../../../../packages/microservices/src";
import {
  Test,
  createSpy,
  describeConformance,
  itAdapted,
  request,
  type TestingModule,
} from "../../../_helpers";

interface MathServiceClient {
  sum(
    req: { data: number[] },
    options?: GrpcCallOptions,
  ): Promise<{ result: number }>;
  Sum(
    req: { data: number[] },
    options?: GrpcCallOptions,
  ): Promise<{ result: number }>;
  divide(
    req: { dividend: number; divisor: number },
    options?: GrpcCallOptions,
  ): Promise<{ result: number }>;
  alreadyExists(req: Record<string, never>): Promise<unknown>;
}

interface Math2ServiceClient {
  sum2(
    req: { data: number[] },
    options?: GrpcCallOptions,
  ): Promise<{ result: number }>;
}

/**
 * Custom proxy subclass mirroring upstream `ErrorHandlingProxy` that wraps
 * transport errors in a plain `RpcException` (distinct from default `GrpcException`).
 */
class ErrorHandlingProxy extends GrpcClientProxy {
  override async call<TRes = any, TReq = any>(
    service: string,
    method: string,
    data: TReq,
    options?: GrpcCallOptions,
  ): Promise<TRes> {
    try {
      return await super.call<TRes, TReq>(service, method, data, options);
    } catch (err) {
      throw new RpcException(err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * Global RPC exception filter mirroring upstream `GrpcExceptionFilter`:
 * handles `GrpcException` in RPC contexts while leaving HTTP exceptions
 * untouched for the HTTP layer.
 */
@Catch(GrpcException)
class ConformanceGrpcExceptionFilter implements ExceptionFilter {
  catch(exception: GrpcException, host: ArgumentsHost): unknown {
    if (host.getType() !== "rpc") {
      throw exception;
    }
    throw exception;
  }
}

@Controller()
class GrpcController {
  public standardClient!: GrpcClientProxy;
  public customClient!: GrpcClientProxy;
  public multiClient!: GrpcClientProxy;

  @Post("sum")
  @HttpCode(200)
  async call(@Body() data: number[]): Promise<{ result: number }> {
    const svc = this.standardClient.getService<MathServiceClient>("Math");
    return await svc.sum({ data });
  }

  // Test that getService works with both lowercase and uppercase method names
  @Post("upperMethod/sum")
  @HttpCode(200)
  async callWithUpper(@Body() data: number[]): Promise<{ result: number }> {
    const svc = this.standardClient.getService<MathServiceClient>("Math");
    return await svc.Sum({ data });
  }

  @Post("multi/sum")
  @HttpCode(200)
  async callMultiSum(@Body() data: number[]): Promise<{ result: number }> {
    const svc = this.multiClient.getService<MathServiceClient>("Math");
    return await svc.sum({ data });
  }

  @Post("multi/sum2")
  @HttpCode(200)
  async callMultiSum2(@Body() data: number[]): Promise<{ result: number }> {
    const svc = this.multiClient.getService<Math2ServiceClient>("Math2");
    return await svc.sum2({ data });
  }

  @Post("error")
  @HttpCode(200)
  async serializeError(
    @Query("client") query: "custom" | "standard" = "standard",
  ): Promise<boolean> {
    const targetClient =
      query === "custom" ? this.customClient : this.standardClient;
    const svc = targetClient.getService<MathServiceClient>("Math");
    try {
      await svc.divide({ dividend: 1, divisor: 0 });
      return false;
    } catch (err) {
      // Standard GrpcClientProxy throws GrpcException (subclass of RpcException);
      // ErrorHandlingProxy wraps into a base RpcException (not GrpcException).
      if (query === "custom") {
        return err instanceof RpcException && !(err instanceof GrpcException);
      }
      return err instanceof GrpcException;
    }
  }

  @GrpcMethod("Math")
  async sum({ data }: { data: number[] }): Promise<{ result: number }> {
    return { result: data.reduce((a, b) => a + b, 0) };
  }

  @GrpcStreamMethod("Math")
  async *sumStream({
    data,
  }: {
    data: number[];
  }): AsyncGenerator<{ result: number }> {
    yield { result: data.reduce((a, b) => a + b, 0) };
  }

  @GrpcStreamCall("Math")
  async *sumStreamPass({
    data,
  }: {
    data: number[];
  }): AsyncGenerator<{ result: number }> {
    yield { result: data.reduce((a, b) => a + b, 0) };
  }

  @GrpcMethod("Math")
  async divide(req: {
    dividend: number;
    divisor: number;
  }): Promise<{ result: number }> {
    if (req.divisor === 0) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: "dividing by 0 is not possible",
      });
    }
    return { result: req.dividend / req.divisor };
  }

  @GrpcMethod("Math")
  async alreadyExists(): Promise<never> {
    throw new GrpcException(GrpcStatus.ALREADY_EXISTS, "email already exists");
  }

  @GrpcStreamMethod("Math", "StreamDivide")
  async *streamDivide({
    data,
  }: {
    data: Array<{ dividend: number; divisor: number }>;
  }): AsyncGenerator<{ data: { result: number } }> {
    for (const item of data) {
      const res = await this.divide(item);
      yield { data: res };
    }
  }

  @GrpcMethod("Math2")
  async sum2({ data }: { data: number[] }): Promise<{ result: number }> {
    return { result: data.reduce((a, b) => a + b, 0) };
  }

  @GrpcStreamMethod("Math")
  async *streamLargeMessages(): AsyncGenerator<{ id: number; data: string }> {
    // Stream 1000 large framed payloads in order to exercise backpressure & framing
    const payloadChunk = "a".repeat(8 * 1024);
    for (let n = 0; n < 1000; n++) {
      yield { id: n, data: payloadChunk };
    }
  }
}

describeConformance(
  "GRPC transport",
  {
    upstreamPath: "integration/microservices/e2e/math-grpc.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Hybrid HTTP + gRPC E2E adapted to Bunest native BunHttpAdapter + GrpcServer (port: 0) + GrpcClientProxy + Promise/AsyncGenerator handlers (ADR-008).",
  },
  () => {
    let moduleRef: TestingModule;
    let app: BunestApplication;
    let grpcServer: GrpcServer;
    let client: GrpcClientProxy;
    let controller: GrpcController;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [
          MicroserviceModule.forRoot({
            transport: Transport.GRPC,
            options: {
              host: "127.0.0.1",
              port: 0,
              package: ["math", "math2"],
            },
          }),
        ],
        controllers: [GrpcController],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      app.useGlobalFilters(new ConformanceGrpcExceptionFilter());

      const host = moduleRef.get(MicroserviceHost);
      app.connectMicroservice(host, { inheritAppConfig: true });

      await app.startAllMicroservices();
      await app.init();

      grpcServer = moduleRef.get<GrpcServer>(MICROSERVICE_SERVER);
      expect(grpcServer.port).toBeGreaterThan(0);

      client = new GrpcClientProxy({
        url: grpcServer.url,
        package: "math",
      });

      controller = moduleRef.get(GrpcController);
      controller.standardClient = client;
      controller.customClient = new ErrorHandlingProxy({
        url: grpcServer.url,
        package: "math",
      });
      controller.multiClient = new GrpcClientProxy({
        url: grpcServer.url,
        package: ["math", "math2"],
      });
    });

    afterAll(async () => {
      await controller?.customClient?.close();
      await controller?.multiClient?.close();
      await client?.close();
      await moduleRef?.close();
    });

    itAdapted(
      ["ADR-001", "ADR-008"],
      "GRPC Sending and Receiving HTTP POST (lower & upper case service method)",
      async () => {
        await request(app)
          .post("/sum")
          .send([1, 2, 3, 4, 5])
          .expect(200, { result: 15 });

        await request(app)
          .post("/upperMethod/sum")
          .send([1, 2, 3, 4, 5])
          .expect(200, { result: 15 });
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "GRPC Receiving serialized Error via standard and custom proxy",
      async () => {
        await request(app)
          .post("/error?client=standard")
          .expect(200)
          .expect("true");

        await request(app)
          .post("/error?client=custom")
          .expect(200)
          .expect("true");
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "GRPC maps GrpcException to gRPC status code",
      async () => {
        let caught: unknown;
        try {
          await client.call("Math", "AlreadyExists", {});
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(GrpcException);
        const gErr = caught as GrpcException;
        expect(gErr.code).toBe(GrpcStatus.ALREADY_EXISTS);
        expect(gErr.message).toBe("email already exists");
      },
    );

    itAdapted(
      ["ADR-001"],
      "GRPC exception filter leaves HTTP exceptions to the HTTP layer",
      async () => {
        const res = await request(app).get("/missing").expect(404);
        const body = res.body as {
          statusCode: number;
          message: string;
          error: string;
        };
        expect(body.statusCode).toBe(404);
        expect(body.error).toBe("Not Found");
        expect(body.message).toContain("/missing");
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "GRPC Sending and Receiving HTTP POST (multiple packages: math & math2)",
      async () => {
        await request(app)
          .post("/multi/sum")
          .send([1, 2, 3, 4, 5])
          .expect(200, { result: 15 });

        await request(app)
          .post("/multi/sum2")
          .send([1, 2, 3, 4, 5])
          .expect(200, { result: 15 });
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "GRPC Sending and receiving Stream from @GrpcStreamMethod handler",
      async () => {
        const received: Array<{ result: number }> = [];
        for await (const msg of client.stream<{ result: number }>(
          "Math",
          "SumStream",
          { data: [1, 2, 3, 4, 5] },
        )) {
          received.push(msg);
        }
        expect(received).toEqual([{ result: 15 }]);
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "GRPC Sending and receiving Stream from @GrpcStreamCall handler",
      async () => {
        const received: Array<{ result: number }> = [];
        for await (const msg of client.stream<{ result: number }>(
          "Math",
          "SumStreamPass",
          { data: [1, 2, 3, 4, 5] },
        )) {
          received.push(msg);
        }
        expect(received).toEqual([{ result: 15 }]);
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "GRPC with backpressure control (1000 framed streamed messages in strict order)",
      async () => {
        const expectedIds = Array.from({ length: 1000 }, (_, n) => n);
        const receivedIds: number[] = [];

        for await (const msg of client.stream<{ id: number; data: string }>(
          "Math",
          "StreamLargeMessages",
          {},
          { timeoutMs: 15_000 },
        )) {
          receivedIds.push(msg.id);
        }

        expect(receivedIds).toEqual(expectedIds);
      },
      15_000,
    );

    describe("streaming calls that error", () => {
      let processSpy: ReturnType<typeof createSpy>;

      beforeEach(() => {
        processSpy = createSpy();
        process.on("unhandledRejection", processSpy);
      });

      afterEach(() => {
        process.off("unhandledRejection", processSpy);
      });

      itAdapted(
        ["ADR-001", "ADR-008"],
        "should not crash or emit unhandledRejection when replying with an error",
        async () => {
          const emitted: unknown[] = [];
          let caught: unknown;
          try {
            for await (const item of client.stream("Math", "StreamDivide", {
              data: [{ dividend: 1, divisor: 0 }],
            })) {
              emitted.push(item);
            }
          } catch (err) {
            caught = err;
          }

          await Bun.sleep(10);

          expect(emitted).toEqual([]);
          expect(caught).toBeInstanceOf(GrpcException);
          expect((caught as GrpcException).code).toBe(
            GrpcStatus.INVALID_ARGUMENT,
          );
          expect((caught as GrpcException).message).toBe(
            "dividing by 0 is not possible",
          );
          expect(processSpy.notCalled).toBe(true);
        },
      );
    });
  },
);
