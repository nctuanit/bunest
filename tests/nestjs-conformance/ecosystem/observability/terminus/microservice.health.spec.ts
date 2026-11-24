import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Transport } from "../../../../../packages/microservices/src";
import {
  HealthIndicatorService,
  MicroserviceHealthIndicator,
} from "../../../../../packages/observability/src";
import {
  Test,
  type TestingModule,
  describeConformance,
  itAdapted,
} from "../../../_helpers/index";

type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// Note on typing: BUNEST_BUG — `@bunest/microservices`'s `TcpClientOptions` and
// `RmqOptions` fail the `MicroserviceOptionsLike` generic constraint
// (`options?: Record<string, unknown> & ...` in packages/observability/src/health/health.indicators.ts:861),
// so calls below omit explicit `<TcpClientOptions>`/`<RmqOptions>`/`<KafkaOptions>` type arguments.
describeConformance(
  "MicroserviceHealthIndicator",
  {
    upstreamPath:
      "terminus/lib/health-indicator/microservice/microservice.health.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/terminus MicroserviceHealthIndicator unit tests to zero-dep Bunest MicroserviceHealthIndicator (ADR-001: native TCP socket probe + custom client/ping hooks without ClientProxyFactory peer loading).",
  },
  () => {
    it("types the code on a failed result", () => {
      type Entry = Awaited<
        ReturnType<MicroserviceHealthIndicator["pingCheck"]>
      >[string];
      const _codeCheck: AssertEqual<
        Extract<Entry, { message: string }>["code"],
        string | number | undefined
      > = true;
      expect(_codeCheck).toBe(true);
    });

    const clientMock = {
      connect: mock(),
      close: mock(),
    };

    let moduleRef: TestingModule;
    let microservice: MicroserviceHealthIndicator;

    beforeEach(async () => {
      clientMock.connect.mockReset();
      clientMock.close.mockReset();

      moduleRef = await Test.createTestingModule({
        providers: [MicroserviceHealthIndicator, HealthIndicatorService],
      }).compile({ logger: false });
      microservice = await moduleRef.resolve(MicroserviceHealthIndicator);
      await microservice.onModuleInit();
    });

    afterEach(async () => {
      await moduleRef.close();
    });

    itAdapted(
      ["ADR-001"],
      "closes the client after a successful connect",
      async () => {
        clientMock.connect.mockResolvedValue(undefined);

        const result = await microservice.pingCheck("tcp", {
          transport: Transport.TCP,
          options: {},
          client: clientMock,
        });

        expect(result).toEqual({
          tcp: { status: "up", responseTime: expect.any(Number) },
        });
        expect(clientMock.close).toHaveBeenCalledTimes(1);
      },
      "Passes options.client directly instead of mocking ClientProxyFactory.create",
    );

    itAdapted(
      ["ADR-001"],
      "closes the client when connect fails",
      async () => {
        clientMock.connect.mockRejectedValue(new Error("ECONNREFUSED"));

        const result = await microservice.pingCheck("tcp", {
          transport: Transport.TCP,
          options: {},
          client: clientMock,
        });

        expect(result).toEqual({
          tcp: {
            status: "down",
            message: "ECONNREFUSED",
            responseTime: expect.any(Number),
          },
        });
        expect(clientMock.close).toHaveBeenCalledTimes(1);
      },
      "Passes options.client directly instead of mocking ClientProxyFactory.create",
    );

    it("adds the error code to a failed result (a real TCP client on a closed port)", async () => {
      // A port that was just free and is closed again
      const server = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: { data() {} },
      });
      const { port } = server;
      server.stop(true);

      const result = await microservice.pingCheck("tcp", {
        transport: Transport.TCP,
        options: { host: "127.0.0.1", port },
      });

      expect(result).toEqual({
        tcp: {
          status: "down",
          message: `connect ECONNREFUSED 127.0.0.1:${port}`,
          code: "ECONNREFUSED",
          responseTime: expect.any(Number),
        },
      });
    });

    it('falls back to "<key> is not available" when connect rejects with a non-Error', async () => {
      clientMock.connect.mockRejectedValue({
        err: "connectFailed",
        url: "amqp://x",
      });

      const result = await microservice.pingCheck("rmq", {
        transport: Transport.RMQ,
        options: {},
        client: clientMock,
      });

      expect(result).toEqual({
        rmq: {
          status: "down",
          message: "rmq is not available",
          responseTime: expect.any(Number),
        },
      });
    });

    describe("probe defaults & transport options", () => {
      itAdapted(
        ["ADR-001"],
        "supports Kafka transport probe via custom ping/client hook",
        async () => {
          const ping = mock(async () => undefined);
          const result = await microservice.pingCheck("kafka", {
            transport: Transport.KAFKA,
            options: { client: { brokers: ["localhost:9092"] } },
            ping,
          });

          expect(result).toEqual({
            kafka: { status: "up", responseTime: expect.any(Number) },
          });
          expect(ping).toHaveBeenCalledTimes(1);
        },
        "Zero-dep MicroserviceHealthIndicator probes non-TCP transports via options.ping or options.client rather than KafkaJS producerOnlyMode",
      );

      itAdapted(
        ["ADR-001"],
        "probes RMQ transport urls without asserting a queue",
        async () => {
          const server = Bun.listen({
            hostname: "127.0.0.1",
            port: 0,
            socket: { data() {} },
          });
          const { port } = server;
          try {
            const result = await microservice.pingCheck("rmq", {
              transport: Transport.RMQ,
              options: { urls: [`amqp://127.0.0.1:${port}`] },
            });
            expect(result).toEqual({
              rmq: { status: "up", responseTime: expect.any(Number) },
            });
          } finally {
            server.stop(true);
          }
        },
        "Zero-dep MicroserviceHealthIndicator extracts host:port from options.urls for raw TCP probe without amqplib queue assertion",
      );

      itAdapted(
        ["ADR-001"],
        "probes RMQ transport urls when queue is undefined",
        async () => {
          const server = Bun.listen({
            hostname: "127.0.0.1",
            port: 0,
            socket: { data() {} },
          });
          const { port } = server;
          try {
            const result = await microservice.pingCheck("rmq", {
              transport: Transport.RMQ,
              options: { urls: [`amqp://127.0.0.1:${port}`], queue: undefined },
            });
            expect(result.rmq.status).toBe("up");
          } finally {
            server.stop(true);
          }
        },
        "Zero-dep raw TCP probe over options.urls with queue: undefined",
      );

      itAdapted(
        ["ADR-001"],
        "probes RMQ transport when queue is configured",
        async () => {
          clientMock.connect.mockResolvedValue(undefined);
          const result = await microservice.pingCheck("rmq", {
            transport: Transport.RMQ,
            options: { urls: ["amqp://localhost:5672"], queue: "health" },
            client: clientMock,
          });
          expect(result.rmq.status).toBe("up");
          expect(clientMock.connect).toHaveBeenCalledTimes(1);
          expect(clientMock.close).toHaveBeenCalledTimes(1);
        },
        "Zero-dep probe uses caller-supplied client for custom RMQ queue verification",
      );

      itAdapted(
        ["ADR-001"],
        "lets caller override behavior with custom ping hook",
        async () => {
          let receivedSignal: AbortSignal | undefined;
          const result = await microservice.pingCheck("rmq", {
            transport: Transport.RMQ,
            options: { urls: ["amqp://localhost:5672"], noAssert: false },
            ping: async (signal: AbortSignal) => {
              receivedSignal = signal;
            },
          });
          expect(result.rmq.status).toBe("up");
          expect(receivedSignal).toBeInstanceOf(AbortSignal);
        },
        "Zero-dep probe supports caller override via options.ping(signal)",
      );

      it("does not mutate the given options", async () => {
        clientMock.connect.mockResolvedValue(undefined);
        const given = {
          transport: Transport.RMQ,
          options: { urls: ["amqp://localhost:5672"] },
          client: clientMock,
        };
        await microservice.pingCheck("rmq", given);

        expect(given.options).toEqual({ urls: ["amqp://localhost:5672"] });
      });
    });
  },
);
