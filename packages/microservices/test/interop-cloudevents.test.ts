import { afterEach, describe, expect, it } from "bun:test";
import {
  CLOUD_EVENTS_SPEC_VERSION,
  CloudEventsDeserializer,
  CloudEventsSerializer,
  MqttClientProxy,
  MqttServer,
  NatsClientProxy,
  NatsServer,
  RabbitMqClientProxy,
  RabbitMqServer,
  RedisClientProxy,
  RedisServer,
  TcpClientProxy,
  TcpServer,
  encodeFrame,
  isCloudEvent,
  matchMqttTopic,
  type CloudEvent,
  type Deserializer,
  type MqttClientLike,
  type MqttMessageListener,
  type MqttQoS,
  type NatsContext,
  type NatsMessageLike,
  type NatsTransportClientLike,
  type RabbitMqChannelLike,
  type RabbitMqMessageLike,
  type RedisContext,
  type RedisTransportClientLike,
  type RmqContext,
  type Serializer,
  type TcpContext,
} from "../src/index";
import type { MqttContext } from "../src/transports/mqtt.transport";

function createMockRedisBroker() {
  const channels = new Map<string, Set<(msg: string, ch: string) => void>>();
  const subscribedChannels: string[] = [];
  const client: RedisTransportClientLike = {
    subscribe(channel, listener) {
      subscribedChannels.push(channel);
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
      for (const fn of [...(channels.get(channel) ?? [])]) {
        fn(message, channel);
      }
      return 1;
    },
  };
  return { client, subscribedChannels, channels };
}

function createMockNatsBroker() {
  const subs = new Map<
    string,
    Set<(msg: NatsMessageLike) => Promise<void> | void>
  >();
  const client: NatsTransportClientLike = {
    subscribe(subject, handler) {
      let set = subs.get(subject);
      if (!set) {
        set = new Set();
        subs.set(subject, set);
      }
      set.add(handler);
      return {
        unsubscribe: () => {
          set?.delete(handler);
        },
      };
    },
    async publish(subject, data, options) {
      for (const h of [...(subs.get(subject) ?? [])]) {
        await h({
          subject,
          data,
          reply: options?.reply,
          headers: options?.headers,
          respond: options?.reply
            ? (replyData, replyOpts) =>
                client.publish(options.reply!, replyData, replyOpts)
            : undefined,
        });
      }
    },
  };
  return { client };
}

function createMockRmqChannel() {
  const consumers = new Map<
    string,
    Array<{
      tag: string;
      handler: (msg: RabbitMqMessageLike) => Promise<void> | void;
    }>
  >();
  let seq = 0;
  const channel: RabbitMqChannelLike & {
    deliverRaw(
      queue: string,
      msg: RabbitMqMessageLike,
    ): Promise<void>;
  } = {
    assertQueue(queue) {
      if (!consumers.has(queue)) consumers.set(queue, []);
      return { queue };
    },
    consume(queue, onMessage) {
      const tag = `tag_${++seq}`;
      const list = consumers.get(queue) ?? [];
      list.push({ tag, handler: onMessage });
      consumers.set(queue, list);
      return { consumerTag: tag };
    },
    async sendToQueue(queue, content, options) {
      await channel.deliverRaw(queue, {
        content,
        properties: {
          correlationId: options?.correlationId,
          replyTo: options?.replyTo,
          headers: options?.headers,
        },
      });
      return true;
    },
    async deliverRaw(queue, msg) {
      for (const c of [...(consumers.get(queue) ?? [])]) {
        await c.handler(msg);
      }
    },
    ack() {},
    nack() {},
    cancel(tag) {
      for (const list of consumers.values()) {
        const idx = list.findIndex((c) => c.tag === tag);
        if (idx !== -1) list.splice(idx, 1);
      }
    },
  };
  return channel;
}

