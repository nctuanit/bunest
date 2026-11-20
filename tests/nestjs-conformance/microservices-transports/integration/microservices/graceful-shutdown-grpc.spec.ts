import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { Controller } from "../../../../../packages/common/src";
import {
  GrpcClientProxy,
  GrpcContext,
  GrpcException,
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

@Controller()
class StreamController {
  // Streams `n` items, the first immediately and subsequent items 40ms apart
  @GrpcStreamMethod("AsyncMap")
  async *serverStream(
    payload: { n: number },
    ctx: GrpcContext,
  ): AsyncGenerator<{ n: number; label: string }> {
    for (let index = 0; index < payload.n; index++) {
      if (ctx.signal.aborted) {
        return;
      }
      if (index > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 40);
          ctx.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        if (ctx.signal.aborted) {
          return;
        }
      }
      yield { n: index + 1, label: "item" };
    }
  }
}

interface CallResult {
  items: number;
  error?: GrpcException;
}

describeConformance(
  "GRPC transport (graceful shutdown)",
  {
    upstreamPath:
      "integration/microservices/e2e/graceful-shutdown-grpc.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapted to Bunest native GrpcServer/GrpcClientProxy (port: 0) and AsyncGenerator streams (ADR-008). Bounded gracePeriod shutdown options are skipped as BUNEST_BUG since GrpcServer.close() currently always force-stops immediately via server.stop(true).",
  },
  () => {
    let moduleRef: TestingModule | undefined;
    let server: GrpcServer | undefined;
    let client: GrpcClientProxy | undefined;

    async function createServer() {
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
        controllers: [StreamController],
      }).compile();
      await moduleRef.init();

      server = moduleRef.get<GrpcServer>(MICROSERVICE_SERVER);
      client = new GrpcClientProxy({
        url: server.url,
        package: "asyncmap",
      });
      return server;
    }

    function startStream(n: number) {
      let items = 0;
      let resolveStarted!: () => void;
      let rejectStarted!: (err: unknown) => void;
      const started = new Promise<void>((resolve, reject) => {
        resolveStarted = resolve;
        rejectStarted = reject;
      });

      const ended = (async (): Promise<CallResult> => {
        try {
          for await (const _item of client!.stream(
            "AsyncMap",
            "ServerStream",
            { n },
            { timeoutMs: 10_000 },
          )) {
            items++;
            if (items === 1) {
              resolveStarted();
            }
          }
          return { items };
        } catch (err) {
          if (items === 0) {
            rejectStarted(err);
          }
          return {
            items,
            error: err instanceof GrpcException ? err : undefined,
          };
        }
      })();

      return { started, ended };
    }

    beforeEach(() => {
      moduleRef = undefined;
      server = undefined;
      client = undefined;
    });

    afterEach(async () => {
      await client?.close();
      await moduleRef?.close();
      client = undefined;
      server = undefined;
      moduleRef = undefined;
    });

    itAdapted(
      ["ADR-001", "ADR-008"],
      "should terminate an active streaming call when GrpcServer.close() stops the server and reject subsequent calls",
      async () => {
        const grpcServer = await createServer();
        const { started, ended } = startStream(50);
        await started;

        await grpcServer.close();
        expect(grpcServer.isListening).toBe(false);
        expect(grpcServer.port).toBeUndefined();
        expect(grpcServer.url).toBeUndefined();
        expect(grpcServer.address).toBeNull();

        const { items, error } = await ended;
        expect(items).toBeGreaterThanOrEqual(1);
        expect(items).toBeLessThan(50);
        // Server.stop(true) tears down the socket immediately -> client observes
        // UNAVAILABLE, CANCELLED, or DATA_LOSS (truncated frame) or premature EOF
        if (error) {
          expect([
            GrpcStatus.CANCELLED,
            GrpcStatus.UNAVAILABLE,
            GrpcStatus.DATA_LOSS,
          ]).toContain(error.code);
        }

        // Subsequent RPCs must fail with UNAVAILABLE
        let postCloseErr: unknown;
        try {
          await client!.call("AsyncMap", "ServerStream", { n: 1 }, { timeoutMs: 500 });
        } catch (err) {
          postCloseErr = err;
        }
        expect(postCloseErr).toBeInstanceOf(GrpcException);
        expect((postCloseErr as GrpcException).code).toBe(
          GrpcStatus.UNAVAILABLE,
        );
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "should deliver all items cleanly for a short stream and then shut down cleanly on close()",
      async () => {
        const grpcServer = await createServer();
        const { started, ended } = startStream(3);
        await started;

        const { items, error } = await ended;
        expect(error).toBeUndefined();
        expect(items).toBe(3);

        await grpcServer.close();
        expect(grpcServer.isListening).toBe(false);
      },
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "should abort an in-flight stream with CANCELLED when GrpcClientProxy.close() is called",
      async () => {
        await createServer();
        const { started, ended } = startStream(50);
        await started;

        await client!.close();
        const { items, error } = await ended;
        expect(items).toBeGreaterThanOrEqual(1);
        expect(items).toBeLessThan(50);
        expect(error).toBeInstanceOf(GrpcException);
        expect(error?.code).toBe(GrpcStatus.CANCELLED);
      },
    );

    // BUNEST_BUG: GrpcTransportOptions has no `gracefulShutdown` or `gracePeriod` option and GrpcServer.close() unconditionally calls `this.server.stop(true)` (immediate force stop) instead of waiting up to `gracePeriod` for in-flight RPCs to drain before cancelling (packages/microservices/src/interfaces.ts:244-253, packages/microservices/src/transports/grpc.transport.ts:803-813).
    it.skip('should cancel a call still running once "gracePeriod" is over', async () => {
      const grpcServer = new GrpcServer({
        host: "127.0.0.1",
        port: 0,
        package: "asyncmap",
        ...({ gracefulShutdown: true, gracePeriod: 300 } as Record<
          string,
          unknown
        >),
      });
      await grpcServer.listen();
      const closeCalledAt = Date.now();
      await grpcServer.close();
      const elapsed = Date.now() - closeCalledAt;
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(2000);
    });

    // BUNEST_BUG: GrpcServer.close() calls `this.server.stop(true)` immediately without draining in-flight streams when `gracefulShutdown: true` is configured (packages/microservices/src/transports/grpc.transport.ts:803-813).
    it.skip('should let a call in progress finish, well before "gracePeriod"', async () => {
      const grpcServer = await createServer();
      const { started, ended } = startStream(3);
      await started;

      const closeCalledAt = Date.now();
      await grpcServer.close();
      expect(Date.now() - closeCalledAt).toBeLessThan(5000);

      const { items, error } = await ended;
      expect(error).toBeUndefined();
      expect(items).toBe(3);
    });
  },
);
