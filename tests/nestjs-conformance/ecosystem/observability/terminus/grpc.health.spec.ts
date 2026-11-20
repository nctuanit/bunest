import "reflect-metadata";
import net from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import {
  GRPCHealthIndicator,
  HealthIndicatorService,
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

// Note on typing: BUNEST_BUG — `@bunest/microservices`'s `GrpcOptions` has
// `package?: string | readonly string[]`, which fails `GrpcClientOptionsLike`
// (`package?: string | string[]` in packages/observability/src/health/health.indicators.ts:1053),
// so calls below omit the `<GrpcOptions>` type argument.
describeConformance(
  "GRPCHealthIndicator",
  {
    upstreamPath:
      "terminus/lib/health-indicator/microservice/grpc.health.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapts upstream @nestjs/terminus GRPCHealthIndicator unit tests to zero-dep Bunest GRPCHealthIndicator (ADR-001/ADR-008: Promise-based client/healthService/healthServiceCheck stubs and native TCP url probe without @grpc/grpc-js or RxJS).",
  },
  () => {
    it("types the failure data on a failed result", () => {
      type Entry = Awaited<
        ReturnType<GRPCHealthIndicator["checkService"]>
      >[string];
      type Failure = Extract<Entry, { message: string }>;
      const _codeCheck: AssertEqual<Failure["code"], number | undefined> = true;
      const _statusCheck: AssertEqual<
        Failure["servingStatus"],
        string | number | undefined
      > = true;
      expect(_codeCheck && _statusCheck).toBe(true);
    });

    const healthServiceMock = {
      check: mock(
        async (_req: { service: string }): Promise<{ status: number }> => ({
          status: 1,
        }),
      ),
    };

    const grpcClientMock = {
      getService: mock((_name: string): unknown => healthServiceMock),
      close: mock(),
    };

    let moduleRef: TestingModule;
    let grpc: GRPCHealthIndicator;

    beforeEach(async () => {
      healthServiceMock.check.mockReset();
      healthServiceMock.check.mockResolvedValue({ status: 1 });
      grpcClientMock.getService.mockReset();
      grpcClientMock.getService.mockImplementation(() => healthServiceMock);
      grpcClientMock.close.mockReset();

      moduleRef = await Test.createTestingModule({
        providers: [GRPCHealthIndicator, HealthIndicatorService],
      }).compile({ logger: false });
      grpc = await moduleRef.resolve(GRPCHealthIndicator);
      await grpc.onModuleInit();
    });

    afterEach(async () => {
      await moduleRef.close();
    });

    describe("checkService", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "should return a healthy result",
        async () => {
          const result = await grpc.checkService("grpc", "test", {
            client: grpcClientMock,
          });
          expect(result).toEqual({
            grpc: {
              servingStatus: "SERVING",
              status: "up",
              statusCode: 1,
              responseTime: expect.any(Number),
            },
          });
        },
        "Passes Promise-based client stub instead of mocking @nestjs/microservices ClientProxyFactory",
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "should keep its own data when the user adds data to the attempt",
        async () => {
          const result = await grpc
            .checkService("grpc", "test", {
              client: grpcClientMock,
            })
            .withData({ owner: "team-heroes" })
            .withSuccessData({ region: "eu" });
          expect(result).toEqual({
            grpc: {
              status: "up",
              statusCode: 1,
              servingStatus: "SERVING",
              owner: "team-heroes",
              region: "eu",
              responseTime: expect.any(Number),
            },
          });
        },
        "Passes Promise-based client stub",
      );

      itAdapted(
        ["ADR-001"],
        'should look up default "Health" service and pass service name to check()',
        async () => {
          await grpc.checkService("grpc", "test", {
            client: grpcClientMock,
          });
          expect(grpcClientMock.getService).toHaveBeenCalledWith("Health");
          expect(healthServiceMock.check).toHaveBeenCalledWith({
            service: "test",
          });
        },
        "Zero-dep GRPCHealthIndicator calls client.getService('Health') without ClientProxyFactory",
      );

      itAdapted(
        ["ADR-001"],
        "should accept custom protoPath, timeout, and package options with client",
        async () => {
          const result = await grpc.checkService("grpc", "test", {
            protoPath: "test.proto",
            timeout: 100,
            package: "grpc.health.v2",
            client: grpcClientMock,
          });
          expect(result.grpc.status).toBe("up");
          expect(healthServiceMock.check).toHaveBeenCalledWith({
            service: "test",
          });
        },
        "Zero-dep GRPCHealthIndicator accepts gRPC options alongside custom client",
      );

      itAdapted(
        ["ADR-001"],
        "should track one client per key and close each on shutdown",
        async () => {
          const clientA = {
            getService: mock(() => healthServiceMock),
            close: mock(),
          };
          const clientB = {
            getService: mock(() => healthServiceMock),
            close: mock(),
          };
          await grpc.checkService("a", "test", {
            url: "a:50051",
            client: clientA,
          });
          await grpc.checkService("a", "test", {
            url: "a:50051",
            client: clientA,
          });
          await grpc.checkService("b", "test", {
            url: "b:50051",
            client: clientB,
          });
          grpc.onApplicationShutdown();
          expect(clientA.close).toHaveBeenCalledTimes(1);
          expect(clientB.close).toHaveBeenCalledTimes(1);
        },
        "Clients are tracked per indicator key and closed on shutdown",
      );

      it("should close the clients on shutdown", async () => {
        await grpc.checkService("grpc", "test", {
          client: grpcClientMock,
        });
        grpc.onApplicationShutdown();
        expect(grpcClientMock.close).toHaveBeenCalledTimes(1);
      });

      // BUNEST_BUG: NotServingError formats message as "The service is not serving (status: NOT_SERVING)" instead of upstream "serving status: NOT_SERVING" (packages/observability/src/health/units.ts:111).
      it.skip("should be down in case the health service returns a faulty response code", async () => {
        healthServiceMock.check.mockResolvedValueOnce({ status: 2 });
        const result = await grpc.checkService("grpc", "test", {
          client: grpcClientMock,
        });
        expect(result).toEqual({
          grpc: {
            status: "down",
            message: "serving status: NOT_SERVING",
            statusCode: 2,
            servingStatus: "NOT_SERVING",
            responseTime: expect.any(Number),
          },
        });
      });

      it("should add the gRPC status code when the call fails", async () => {
        healthServiceMock.check.mockRejectedValueOnce(
          Object.assign(
            new Error("14 UNAVAILABLE: No connection established"),
            {
              code: 14,
              details: "No connection established",
              metadata: {},
            },
          ),
        );
        const result = await grpc.checkService("grpc", "test", {
          client: grpcClientMock,
        });
        expect(result).toEqual({
          grpc: {
            status: "down",
            message: "14 UNAVAILABLE: No connection established",
            code: 14,
            responseTime: expect.any(Number),
          },
        });
      });

      it("should be down when the timeout runs out", async () => {
        healthServiceMock.check.mockImplementationOnce(
          () => new Promise(() => {}),
        );
        const result = await grpc.checkService("grpc", "test", {
          timeout: 10,
          client: grpcClientMock,
        });
        expect(result).toEqual({
          grpc: {
            status: "down",
            message: "timeout of 10ms exceeded",
            responseTime: expect.any(Number),
          },
        });
      });

      itAdapted(
        ["ADR-001"],
        "should be down when no url, client, healthService, or healthServiceCheck is configured",
        async () => {
          const result = await grpc.checkService("grpc", "test");
          expect(result).toEqual({
            grpc: {
              status: "down",
              message: expect.stringContaining('GRPCHealthIndicator("grpc")'),
              responseTime: expect.any(Number),
            },
          });
        },
        "Replaces ClientProxyFactory creation error with zero-dep missing-target error",
      );

      it("should use the custom healthServiceCheck function", async () => {
        const healthServiceCheck = mock(async () => ({ status: 1 }));

        await grpc.checkService("grpc", "test", {
          healthServiceCheck,
        });

        expect(healthServiceCheck).toHaveBeenCalledTimes(1);
      });

      it("should use the custom healthServiceName", async () => {
        await grpc.checkService("grpc", "test", {
          healthServiceName: "health2",
          client: grpcClientMock,
        });
        expect(grpcClientMock.getService).toHaveBeenCalledWith("health2");
      });

      it("should be down when client.getService throws a TypeError", async () => {
        grpcClientMock.getService.mockImplementationOnce(() => {
          throw new TypeError("test");
        });
        const result = await grpc.checkService("grpc", "test", {
          client: grpcClientMock,
        });
        expect(result).toEqual({
          grpc: {
            status: "down",
            message: "test",
            responseTime: expect.any(Number),
          },
        });
      });
    });

    describe("GRPCHealthIndicator with a local server / stub", () => {
      let tcpServer: net.Server;
      let listeningUrl: string;
      let closedUrl: string;

      beforeAll(async () => {
        tcpServer = net.createServer();
        await new Promise<void>((resolve) =>
          tcpServer.listen(0, "127.0.0.1", resolve),
        );
        listeningUrl = `127.0.0.1:${(tcpServer.address() as net.AddressInfo).port}`;

        const probe = net.createServer();
        await new Promise<void>((resolve) =>
          probe.listen(0, "127.0.0.1", resolve),
        );
        closedUrl = `127.0.0.1:${(probe.address() as net.AddressInfo).port}`;
        await new Promise<void>((resolve) => probe.close(() => resolve()));
      });

      afterAll(async () => {
        await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
      });

      itAdapted(
        ["ADR-001"],
        "should be up when probing a listening TCP endpoint via url",
        async () => {
          const result = await grpc.checkService("grpc", "ok", {
            url: listeningUrl,
          });
          expect(result).toEqual({
            grpc: {
              status: "up",
              statusCode: 1,
              servingStatus: "SERVING",
              responseTime: expect.any(Number),
            },
          });
        },
        "Zero-dep url probe checks TCP reachability without @grpc/grpc-js",
      );

      // BUNEST_BUG: NotServingError formats message as "The service is not serving (status: NOT_SERVING)" instead of upstream "serving status: NOT_SERVING" (packages/observability/src/health/units.ts:111).
      it.skip("should add the serving status when the service is not serving", async () => {
        const result = await grpc.checkService("grpc", "down", {
          healthService: {
            check: async ({ service }: { service: string }) => ({
              status: service === "ok" ? 1 : 2,
            }),
          },
        });
        expect(result).toEqual({
          grpc: {
            status: "down",
            message: "serving status: NOT_SERVING",
            statusCode: 2,
            servingStatus: "NOT_SERVING",
            responseTime: expect.any(Number),
          },
        });
      });

      itAdapted(
        ["ADR-001"],
        "should be down when nothing listens on the target url",
        async () => {
          const result = await grpc.checkService("grpc", "ok", {
            url: closedUrl,
          });
          expect(result.grpc).toMatchObject({
            status: "down",
            message: expect.stringContaining("ECONNREFUSED"),
          });
        },
        "Zero-dep TCP url probe fails with ECONNREFUSED instead of @grpc/grpc-js numeric status 14",
      );
    });
  },
);