function createMockMqttClient(
  clients = new Set<{
    subs: Map<string, MqttQoS>;
    listeners: Set<MqttMessageListener>;
  }>(),
): MqttClientLike {
  const state = {
    subs: new Map<string, MqttQoS>(),
    listeners: new Set<MqttMessageListener>(),
  };
  clients.add(state);
  return {
    subscribe(topic, opts) {
      const list = Array.isArray(topic) ? topic : [topic];
      for (const t of list) state.subs.set(t, opts?.qos ?? 0);
    },
    unsubscribe(topic) {
      const list = Array.isArray(topic) ? topic : [topic];
      for (const t of list) state.subs.delete(t);
    },
    on(_ev, l) {
      state.listeners.add(l);
    },
    off(_ev, l) {
      state.listeners.delete(l);
    },
    publish(topic, message, opts) {
      for (const c of [...clients]) {
        const matched = [...c.subs.keys()].some(
          (f) => f === topic || matchMqttTopic(f, topic),
        );
        if (!matched) continue;
        const packet = {
          topic,
          payload: message,
          qos: opts?.qos ?? 0,
          retain: opts?.retain ?? false,
          properties: opts?.properties,
        };
        for (const l of [...c.listeners]) {
          queueMicrotask(() => l(topic, message, packet));
        }
      }
    },
  };
}

describe("CloudEvents v1.0 Serializer / Deserializer", () => {
  it("serializes and deserializes CloudEvents v1.0 structured JSON with W3C traceparent propagation", () => {
    const traceparent =
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    const serializer = new CloudEventsSerializer({
      source: "urn:orders:api",
      getTraceparent: () => traceparent,
    });

    const ce = serializer.serialize({
      id: "evt-123",
      pattern: "order.created",
      data: { orderId: "ord_9", total: 42 },
    });

    expect(isCloudEvent(ce)).toBe(true);
    expect(ce.specversion).toBe(CLOUD_EVENTS_SPEC_VERSION);
    expect(ce.id).toBe("evt-123");
    expect(ce.source).toBe("urn:orders:api");
    expect(ce.type).toBe("order.created");
    expect(ce.datacontenttype).toBe("application/json");
    expect(ce.data).toEqual({ orderId: "ord_9", total: 42 });
    expect(ce.traceparent).toBe(traceparent);
    expect(typeof ce.time).toBe("string");

    // Default "data" mode passes ce.data and populates metadata + cloudEvent
    const dataDeserializer = new CloudEventsDeserializer({ payloadMode: "data" });
    const parsedDataMode = dataDeserializer.deserialize(JSON.stringify(ce));
    expect(parsedDataMode.pattern).toBe("order.created");
    expect(parsedDataMode.data).toEqual({ orderId: "ord_9", total: 42 });
    expect(parsedDataMode.cloudEvent?.id).toBe("evt-123");
    expect(parsedDataMode.metadata?.traceparent).toBe(traceparent);

    // "envelope" mode passes { data, cloudEvent }
    const envDeserializer = new CloudEventsDeserializer({
      payloadMode: "envelope",
    });
    const parsedEnvMode = envDeserializer.deserialize(ce);
    expect(parsedEnvMode.pattern).toBe("order.created");
    expect(parsedEnvMode.data).toEqual({
      data: { orderId: "ord_9", total: 42 },
      cloudEvent: ce,
    });
  });
});

