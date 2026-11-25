import { afterAll, beforeAll, expect, it } from "bun:test";
import {
  Controller,
  Injectable,
  UseInterceptors,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
} from "../../../../../packages/core/src/common";
import {
  GrpcClientProxy,
  GrpcException,
  GrpcMethod,
  GrpcServer,
  GrpcStatus,
  GrpcStreamMethod,
  MICROSERVICE_SERVER,
  MicroserviceModule,
  Transport,
} from "../../../../../packages/microservices/src";
import {
  Test,
  describeConformance,
  itAdapted,
  type TestingModule,
} from "../../../_helpers";

interface Item {
  n: number;
  label: string;
  reject?: boolean;
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in (value as Record<PropertyKey, unknown>)
  );
}

/**
 * Promise/AsyncIterable equivalent (ADR-008) of upstream's RxJS
 * `map(async item => ...)` interceptor: asynchronously maps both unary
 * resolved payloads and every yielded item of a server-streaming AsyncIterable.
 */
@Injectable()
class AsyncMapInterceptor implements BunestInterceptor {
  async intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    const result = await next.handle();
    if (isAsyncIterable<Item>(result)) {
      return (async function* () {
        for await (const item of result) {
          if (item.reject) {
            throw new Error("async map rejected");
          }
          yield { n: item.n, label: `${item.label}!` };
        }
      })();
    }
    const item = result as Item;
    if (item.reject) {
      throw new Error("async map rejected");
    }
    return { n: item.n, label: `${item.label}!` };
  }
}

@Controller()
@UseInterceptors(AsyncMapInterceptor)
class AsyncMapController {
  @GrpcMethod("AsyncMap")
  unary(item: Item): Item {
    return { n: item.n, label: "unary" };
  }

  @GrpcStreamMethod("AsyncMap")
  async *serverStream(count: {
    n: number;
    label: string;
    reject?: boolean;
  }): AsyncGenerator<Item> {
    for (let n = 1; n <= count.n; n++) {
      yield { n, label: count.label, reject: count.reject };
    }
  }
}

describeConformance(
  "GRPC transport (interceptor that maps to an async function)",
  {
    upstreamPath: "integration/microservices/e2e/async-map-grpc.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapted to Bunest native GrpcServer/GrpcClientProxy (ephemeral port: 0) and Promise/AsyncIterable interceptor pipeline (ADR-008). Bidi client-to-server streaming is skipped as BUNEST_BUG.",
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
              package: "asyncmap",
            },
          }),
        ],
        controllers: [AsyncMapController],
        providers: [AsyncMapInterceptor],
      }).compile();
      await moduleRef.init();

      const server = moduleRef.get<GrpcServer>(MICROSERVICE_SERVER);
      expect(server.port).toBeGreaterThan(0);

      client = new GrpcClientProxy({
        url: server.url,
        package: "asyncmap",
      });
    });

    afterAll(async () => {
      await client?.close();
      await moduleRef?.close();
    });

    itAdapted(
      ["ADR-001", "ADR-008"],
      "should send the resolved messages on unary and server-streaming calls",
      async () => {
        const unary = await client.call<Item>(
          "AsyncMap",
          "Unary",
          { n: 5 },
          { timeoutMs: 2000 },
        );

        const streamed: Item[] = [];
        for await (const msg of client.stream<Item>(
          "AsyncMap",
          "ServerStream",
          { n: 2, label: "stream" },
          { timeoutMs: 2000 },
        )) {
          streamed.push(msg);
        }

        expect(unary).toEqual({ n: 5, label: "unary!" });
        expect(streamed).toEqual([
          { n: 1, label: "stream!" },
          { n: 2, label: "stream!" },
        ]);
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "should fail a server stream whose async mapping function rejects without leaving unhandled rejections",
      async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on("unhandledRejection", onUnhandled);
        try {
          const messages: Item[] = [];
          let caught: unknown;
          try {
            for await (const msg of client.stream<Item>(
              "AsyncMap",
              "ServerStream",
              { n: 1, label: "stream", reject: true },
              { timeoutMs: 2000 },
            )) {
              messages.push(msg);
            }
          } catch (err) {
            caught = err;
          }

          await Bun.sleep(10);

          expect(messages).toEqual([]);
          expect(caught).toBeInstanceOf(GrpcException);
          expect((caught as GrpcException).code).toBe(GrpcStatus.INTERNAL);
          expect((caught as GrpcException).message).toBe("async map rejected");
          expect(unhandled).toEqual([]);
        } finally {
          process.off("unhandledRejection", onUnhandled);
        }
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "should send the resolved messages on server streaming calls",
      async () => {
        const items: Item[] = [];
        for await (const msg of client.stream<Item>("AsyncMap", "ServerStream", {
          n: 2,
          label: "echo",
        })) {
          items.push(msg);
        }
        expect(items.length).toBeGreaterThanOrEqual(1);
      },
      "ADR-001: Bun.serve HTTP/1.1 gRPC transport supports unary and server-streaming AsyncIterable (not full-duplex bidi HTTP/2)",
    );
  },
);
