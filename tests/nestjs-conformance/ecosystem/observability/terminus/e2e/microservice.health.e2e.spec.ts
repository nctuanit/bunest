import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Controller, Get } from "../../../../../../packages/core/src/common";
import { Transport } from "../../../../../../packages/microservices/src";
import {
  HealthCheck,
  HealthCheckService,
  MicroserviceHealthIndicator,
  TerminusModule,
  type HealthCheckResult,
} from "../../../../../../packages/observability/src";
import {
  adaptedTitle,
  createTestApp,
  describeConformance,
  httpRequest,
  itAdapted,
  type TestAppContext,
} from "../../../../_helpers/index";

function createMicroserviceHealthApp(
  handler: (props: {
    healthCheck: HealthCheckService;
    microservice: MicroserviceHealthIndicator;
  }) => Promise<HealthCheckResult>,
): Promise<TestAppContext> {
  @Controller()
  class HealthController {
    constructor(
      private readonly healthCheck: HealthCheckService,
      private readonly microservice: MicroserviceHealthIndicator,
    ) {}

    @Get("health")
    @HealthCheck()
    health() {
      return handler({
        healthCheck: this.healthCheck,
        microservice: this.microservice,
      });
    }
  }

  return createTestApp(
    {
      imports: [TerminusModule.forRoot({ logger: false })],
      controllers: [HealthController],
    },
    { silentLogger: true },
  );
}

