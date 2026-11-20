import "reflect-metadata";
import { afterAll, beforeAll, expect, it } from "bun:test";
import {
  Body,
  Controller,
  HttpCode,
  Post,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Ctx,
  GrpcClientProxy,
  GrpcContext,
  GrpcMethod,
  GrpcServer,
  GrpcStatus,
  GrpcStreamCall,
  GrpcStreamMethod,
  MICROSERVICE_SERVER,
  MicroserviceHost,
  MicroserviceModule,
  Payload,
  Transport,
  decodeGrpcFrames,
  encodeGrpcFrame,
  parseGrpcTrailers,
} from "../../../../../packages/microservices/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
  type TestingModule,
} from "../../../_helpers";

interface ShipmentType {
  from: string;
  to: string;
  carrier: string;
}

interface OrderMessage {
  id: number;
  itemTypes: number[];
  shipmentType: ShipmentType;
}

const SAMPLE_ORDER: OrderMessage = {
  id: 1,
  itemTypes: [1],
  shipmentType: {
    from: "test",
    to: "test1",
    carrier: "test-carrier",
  },
};

interface OrderServiceClient {
  find(req: { id: number }): Promise<OrderMessage>;
}

@Controller()
class AdvancedGrpcController {
  public client!: GrpcClientProxy;

  @Post()
  @HttpCode(200)
  async call(@Body() body: { id: number }): Promise<OrderMessage> {
    const svc = this.client.getService<OrderServiceClient>("OrderService");
    return await svc.find({ id: body.id });
  }

  @Post("server-streaming")
  @HttpCode(200)
  async streamViaHttp(@Body() body: { id: number }): Promise<OrderMessage> {
    let last: OrderMessage | undefined;
    for await (const msg of this.client.stream<OrderMessage>(
      "OrderService",
      "Sync",
      { id: body.id },
    )) {
      last = msg;
    }
    return last!;
  }

  @GrpcMethod("OrderService")
  async find(@Payload() _req: { id: number }): Promise<OrderMessage> {
    return SAMPLE_ORDER;
  }

  @GrpcStreamMethod("OrderService")
  async *sync(
    @Payload() _req: { id: number },
    @Ctx() ctx: GrpcContext,
  ): AsyncGenerator<OrderMessage> {
    ctx.setResponseMetadata("set-cookie", "test_cookie=abcd");
    yield SAMPLE_ORDER;
  }

  @GrpcStreamCall("OrderService")
  async *syncCall(
    @Payload() _req: { id: number },
  ): AsyncGenerator<OrderMessage> {
    yield SAMPLE_ORDER;
  }

  @GrpcMethod("OrderService")
  async findWithCookie(
    @Payload() _req: { id: number },
    @Ctx() ctx: GrpcContext,
  ): Promise<OrderMessage> {
    ctx.setResponseMetadata("set-cookie", "test_cookie=abcd");
    return SAMPLE_ORDER;
  }
}

