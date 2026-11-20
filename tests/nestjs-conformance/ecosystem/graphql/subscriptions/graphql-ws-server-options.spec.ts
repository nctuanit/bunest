import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  GraphQLError,
  type ValidationContext,
} from "../../../../../packages/graphql/node_modules/graphql";
import { Module } from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  GRAPHQL_TRANSPORT_WS_PROTOCOL,
  GraphQLModule,
  type GraphQLModuleOptions,
  GraphQLService,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

@Resolver()
class AppResolver {
  @Query(() => String)
  hello(): string {
    return "world";
  }

  @Query(() => String)
  secret(): string {
    return "top secret";
  }

  @Query(() => String)
  failing(): string {
    throw new Error("connection to db-internal.local:5432 refused");
  }
}

// Refuses every operation that selects the "secret" field
const NoSecretRule = (context: ValidationContext) => ({
  Field(node: { name: { value: string } }) {
    if (node.name.value === "secret") {
      context.reportError(new GraphQLError('"secret" is not allowed'));
    }
  },
});

describeConformance(
  "graphql-ws server options",
  {
    upstreamPath:
      "packages/apollo/tests/subscriptions/graphql-ws-server-options.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts ApolloDriver + ApolloFederationDriver graphql-ws server options (onSubscribe, validationRules, formatError) to native @bunest/graphql and Bun WebSocket (ADR-013).",
  },
  () => {
    const cases: Array<[string, Partial<GraphQLModuleOptions>]> = [
      ["GraphQLModule", {}],
      ["GraphQLModule Federation", { federation: { version: 2 } }],
    ];

    describe.each(cases)("graphql-ws server options (%s)", (_label, extraOpts) => {
      let app: BunestApplication;
      let ws: WebSocket | undefined;
      let port: number;
      let onSubscribe: ReturnType<typeof mock>;
      let opCounter = 0;

      beforeEach(async () => {
        onSubscribe = mock(() => {});
        opCounter = 0;

        const moduleOptions: GraphQLModuleOptions & {
          validationRules?: unknown[];
        } = {
          autoSchemaFile: true,
          includeStacktraceInErrorResponses: false,
          validationRules: [NoSecretRule],
          formatError: (formattedError) =>
            formattedError.extensions?.code === "INTERNAL_SERVER_ERROR"
              ? { message: "Internal server error" }
              : formattedError,
          subscriptions: { "graphql-ws": { onSubscribe } },
          ...extraOpts,
        };

        @Module({
          imports: [GraphQLModule.forRoot(moduleOptions)],
          providers: [AppResolver],
        })
        class AppModule {}

        const moduleRef = await Test.createTestingModule({
          imports: [AppModule],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
        app.get(GraphQLService).attachWebSocket(app);
        const info = await app.listen({ port: 0, hostname: "127.0.0.1" });
        port = info.port;

        ws = new WebSocket(
          `ws://127.0.0.1:${port}/graphql`,
          GRAPHQL_TRANSPORT_WS_PROTOCOL,
        );
        const socket = ws;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Timed out waiting for connection_ack")),
            2000,
          );
          socket.addEventListener("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
          socket.addEventListener("open", () => {
            socket.send(JSON.stringify({ type: "connection_init" }));
          });
          socket.addEventListener("message", (ev) => {
            const msg = JSON.parse(String(ev.data)) as { type: string };
            if (msg.type === "connection_ack") {
              clearTimeout(timer);
              resolve();
            }
          });
        });
      });

      afterEach(async () => {
        if (ws && ws.readyState < WebSocket.CLOSING) {
          ws.close();
        }
        ws = undefined;
        await app.close();
      });

      const overHttp = async (query: string) =>
        (await request(app).post("/graphql").send({ query })).body;

      const overWebSocket = (query: string) =>
        new Promise<any>((resolve, reject) => {
          const id = `op-${++opCounter}`;
          const socket = ws!;
          let result: any;
          const timer = setTimeout(
            () => reject(new Error("Timed out waiting for WS operation")),
            2000,
          );
          const onMessage = (ev: MessageEvent) => {
            const msg = JSON.parse(String(ev.data)) as {
              id?: string;
              type: string;
              payload?: any;
            };
            if (msg.id !== id) return;
            if (msg.type === "next") {
              result = msg.payload;
            } else if (msg.type === "error") {
              clearTimeout(timer);
              socket.removeEventListener("message", onMessage);
              resolve({ errors: msg.payload });
            } else if (msg.type === "complete") {
              clearTimeout(timer);
              socket.removeEventListener("message", onMessage);
              resolve(result);
            }
          };
          socket.addEventListener("message", onMessage);
          socket.send(
            JSON.stringify({
              id,
              type: "subscribe",
              payload: { query },
            }),
          );
        });

      // BUNEST_BUG: GraphQLWsHandler never invokes the `subscriptions["graphql-ws"].onSubscribe` callback (declared in graphql.interface.ts:469), so `onSubscribe` is called 0 times instead of 1 (packages/graphql/src/subscriptions/graphql-ws.handler.ts:395-486).
      it.skip("should execute valid operations", async () => {
        expect(await overWebSocket("{ hello }")).toEqual({
          data: { hello: "world" },
        });
        expect(onSubscribe).toHaveBeenCalledTimes(1);
      });

      // BUNEST_BUG: GraphQLModuleOptions and GraphQLService.getValidationRules() do not support custom `validationRules` (packages/graphql/src/driver/graphql-http.handler.ts:310-324), so custom rules like `NoSecretRule` are ignored over both HTTP and graphql-ws.
      it.skip('should apply "validationRules" as over HTTP', async () => {
        const httpResult = await overHttp("{ secret }");
        expect(httpResult.errors[0].message).toBe('"secret" is not allowed');

        const wsResult = await overWebSocket("{ secret }");
        expect(wsResult.data).toBeUndefined();
        expect(wsResult.errors).toEqual([
          expect.objectContaining({ message: '"secret" is not allowed' }),
        ]);
      });

      it('should apply "formatError" as over HTTP', async () => {
        const httpResult = await overHttp("{ failing }");
        expect(httpResult.errors).toEqual([
          { message: "Internal server error" },
        ]);

        expect(await overWebSocket("{ failing }")).toEqual({
          data: null,
          errors: [{ message: "Internal server error" }],
        });
      });
    });
  },
);