describe("Cross-Language Wire Format Interop (raw-json, cloudevents, custom serializer, channelPrefix: '')", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      await cleanupFns.pop()!();
    }
  });

  it('supports Redis channelPrefix: "" without leading colon and wireFormat: "raw-json"', async () => {
    const { client: redis, subscribedChannels } = createMockRedisBroker();
    const receivedEvents: unknown[] = [];

    const server = new RedisServer({
      pubClient: redis,
      subClient: redis,
      channelPrefix: "",
      wireFormat: "raw-json",
    });
    server.addEventHandler("orders.created", (data) => {
      receivedEvents.push(data);
    });
    server.addMessageHandler("math.double", (data) => {
      const { n } = data as { n: number };
      return { doubled: n * 2 };
    });
    await server.listen();
    cleanupFns.push(() => server.close());

    // No leading ":" when channelPrefix is ""
    expect(subscribedChannels).toContain("orders.created");
    expect(subscribedChannels).toContain("math.double");
    expect(subscribedChannels.some((ch) => ch.startsWith(":"))).toBe(false);

    // External non-Bunest Go/Python publisher emits raw JSON without { type, pattern, data }
    redis.publish("orders.created", JSON.stringify({ orderId: "py_1", usd: 99 }));
    await Bun.sleep(10);
    expect(receivedEvents).toEqual([{ orderId: "py_1", usd: 99 }]);

    // External raw-json RPC request-reply using <pattern>.reply
    let rawReply: unknown;
    redis.subscribe("math.double.reply", (msg) => {
      rawReply = JSON.parse(
        typeof msg === "string" ? msg : new TextDecoder().decode(msg),
      );
    });
    redis.publish("math.double", JSON.stringify({ n: 21 }));
    await Bun.sleep(10);
    expect(rawReply).toEqual({ doubled: 42 });

    // RedisClientProxy with channelPrefix: "" and wireFormat: "raw-json"
    const client = new RedisClientProxy({
      pubClient: redis,
      subClient: redis,
      channelPrefix: "",
      clientId: "worker-1",
      wireFormat: "raw-json",
    });
    cleanupFns.push(() => client.close());
    expect(client.replyChannel).toBe("reply:worker-1");
    expect(await client.send("math.double", { n: 12 })).toEqual({ doubled: 24 });
  });

  it('supports NATS wireFormat: "raw-json" and "cloudevents" with traceparent propagation', async () => {
    const { client: nats } = createMockNatsBroker();
    const rawEvents: unknown[] = [];
    const ceEvents: Array<{
      data: unknown;
      traceparent?: unknown;
      ceId?: string;
    }> = [];

    // 1. Raw JSON NATS server receiving non-Bunest Rust/Go JSON payloads
    const rawServer = new NatsServer({
      client: nats,
      wireFormat: "raw-json",
    });
    rawServer.addEventHandler("telemetry.cpu", (data) => {
      rawEvents.push(data);
    });
    rawServer.addMessageHandler("users.lookup", (data) => {
      const { userId } = data as { userId: string };
      return { found: true, userId };
    });
    await rawServer.listen();
    cleanupFns.push(() => rawServer.close());

    await nats.publish("telemetry.cpu", JSON.stringify({ host: "n1", pct: 77 }));
    let rpcReply: unknown;
    await nats.subscribe("_INBOX.ext1", (msg) => {
      rpcReply = JSON.parse(
        typeof msg.data === "string"
          ? msg.data
          : new TextDecoder().decode(msg.data),
      );
    });
    await nats.publish(
      "users.lookup",
      JSON.stringify({ userId: "u_77" }),
      { reply: "_INBOX.ext1" },
    );
    expect(rawEvents).toEqual([{ host: "n1", pct: 77 }]);
    expect(rpcReply).toEqual({ found: true, userId: "u_77" });

    // 2. CloudEvents NATS server + client with traceparent propagation
    const ceServer = new NatsServer({
      client: nats,
      wireFormat: "cloudevents",
      deserializer: new CloudEventsDeserializer({ payloadMode: "envelope" }),
    });
    ceServer.addEventHandler("invoice.issued", (payload, ctx) => {
      const nCtx = ctx as NatsContext;
      const typed = payload as { data: unknown; cloudEvent: CloudEvent };
      ceEvents.push({
        data: typed.data,
        traceparent: nCtx.metadata?.traceparent ?? nCtx.getMetadata()?.traceparent,
        ceId: typed.cloudEvent.id,
      });
    });
    ceServer.addMessageHandler("billing.quote", (payload) => {
      const typed = payload as { data: { seats: number }; cloudEvent: CloudEvent };
      return { total: typed.data.seats * 15, ceSource: typed.cloudEvent.source };
    });
    await ceServer.listen();
    cleanupFns.push(() => ceServer.close());

    const traceparent =
      "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    const ceClient = new NatsClientProxy({
      client: nats,
      wireFormat: "cloudevents",
      serializer: new CloudEventsSerializer({
        source: "urn:gateway",
        getTraceparent: () => traceparent,
      }),
    });
    cleanupFns.push(() => ceClient.close());

    // Publish raw CloudEvent with type matching handler while arriving on wildcard/subject
    await nats.publish(
      "invoice.issued",
      JSON.stringify({
        specversion: "1.0",
        id: "ce-900",
        source: "urn:go-billing",
        type: "invoice.issued",
        traceparent,
        data: { invoiceId: "inv_9" },
      }),
    );
    expect(ceEvents).toEqual([
      {
        data: { invoiceId: "inv_9" },
        traceparent,
        ceId: "ce-900",
      },
    ]);

    const quote = await ceClient.send("billing.quote", { seats: 4 });
    expect(quote).toEqual({ total: 60, ceSource: "urn:gateway" });
  });

  it('supports RabbitMQ wireFormat: "raw-json" (routingKey & header fallback) and "cloudevents"', async () => {
    const channel = createMockRmqChannel();
    const seenEvents: unknown[] = [];

    const server = new RabbitMqServer({
      channel,
      queue: "interop.q",
      wireFormat: "raw-json",
    });
    server.addEventHandler("payments.settled", (data) => {
      seenEvents.push(data);
    });
    server.addMessageHandler("fx.convert", (data) => {
      const { amount } = data as { amount: number };
      return { eur: amount * 0.9 };
    });
    await server.listen();
    cleanupFns.push(() => server.close());

    // External publisher delivers raw JSON with AMQP routingKey (no Bunest envelope!)
    await channel.deliverRaw("interop.q", {
      content: JSON.stringify({ txId: "tx_1", cents: 500 }),
      fields: { routingKey: "payments.settled" },
    });
    expect(seenEvents).toEqual([{ txId: "tx_1", cents: 500 }]);

    // RabbitMQ client in raw-json mode dispatches via x-pattern header & receives raw JSON reply
    const client = new RabbitMqClientProxy({
      channel,
      queue: "interop.q",
      wireFormat: "raw-json",
    });
    await client.connect();
    cleanupFns.push(() => client.close());
    expect(await client.send("fx.convert", { amount: 100 })).toEqual({ eur: 90 });

    // CloudEvents mode dispatches by ce.type even on shared queue without routingKey
    const ceChannel = createMockRmqChannel();
    const ceEvents: Array<{ data: unknown; tp?: unknown }> = [];
    const ceServer = new RabbitMqServer({
      channel: ceChannel,
      queue: "ce.q",
      wireFormat: "cloudevents",
    });
    ceServer.addEventHandler("shipment.dispatched", (data, ctx) => {
      const rCtx = ctx as RmqContext;
      ceEvents.push({
        data,
        tp: rCtx.metadata?.traceparent ?? rCtx.getMetadata()?.traceparent,
      });
    });
    await ceServer.listen();
    cleanupFns.push(() => ceServer.close());

    await ceChannel.deliverRaw("ce.q", {
      content: JSON.stringify({
        specversion: "1.0",
        id: "rmq-ce-1",
        source: "urn:warehouse",
        type: "shipment.dispatched",
        traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
        data: { tracking: "TRK42" },
      }),
    });
    expect(ceEvents).toEqual([
      {
        data: { tracking: "TRK42" },
        tp: "00-11111111111111111111111111111111-2222222222222222-01",
      },
    ]);
  });

  it('supports TCP wireFormat: "cloudevents" and "raw-json" plus custom serializer/deserializer', async () => {
    const ceEvents: Array<{ data: unknown; traceparent?: unknown }> = [];
    const server = new TcpServer({
      host: "127.0.0.1",
      port: 0,
      wireFormat: "cloudevents",
    });
    server.addEventHandler("audit.recorded", (data, ctx) => {
      const tCtx = ctx as TcpContext;
      ceEvents.push({ data, traceparent: tCtx.metadata?.traceparent });
    });
    server.addMessageHandler("calc.add", (data) => {
      const { a, b } = data as { a: number; b: number };
      return { sum: a + b };
    });
    await server.listen();
    cleanupFns.push(() => server.close());

    const traceparent =
      "00-99999999999999999999999999999999-8888888888888888-01";
    const client = new TcpClientProxy({
      host: "127.0.0.1",
      port: server.port!,
      wireFormat: "cloudevents",
      serializer: new CloudEventsSerializer({
        source: "urn:tcp-client",
        getTraceparent: () => traceparent,
      }),
    });
    await client.connect();
    cleanupFns.push(() => client.close());

    expect(await client.send("calc.add", { a: 7, b: 8 })).toEqual({ sum: 15 });
    await client.emit("audit.recorded", { action: "add" });
    await Bun.sleep(20);
    expect(ceEvents).toEqual([{ data: { action: "add" }, traceparent }]);

    // Raw TCP socket sending raw NestJS/cross-language JSON frame in raw-json mode
    const rawServer = new TcpServer({
      host: "127.0.0.1",
      port: 0,
      wireFormat: "raw-json",
    });
    rawServer.addMessageHandler("ping", (d) => ({ pong: d }));
    await rawServer.listen();
    cleanupFns.push(() => rawServer.close());

    const rawReply = await new Promise<unknown>((resolve, reject) => {
      let buf = Buffer.alloc(0);
      void Bun.connect({
        hostname: "127.0.0.1",
        port: rawServer.port!,
        socket: {
          open(sock) {
            sock.write(encodeFrame({ id: "ext-1", pattern: "ping", data: "hi" }));
          },
          data(sock, chunk) {
            buf = Buffer.concat([buf, chunk]);
            if (buf.length >= 4) {
              const len = buf.readUInt32BE(0);
              if (buf.length >= 4 + len) {
                const payload = JSON.parse(
                  buf.subarray(4, 4 + len).toString("utf8"),
                );
                sock.end();
                resolve(payload);
              }
            }
          },
          error(_sock, err) {
            reject(err);
          },
        },
      });
    });
    expect(rawReply).toEqual({
      id: "ext-1",
      response: { pong: "hi" },
      isDisposed: true,
    });
  });

  it('supports MQTT wireFormat: "raw-json", "cloudevents", and custom serializer/deserializer', async () => {
    const clients = new Set<{
      subs: Map<string, MqttQoS>;
      listeners: Set<MqttMessageListener>;
    }>();
    const serverMqtt = createMockMqttClient(clients);
    const extMqtt = createMockMqttClient(clients);
    const ceEvents: Array<{ data: unknown; traceparent?: unknown }> = [];

    // 1. MQTT CloudEvents mode (with custom CloudEventsDeserializer envelope mode)
    const server = new MqttServer({
      client: serverMqtt,
      wireFormat: "cloudevents",
      deserializer: new CloudEventsDeserializer({ payloadMode: "envelope" }),
    });
    server.addEventHandler("sensors/+/temp", (payload, ctx) => {
      const mCtx = ctx as MqttContext;
      const typed = payload as { data: unknown; cloudEvent: CloudEvent };
      ceEvents.push({
        data: typed.data,
        traceparent: mCtx.metadata.traceparent,
      });
    });
    server.addMessageHandler("devices/+/ping", (payload) => {
      const typed = payload as { data: unknown; cloudEvent: CloudEvent };
      return { ok: true, id: typed.cloudEvent.id, input: typed.data };
    });
    await server.listen();
    cleanupFns.push(() => server.close());

    const client = new MqttClientProxy({
      client: createMockMqttClient(clients),
      wireFormat: "cloudevents",
    });
    cleanupFns.push(() => client.close());

    // External CloudEvent published to wildcard MQTT topic (falls back to topic match when ce.type differs)
    extMqtt.publish(
      "sensors/lab1/temp",
      JSON.stringify({
        specversion: "1.0",
        id: "mqtt-ce-1",
        source: "urn:esp32",
        type: "com.acme.temp.reading",
        traceparent: "00-abcdef0123456789abcdef0123456789-0123456789abcdef-01",
        data: { celsius: 22.4 },
      }),
    );
    await Bun.sleep(20);
    expect(ceEvents).toEqual([
      {
        data: { celsius: 22.4 },
        traceparent: "00-abcdef0123456789abcdef0123456789-0123456789abcdef-01",
      },
    ]);

    const pingRes = await client.send<{ ok: boolean; input: unknown }>(
      "devices/d1/ping",
      { seq: 1 },
    );
    expect(pingRes.ok).toBe(true);
    expect(pingRes.input).toEqual({ seq: 1 });

    // 2. MQTT custom serializer & deserializer honored
    const customEvents: unknown[] = [];
    const customSerializer: Serializer = {
      serialize(val) {
        return JSON.stringify({ wrappedByCustom: true, payload: val });
      },
    };
    const customDeserializer: Deserializer = {
      deserialize(raw, opts) {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        return {
          pattern: opts?.channel,
          data: parsed.wrappedByCustom ? parsed.payload.data : parsed,
        };
      },
    };

    const customClients = new Set<{
      subs: Map<string, MqttQoS>;
      listeners: Set<MqttMessageListener>;
    }>();
    const customServer = new MqttServer({
      client: createMockMqttClient(customClients),
      deserializer: customDeserializer,
    });
    customServer.addEventHandler("custom/topic", (d) => {
      customEvents.push(d);
    });
    await customServer.listen();
    cleanupFns.push(() => customServer.close());

    const customClient = new MqttClientProxy({
      client: createMockMqttClient(customClients),
      serializer: customSerializer,
    });
    cleanupFns.push(() => customClient.close());
    await customClient.emit("custom/topic", { hello: "custom" });
    await Bun.sleep(20);
    expect(customEvents).toEqual([{ hello: "custom" }]);
  });
});
