import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import {
  ClientsModule,
  InMemoryBroker,
  InMemoryClientProxy,
  InMemoryServer,
  NatsTransportAdapter,
  RabbitMqTransportAdapter,
  RedisTransportAdapter,
  RpcException,
  Transport,
  type ClientProxy,
  type NatsMessageLike,
  type NatsTransportClientLike,
  type RabbitMqChannelLike,
  type RabbitMqMessageLike,
  type RedisTransportClientLike,
} from "../src/index";

describe("InMemoryTransport", () => {
  it("routes RPC requests, events, and RpcExceptions in-process via ClientsModule", async () => {
    const broker = new InMemoryBroker();
    const server = new InMemoryServer({ channel: "orders", broker });
    const events: unknown[] = [];

    server.addMessageHandler("orders.get", (data: unknown) => {
      const { id } = data as { id: string };
      if (id === "missing") {
        throw new RpcException({ status: 404, message: "Order not found" });
      }
      return { id, status: "paid" };
    });
    server.addEventHandler("orders.paid", (data) => {
      events.push(data);
    });

    await server.listen();

    const ORDERS_CLIENT = "ORDERS_CLIENT";
    const mod = await Test.createTestingModule({
      imports: [
        ClientsModule.register([
          {
            name: ORDERS_CLIENT,
            transport: Transport.IN_MEMORY,
            options: { channel: "orders", broker },
          },
        ]),
      ],
    }).compile();
    await mod.init();

    const client = mod.get<ClientProxy>(ORDERS_CLIENT);
    expect(client).toBeInstanceOf(InMemoryClientProxy);

    expect(await client.send("orders.get", { id: "ord_1" })).toEqual({
      id: "ord_1",
      status: "paid",
    });

    await expect(client.send("orders.get", { id: "missing" })).rejects.toBeInstanceOf(
      RpcException,
    );

    await client.emit("orders.paid", { id: "ord_1" });
    expect(events).toEqual([{ id: "ord_1" }]);

    await mod.close();
    await server.close();
  });
});

