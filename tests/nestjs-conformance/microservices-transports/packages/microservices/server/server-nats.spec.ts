import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import {
  createSandbox,
  describeConformance,
  expectCalledOnce,
  expectNotCalled,
  itAdapted,
} from "../../../../_helpers";
import {
  BadRequestException,
  HttpException,
  HttpStatus,
} from "../../../../../../packages/common/src";
import {
  NatsClientProxy,
  NatsRecordBuilder,
  NatsServer,
  NatsTransportAdapter,
  NatsTransportServer,
  RpcException,
  Transport,
  type NatsMessageLike,
  type NatsSubscriptionLike,
  type NatsTransportClientLike,
  type RpcContext,
  type RpcEventEnvelope,
  type RpcRequestEnvelope,
  type RpcResponseEnvelope,
} from "../../../../../../packages/microservices/src";

interface RecordedSub {
  readonly subject: string;
  readonly handler: (msg: NatsMessageLike) => Promise<void> | void;
  unsubscribed: boolean;
  unsubscribeCount: number;
}

interface RecordedPublish {
  readonly subject: string;
  readonly data: string | Uint8Array;
  readonly options?: { reply?: string };
}

function createMockNatsBroker(config?: {
  omitSubscriptionReturn?: boolean;
  omitUnsubscribeMethod?: boolean;
}) {
  const subs: RecordedSub[] = [];
  const subsBySubject = new Map<string, Set<RecordedSub>>();
  const published: RecordedPublish[] = [];

  const client: NatsTransportClientLike = {
    subscribe(subject, handler): NatsSubscriptionLike | void {
      const entry: RecordedSub = {
        subject,
        handler,
        unsubscribed: false,
        unsubscribeCount: 0,
      };
      subs.push(entry);
      let set = subsBySubject.get(subject);
      if (!set) {
        set = new Set();
        subsBySubject.set(subject, set);
      }
      set.add(entry);

      if (config?.omitSubscriptionReturn) {
        return undefined;
      }
      if (config?.omitUnsubscribeMethod) {
        return {};
      }
      return {
        unsubscribe() {
          entry.unsubscribed = true;
          entry.unsubscribeCount += 1;
          set?.delete(entry);
        },
      };
    },
    async publish(subject, data, options) {
      published.push({ subject, data, options });
      const listeners = [...(subsBySubject.get(subject) ?? [])];
      for (const listener of listeners) {
        await listener.handler({
          subject,
          data,
          reply: options?.reply,
          respond: options?.reply
            ? (replyData) => client.publish(options.reply!, replyData)
            : undefined,
        });
      }
    },
  };

  const deliverToSubject = async (subject: string, msg: NatsMessageLike) => {
    const listeners = [...(subsBySubject.get(subject) ?? [])];
    for (const listener of listeners) {
      await listener.handler(msg);
    }
  };

  return {
    client,
    subs,
    published,
    deliverToSubject,
  };
}

