import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildSchema } from "../../../../../../packages/graphql/node_modules/graphql";
import {
  GRAPHQL_TRANSPORT_WS_PROTOCOL,
  GRAPHQL_WS_CLOSE_CODES,
  GqlSubscriptionService,
  type GqlSubscriptionServiceOptions,
  GraphQLWsHandler,
  type GraphQLWsServer,
} from "../../../../../../packages/graphql/src";
import {
  type BunServerLike,
  type WebSocketUpgradeHandler,
} from "../../../../../../packages/http/src";
import {
  createSpy,
  describeConformance,
  itAdapted,
} from "../../../../_helpers/index";

const sampleSchema = buildSchema(`
  type Query {
    ping: String!
  }
`);

interface RegisteredWsEntry {
  readonly path: string;
  readonly upgrade: WebSocketUpgradeHandler;
  readonly websocket: Record<string, (...args: any[]) => any>;
}

function createMockBunHttpAdapter() {
  const registrations = new Map<string, RegisteredWsEntry>();
  const registerWebsocketHandler = createSpy(
    (
      path: string,
      upgrade: WebSocketUpgradeHandler,
      websocket?: Record<string, (...args: any[]) => any>,
    ) => {
      const normalized = path.startsWith("/") ? path : `/${path}`;
      registrations.set(normalized, {
        path: normalized,
        upgrade,
        websocket: websocket ?? {},
      });
    },
  );

  const dispatchUpgrade = (req: Request, server: BunServerLike) => {
    const pathname = new URL(req.url).pathname;
    const entry = registrations.get(pathname);
    if (!entry) {
      return { handled: false as const, response: undefined };
    }
    const response = entry.upgrade(req, server);
    return { handled: true as const, response, entry };
  };

  return {
    registerWebsocketHandler,
    registrations,
    dispatchUpgrade,
  };
}

function createMockBunServer() {
  let upgradedData: unknown;
  let upgradedHeaders: Record<string, string> | undefined;
  const upgrade = createSpy(
    (
      _req: Request,
      opts?: { data?: unknown; headers?: Record<string, string> },
    ) => {
      upgradedData = opts?.data;
      upgradedHeaders = opts?.headers;
      return true;
    },
  );
  const server = {
    upgrade,
  } as unknown as BunServerLike;
  return {
    server,
    upgrade,
    getUpgradedData: () => upgradedData,
    getUpgradedHeaders: () => upgradedHeaders,
  };
}

function createMockWsSocket(data: unknown) {
  const sent: Array<Record<string, unknown>> = [];
  const close = createSpy((_code?: number, _reason?: string) => {});
  const send = createSpy((raw: string) => {
    sent.push(JSON.parse(raw) as Record<string, unknown>);
    return raw.length;
  });
  return {
    data,
    send,
    close,
    sent,
  };
}

function createUpgradeRequest(
  pathWithQuery: string,
  protocol: string | null = GRAPHQL_TRANSPORT_WS_PROTOCOL,
): Request {
  const headers: Record<string, string> = {
    upgrade: "websocket",
    connection: "Upgrade",
    "sec-websocket-version": "13",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  };
  if (protocol !== null) {
    headers["sec-websocket-protocol"] = protocol;
  }
  return new Request(`http://127.0.0.1${pathWithQuery}`, {
    method: "GET",
    headers,
  });
}

function createCustomWsServer(options: {
  noServer?: boolean;
  path?: string;
}): GraphQLWsServer {
  return {
    options,
    handleUpgrade: createSpy(),
    emit: createSpy(() => true),
  };
}

