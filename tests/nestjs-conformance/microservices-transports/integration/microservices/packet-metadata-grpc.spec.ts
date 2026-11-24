import { afterEach, beforeEach, expect, it } from "bun:test";
import { Controller, Module } from "../../../../../packages/core/src/common";
import {
  Ctx,
  GrpcClientProxy,
  GrpcContext,
  GrpcMetadata,
  GrpcMethod,
  GrpcServer,
  GrpcStreamMethod,
  MICROSERVICE_SERVER,
  MicroserviceModule,
  Payload,
  Transport,
} from "../../../../../packages/microservices/src";
import {
  Test,
  describeConformance,
  itAdapted,
  type TestingModule,
} from "../../../_helpers";

@Controller()
class MathMetadataController {
  static received: Record<string, string>[] = [];

  @GrpcMethod("Math", "Sum")
  sum(
    @Payload() { data }: { data: number[] },
    @Ctx() ctx: GrpcContext,
  ): { result: number } {
    MathMetadataController.received.push(ctx.getMetadata().toRecord());
    return { result: data.reduce((total, value) => total + value, 0) };
  }

  @GrpcStreamMethod("Math", "StreamDivide")
  async *streamDivide(
    @Payload() { data }: { data: Array<{ dividend: number; divisor: number }> },
    @Ctx() ctx: GrpcContext,
  ): AsyncGenerator<{ data: { result: number } }> {
    MathMetadataController.received.push(ctx.getMetadata().toRecord());
    for (const { dividend, divisor } of data) {
      yield { data: { result: dividend / divisor } };
    }
  }
}

@Module({ controllers: [MathMetadataController] })
class MathMetadataModule {}

describeConformance(
  "Packet metadata (gRPC)",
  {
    upstreamPath: "integration/microservices/e2e/packet-metadata-grpc.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Verifies GrpcMetadata propagation across unary and streaming gRPC calls, default vs per-call precedence without mutating caller GrpcMetadata, and documents missing dispatch/pre-request hook invocation in GrpcServer/GrpcClientProxy as BUNEST_BUG.",
  },
  () => {
    let moduleRef: TestingModule;
    let server: GrpcServer;
    let client: GrpcClientProxy;

    beforeEach(async () => {
      MathMetadataController.received = [];
      server = new GrpcServer({
        host: "127.0.0.1",
        port: 0,
        package: "math",
      });

      moduleRef = await Test.createTestingModule({
        imports: [MicroserviceModule.forRoot({ server }), MathMetadataModule],
      }).compile();
      await moduleRef.init();
      expect(server.port).toBeGreaterThan(0);

      client = new GrpcClientProxy({
        url: server.url,
        package: "math",
      });
    });

    afterEach(async () => {
      await client?.close();
      await moduleRef?.close();
    });

    itAdapted(
      ["ADR-001", "ADR-008"],
      "delivers default client metadata as call metadata on unary RPCs",
      async () => {
        const taggedClient = new GrpcClientProxy({
          url: server.url,
          package: "math",
          metadata: { "x-request-id": "trace-1" },
        });
        try {
          const math = taggedClient.getService<{
            sum(req: { data: number[] }): Promise<{ result: number }>;
          }>("Math");
          const reply = await math.sum({ data: [1, 2, 3] });

          expect(reply).toEqual({ result: 6 });
          expect(MathMetadataController.received[0]).toMatchObject({
            "x-request-id": "trace-1",
          });
        } finally {
          await taggedClient.close();
        }
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "delivers metadata for every call, including server-streaming RPCs",
      async () => {
        const reply = await client.call<{ result: number }>(
          "Math",
          "Sum",
          { data: [1] },
          { metadata: { "x-request-id": "trace-1" } },
        );
        expect(reply).toEqual({ result: 1 });

        const results: Array<{ data: { result: number } }> = [];
        for await (const item of client.stream<{ data: { result: number } }>(
          "Math",
          "StreamDivide",
          { data: [{ dividend: 6, divisor: 3 }] },
          { metadata: { "x-request-id": "trace-2" } },
        )) {
          results.push(item);
        }

        expect(results).toEqual([{ data: { result: 2 } }]);
        expect(
          MathMetadataController.received.map((md) => md["x-request-id"]),
        ).toEqual(["trace-1", "trace-2"]);
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "lets the caller's own metadata win over default metadata, and leaves the caller's GrpcMetadata unchanged",
      async () => {
        const taggedClient = new GrpcClientProxy({
          url: server.url,
          package: "math",
          metadata: { "x-request-id": "trace-3", tenant: "acme" },
        });
        try {
          const callerMetadata = new GrpcMetadata();
          callerMetadata.set("x-request-id", "from-caller");

          await taggedClient.call(
            "Math",
            "Sum",
            { data: [1, 2] },
            { metadata: callerMetadata },
          );

          expect(MathMetadataController.received[0]).toMatchObject({
            "x-request-id": "from-caller",
            tenant: "acme",
          });
          // Caller's GrpcMetadata instance must not have been mutated with `tenant`
          expect(callerMetadata.toRecord()).toEqual({
            "x-request-id": "from-caller",
          });
        } finally {
          await taggedClient.close();
        }
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "adds no custom metadata headers when neither default nor per-call metadata is set",
      async () => {
        await client.call("Math", "Sum", { data: [1, 2] });

        expect(MathMetadataController.received[0]).not.toHaveProperty(
          "x-request-id",
        );
        expect(MathMetadataController.received[0]).not.toHaveProperty("tenant");
      },
    );

    // BUNEST_BUG: GrpcServer inherits setPreRequestHook() from MicroserviceTransportServer, but GrpcServer.handleHttpRequest() invokes route.handler() directly instead of calling this.preRequestHook (packages/microservices/src/transports/grpc.transport.ts:941-947).
    it.skip("invokes server pre-request hook with GrpcContext metadata before executing handler", async () => {
      const processed: Array<Record<string, string>> = [];
      server.setPreRequestHook(({ ctx }) => {
        processed.push((ctx as GrpcContext).getMetadata().toRecord());
      });

      await client.call(
        "Math",
        "Sum",
        { data: [1, 2, 3] },
        { metadata: { "x-request-id": "trace-hook" } },
      );

      expect(processed).toHaveLength(1);
      expect(processed[0]).toMatchObject({ "x-request-id": "trace-hook" });
    });

    // BUNEST_BUG: GrpcClientProxy does not invoke ClientProxy.setPreRequestHook() on call()/callWithMetadata()/stream()/getService(), and lacks NestJS setOnDispatchHook() for dynamically attaching per-call packet metadata (packages/microservices/src/transports/grpc.transport.ts:1263-1573).
    it.skip("invokes client dispatch/pre-request hook for every unary and streaming gRPC call", async () => {
      const seenPatterns: string[] = [];
      client.setPreRequestHook(({ pattern }) => {
        seenPatterns.push(pattern);
      });

      await client.call("Math", "Sum", { data: [1] });
      for await (const _item of client.stream("Math", "StreamDivide", {
        data: [{ dividend: 6, divisor: 3 }],
      })) {
        // drain
      }

      expect(seenPatterns).toEqual([
        "/math.Math/Sum",
        "/math.Math/StreamDivide",
      ]);
    });
  },
);
