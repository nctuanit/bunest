import { afterEach, describe, expect, it } from "bun:test";
import { Controller, Get } from "../../../../../../packages/core/src/common";
import {
  HealthCheck,
  HealthCheckService,
  HttpHealthIndicator,
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

function createHttpHealthApp(
  handler: (props: {
    healthCheck: HealthCheckService;
    http: HttpHealthIndicator;
  }) => Promise<HealthCheckResult>,
): Promise<TestAppContext> {
  @Controller()
  class HealthController {
    constructor(
      private readonly healthCheck: HealthCheckService,
      private readonly http: HttpHealthIndicator,
    ) {}

    @Get("health")
    @HealthCheck()
    health() {
      return handler({ healthCheck: this.healthCheck, http: this.http });
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

describeConformance(
  "HttpHealthIndicator (e2e)",
  {
    upstreamPath: "terminus/e2e/health-checks/http.health.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapts upstream @nestjs/terminus HttpHealthIndicator E2E spec to zero-socket BunestApplication, ephemeral local Bun.serve remote server (zero Express, zero external DNS), and native fetch-backed HttpHealthIndicator (includes responseTime via HealthCheckAttempt).",
  },
  () => {
    let ctx: TestAppContext | undefined;
    let remoteServer: ReturnType<typeof Bun.serve> | undefined;
    const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

    const startRemoteServer = (
      handler: (req: Request) => Response | Promise<Response>,
    ): string => {
      remoteServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: handler,
      });
      return `http://127.0.0.1:${remoteServer.port}`;
    };

    afterEach(async () => {
      for (const timer of pendingTimers) {
        clearTimeout(timer);
      }
      pendingTimers.clear();
      if (ctx) {
        await ctx.close();
        ctx = undefined;
      }
      if (remoteServer) {
        remoteServer.stop(true);
        remoteServer = undefined;
      }
    });

    describe("#pingCheck", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "should return a healthy response if the remote server sends 200 status code",
        async () => {
          const remoteUrl = startRemoteServer(
            () => new Response("OK", { status: 200, statusText: "OK" }),
          );
          ctx = await createHttpHealthApp(({ healthCheck, http }) =>
            healthCheck.check([() => http.pingCheck("http", remoteUrl)]),
          );

          const res = await httpRequest(ctx.app).get("/health").expect(200);
          const body = res.body as Record<string, unknown>;
          const details = {
            http: { status: "up", responseTime: expect.any(Number) },
          };
          expect(body.status).toBe("ok");
          expect(body.info).toEqual(details);
          expect(body.error).toEqual({});
          expect(body.details).toEqual(details);
        },
        "Bunest native fetch HttpHealthIndicator records responseTime via HealthCheckAttempt",
      );

      it(
        adaptedTitle(
          ["ADR-001", "ADR-008"],
          "should check if correctly display a timeout error",
          "Uses local Bun.serve slow endpoint and verifies timeout error",
        ),
        async () => {
          const remoteUrl = startRemoteServer(
            () =>
              new Promise((resolve) => {
                const timer = setTimeout(() => {
                  pendingTimers.delete(timer);
                  resolve(new Response("OK", { status: 200 }));
                }, 200);
                pendingTimers.add(timer);
              }),
          );

          ctx = await createHttpHealthApp(({ healthCheck, http }) =>
            healthCheck.check([
              () => http.pingCheck("google", remoteUrl, { timeout: 1 }),
            ]),
          );

          const details = {
            google: {
              status: "down",
              message: "timeout of 1ms exceeded",
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

      it(
        adaptedTitle(
          ["ADR-001"],
          "should display an error message when the address does not exist / is unreachable",
          "Uses closed ephemeral localhost port instead of external DNS lookup",
        ),
        async () => {
          const probe = Bun.listen({
            hostname: "127.0.0.1",
            port: 0,
            socket: { data() {} },
          });
          const closedPort = probe.port;
          probe.stop(true);

          ctx = await createHttpHealthApp(({ healthCheck, http }) =>
            healthCheck.check([
              () => http.pingCheck("http", `http://127.0.0.1:${closedPort}`),
            ]),
          );

          const res = await httpRequest(ctx.app).get("/health").expect(503);
          const body = res.body as {
            status: string;
            info: Record<string, unknown>;
            error: {
              http: { status: string; message: string; responseTime: number };
            };
            details: {
              http: { status: string; message: string; responseTime: number };
            };
          };
          expect(body.status).toBe("error");
          expect(body.info).toEqual({});
          expect(body.error.http).toEqual({
            status: "down",
            message: expect.stringContaining("ECONNREFUSED"),
            responseTime: expect.any(Number),
          });
          expect(body.details).toEqual(body.error);
        },
      );

      it(
        adaptedTitle(
          ["ADR-001", "ADR-008"],
          "should return an error if the address return 404",
          "Native fetch HttpHealthIndicator includes statusCode, statusText, and responseTime",
        ),
        async () => {
          const remoteUrl = startRemoteServer(
            () =>
              new Response("Not Found", {
                status: 404,
                statusText: "Not Found",
              }),
          );
          ctx = await createHttpHealthApp(({ healthCheck, http }) =>
            healthCheck.check([() => http.pingCheck("http", remoteUrl)]),
          );

          const details = {
            http: {
              status: "down",
              message: "Request failed with status code 404",
              statusCode: 404,
              statusText: "Not Found",
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

    describe("#responseCheck", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "should be healthy if remote server returns 200 and status code 200 is expected",
        async () => {
          const remoteUrl = startRemoteServer(
            () => new Response("OK", { status: 200, statusText: "OK" }),
          );
          ctx = await createHttpHealthApp(({ healthCheck, http }) =>
            healthCheck.check([
              () =>
                http.responseCheck(
                  "http",
                  remoteUrl,
                  (res) => res.status === 200,
                ),
            ]),
          );

          const details = {
            http: { status: "up", responseTime: expect.any(Number) },
          };
          const res = await httpRequest(ctx.app).get("/health").expect(200);
          const body = res.body as Record<string, unknown>;
          expect(body.status).toBe("ok");
          expect(body.info).toEqual(details);
          expect(body.error).toEqual({});
          expect(body.details).toEqual(details);
        },
        "Native fetch responseCheck records responseTime via HealthCheckAttempt",
      );

      it("should not be healthy if remote server returns 400 and status code 200 is expected", async () => {
        const remoteUrl = startRemoteServer(
          () =>
            new Response("Bad Request", {
              status: 400,
              statusText: "Bad Request",
            }),
        );
        ctx = await createHttpHealthApp(({ healthCheck, http }) =>
          healthCheck.check([
            () =>
              http.responseCheck(
                "http",
                remoteUrl,
                (res) => res.status === 200,
              ),
          ]),
        );

        const details = {
          http: {
            status: "down",
            message: "Request failed with status code 400",
            statusCode: 400,
            statusText: "Bad Request",
            responseTime: expect.any(Number),
          },
        };

        const res = await httpRequest(ctx.app).get("/health").expect(503);
        const body = res.body as Record<string, unknown>;
        expect(body.status).toBe("error");
        expect(body.info).toEqual({});
        expect(body.error).toEqual(details);
        expect(body.details).toEqual(details);
      });

      it("should be healthy if remote server returns a text which is expected", async () => {
        const remoteUrl = startRemoteServer(
          () => new Response("response data", { status: 200 }),
        );
        ctx = await createHttpHealthApp(({ healthCheck, http }) =>
          healthCheck.check([
            () =>
              http.responseCheck(
                "http",
                remoteUrl,
                (res) => res.data === "response data",
              ),
          ]),
        );

        await httpRequest(ctx.app).get("/health").expect(200);
      });

      it("should not be healthy if remote server returns a text which is not expected", async () => {
        const remoteUrl = startRemoteServer(
          () => new Response("not response data", { status: 200 }),
        );
        ctx = await createHttpHealthApp(({ healthCheck, http }) =>
          healthCheck.check([
            () =>
              http.responseCheck(
                "http",
                remoteUrl,
                (res) => res.data === "response data",
              ),
          ]),
        );

        await httpRequest(ctx.app).get("/health").expect(503);
      });

      itAdapted(
        ["ADR-001", "ADR-008"],
        "should be healthy if remote server returns 400 and status code 400 is expected",
        async () => {
          const remoteUrl = startRemoteServer(
            () =>
              new Response("Bad Request", {
                status: 400,
                statusText: "Bad Request",
              }),
          );
          ctx = await createHttpHealthApp(({ healthCheck, http }) =>
            healthCheck.check([
              () =>
                http.responseCheck(
                  "http",
                  remoteUrl,
                  (res) => res.status === 400,
                ),
            ]),
          );

          const details = {
            http: { status: "up", responseTime: expect.any(Number) },
          };
          const res = await httpRequest(ctx.app).get("/health").expect(200);
          const body = res.body as Record<string, unknown>;
          expect(body.status).toBe("ok");
          expect(body.info).toEqual(details);
          expect(body.error).toEqual({});
          expect(body.details).toEqual(details);
        },
        "Native fetch responseCheck records responseTime via HealthCheckAttempt",
      );
    });
  },
);