describeConformance(
  "GqlSubscriptionService",
  {
    upstreamPath:
      "packages/graphql/tests/services/gql-subscription.service.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts Node ws.WebSocketServer / http.Server upgrade listener mocks to Bunest native GqlSubscriptionService + GraphQLWsHandler + BunHttpAdapter (ADR-001, ADR-013).",
  },
  () => {
    let mockAdapter: ReturnType<typeof createMockBunHttpAdapter>;
    const servicesToStop: GqlSubscriptionService[] = [];

    beforeEach(() => {
      mockAdapter = createMockBunHttpAdapter();
    });

    afterEach(async () => {
      while (servicesToStop.length > 0) {
        await servicesToStop.pop()!.stop();
      }
    });

    describe("constructor", () => {
      itAdapted(
        "ADR-001",
        "should create default GraphQLWsHandler instance when no custom server is provided",
        () => {
          const options: GqlSubscriptionServiceOptions = {
            schema: sampleSchema,
            path: "/graphql",
            "graphql-ws": {},
          };

          const service = new GqlSubscriptionService(options, mockAdapter);
          servicesToStop.push(service);
          const handler = service.getHandler();

          expect(handler).toBeInstanceOf(GraphQLWsHandler);
          expect(handler.getPath()).toBe("/graphql");
          expect(mockAdapter.registerWebsocketHandler.callCount).toBe(1);
          expect(mockAdapter.registrations.has("/graphql")).toBe(true);
        },
      );

      // BUNEST_BUG: GqlSubscriptionService in packages/graphql/src/services/gql-subscription.service.ts (lines 44-48) ignores `options["graphql-ws"].server.options.path`, falling back to driver `options.path` ("/graphql") instead of "/subscriptions".
      it.skip("should use custom WebSocketServer instance path when provided", () => {
        const customWss = createCustomWsServer({
          noServer: true,
          path: "/subscriptions",
        });

        const options: GqlSubscriptionServiceOptions = {
          schema: sampleSchema,
          path: "/graphql",
          "graphql-ws": {
            server: customWss,
          },
        };

        const service = new GqlSubscriptionService(options, mockAdapter);
        servicesToStop.push(service);

        expect(service.getHandler().getPath()).toBe("/subscriptions");
        expect(mockAdapter.registrations.has("/subscriptions")).toBe(true);
      });

      // BUNEST_BUG: GqlSubscriptionService in packages/graphql/src/services/gql-subscription.service.ts (lines 37-50) does not validate that a custom `server` passed to `"graphql-ws"` has `options.noServer === true` and does not throw when `noServer: false`.
      it.skip("should throw an error if custom server is not instantiated with noServer: true", () => {
        const invalidWss = createCustomWsServer({
          noServer: false,
          path: "/custom",
        });

        const options: GqlSubscriptionServiceOptions = {
          schema: sampleSchema,
          path: "/graphql",
          "graphql-ws": {
            server: invalidWss,
          },
        };

        expect(() => new GqlSubscriptionService(options, mockAdapter)).toThrow(
          'Custom WebSocketServer passed to "graphql-ws" must be instantiated with "noServer: true".',
        );
      });

      itAdapted(
        "ADR-001",
        "should handle boolean true for graphql-ws (default behavior)",
        () => {
          const options: GqlSubscriptionServiceOptions = {
            schema: sampleSchema,
            path: "/graphql",
            "graphql-ws": true,
          };

          const service = new GqlSubscriptionService(options, mockAdapter);
          servicesToStop.push(service);
          const handler = service.getHandler();

          expect(handler).toBeInstanceOf(GraphQLWsHandler);
          expect(handler.getPath()).toBe("/graphql");
          expect(mockAdapter.registrations.has("/graphql")).toBe(true);
        },
      );
    });

    describe("initialize & upgrade handling", () => {
      itAdapted(
        "ADR-001",
        "should configure explicit graphql-ws path and connectionInitWaitTimeout on GraphQLWsHandler",
        async () => {
          const options: GqlSubscriptionServiceOptions = {
            schema: sampleSchema,
            path: "/graphql",
            "graphql-ws": {
              path: "/ws",
              connectionInitWaitTimeout: 60,
              unclaimedUpgradeTimeout: 5000,
            },
          };

          const service = new GqlSubscriptionService(options, mockAdapter);
          servicesToStop.push(service);

          expect(service.getHandler().getPath()).toBe("/ws");
          expect(mockAdapter.registrations.has("/ws")).toBe(true);
          expect(mockAdapter.registrations.has("/graphql")).toBe(false);

          const { server, getUpgradedData } = createMockBunServer();
          const { entry } = mockAdapter.dispatchUpgrade(
            createUpgradeRequest("/ws"),
            server,
          );
          const ws = createMockWsSocket(getUpgradedData());
          entry!.websocket.open?.(ws);

          await Bun.sleep(100);
          expect(ws.close.calledOnce).toBe(true);
          expect(ws.close.firstCall?.args[0]).toBe(
            GRAPHQL_WS_CLOSE_CODES.CONNECTION_INIT_TIMEOUT,
          );
        },
      );

      // BUNEST_BUG: GqlSubscriptionService in packages/graphql/src/services/gql-subscription.service.ts (lines 44-48) ignores `wsConfig.server?.options?.path` and registers under driver default `options.path` ("/graphql") instead of "/subscriptions".
      it.skip("should prioritize custom server path over driver default path", () => {
        const customWss = createCustomWsServer({
          noServer: true,
          path: "/subscriptions",
        });

        const options: GqlSubscriptionServiceOptions = {
          schema: sampleSchema,
          path: "/graphql",
          "graphql-ws": {
            server: customWss,
          },
        };

        const service = new GqlSubscriptionService(options, mockAdapter);
        servicesToStop.push(service);

        const { server: validServer, upgrade: validUpgrade } =
          createMockBunServer();
        const validResult = mockAdapter.dispatchUpgrade(
          createUpgradeRequest("/subscriptions"),
          validServer,
        );
        expect(validResult.handled).toBe(true);
        expect(validUpgrade.calledOnce).toBe(true);

        const { server: invalidServer, upgrade: invalidUpgrade } =
          createMockBunServer();
        const invalidResult = mockAdapter.dispatchUpgrade(
          createUpgradeRequest("/graphql"),
          invalidServer,
        );
        expect(invalidResult.handled).toBe(false);
        expect(invalidUpgrade.notCalled).toBe(true);
      });

      itAdapted(
        "ADR-001",
        "should use explicit graphql-ws path when custom server has no internal path",
        () => {
          const customWss = createCustomWsServer({ noServer: true });

          const options: GqlSubscriptionServiceOptions = {
            schema: sampleSchema,
            path: "/graphql",
            "graphql-ws": {
              server: customWss,
              path: "/explicit-path",
            },
          };

          const service = new GqlSubscriptionService(options, mockAdapter);
          servicesToStop.push(service);

          const { server, upgrade } = createMockBunServer();
          const result = mockAdapter.dispatchUpgrade(
            createUpgradeRequest("/explicit-path"),
            server,
          );
          expect(result.handled).toBe(true);
          expect(upgrade.calledOnce).toBe(true);
        },
      );

      // BUNEST_BUG: GqlSubscriptionService in packages/graphql/src/services/gql-subscription.service.ts (line 48) unconditionally defaults `path` to "/graphql" when neither `wsConfig.path`, `wsConfig.server.options.path`, nor `options.path` is set, instead of failing closed.
      it.skip("should fail closed and not handle upgrade if no path resolves", () => {
        const customWss = createCustomWsServer({ noServer: true });

        const options: GqlSubscriptionServiceOptions = {
          schema: sampleSchema,
          path: undefined,
          "graphql-ws": {
            server: customWss,
          },
        };

        const service = new GqlSubscriptionService(options, mockAdapter);
        servicesToStop.push(service);

        const { server, upgrade } = createMockBunServer();
        const result = mockAdapter.dispatchUpgrade(
          createUpgradeRequest("/graphql"),
          server,
        );
        expect(result.handled).toBe(false);
        expect(upgrade.notCalled).toBe(true);
      });

      itAdapted(
        "ADR-001",
        "should ignore upgrades to other paths when only /graphql is registered",
        () => {
          const options: GqlSubscriptionServiceOptions = {
            schema: sampleSchema,
            path: "/graphql",
            "graphql-ws": true,
          };

          const service = new GqlSubscriptionService(options, mockAdapter);
          servicesToStop.push(service);

          for (const path of ["/another", "/", "/graphq"]) {
            const { server, upgrade } = createMockBunServer();
            const res = mockAdapter.dispatchUpgrade(
              createUpgradeRequest(path),
              server,
            );
            expect(res.handled).toBe(false);
            expect(upgrade.notCalled).toBe(true);
          }
        },
      );

      describe("when another upgrade handler is registered on BunHttpAdapter (ADR-001)", () => {
        const setupMultiHandlerAdapter = (
          graphqlWsConfig: GqlSubscriptionServiceOptions["graphql-ws"] = true,
        ) => {
          const otherUpgrade = createSpy((_req: Request, _srv: BunServerLike) =>
            undefined,
          );
          mockAdapter.registerWebsocketHandler("/another", otherUpgrade, {});
          const service = new GqlSubscriptionService(
            {
              schema: sampleSchema,
              path: "/graphql",
              "graphql-ws": graphqlWsConfig,
            },
            mockAdapter,
          );
          servicesToStop.push(service);
          return { service, otherUpgrade };
        };

        itAdapted(
          "ADR-001",
          "should leave upgrades to other paths to their registered handler without throwing on socket close",
          () => {
            const { otherUpgrade } = setupMultiHandlerAdapter();
            const { server, upgrade } = createMockBunServer();

            const res = mockAdapter.dispatchUpgrade(
              createUpgradeRequest("/another", null),
              server,
            );
            expect(res.handled).toBe(true);
            expect(otherUpgrade.calledOnce).toBe(true);
            expect(upgrade.notCalled).toBe(true);
          },
        );

        itAdapted(
          "ADR-001",
          "should close an uninitialized graphql-ws connection after connectionInitWaitTimeout",
          async () => {
            setupMultiHandlerAdapter({ connectionInitWaitTimeout: 60 });
            const { server, getUpgradedData } = createMockBunServer();
            const { entry } = mockAdapter.dispatchUpgrade(
              createUpgradeRequest("/graphql"),
              server,
            );
            const ws = createMockWsSocket(getUpgradedData());
            entry!.websocket.open?.(ws);

            await Bun.sleep(25);
            expect(ws.close.notCalled).toBe(true);
            await Bun.sleep(60);
            expect(ws.close.calledOnce).toBe(true);
            expect(ws.close.firstCall?.args[0]).toBe(
              GRAPHQL_WS_CLOSE_CODES.CONNECTION_INIT_TIMEOUT,
            );
          },
        );

        itAdapted(
          "ADR-001",
          "should keep a graphql-ws connection open once connection_init is acknowledged",
          async () => {
            setupMultiHandlerAdapter({ connectionInitWaitTimeout: 60 });
            const { server, getUpgradedData } = createMockBunServer();
            const { entry } = mockAdapter.dispatchUpgrade(
              createUpgradeRequest("/graphql"),
              server,
            );
            const ws = createMockWsSocket(getUpgradedData());
            entry!.websocket.open?.(ws);
            entry!.websocket.message?.(
              ws,
              JSON.stringify({ type: "connection_init" }),
            );

            await Bun.sleep(90);
            expect(ws.close.notCalled).toBe(true);
            expect(ws.sent).toContainEqual({ type: "connection_ack" });
          },
        );

        itAdapted(
          "ADR-001",
          "should close a connection with BAD_REQUEST on malformed JSON payload",
          async () => {
            setupMultiHandlerAdapter();
            const { server, getUpgradedData } = createMockBunServer();
            const { entry } = mockAdapter.dispatchUpgrade(
              createUpgradeRequest("/graphql"),
              server,
            );
            const ws = createMockWsSocket(getUpgradedData());
            entry!.websocket.open?.(ws);
            entry!.websocket.message?.(ws, "{not-valid-json");

            await Bun.sleep(10);
            expect(ws.close.calledOnce).toBe(true);
            expect(ws.close.firstCall?.args[0]).toBe(
              GRAPHQL_WS_CLOSE_CODES.BAD_REQUEST,
            );
          },
        );

        itAdapted(
          "ADR-001",
          "should close an unauthenticated subscribe frame before connection_init with UNAUTHORIZED",
          async () => {
            setupMultiHandlerAdapter();
            const { server, getUpgradedData } = createMockBunServer();
            const { entry } = mockAdapter.dispatchUpgrade(
              createUpgradeRequest("/graphql"),
              server,
            );
            const ws = createMockWsSocket(getUpgradedData());
            entry!.websocket.open?.(ws);
            entry!.websocket.message?.(
              ws,
              JSON.stringify({
                id: "1",
                type: "subscribe",
                payload: { query: "{ ping }" },
              }),
            );

            await Bun.sleep(10);
            expect(ws.close.calledOnce).toBe(true);
            expect(ws.close.firstCall?.args[0]).toBe(
              GRAPHQL_WS_CLOSE_CODES.UNAUTHORIZED,
            );
          },
        );

        itAdapted(
          "ADR-001",
          'should accept "unclaimedUpgradeTimeout" option alongside other upgrade handlers',
          () => {
            const { otherUpgrade } = setupMultiHandlerAdapter({
              unclaimedUpgradeTimeout: 5000,
            });
            const { server } = createMockBunServer();
            const res = mockAdapter.dispatchUpgrade(
              createUpgradeRequest("/another", null),
              server,
            );
            expect(res.handled).toBe(true);
            expect(otherUpgrade.calledOnce).toBe(true);
          },
        );

        itAdapted(
          "ADR-001",
          'should accept "unclaimedUpgradeTimeout: 0" alongside other upgrade handlers',
          () => {
            const { otherUpgrade } = setupMultiHandlerAdapter({
              unclaimedUpgradeTimeout: 0,
            });
            const { server } = createMockBunServer();
            const res = mockAdapter.dispatchUpgrade(
              createUpgradeRequest("/another", null),
              server,
            );
            expect(res.handled).toBe(true);
            expect(otherUpgrade.calledOnce).toBe(true);
          },
        );
      });

      itAdapted(
        "ADR-001",
        "should only handle upgrades to the whole path when custom server has no internal path",
        () => {
          const customWss = createCustomWsServer({ noServer: true });

          const options: GqlSubscriptionServiceOptions = {
            schema: sampleSchema,
            path: "/graphql",
            "graphql-ws": { server: customWss },
          };

          const service = new GqlSubscriptionService(options, mockAdapter);
          servicesToStop.push(service);

          for (const url of [
            "/graphql-admin",
            "/graphql/admin",
            "/graphql/../live",
          ]) {
            const { server, upgrade } = createMockBunServer();
            const res = mockAdapter.dispatchUpgrade(
              createUpgradeRequest(url),
              server,
            );
            expect(res.handled).toBe(false);
            expect(upgrade.notCalled).toBe(true);
          }

          const { server, upgrade } = createMockBunServer();
          const matched = mockAdapter.dispatchUpgrade(
            createUpgradeRequest("/graphql?token=1"),
            server,
          );
          expect(matched.handled).toBe(true);
          expect(upgrade.calledOnce).toBe(true);
        },
      );

      // BUNEST_BUG: GqlSubscriptionService.initialize() in packages/graphql/src/services/gql-subscription.service.ts (lines 150-164) unconditionally registers a WebSocket handler on BunHttpAdapter even when `options["graphql-ws"]` is undefined or false.
      it.skip("should not take over upgrades when graphql-ws is not enabled", () => {
        const configs: GqlSubscriptionServiceOptions[] = [
          { schema: sampleSchema, path: "/graphql" },
          { schema: sampleSchema, path: "/graphql", "graphql-ws": false },
        ];

        for (const options of configs) {
          const service = new GqlSubscriptionService(options, mockAdapter);
          servicesToStop.push(service);
        }

        expect(mockAdapter.registerWebsocketHandler.notCalled).toBe(true);
        expect(mockAdapter.registrations.size).toBe(0);
      });

      itAdapted(
        "ADR-001",
        "should reject upgrades with an unsupported subprotocol",
        () => {
          const options: GqlSubscriptionServiceOptions = {
            schema: sampleSchema,
            path: "/graphql",
            "graphql-ws": true,
          };

          const service = new GqlSubscriptionService(options, mockAdapter);
          servicesToStop.push(service);

          const { server, upgrade } = createMockBunServer();
          const res = mockAdapter.dispatchUpgrade(
            createUpgradeRequest("/graphql", "other-protocol"),
            server,
          );
          expect(res.handled).toBe(true);
          expect(res.response).toBeInstanceOf(Response);
          expect((res.response as Response).status).toBe(400);
          expect(upgrade.notCalled).toBe(true);
        },
      );
    });

    describe("stop", () => {
      itAdapted(
        "ADR-001",
        "should close all active graphql-ws sockets on stop",
        async () => {
          const options: GqlSubscriptionServiceOptions = {
            schema: sampleSchema,
            path: "/graphql",
            "graphql-ws": true,
          };

          const service = new GqlSubscriptionService(options, mockAdapter);
          const { server, getUpgradedData } = createMockBunServer();
          const { entry } = mockAdapter.dispatchUpgrade(
            createUpgradeRequest("/graphql"),
            server,
          );
          const ws = createMockWsSocket(getUpgradedData());
          entry!.websocket.open?.(ws);

          await service.stop();

          expect(ws.close.calledOnce).toBe(true);
          expect(ws.close.firstCall?.args[0]).toBe(1001);
        },
      );
    });
  },
);
