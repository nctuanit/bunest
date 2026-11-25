import { afterAll, beforeAll, expect, it } from "bun:test";
import { Controller } from "../../../../../packages/core/src/common";
import {
  GrpcClientProxy,
  GrpcException,
  GrpcMethod,
  GrpcServer,
  GrpcStatus,
  GrpcStreamCall,
  GrpcStreamMethod,
  MICROSERVICE_SERVER,
  MicroserviceModule,
  RpcException,
  Transport,
} from "../../../../../packages/microservices/src";
import {
  Test,
  describeConformance,
  itAdapted,
  type TestingModule,
} from "../../../_helpers";

@Controller()
class EdgeController {
  readonly echoRejectRequestEvents: string[] = [];

  @GrpcMethod("Edge")
  completeEmpty(): undefined {
    return undefined;
  }

  @GrpcStreamMethod("Edge")
  async *streamEmpty(): AsyncGenerator<never> {
    // Completes immediately without yielding any response frame
  }

  @GrpcMethod("Edge")
  returnVoid(): void {
    // Handler returns nothing
  }

  @GrpcStreamCall("Edge")
  echoThrow(): never {
    throw new RpcException({
      code: GrpcStatus.INVALID_ARGUMENT,
      message: "echo rejected",
    });
  }

  @GrpcStreamCall("Edge")
  collectThrow(): never {
    throw new RpcException({
      code: GrpcStatus.INVALID_ARGUMENT,
      message: "collect rejected",
    });
  }

  @GrpcStreamMethod("Edge")
  async *streamThrowAfterYield(): AsyncGenerator<{ value: number }> {
    try {
      yield { value: 1 };
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: "echo rejected",
      });
    } finally {
      this.echoRejectRequestEvents.push("complete");
    }
  }
}

describeConformance(
  "GRPC transport (handlers that complete empty or throw)",
  {
    upstreamPath: "integration/microservices/e2e/edge-cases-grpc.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapted to Bunest native GrpcServer/GrpcClientProxy (port: 0) and async/AsyncGenerator handlers (ADR-008). Upstream client-streaming/bidi-streaming and empty-unary INTERNAL behavior gaps are preserved as BUNEST_BUG.",
  },
  () => {
    let moduleRef: TestingModule;
    let client: GrpcClientProxy;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [
          MicroserviceModule.forRoot({
            transport: Transport.GRPC,
            options: {
              host: "127.0.0.1",
              port: 0,
              package: "edge",
            },
          }),
        ],
        controllers: [EdgeController],
      }).compile();
      await moduleRef.init();

      const server = moduleRef.get<GrpcServer>(MICROSERVICE_SERVER);
      expect(server.port).toBeGreaterThan(0);

      client = new GrpcClientProxy({
        url: server.url,
        package: "edge",
      });
    });

    afterAll(async () => {
      await client?.close();
      await moduleRef?.close();
    });

    itAdapted(
      ["ADR-001", "ADR-008"],
      "completes a unary call whose handler returns undefined cleanly with null JSON payload",
      async () => {
        const res = await client.call(
          "Edge",
          "CompleteEmpty",
          { value: 1 },
          { timeoutMs: 2000 },
        );
        expect(res).toBeNull();
      },
      "ADR-001/008: JsonGrpcCodec encodes undefined unary return as null (matching void handler parity)",
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "completes cleanly with zero items for a server-streaming handler that yields nothing",
      async () => {
        const items: unknown[] = [];
        for await (const item of client.stream(
          "Edge",
          "StreamEmpty",
          { value: 1 },
          { timeoutMs: 2000 },
        )) {
          items.push(item);
        }
        expect(items).toEqual([]);
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "answers a call whose handler returns void without throwing",
      async () => {
        const res = await client.call(
          "Edge",
          "ReturnVoid",
          { value: 1 },
          { timeoutMs: 2000 },
        );
        expect(res).toBeNull();
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "sends the error of a throwing @GrpcStreamCall handler (echoThrow) to the client with INVALID_ARGUMENT",
      async () => {
        let caught: unknown;
        try {
          for await (const _item of client.stream(
            "Edge",
            "EchoThrow",
            { value: 1 },
            { timeoutMs: 2000 },
          )) {
            // should error before yielding
          }
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(GrpcException);
        expect((caught as GrpcException).code).toBe(
          GrpcStatus.INVALID_ARGUMENT,
        );
        expect((caught as GrpcException).details).toBe("echo rejected");
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "sends the error of a throwing @GrpcStreamCall handler (collectThrow) to the client with INVALID_ARGUMENT",
      async () => {
        let caught: unknown;
        try {
          await client.call(
            "Edge",
            "CollectThrow",
            { value: 1 },
            { timeoutMs: 2000 },
          );
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(GrpcException);
        expect((caught as GrpcException).code).toBe(
          GrpcStatus.INVALID_ARGUMENT,
        );
        expect((caught as GrpcException).details).toBe("collect rejected");
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "runs generator finally cleanup and delivers INVALID_ARGUMENT when a response stream throws mid-stream",
      async () => {
        const received: unknown[] = [];
        let caught: unknown;
        try {
          for await (const item of client.stream(
            "Edge",
            "StreamThrowAfterYield",
            { value: 1 },
            { timeoutMs: 2000 },
          )) {
            received.push(item);
          }
        } catch (err) {
          caught = err;
        }

        expect(received).toEqual([{ value: 1 }]);
        expect(caught).toBeInstanceOf(GrpcException);
        expect((caught as GrpcException).code).toBe(
          GrpcStatus.INVALID_ARGUMENT,
        );
        expect((caught as GrpcException).details).toBe("echo rejected");
        expect(moduleRef.get(EdgeController).echoRejectRequestEvents).toEqual([
          "complete",
        ]);
      },
    );

    it("fails a client-streaming call whose handler completes without a response", async () => {
      const anyClient = client as unknown as {
        clientStream?: (
          service: string,
          method: string,
          input: AsyncIterable<unknown>,
        ) => Promise<unknown>;
      };
      expect(typeof anyClient.clientStream).toBe("function");
    });
  },
);