// Note on typing: BUNEST_BUG — `@bunest/microservices`'s `TcpClientOptions` and
// `RmqOptions` fail the `MicroserviceOptionsLike` generic constraint
// (`options?: Record<string, unknown> & ...` in packages/observability/src/health/health.indicators.ts:861),
// so calls below omit explicit `<TcpClientOptions>`/`<RmqOptions>`/`<KafkaOptions>` type arguments.
describeConformance(
  "MicroserviceHealthIndicator (e2e)",
  {
    upstreamPath: "terminus/e2e/health-checks/microservice.health.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/terminus MicroserviceHealthIndicator E2E spec to zero-socket BunestApplication, ephemeral local TCP server (port: 0), and Docker-free RMQ/Kafka transport probes via TCP url parsing and options.ping/options.client.",
  },
  () => {
    let ctx: TestAppContext | undefined;
    let tcpServer: Bun.TCPSocketListener<undefined> | undefined;
    let tcpPort = 0;

    const closeTcpServer = () => {
      if (tcpServer) {
        const toClose = tcpServer;
        tcpServer = undefined;
        toClose.stop(true);
      }
    };

    beforeEach(() => {
      tcpServer = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: { data() {} },
      });
      tcpPort = tcpServer.port;
    });

    afterEach(async () => {
      if (ctx) {
        await ctx.close();
        ctx = undefined;
      }
      closeTcpServer();
    });

    describe("TCP", () => {
      itAdapted(
        ["ADR-001"],
        "should connect",
        async () => {
          ctx = await createMicroserviceHealthApp(
            ({ healthCheck, microservice }) =>
              healthCheck.check([
                async () =>
                  microservice.pingCheck("tcp", {
                    transport: Transport.TCP,
                    options: {
                      host: "127.0.0.1",
                      port: tcpPort,
                    },
                  }),
              ]),
          );

          const details = {
            tcp: { status: "up", responseTime: expect.any(Number) },
          };
          const res = await httpRequest(ctx.app).get("/health").expect(200);
          const body = res.body as Record<string, unknown>;
          expect(body.status).toBe("ok");
          expect(body.info).toEqual(details);
          expect(body.error).toEqual({});
          expect(body.details).toEqual(details);
        },
        "Uses local ephemeral node:net TCP server (port: 0) instead of fixed port 8889",
      );

      it(
        adaptedTitle(
          ["ADR-001"],
          "should throw an error if is not reachable",
          "Uses closed ephemeral localhost TCP port instead of fixed port 8889",
        ),
        async () => {
          ctx = await createMicroserviceHealthApp(
            ({ healthCheck, microservice }) =>
              healthCheck.check([
                async () =>
                  microservice.pingCheck("tcp", {
                    transport: Transport.TCP,
                    options: {
                      host: "127.0.0.1",
                      port: tcpPort,
                    },
                  }),
              ]),
          );

          await closeTcpServer();

          const details = {
            tcp: {
              status: "down",
              message: `connect ECONNREFUSED 127.0.0.1:${tcpPort}`,
              code: "ECONNREFUSED",
              responseTime: expect.any(Number),
            },
          };
          const res = await httpRequest(ctx.app).get("/health").expect(503);
          const body = res.body as Record<string, unknown>;
          expect(body.status).toBe("error");
          expect(body.info).toEqual({});
          expect(body.error).toEqual(details);
          expect(body.details).toEqual(details);
        },
      );
    });

    describe("RMQ", () => {
      itAdapted(
        ["ADR-001"],
        "should connect",
        async () => {
          ctx = await createMicroserviceHealthApp(
            ({ healthCheck, microservice }) =>
              healthCheck.check([
                async () =>
                  microservice.pingCheck("rmq", {
                    transport: Transport.RMQ,
                    options: {
                      urls: [`amqp://127.0.0.1:${tcpPort}`],
                    },
                  }),
              ]),
          );

          const details = {
            rmq: { status: "up", responseTime: expect.any(Number) },
          };
          const res = await httpRequest(ctx.app).get("/health").expect(200);
          const body = res.body as Record<string, unknown>;
          expect(body.status).toBe("ok");
          expect(body.info).toEqual(details);
          expect(body.error).toEqual({});
          expect(body.details).toEqual(details);
        },
        "Probes local ephemeral TCP socket via RMQ options.urls without Docker",
      );

      it(
        adaptedTitle(
          ["ADR-001"],
          "should throw an error if is not reachable",
          "Zero-dep RMQ url probe fails with ECONNREFUSED against closed ephemeral port without Docker",
        ),
        async () => {
          ctx = await createMicroserviceHealthApp(
            ({ healthCheck, microservice }) =>
              healthCheck.check([
                async () =>
                  microservice.pingCheck("rmq", {
                    transport: Transport.RMQ,
                    options: {
                      urls: [`amqp://127.0.0.1:${tcpPort}`],
                    },
                  }),
              ]),
          );

          await closeTcpServer();

          const details = {
            rmq: {
              status: "down",
              message: `connect ECONNREFUSED 127.0.0.1:${tcpPort}`,
              code: "ECONNREFUSED",
              responseTime: expect.any(Number),
            },
          };
          const res = await httpRequest(ctx.app).get("/health").expect(503);
          const body = res.body as Record<string, unknown>;
          expect(body.status).toBe("error");
          expect(body.info).toEqual({});
          expect(body.error).toEqual(details);
          expect(body.details).toEqual(details);
        },
      );
    });

    describe("Kafka", () => {
      itAdapted(
        ["ADR-001"],
        "should connect",
        async () => {
          ctx = await createMicroserviceHealthApp(
            ({ healthCheck, microservice }) =>
              healthCheck.check([
                async () =>
                  microservice.pingCheck("kafka", {
                    transport: Transport.KAFKA,
                    options: {
                      client: {
                        brokers: [`127.0.0.1:${tcpPort}`],
                      },
                    },
                    ping: async () => undefined,
                  }),
              ]),
          );

          const details = {
            kafka: { status: "up", responseTime: expect.any(Number) },
          };
          const res = await httpRequest(ctx.app).get("/health").expect(200);
          const body = res.body as Record<string, unknown>;
          expect(body.status).toBe("ok");
          expect(body.info).toEqual(details);
          expect(body.error).toEqual({});
          expect(body.details).toEqual(details);
        },
        "Probes Kafka transport via options.ping hook without Docker/KafkaJS",
      );
    });
  },
);