describe("Broker Transport Adapters (Redis, NATS, RabbitMQ)", () => {
  it("RedisTransportAdapter handles request-reply, RpcException, and pub/sub events", async () => {
    const channels = new Map<string, Set<(msg: string, ch: string) => void>>();
    const mockRedis: RedisTransportClientLike = {
      subscribe(channel, listener) {
        let set = channels.get(channel);
        if (!set) {
          set = new Set();
          channels.set(channel, set);
        }
        set.add(listener);
      },
      unsubscribe(channel) {
        channels.delete(channel);
      },
      publish(channel, message) {
        for (const listener of channels.get(channel) ?? []) {
          listener(message, channel);
        }
        return 1;
      },
    };

    const server = new RedisTransportAdapter.Server({
      pubClient: mockRedis,
      subClient: mockRedis,
      channelPrefix: "svc",
    });
    const receivedEvents: unknown[] = [];

    server.addMessageHandler("math.mul", (data: unknown) => {
      const { a, b } = data as { a: number; b: number };
      return a * b;
    });
    server.addMessageHandler("math.div", (data: unknown) => {
      const { a, b } = data as { a: number; b: number };
      if (b === 0) throw new RpcException("division by zero");
      return a / b;
    });
    server.addEventHandler("math.logged", (data) => {
      receivedEvents.push(data);
    });

    await server.listen();

    const client = new RedisTransportAdapter.Client({
      pubClient: mockRedis,
      subClient: mockRedis,
      channelPrefix: "svc",
    });

    expect(await client.send<number>("math.mul", { a: 6, b: 7 })).toBe(42);
    await expect(
      client.send("math.div", { a: 1, b: 0 }),
    ).rejects.toThrow("division by zero");

    await client.emit("math.logged", { op: "mul" });
    expect(receivedEvents).toEqual([{ op: "mul" }]);

    await client.close();
    await server.close();
  });

  it("NatsTransportAdapter handles request-reply (inbox & native request) and events", async () => {
    const subs = new Map<
      string,
      Set<(msg: NatsMessageLike) => Promise<void> | void>
    >();

    const makeNatsClient = (withNativeRequest: boolean): NatsTransportClientLike => {
      const client: NatsTransportClientLike = {
        subscribe(subject, handler) {
          let set = subs.get(subject);
          if (!set) {
            set = new Set();
            subs.set(subject, set);
          }
          set.add(handler);
          return {
            unsubscribe() {
              set?.delete(handler);
            },
          };
        },
        async publish(subject, data, options) {
          for (const handler of [...(subs.get(subject) ?? [])]) {
            await handler({
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

      if (withNativeRequest) {
        client.request = (subject, data) =>
          new Promise<NatsMessageLike>((resolve) => {
            const reply = `_INBOX.${crypto.randomUUID()}`;
            const sub = client.subscribe(reply, (msg) => {
              void (sub as { unsubscribe?: () => void })?.unsubscribe?.();
              resolve(msg);
            });
            void client.publish(subject, data, { reply });
          });
      }

      return client;
    };

    const nativeNats = makeNatsClient(true);
    const server = new NatsTransportAdapter.Server({
      client: nativeNats,
      subjectPrefix: "bunest",
    });
    const events: unknown[] = [];

    server.addMessageHandler("ping", (d: unknown) => ({ pong: d }));
    server.addEventHandler("metrics", (d) => {
      events.push(d);
    });
    await server.listen();

    // 1. Native request() path
    const clientNative = new NatsTransportAdapter.Client({
      client: nativeNats,
      subjectPrefix: "bunest",
    });
    expect(await clientNative.send("ping", "v1")).toEqual({ pong: "v1" });

    // 2. Inbox fallback path (client without .request())
    const clientInbox = new NatsTransportAdapter.Client({
      client: makeNatsClient(false),
      subjectPrefix: "bunest",
    });
    expect(await clientInbox.send("ping", "v2")).toEqual({ pong: "v2" });

    await clientNative.emit("metrics", { cpu: 42 });
    expect(events).toEqual([{ cpu: 42 }]);

    await clientNative.close();
    await clientInbox.close();
    await server.close();
  });

  it("RabbitMqTransportAdapter handles queue RPC with correlationId, ack, and events", async () => {
    const consumers = new Map<
      string,
      Array<{ tag: string; handler: (msg: RabbitMqMessageLike) => Promise<void> | void }>
    >();
    let ackedCount = 0;
    let tagSeq = 0;

    const mockChannel: RabbitMqChannelLike = {
      assertQueue(queue) {
        if (!consumers.has(queue)) {
          consumers.set(queue, []);
        }
        return { queue };
      },
      consume(queue, onMessage) {
        const tag = `ctag_${++tagSeq}`;
        const list = consumers.get(queue) ?? [];
        list.push({ tag, handler: onMessage });
        consumers.set(queue, list);
        return { consumerTag: tag };
      },
      async sendToQueue(queue, content, options) {
        const list = consumers.get(queue) ?? [];
        for (const consumer of [...list]) {
          await consumer.handler({
            content,
            properties: {
              correlationId: options?.correlationId,
              replyTo: options?.replyTo,
            },
          });
        }
        return true;
      },
      ack() {
        ackedCount++;
      },
      cancel(consumerTag) {
        for (const list of consumers.values()) {
          const idx = list.findIndex((c) => c.tag === consumerTag);
          if (idx !== -1) list.splice(idx, 1);
        }
      },
    };

    const server = new RabbitMqTransportAdapter.Server({
      channel: mockChannel,
      queue: "jobs.rpc",
    });
    const events: unknown[] = [];

    server.addMessageHandler("invoice.create", (data: unknown) => ({
      invoiceId: "inv_100",
      input: data,
    }));
    server.addEventHandler("invoice.sent", (data) => {
      events.push(data);
    });
    await server.listen();

    const client = new RabbitMqTransportAdapter.Client({
      channel: mockChannel,
      queue: "jobs.rpc",
    });
    await client.connect();

    const res = await client.send("invoice.create", { amount: 250 });
    expect(res).toEqual({ invoiceId: "inv_100", input: { amount: 250 } });

    await client.emit("invoice.sent", { invoiceId: "inv_100" });
    expect(events).toEqual([{ invoiceId: "inv_100" }]);
    expect(ackedCount).toBe(2);

    // Malformed JSON messages on RabbitMQ queue must not crash server/client
    await mockChannel.sendToQueue("jobs.rpc", "{not-valid-json");
    expect(await client.send("invoice.create", { amount: 99 })).toEqual({
      invoiceId: "inv_100",
      input: { amount: 99 },
    });

    await client.close();
    await server.close();
  });

  it("ignores malformed JSON payloads across Redis and NATS adapters without unhandled rejections", async () => {
    // Redis malformed payload resilience
    const redisChannels = new Map<string, Set<(msg: string, ch: string) => void>>();
    const mockRedis: RedisTransportClientLike = {
      subscribe(ch, fn) {
        let s = redisChannels.get(ch);
        if (!s) {
          s = new Set();
          redisChannels.set(ch, s);
        }
        s.add(fn);
      },
      unsubscribe(ch) {
        redisChannels.delete(ch);
      },
      publish(ch, msg) {
        for (const fn of redisChannels.get(ch) ?? []) fn(msg, ch);
        return 1;
      },
    };
    const rServer = new RedisTransportAdapter.Server({
      pubClient: mockRedis,
      channelPrefix: "safe",
    });
    rServer.addMessageHandler("ok", () => "still-alive");
    await rServer.listen();
    const rClient = new RedisTransportAdapter.Client({
      pubClient: mockRedis,
      channelPrefix: "safe",
    });
    mockRedis.publish("safe:ok", "{broken-json");
    mockRedis.publish("safe:ok.reply", "not-json-at-all");
    expect(await rClient.send("ok", {})).toBe("still-alive");
    await rClient.close();
    await rServer.close();

    // NATS malformed payload resilience
    const natsSubs = new Map<string, Set<(msg: NatsMessageLike) => Promise<void> | void>>();
    const mockNats: NatsTransportClientLike = {
      subscribe(subject, handler) {
        let s = natsSubs.get(subject);
        if (!s) {
          s = new Set();
          natsSubs.set(subject, s);
        }
        s.add(handler);
        return { unsubscribe: () => { s?.delete(handler); } };
      },
      async publish(subject, data, options) {
        for (const h of [...(natsSubs.get(subject) ?? [])]) {
          await h({
            subject,
            data,
            reply: options?.reply,
            respond: options?.reply
              ? (d) => mockNats.publish(options.reply!, d)
              : undefined,
          });
        }
      },
    };
    const nServer = new NatsTransportAdapter.Server({ client: mockNats });
    nServer.addMessageHandler("ok", () => "nats-alive");
    await nServer.listen();
    const nClient = new NatsTransportAdapter.Client({ client: mockNats });
    await mockNats.publish("ok", "{{malformed");
    expect(await nClient.send("ok", {})).toBe("nats-alive");
    await nClient.close();
    await nServer.close();
  });
});