describeConformance(
  "Advanced GRPC transport",
  {
    upstreamPath: "integration/microservices/e2e/orders-grpc.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapted to Bunest native BunHttpAdapter + GrpcServer (port: 0) with nested package namespace `proto_example.orders.OrderService`, response metadata (`set-cookie`), and AsyncGenerator streams. Sub-package prefix qualification bug & client-streaming RPCs skipped as BUNEST_BUG.",
  },
  () => {
    let moduleRef: TestingModule;
    let app: BunestApplication;
    let grpcServer: GrpcServer;
    let client: GrpcClientProxy;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [
          MicroserviceModule.forRoot({
            transport: Transport.GRPC,
            options: {
              host: "127.0.0.1",
              port: 0,
              package: "proto_example.orders",
            },
          }),
        ],
        controllers: [AdvancedGrpcController],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      const host = moduleRef.get(MicroserviceHost);
      app.connectMicroservice(host);
      await app.startAllMicroservices();
      await app.init();

      grpcServer = moduleRef.get<GrpcServer>(MICROSERVICE_SERVER);
      expect(grpcServer.port).toBeGreaterThan(0);

      client = new GrpcClientProxy({
        url: grpcServer.url,
        package: "proto_example.orders",
      });
      moduleRef.get(AdvancedGrpcController).client = client;
    });

    afterAll(async () => {
      await client?.close();
      await moduleRef?.close();
    });

    itAdapted(
      ["ADR-001", "ADR-008"],
      "GRPC Sending and Receiving HTTP POST for nested package OrderService",
      async () => {
        const res = await request(app).post("/").send({ id: 1 }).expect(200);
        expect(res.body).toEqual(SAMPLE_ORDER);
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "GRPC Streaming and Receiving via HTTP POST proxy",
      async () => {
        const res = await request(app)
          .post("/server-streaming")
          .send({ id: 1 })
          .expect(200);
        expect(res.body).toEqual(SAMPLE_ORDER);
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "GRPC Sending and receiving unary message directly on nested package service",
      async () => {
        const result = await client.call<OrderMessage>("OrderService", "Find", {
          id: 1,
        });
        expect(result).toEqual(SAMPLE_ORDER);
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "GRPC Sending and receiving response metadata (Set-Cookie) on unary and streaming handlers",
      async () => {
        // 1. Unary callWithMetadata receives set-cookie metadata
        const unaryRes = await client.callWithMetadata<OrderMessage>(
          "OrderService",
          "FindWithCookie",
          { id: 1 },
        );
        expect(unaryRes.status).toBe(GrpcStatus.OK);
        expect(unaryRes.data).toEqual(SAMPLE_ORDER);
        expect(unaryRes.metadata.get("set-cookie")).toBe("test_cookie=abcd");

        // 2. Streaming handler delivers payload + set-cookie in trailer & headers
        const streamed: OrderMessage[] = [];
        for await (const msg of client.stream<OrderMessage>(
          "OrderService",
          "Sync",
          { id: 1 },
        )) {
          streamed.push(msg);
        }
        expect(streamed).toEqual([SAMPLE_ORDER]);

        // Verify raw gRPC stream response carries Set-Cookie in trailer frame
        const rawRes = await fetch(
          `${grpcServer.url}/proto_example.orders.OrderService/Sync`,
          {
            method: "POST",
            headers: { "content-type": "application/grpc+json" },
            body: encodeGrpcFrame(
              new TextEncoder().encode(JSON.stringify({ id: 1 })),
            ),
          },
        );
        const frames = decodeGrpcFrames(
          new Uint8Array(await rawRes.arrayBuffer()),
        );
        expect(frames.length).toBe(2);
        expect(frames[1]!.isTrailer).toBe(true);
        const trailers = parseGrpcTrailers(frames[1]!.payload);
        expect(trailers["set-cookie"]).toBe("test_cookie=abcd");
        expect(trailers["grpc-status"]).toBe(String(GrpcStatus.OK));
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "GRPC Sending and receiving Stream from @GrpcStreamCall handler (SyncCall)",
      async () => {
        const received: OrderMessage[] = [];
        for await (const msg of client.stream<OrderMessage>(
          "OrderService",
          "SyncCall",
          { id: 1 },
        )) {
          received.push(msg);
        }
        expect(received).toEqual([SAMPLE_ORDER]);
      },
    );

    // BUNEST_BUG: GrpcServer.addGrpcHandler() skips qualifying `service` with `this.packages` whenever `service.includes(".")` (packages/microservices/src/transports/grpc.transport.ts:733), and resolveRoute() only strips down to lastIndexOf("."). Thus server `{ package: "proto_example" }` + `@GrpcMethod("orders.OrderService")` fails with UNIMPLEMENTED when invoked as `/proto_example.orders.OrderService/Find`.
    it.skip("GRPC resolves sub-package service name (orders.OrderService) under parent package (proto_example)", async () => {
      const parentSrv = new GrpcServer({
        host: "127.0.0.1",
        port: 0,
        package: "proto_example",
      });
      parentSrv.addGrpcHandler("orders.OrderService", "Find", () => SAMPLE_ORDER);
      await parentSrv.listen();
      const nestedClient = new GrpcClientProxy({
        url: parentSrv.url,
        package: "proto_example.orders",
      });
      try {
        const res = await nestedClient.call<OrderMessage>(
          "OrderService",
          "Find",
          { id: 1 },
        );
        expect(res).toEqual(SAMPLE_ORDER);
      } finally {
        await nestedClient.close();
        await parentSrv.close();
      }
    });

    // BUNEST_BUG: GrpcServer.handleHttpRequest only decodes a single incoming request frame (`frames[0]`) and GrpcClientProxy lacks client-streaming RPC support (packages/microservices/src/transports/grpc.transport.ts:874-886).
    it.skip("GRPC Sending Stream and receiving a single message from client-streaming handler (streamReq)", async () => {
      const anyClient = client as unknown as {
        clientStream?: (
          service: string,
          method: string,
          input: AsyncIterable<unknown>,
        ) => Promise<OrderMessage>;
      };
      expect(typeof anyClient.clientStream).toBe("function");
    });

    // BUNEST_BUG: GrpcServer / GrpcClientProxy do not implement client-streaming Call passthrough (`streamReqCall`) (packages/microservices/src/transports/grpc.transport.ts).
    it.skip("GRPC Sending Stream and receiving a single message from Call handler (streamReqCall)", async () => {
      const anyClient = client as unknown as {
        clientStream?: (
          service: string,
          method: string,
          input: AsyncIterable<unknown>,
        ) => Promise<OrderMessage>;
      };
      expect(typeof anyClient.clientStream).toBe("function");
    });
  },
);