describeConformance(
  "ServerNats (NatsTransportServer)",
  {
    upstreamPath: "packages/microservices/test/server/server-nats.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Bunest uses client-injected NatsTransportClientLike (zero @nats-io/transport-node driver dependency) and Promise-based message/event handlers instead of RxJS streams.",
  },
  () => {
    const sandbox = createSandbox();
    const activeServers: NatsTransportServer[] = [];

    const track = (server: NatsTransportServer): NatsTransportServer => {
      activeServers.push(server);
      return server;
    };

    afterEach(async () => {
      sandbox.restore();
      while (activeServers.length > 0) {
        const s = activeServers.pop();
        await s?.close();
      }
    });

    describe("constructor & handler registration", () => {
      it("sets Transport.NATS and exposes NatsServer and NatsTransportAdapter.Server aliases", () => {
        const broker = createMockNatsBroker();
        const server = track(new NatsTransportServer({ client: broker.client }));

        expect(server.transport).toBe(Transport.NATS);
        expect(server.isListening).toBe(false);
        expect(NatsServer).toBe(NatsTransportServer);
        expect(NatsTransportAdapter.Server).toBe(NatsTransportServer);
        expect(server.unwrap<NatsTransportServer>()).toBe(server);
      });

      it("registers string, RegExp, and structured object patterns and rejects duplicate message handlers", () => {
        const broker = createMockNatsBroker();
        const server = track(new NatsTransportServer({ client: broker.client }));

        const sumHandler = () => 1;
        const regexHandler = () => 2;
        const evt1 = () => {};
        const evt2 = () => {};

        server.addMessageHandler("math.sum", sumHandler);
        server.addMessageHandler({ cmd: "mul", v: 1 }, sumHandler);
        server.addMessageHandler(/^orders\./, regexHandler);
        server.addEventHandler("audit.log", evt1);
        server.addEventHandler("audit.log", evt2);

        expect(server.getMessageHandler("math.sum")).toBe(sumHandler);
        expect(server.getMessageHandler({ v: 1, cmd: "mul" })).toBe(sumHandler);
        expect(server.getMessageHandler(/^orders\./)).toBe(regexHandler);
        expect(server.getEventHandlers("audit.log")).toEqual([evt1, evt2]);
        expect(server.getRegisteredPatterns()).toEqual({
          messagePatterns: ["math.sum", '{"cmd":"mul","v":1}', "/^orders\\./"],
          eventPatterns: ["audit.log"],
        });

        expect(() => server.addMessageHandler("math.sum", () => 3)).toThrow(
          /Duplicate @MessagePattern\(math\.sum\)/,
        );
        expect(() =>
          server.addMessageHandler({ v: 1, cmd: "mul" }, () => 4),
        ).toThrow(/Duplicate @MessagePattern/);
      });
    });

    describe("listen() & close()", () => {
      it("subscribes unique subjects with optional subjectPrefix and makes listen() idempotent", async () => {
        const broker = createMockNatsBroker();
        const server = track(
          new NatsTransportServer({
            client: broker.client,
            subjectPrefix: "svc.billing",
          }),
        );

        server.addMessageHandler("invoice.get", () => "ok");
        server.addEventHandler("invoice.get", () => {});
        server.addEventHandler("invoice.paid", () => {});

        await server.listen();
        expect(server.isListening).toBe(true);
        expect(broker.subs.map((s) => s.subject)).toEqual([
          "svc.billing.invoice.get",
          "svc.billing.invoice.paid",
        ]);

        // Second listen() must be a no-op
        await server.listen();
        expect(broker.subs).toHaveLength(2);
      });

      it("unsubscribes all stored subscriptions on close(), resets isListening, and supports re-listening", async () => {
        const broker = createMockNatsBroker();
        const server = track(new NatsTransportServer({ client: broker.client }));

        server.addMessageHandler("ping", () => "pong");
        server.addEventHandler("tick", () => {});
        await server.listen();

        expect(broker.subs).toHaveLength(2);
        await server.close();

        expect(server.isListening).toBe(false);
        expect(broker.subs[0]?.unsubscribed).toBe(true);
        expect(broker.subs[1]?.unsubscribed).toBe(true);

        // Repeated close must not double-unsubscribe
        await server.close();
        expect(broker.subs[0]?.unsubscribeCount).toBe(1);
        expect(broker.subs[1]?.unsubscribeCount).toBe(1);

        // Re-listening subscribes newly registered patterns as well
        server.addMessageHandler("pong", () => "ping");
        await server.listen();
        expect(server.isListening).toBe(true);
        expect(broker.subs).toHaveLength(5);
      });

      it("handles subscribe() returning void or subscription objects without unsubscribe()", async () => {
        const voidBroker = createMockNatsBroker({
          omitSubscriptionReturn: true,
        });
        const voidServer = track(
          new NatsTransportServer({ client: voidBroker.client }),
        );
        voidServer.addMessageHandler("a", () => 1);
        await voidServer.listen();
        await expect(voidServer.close()).resolves.toBeUndefined();

        const partialBroker = createMockNatsBroker({
          omitUnsubscribeMethod: true,
        });
        const partialServer = track(
          new NatsTransportServer({ client: partialBroker.client }),
        );
        partialServer.addMessageHandler("b", () => 2);
        await partialServer.listen();
        await expect(partialServer.close()).resolves.toBeUndefined();
      });
    });

    describe("onMessage() — request-reply dispatch", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "dispatches request with RpcContext and prefers msg.respond() over client.publish(msg.reply)",
        async () => {
          const broker = createMockNatsBroker();
          const server = track(
            new NatsTransportServer({
              client: broker.client,
              subjectPrefix: "prod",
            }),
          );

          let capturedCtx: RpcContext | undefined;
          server.addMessageHandler("orders.get", async (data, ctx) => {
            capturedCtx = ctx;
            await Promise.resolve();
            return { received: data };
          });
          await server.listen();

          const respondSpy = sandbox.spy();
          const req: RpcRequestEnvelope = {
            type: "request",
            id: "req-1",
            pattern: "orders.get",
            data: { orderId: "o-7" },
          };

          await broker.deliverToSubject("prod.orders.get", {
            subject: "prod.orders.get",
            reply: "_INBOX.req-1",
            data: JSON.stringify(req),
            respond: respondSpy,
          });

          expect(capturedCtx).toEqual({
            transport: Transport.NATS,
            pattern: "orders.get",
            metadata: {
              subject: "prod.orders.get",
              reply: "_INBOX.req-1",
            },
          });
          expectCalledOnce(respondSpy);
          expect(broker.published).toHaveLength(0);

          const replyEnvelope = JSON.parse(
            String(respondSpy.firstCall?.args[0]),
          ) as RpcResponseEnvelope;
          expect(replyEnvelope).toEqual({
            type: "response",
            id: "req-1",
            response: { received: { orderId: "o-7" } },
            isDisposed: true,
          });
        },
      );

      it("falls back to client.publish(msg.reply, ...) when msg.respond is absent", async () => {
        const broker = createMockNatsBroker();
        const server = track(new NatsTransportServer({ client: broker.client }));
        server.addMessageHandler("math.double", (n) => (n as number) * 2);
        await server.listen();

        await broker.deliverToSubject("math.double", {
          subject: "math.double",
          reply: "_INBOX.fallback",
          data: JSON.stringify({
            type: "request",
            id: "req-2",
            pattern: "math.double",
            data: 21,
          } satisfies RpcRequestEnvelope),
        });

        expect(broker.published).toHaveLength(1);
        expect(broker.published[0]?.subject).toBe("_INBOX.fallback");
        expect(JSON.parse(String(broker.published[0]?.data))).toEqual({
          type: "response",
          id: "req-2",
          response: 42,
          isDisposed: true,
        });
      });

      it("silently drops reply when neither msg.respond nor msg.reply is present", async () => {
        const broker = createMockNatsBroker();
        const server = track(new NatsTransportServer({ client: broker.client }));
        const handlerSpy = sandbox.spy(() => "computed");
        server.addMessageHandler("fire.and.drop", handlerSpy);
        await server.listen();

        await broker.deliverToSubject("fire.and.drop", {
          subject: "fire.and.drop",
          data: JSON.stringify({
            type: "request",
            id: "req-3",
            pattern: "fire.and.drop",
            data: "hello",
          } satisfies RpcRequestEnvelope),
        });

        expectCalledOnce(handlerSpy);
        expect(broker.published).toHaveLength(0);
      });

      it("decodes Uint8Array request payloads cleanly", async () => {
        const encoder = new TextEncoder();
        const broker = createMockNatsBroker();
        const server = track(new NatsTransportServer({ client: broker.client }));
        server.addMessageHandler("bin.echo", (data) => ({ echoed: data }));
        await server.listen();

        const respondSpy = sandbox.spy();
        await broker.deliverToSubject("bin.echo", {
          subject: "bin.echo",
          reply: "_INBOX.bin",
          data: encoder.encode(
            JSON.stringify({
              type: "request",
              id: "req-bin",
              pattern: "bin.echo",
              data: "café",
            } satisfies RpcRequestEnvelope),
          ),
          respond: respondSpy,
        });

        expectCalledOnce(respondSpy);
        expect(JSON.parse(String(respondSpy.firstCall?.args[0]))).toEqual({
          type: "response",
          id: "req-bin",
          response: { echoed: "café" },
          isDisposed: true,
        });
      });

      it("ignores malformed JSON, non-envelope payloads, and response envelopes without invoking handlers", async () => {
        const broker = createMockNatsBroker();
        const server = track(new NatsTransportServer({ client: broker.client }));
        const handlerSpy = sandbox.spy(() => "should-not-run");
        server.addMessageHandler("test", handlerSpy);
        await server.listen();

        const respondSpy = sandbox.spy();
        const noiseMessages = [
          "{not-json",
          JSON.stringify({ pattern: "test", data: "missing-type" }),
          JSON.stringify({
            type: "response",
            id: "resp-1",
            response: "active",
            isDisposed: true,
          } satisfies RpcResponseEnvelope),
        ];

        for (const payload of noiseMessages) {
          await broker.deliverToSubject("test", {
            subject: "test",
            reply: "_INBOX.noise",
            data: payload,
            respond: respondSpy,
          });
        }

        expectNotCalled(handlerSpy);
        expectNotCalled(respondSpy);
        expect(broker.published).toHaveLength(0);
      });

      it("replies with 404 RpcException when no message handler exists for a request pattern", async () => {
        const broker = createMockNatsBroker();
        const server = track(new NatsTransportServer({ client: broker.client }));
        // Only register an event handler so the subject is subscribed
        const eventSpy = sandbox.spy();
        server.addEventHandler("only.event", eventSpy);
        await server.listen();

        const respondSpy = sandbox.spy();
        await broker.deliverToSubject("only.event", {
          subject: "only.event",
          reply: "_INBOX.404",
          data: JSON.stringify({
            type: "request",
            id: "req-404",
            pattern: "only.event",
            data: null,
          } satisfies RpcRequestEnvelope),
          respond: respondSpy,
        });

        expectNotCalled(eventSpy);
        expectCalledOnce(respondSpy);
        const reply = JSON.parse(
          String(respondSpy.firstCall?.args[0]),
        ) as RpcResponseEnvelope;
        expect(reply.id).toBe("req-404");
        expect(reply.error?.isRpcException).toBe(true);
        expect(reply.error?.status).toBe(404);
        expect(reply.error?.message).toContain("only.event");
      });

      // BUNEST_BUG: NatsTransportServer.onMessage() checks `typeof msg.respond === "function"` without verifying `msg.reply` is defined, so real NATS Msg instances with a `.respond()` method but `reply: undefined` still get `msg.respond()` called (packages/microservices/src/transports/broker.transports.ts).
      it.skip("does not call msg.respond() when msg.reply is undefined", async () => {
        const broker = createMockNatsBroker();
        const server = track(new NatsTransportServer({ client: broker.client }));
        server.addMessageHandler("no.reply", () => "result");
        await server.listen();

        const respondSpy = sandbox.spy();
        await broker.deliverToSubject("no.reply", {
          subject: "no.reply",
          reply: undefined,
          data: JSON.stringify({
            type: "request",
            id: "req-noreply",
            pattern: "no.reply",
            data: "x",
          } satisfies RpcRequestEnvelope),
          respond: respondSpy,
        });

        expectNotCalled(respondSpy);
      });

      // BUNEST_BUG: NatsTransportServer.onMessage() does not unwrap NatsRecord returned from a message handler; it serializes the raw { data, headers } wrapper inside response and does not forward headers to msg.respond() (packages/microservices/src/transports/broker.transports.ts).
      it.skip("unwraps NatsRecord returned by a message handler into response data and headers", async () => {
        const broker = createMockNatsBroker();
        const server = track(new NatsTransportServer({ client: broker.client }));
        const headers = { "x-source": "nats-srv" };
        server.addMessageHandler("record.op", () =>
          new NatsRecordBuilder({ value: "ok" }).setHeaders(headers).build(),
        );
        await server.listen();

        const respondSpy = sandbox.spy();
        await broker.deliverToSubject("record.op", {
          subject: "record.op",
          reply: "_INBOX.rec",
          data: JSON.stringify({
            type: "request",
            id: "req-rec",
            pattern: "record.op",
            data: null,
          } satisfies RpcRequestEnvelope),
          respond: respondSpy,
        });

        expectCalledOnce(respondSpy);
        const reply = JSON.parse(
          String(respondSpy.firstCall?.args[0]),
        ) as RpcResponseEnvelope;
        expect(reply.response).toEqual({ value: "ok" });
        expect(respondSpy.firstCall?.args[1]).toEqual({ headers });
      });

      // BUNEST_BUG: NatsTransportServer lacks NATS wildcard subject matching/precedence; when both wildcard ("orders.*") and exact ("orders.get") handlers receive a matching request, both execute and send duplicate replies (packages/microservices/src/transports/broker.transports.ts).
      it.skip("prefers exact message handler over wildcard subscription without duplicate replies", async () => {
        const broker = createMockNatsBroker();
        const server = track(new NatsTransportServer({ client: broker.client }));
        const wildcardSpy = sandbox.spy(() => "wildcard");
        const exactSpy = sandbox.spy(() => "exact");
        server.addMessageHandler("orders.*", wildcardSpy);
        server.addMessageHandler("orders.get", exactSpy);
        await server.listen();

        const respondSpy = sandbox.spy();
        const msg: NatsMessageLike = {
          subject: "orders.get",
          reply: "_INBOX.wc",
          data: JSON.stringify({
            type: "request",
            id: "req-wc",
            pattern: "orders.get",
            data: null,
          } satisfies RpcRequestEnvelope),
          respond: respondSpy,
        };

        await broker.deliverToSubject("orders.*", msg);
        await broker.deliverToSubject("orders.get", msg);

        expectNotCalled(wildcardSpy);
        expectCalledOnce(exactSpy);
        expectCalledOnce(respondSpy);
      });
    });

    describe("onMessage() — error serialization", () => {
      it("serializes RpcException (string & object), HttpException, Error, and non-Error values", async () => {
        const broker = createMockNatsBroker();
        const server = track(new NatsTransportServer({ client: broker.client }));

        server.addMessageHandler("err.rpc.str", () => {
          throw new RpcException("rpc-string-error");
        });
        server.addMessageHandler("err.rpc.obj", () => {
          throw new RpcException({ status: 409, message: "conflict", field: "id" });
        });
        server.addMessageHandler("err.http", () => {
          throw new BadRequestException("bad request payload");
        });
        server.addMessageHandler("err.http.custom", () => {
          throw new HttpException({ reason: "teapot" }, HttpStatus.I_AM_A_TEAPOT);
        });
        server.addMessageHandler("err.generic", () => {
          throw new TypeError("invalid type");
        });
        server.addMessageHandler("err.primitive", () => {
          throw "raw-failure";
        });
        await server.listen();

        const invoke = async (pattern: string): Promise<RpcResponseEnvelope> => {
          const respondSpy = sandbox.spy();
          await broker.deliverToSubject(pattern, {
            subject: pattern,
            reply: `_INBOX.${pattern}`,
            data: JSON.stringify({
              type: "request",
              id: `id-${pattern}`,
              pattern,
              data: null,
            } satisfies RpcRequestEnvelope),
            respond: respondSpy,
          });
          return JSON.parse(
            String(respondSpy.firstCall?.args[0]),
          ) as RpcResponseEnvelope;
        };

        const rpcStr = await invoke("err.rpc.str");
        expect(rpcStr.error).toEqual({
          message: "rpc-string-error",
          name: "RpcException",
          isRpcException: true,
        });

        const rpcObj = await invoke("err.rpc.obj");
        expect(rpcObj.error).toEqual({
          message: "conflict",
          name: "RpcException",
          status: 409,
          details: { status: 409, message: "conflict", field: "id" },
          isRpcException: true,
        });

        const httpErr = await invoke("err.http");
        expect(httpErr.error?.isRpcException).toBe(true);
        expect(httpErr.error?.status).toBe(400);
        expect(httpErr.error?.name).toBe("BadRequestException");

        const customHttp = await invoke("err.http.custom");
        expect(customHttp.error?.isRpcException).toBe(true);
        expect(customHttp.error?.status).toBe(418);
        expect(customHttp.error?.details).toEqual({ reason: "teapot" });

        const genericErr = await invoke("err.generic");
        expect(genericErr.error).toEqual({
          message: "invalid type",
          name: "TypeError",
          isRpcException: false,
        });

        const primitiveErr = await invoke("err.primitive");
        expect(primitiveErr.error).toEqual({
          message: "raw-failure",
          isRpcException: false,
        });
      });
    });

    describe("onMessage() — event dispatch & error isolation", () => {
      it("dispatches events to all registered handlers in order and isolates thrown/rejected errors", async () => {
        const broker = createMockNatsBroker();
        const server = track(new NatsTransportServer({ client: broker.client }));
        const log: string[] = [];

        server.addEventHandler("user.updated", (data, ctx) => {
          log.push(`h1:${JSON.stringify(data)}:${ctx.transport}`);
        });
        server.addEventHandler("user.updated", () => {
          log.push("h2:throw");
          throw new Error("sync boom");
        });
        server.addEventHandler("user.updated", async () => {
          log.push("h3:reject");
          throw new Error("async boom");
        });
        server.addEventHandler("user.updated", (data, ctx) => {
          log.push(`h4:${ctx.pattern}:${String(ctx.metadata?.subject)}`);
        });
        await server.listen();

        const respondSpy = sandbox.spy();
        await broker.deliverToSubject("user.updated", {
          subject: "user.updated",
          reply: "_INBOX.unused",
          data: JSON.stringify({
            type: "event",
            pattern: "user.updated",
            data: { id: 9 },
          } satisfies RpcEventEnvelope),
          respond: respondSpy,
        });

        expect(log).toEqual([
          'h1:{"id":9}:NATS',
          "h2:throw",
          "h3:reject",
          "h4:user.updated:user.updated",
        ]);
        expectNotCalled(respondSpy);
        expect(broker.published).toHaveLength(0);
      });

      it("silently ignores event envelopes delivered to a message-only pattern", async () => {
        const broker = createMockNatsBroker();
        const server = track(new NatsTransportServer({ client: broker.client }));
        const msgSpy = sandbox.spy(() => "msg");
        server.addMessageHandler("rpc.only", msgSpy);
        await server.listen();

        await broker.deliverToSubject("rpc.only", {
          subject: "rpc.only",
          data: JSON.stringify({
            type: "event",
            pattern: "rpc.only",
            data: "ignored",
          } satisfies RpcEventEnvelope),
        });

        expectNotCalled(msgSpy);
      });
    });

    describe("setPreRequestHook()", () => {
      it("runs preRequestHook before message handler and serializes hook failures as RPC errors", async () => {
        const broker = createMockNatsBroker();
        const server = track(new NatsTransportServer({ client: broker.client }));
        const order: string[] = [];

        const chained = server.setPreRequestHook(({ pattern, data, ctx }) => {
          order.push(`hook:${pattern}:${ctx.transport}:${String(data)}`);
          if (data === "deny") {
            throw new RpcException({ status: 401, message: "Unauthorized" });
          }
        });
        expect(chained).toBe(server);

        server.addMessageHandler("secure.op", (data) => {
          order.push(`handler:${String(data)}`);
          return { granted: data };
        });
        await server.listen();

        const okRespond = sandbox.spy();
        await broker.deliverToSubject("secure.op", {
          subject: "secure.op",
          reply: "_INBOX.ok",
          data: JSON.stringify({
            type: "request",
            id: "1",
            pattern: "secure.op",
            data: "allow",
          } satisfies RpcRequestEnvelope),
          respond: okRespond,
        });

        expect(order).toEqual(["hook:secure.op:NATS:allow", "handler:allow"]);
        expect(
          (JSON.parse(String(okRespond.firstCall?.args[0])) as RpcResponseEnvelope)
            .response,
        ).toEqual({ granted: "allow" });

        const denyRespond = sandbox.spy();
        await broker.deliverToSubject("secure.op", {
          subject: "secure.op",
          reply: "_INBOX.deny",
          data: JSON.stringify({
            type: "request",
            id: "2",
            pattern: "secure.op",
            data: "deny",
          } satisfies RpcRequestEnvelope),
          respond: denyRespond,
        });

        expect(order).toEqual([
          "hook:secure.op:NATS:allow",
          "handler:allow",
          "hook:secure.op:NATS:deny",
        ]);
        const denyReply = JSON.parse(
          String(denyRespond.firstCall?.args[0]),
        ) as RpcResponseEnvelope;
        expect(denyReply.error?.status).toBe(401);
        expect(denyReply.error?.isRpcException).toBe(true);

        // Clearing hook restores direct dispatch
        server.setPreRequestHook(undefined);
        const clearedRespond = sandbox.spy();
        await broker.deliverToSubject("secure.op", {
          subject: "secure.op",
          reply: "_INBOX.clear",
          data: JSON.stringify({
            type: "request",
            id: "3",
            pattern: "secure.op",
            data: "deny",
          } satisfies RpcRequestEnvelope),
          respond: clearedRespond,
        });
        expect(
          (
            JSON.parse(
              String(clearedRespond.firstCall?.args[0]),
            ) as RpcResponseEnvelope
          ).response,
        ).toEqual({ granted: "deny" });
      });
    });

    describe("end-to-end client-server roundtrip", () => {
      it("routes structured patterns, RpcExceptions, and events between NatsClientProxy and NatsServer", async () => {
        const broker = createMockNatsBroker();
        const server = track(
          new NatsServer({
            client: broker.client,
            subjectPrefix: "e2e",
          }),
        );
        const receivedEvents: unknown[] = [];

        server.addMessageHandler({ cmd: "sum" }, (nums) =>
          (nums as number[]).reduce((a, b) => a + b, 0),
        );
        server.addMessageHandler("fail", () => {
          throw new RpcException({ status: 400, message: "bad-input" });
        });
        server.addEventHandler("log", (entry) => {
          receivedEvents.push(entry);
        });
        await server.listen();

        const client = new NatsClientProxy({
          client: broker.client,
          subjectPrefix: "e2e",
        });

        try {
          expect(await client.send<number>({ cmd: "sum" }, [10, 20, 12])).toBe(
            42,
          );
          await expect(client.send("fail", null)).rejects.toMatchObject({
            name: "RpcException",
            message: "bad-input",
          });
          await client.emit("log", { level: "info" });
          expect(receivedEvents).toEqual([{ level: "info" }]);
        } finally {
          await client.close();
        }
      });
    });
  },
);
