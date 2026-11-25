import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type DynamicModule, Module } from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Context,
  GRAPHQL_TRANSPORT_WS_PROTOCOL,
  GraphQLModule,
  type GraphQLModuleOptions,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

function readRequestId(req: unknown): string | undefined {
  if (!req || typeof req !== "object") return undefined;
  const headers = (req as { headers?: unknown }).headers;
  if (headers instanceof Headers) {
    return headers.get("x-request-id") ?? undefined;
  }
  if (headers && typeof headers === "object") {
    return (headers as Record<string, string | undefined>)["x-request-id"];
  }
  return undefined;
}

@Resolver()
class SharedContextResolver {
  static CONTEXTS: Record<string, unknown>[] = [];
  static BARRIER: Promise<void> | undefined;

  @Query(() => String)
  async requestId(
    @Context() context: Record<string, unknown>,
  ): Promise<string> {
    SharedContextResolver.CONTEXTS.push(context);
    // Lets a test hold concurrent requests here until all of them arrived
    await SharedContextResolver.BARRIER;

    return readRequestId(context.req) ?? "";
  }
}

@Module({})
class SharedContextModule {
  static forRoot(
    context: unknown,
    options: Omit<GraphQLModuleOptions, "context"> = {},
  ): DynamicModule {
    return {
      module: SharedContextModule,
      imports: [
        GraphQLModule.forRoot({
          autoSchemaFile: true,
          context: context as GraphQLModuleOptions["context"],
          ...options,
        }),
      ],
      providers: [SharedContextResolver],
    };
  }
}

async function waitForCondition(
  check: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

async function queryOverGraphQLWs(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, GRAPHQL_TRANSPORT_WS_PROTOCOL);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket query timed out"));
    }, 3000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "connection_init" }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        payload?: unknown;
      };
      if (msg.type === "connection_ack") {
        ws.send(
          JSON.stringify({
            id: "1",
            type: "subscribe",
            payload: { query: "{ requestId }" },
          }),
        );
      } else if (msg.type === "next") {
        clearTimeout(timer);
        ws.close();
        resolve(msg.payload);
      } else if (msg.type === "error") {
        clearTimeout(timer);
        ws.close();
        reject(new Error(JSON.stringify(msg.payload)));
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timer);
      reject(err);
    };
  });
}

describeConformance(
  "GraphQL (context object shared by all requests)",
  {
    upstreamPath: "packages/apollo/tests/e2e/shared-context.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-012"],
    notes:
      "Runs on Bunest native BunHttpAdapter instead of Express/Fastify (ADR-001) and uses native WebSocket graphql-transport-ws client. Also isolates @Context() per-request context cloning from request-scoped @Inject(CONTEXT) resolver instantiation (tested in request-scoped.spec.ts).",
  },
  () => {
    let app: BunestApplication;
    let sharedContext: Record<string, unknown>;

    const queryRequestId = (id: string) =>
      request(app)
        .post("/graphql")
        .set("x-request-id", id)
        .send({ query: "{ requestId }" });

    const expectDistinctContexts = (count: number) => {
      const contexts = SharedContextResolver.CONTEXTS;
      expect(contexts).toHaveLength(count);
      expect(new Set(contexts).size).toBe(count);
      for (const context of contexts) {
        expect(context).not.toBe(sharedContext);
        expect(context.tenant).toBe("static");
      }
    };

    describe("over HTTP", () => {
      const bootstrap = async (context: unknown) => {
        const moduleRef = await Test.createTestingModule({
          imports: [SharedContextModule.forRoot(context)],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      };

      beforeEach(() => {
        sharedContext = { tenant: "static" };
        SharedContextResolver.CONTEXTS = [];
        SharedContextResolver.BARRIER = undefined;
      });

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });

      describe.each([
        ["an object", () => sharedContext],
        ["a function returning the same object", () => () => sharedContext],
      ])('when "context" is %s', (_, createContextOption) => {
        beforeEach(() => bootstrap(createContextOption()));

        it('should give each sequential request its own context and "req"', async () => {
          for (const id of ["first", "second", "third"]) {
            await queryRequestId(id).expect(200, {
              data: { requestId: id },
            });
          }

          expectDistinctContexts(3);
          expect(Reflect.ownKeys(sharedContext)).toEqual(["tenant"]);
        });

        it('should give each concurrent request its own context and "req"', async () => {
          const ids = ["a", "b", "c", "d", "e"];
          let release!: () => void;
          SharedContextResolver.BARRIER = new Promise<void>(
            (resolve) => (release = resolve),
          );

          const responses = Promise.all(ids.map((id) => queryRequestId(id)));
          try {
            await waitForCondition(
              () => SharedContextResolver.CONTEXTS.length === ids.length,
            );
          } finally {
            release();
          }

          expect((await responses).map((res) => res.body)).toEqual(
            ids.map((id) => ({ data: { requestId: id } })),
          );
          expectDistinctContexts(ids.length);
          expect(Reflect.ownKeys(sharedContext)).toEqual(["tenant"]);
        });
      });

      describe.each([
        ["an object", () => sharedContext],
        ["a function returning the same object", () => () => sharedContext],
      ])(
        'when "context" is %s with its own "req"',
        (_, createContextOption) => {
          it('should keep that "req" while still giving each request its own context', async () => {
            sharedContext.req = { headers: { "x-request-id": "static" } };
            await bootstrap(createContextOption());

            for (const id of ["first", "second"]) {
              await queryRequestId(id).expect(200, {
                data: { requestId: "static" },
              });
            }

            expectDistinctContexts(2);
            expect(Reflect.ownKeys(sharedContext)).toEqual(["tenant", "req"]);
          });
        },
      );
    });

    describe("over graphql-ws", () => {
      beforeEach(() => {
        sharedContext = {
          tenant: "static",
          req: { headers: { "x-request-id": "static" } },
        };
        SharedContextResolver.CONTEXTS = [];
        SharedContextResolver.BARRIER = undefined;
      });

      describe.each([
        ["an object", () => sharedContext],
        ["a function returning the same object", () => () => sharedContext],
      ])(
        'when "context" is %s with its own "req"',
        (_, createContextOption) => {
          beforeEach(async () => {
            const moduleRef = await Test.createTestingModule({
              imports: [
                SharedContextModule.forRoot(createContextOption(), {
                  subscriptions: { "graphql-ws": true },
                }),
              ],
            }).compile({ logger: false });

            app = moduleRef.createNestApplication({ logger: false });
            await app.listen(0);
          });

          it("should give each operation its own context", async () => {
            const url =
              app.getUrl()!.replace(/\/$/, "").replace(/^http/, "ws") +
              "/graphql";
            for (let i = 0; i < 2; i++) {
              expect(await queryOverGraphQLWs(url)).toEqual({
                data: { requestId: "static" },
              });
            }

            expectDistinctContexts(2);
            expect(Reflect.ownKeys(sharedContext)).toEqual(["tenant", "req"]);
          });

          afterEach(async () => {
            if (app) {
              await app.close();
            }
          });
        },
      );
    });
  },
);
