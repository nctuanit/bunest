import "reflect-metadata";
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "bun:test";
import {
  Controller,
  Inject,
  Injectable,
  IntrinsicException,
  REQUEST,
  type ArgumentsHost,
} from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  BaseRpcContext,
  BaseRpcExceptionFilter,
  CLIENT_CONFIGURATION_METADATA,
  CLIENT_METADATA,
  CONTEXT,
  Client,
  ClientGrpcProxy,
  ClientKafka,
  ClientMqtt,
  ClientNats,
  ClientProxy,
  ClientProxyFactory,
  ClientRMQ,
  ClientRedis,
  ClientTCP,
  ClientsModule,
  GrpcAbortedException,
  GrpcAlreadyExistsException,
  GrpcCancelledException,
  GrpcClientProxy,
  GrpcContext,
  GrpcDataLossException,
  GrpcDeadlineExceededException,
  GrpcException,
  GrpcExceptionFilter,
  GrpcFailedPreconditionException,
  GrpcInternalException,
  GrpcInvalidArgumentException,
  GrpcMetadata,
  GrpcMethod,
  GrpcMethodStreamingType,
  GrpcNotFoundException,
  GrpcOutOfRangeException,
  GrpcPermissionDeniedException,
  GrpcResourceExhaustedException,
  GrpcServer,
  GrpcService,
  GrpcStatus,
  GrpcUnauthenticatedException,
  GrpcUnavailableException,
  GrpcUnimplementedException,
  GrpcUnknownException,
  IdentityDeserializer,
  IdentitySerializer,
  InMemoryBroker,
  InMemoryClientProxy,
  InMemoryServer,
  IncomingRequestDeserializer,
  IncomingResponseDeserializer,
  JsonSocket,
  KAFKA_CORRELATION_ID_HEADER,
  KAFKA_REPLY_PARTITION_HEADER,
  KAFKA_REPLY_TOPIC_HEADER,
  KafkaClientProxy,
  KafkaContext,
  KafkaHeaders,
  KafkaLogger,
  KafkaParser,
  KafkaReplyPartitionAssigner,
  KafkaRequestDeserializer,
  KafkaRequestSerializer,
  KafkaResponseDeserializer,
  KafkaRetriableException,
  KafkaServer,
  KafkaStatus,
  MessagePattern,
  MicroserviceHost,
  MicroserviceModule,
  MicroserviceTransportServer,
  MqttClientProxy,
  MqttContext,
  MqttServer,
  MqttStatus,
  NatsClientProxy,
  NatsContext,
  NatsRequestJSONDeserializer,
  NatsResponseJSONDeserializer,
  NatsStatus,
  NatsTransportServer,
  NestMicroservice,
  RabbitMqClientProxy,
  RabbitMqTransportServer,
  RedisClientProxy,
  RedisContext,
  RedisStatus,
  RedisTransportServer,
  RmqContext,
  RmqStatus,
  RpcException,
  Server,
  ServerGrpc,
  ServerKafka,
  ServerMqtt,
  ServerNats,
  ServerRMQ,
  ServerRedis,
  ServerTCP,
  TcpClientProxy,
  TcpContext,
  TcpServer,
  TcpStatus,
  Transport,
  createGrpcMethodMetadata,
  createTransportServer,
  getGrpcPackageDefinition,
  type ClientsModuleOptionsFactory,
  type KafkaClientLike,
  type KafkaConsumerLike,
  type KafkaEachMessagePayload,
  type KafkaProducerLike,
  type KafkaProducerRecord,
  type RabbitMqChannelLike,
  type ReadPacket,
  type WritePacket,
} from "../src/index";

const dummyHost = {} as ArgumentsHost;

describe("NestJS v12 API Parity — Enums, Tokens & Aliases", () => {
  it("exports KafkaHeaders as a 34-key runtime enum with exact Spring/NestJS header strings", () => {
    const keys = Object.keys(KafkaHeaders);
    expect(keys.length).toBe(34);
    expect<string>(KafkaHeaders.CORRELATION_ID).toBe("kafka_correlationId");
    expect<string>(KafkaHeaders.REPLY_TOPIC).toBe("kafka_replyTopic");
    expect<string>(KafkaHeaders.REPLY_PARTITION).toBe("kafka_replyPartition");
    expect<string>(KafkaHeaders.NEST_ERR).toBe("kafka_nest-err");
    expect<string>(KafkaHeaders.NEST_IS_DISPOSED).toBe("kafka_nest-is-disposed");
    expect<string>(KafkaHeaders.NEST_NO_RESPONSE).toBe("kafka_nest-no-response");
    expect<string>(KafkaHeaders.DLT_ORIGINAL_TOPIC).toBe("kafka_dlt-original-topic");
    expect<string>(KafkaHeaders.BATCH_CONVERTED_HEADERS).toBe(
      "kafka_batchConvertedHeaders",
    );
    expect<string>(KAFKA_CORRELATION_ID_HEADER).toBe(KafkaHeaders.CORRELATION_ID);
    expect<string>(KAFKA_REPLY_TOPIC_HEADER).toBe(KafkaHeaders.REPLY_TOPIC);
    expect<string>(KAFKA_REPLY_PARTITION_HEADER).toBe(KafkaHeaders.REPLY_PARTITION);
  });

  it("exports Transport.RMQ alias, CONTEXT token, GrpcMethodStreamingType, and all 6 transport *Status enums", () => {
    expect<string>(Transport.RMQ).toBe(Transport.RABBITMQ);
    expect(CONTEXT).toBe(REQUEST);

    expect<string>(GrpcMethodStreamingType.NO_STREAMING).toBe("no_stream");
    expect<string>(GrpcMethodStreamingType.RX_STREAMING).toBe("rx_stream");
    expect<string>(GrpcMethodStreamingType.PT_STREAMING).toBe("pt_stream");

    expect<string>(TcpStatus.CONNECTED).toBe("connected");
    expect<string>(TcpStatus.DISCONNECTED).toBe("disconnected");

    expect<string>(RedisStatus.CONNECTED).toBe("connected");
    expect<string>(RedisStatus.RECONNECTING).toBe("reconnecting");
    expect<string>(RedisStatus.DISCONNECTED).toBe("disconnected");

    expect<string>(NatsStatus.CONNECTED).toBe("connected");
    expect<string>(NatsStatus.RECONNECTING).toBe("reconnecting");
    expect<string>(NatsStatus.DISCONNECTED).toBe("disconnected");

    expect<string>(RmqStatus.CONNECTED).toBe("connected");
    expect<string>(RmqStatus.DISCONNECTED).toBe("disconnected");
    expect<string>(RmqStatus.BLOCKED).toBe("blocked");
    expect<string>(RmqStatus.UNBLOCKED).toBe("unblocked");

    expect<string>(MqttStatus.CONNECTED).toBe("connected");
    expect<string>(MqttStatus.RECONNECTING).toBe("reconnecting");
    expect<string>(MqttStatus.DISCONNECTED).toBe("disconnected");
    expect<string>(MqttStatus.CLOSED).toBe("closed");

    expect<string>(KafkaStatus.CONNECTED).toBe("connected");
    expect<string>(KafkaStatus.DISCONNECTED).toBe("disconnected");
    expect<string>(KafkaStatus.CRASHED).toBe("crashed");
    expect<string>(KafkaStatus.STOPPED).toBe("stopped");
    expect<string>(KafkaStatus.REBALANCING).toBe("rebalancing");
  });

  it("exports all NestJS Server*, Client*, Server, and NestMicroservice class aliases", () => {
    expect(Server).toBe(MicroserviceTransportServer);
    expect(NestMicroservice).toBe(MicroserviceHost);
    expect(ServerTCP).toBe(TcpServer);
    expect(ClientTCP).toBe(TcpClientProxy);
    expect(ServerRedis).toBe(RedisTransportServer);
    expect(ClientRedis).toBe(RedisClientProxy);
    expect(ServerNats).toBe(NatsTransportServer);
    expect(ClientNats).toBe(NatsClientProxy);
    expect(ServerRMQ).toBe(RabbitMqTransportServer);
    expect(ClientRMQ).toBe(RabbitMqClientProxy);
    expect(ServerMqtt).toBe(MqttServer);
    expect(ClientMqtt).toBe(MqttClientProxy);
    expect(ServerKafka).toBe(KafkaServer);
    expect(ClientKafka).toBe(KafkaClientProxy);
    expect(ServerGrpc).toBe(GrpcServer);
    expect(ClientGrpcProxy).toBe(GrpcClientProxy);
  });
});

describe("ClientProxyFactory, @Client(), ClientsModule v12 options & Transport.RMQ", () => {
  it("ClientProxyFactory.create instantiates every built-in transport (including Transport.RMQ) and customClass", () => {
    const tcp = ClientProxyFactory.create({
      transport: Transport.TCP,
      options: { port: 4000 },
    });
    expect(tcp).toBeInstanceOf(ClientTCP);

    const grpc = ClientProxyFactory.create({
      transport: Transport.GRPC,
      options: { url: "127.0.0.1:5000", package: "demo" },
    });
    expect(grpc).toBeInstanceOf(ClientGrpcProxy);

    const kafka = ClientProxyFactory.create({
      transport: Transport.KAFKA,
      options: {},
    });
    expect(kafka).toBeInstanceOf(ClientKafka);

    const inMem = ClientProxyFactory.create({
      transport: Transport.IN_MEMORY,
      options: { channel: "factory-ch" },
    });
    expect(inMem).toBeInstanceOf(InMemoryClientProxy);

    const mockChannel = {
      assertQueue: () => ({ queue: "q" }),
      consume: () => ({ consumerTag: "t1" }),
      sendToQueue: () => true,
    } satisfies RabbitMqChannelLike;

    const rmqClient = ClientProxyFactory.create({
      transport: Transport.RMQ,
      options: { channel: mockChannel, queue: "rmq.jobs" },
    });
    expect(rmqClient).toBeInstanceOf(ClientRMQ);

    const rmqServer = createTransportServer({
      transport: Transport.RMQ,
      options: { channel: mockChannel, queue: "rmq.jobs" },
    });
    expect(rmqServer).toBeInstanceOf(ServerRMQ);

    class CustomProxy extends ClientProxy {
      readonly transport = Transport.IN_MEMORY;
      constructor(public readonly cfg: Record<string, unknown>) {
        super();
      }
      async connect(): Promise<void> {}
      async close(): Promise<void> {}
      protected override async sendOnce<TRes>(pattern: string, data: unknown): Promise<TRes> {
        return { custom: true, pattern, data, cfg: this.cfg } as TRes;
      }
      protected override async dispatchEvent(): Promise<void> {}
    }

    const custom = ClientProxyFactory.create({
      customClass: CustomProxy,
      options: { region: "eu-west-1" },
    });
    expect(custom).toBeInstanceOf(CustomProxy);
    expect((custom as CustomProxy).cfg).toEqual({ region: "eu-west-1" });
  });

  it("supports ClientsModule.register({ clients, isGlobal }) and registerAsync({ clients, isGlobal }) with extraProviders", async () => {
    const broker = new InMemoryBroker();
    const server = new InMemoryServer({ channel: "v12-mod", broker });
    server.addMessageHandler("ping", (d) => ({ pong: d }));
    await server.listen();

    const CONFIG_TOKEN = Symbol("CONFIG_TOKEN");

    @Injectable()
    class MyOptionsFactory implements ClientsModuleOptionsFactory {
      constructor(@Inject(CONFIG_TOKEN) private readonly channel: string) {}
      createClientOptions() {
        return {
          transport: Transport.IN_MEMORY as const,
          options: { channel: this.channel, broker },
        };
      }
    }

    const syncDyn = ClientsModule.register({
      isGlobal: true,
      clients: [
        {
          name: "SYNC_CLIENT",
          transport: Transport.IN_MEMORY,
          options: { channel: "v12-mod", broker },
        },
      ],
    });
    expect(syncDyn.global).toBe(true);

    const asyncDyn = ClientsModule.registerAsync({
      isGlobal: true,
      clients: [
        {
          name: "ASYNC_CLIENT",
          useClass: MyOptionsFactory,
          extraProviders: [{ provide: CONFIG_TOKEN, useValue: "v12-mod" }],
        },
      ],
    });
    expect(asyncDyn.global).toBe(true);

    const mod = await Test.createTestingModule({
      imports: [syncDyn, asyncDyn],
    }).compile();
    await mod.init();

    const syncClient = mod.get<ClientProxy>("SYNC_CLIENT");
    const asyncClient = mod.get<ClientProxy>("ASYNC_CLIENT");
    expect(await syncClient.send("ping", "sync")).toEqual({ pong: "sync" });
    expect(await asyncClient.send("ping", "async")).toEqual({ pong: "async" });

    await mod.close();
    await server.close();
  });

  it("@Client(options) property decorator records metadata and auto-binds a live ClientProxy via MicroserviceModule", async () => {
    const broker = new InMemoryBroker();

    @Controller()
    class PingController {
      @Client({
        transport: Transport.IN_MEMORY,
        options: { channel: "client-deco", broker },
      })
      client!: ClientProxy;

      @MessagePattern("echo")
      echo(data: unknown) {
        return { echoed: data };
      }
    }

    expect(
      Reflect.getMetadata(CLIENT_METADATA, PingController.prototype, "client"),
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        CLIENT_CONFIGURATION_METADATA,
        PingController.prototype,
        "client",
      ),
    ).toEqual({
      transport: Transport.IN_MEMORY,
      options: { channel: "client-deco", broker },
    });

    const mod = await Test.createTestingModule({
      imports: [
        MicroserviceModule.forRoot({
          transport: Transport.IN_MEMORY,
          options: { channel: "client-deco", broker },
        }),
      ],
      controllers: [PingController],
    }).compile();
    await mod.init();

    const ctrl = mod.get(PingController);
    expect(ctrl.client).toBeInstanceOf(InMemoryClientProxy);
    expect(await ctrl.client.send("echo", { ok: 1 })).toEqual({
      echoed: { ok: 1 },
    });

    await mod.close();
  });
});

describe("All 16 Grpc*Exception subclasses, GrpcException, BaseRpcExceptionFilter & GrpcExceptionFilter", () => {
  it("constructs all 16 typed Grpc*Exception subclasses with canonical codes and default/custom messages", () => {
    const cases: Array<[new (msg?: string) => GrpcException, GrpcStatus, string]> = [
      [GrpcCancelledException, GrpcStatus.CANCELLED, "Cancelled"],
      [GrpcUnknownException, GrpcStatus.UNKNOWN, "Unknown"],
      [GrpcInvalidArgumentException, GrpcStatus.INVALID_ARGUMENT, "Invalid argument"],
      [GrpcDeadlineExceededException, GrpcStatus.DEADLINE_EXCEEDED, "Deadline exceeded"],
      [GrpcNotFoundException, GrpcStatus.NOT_FOUND, "Not found"],
      [GrpcAlreadyExistsException, GrpcStatus.ALREADY_EXISTS, "Already exists"],
      [GrpcPermissionDeniedException, GrpcStatus.PERMISSION_DENIED, "Permission denied"],
      [GrpcResourceExhaustedException, GrpcStatus.RESOURCE_EXHAUSTED, "Resource exhausted"],
      [GrpcFailedPreconditionException, GrpcStatus.FAILED_PRECONDITION, "Failed precondition"],
      [GrpcAbortedException, GrpcStatus.ABORTED, "Aborted"],
      [GrpcOutOfRangeException, GrpcStatus.OUT_OF_RANGE, "Out of range"],
      [GrpcUnimplementedException, GrpcStatus.UNIMPLEMENTED, "Unimplemented"],
      [GrpcInternalException, GrpcStatus.INTERNAL, "Internal"],
      [GrpcUnavailableException, GrpcStatus.UNAVAILABLE, "Unavailable"],
      [GrpcDataLossException, GrpcStatus.DATA_LOSS, "Data loss"],
      [GrpcUnauthenticatedException, GrpcStatus.UNAUTHENTICATED, "Unauthenticated"],
    ];

    expect(cases).toHaveLength(16);
    for (const [Ctor, expectedCode, defaultMsg] of cases) {
      const def = new Ctor();
      expect(def).toBeInstanceOf(GrpcException);
      expect(def).toBeInstanceOf(RpcException);
      expect(def.getCode()).toBe(expectedCode);
      expect(def.code).toBe(expectedCode);
      expect(def.message).toBe(defaultMsg);
      expect(def.getError()).toMatchObject({
        code: expectedCode,
        message: defaultMsg,
      });

      const custom = new Ctor("custom detail");
      expect(custom.getCode()).toBe(expectedCode);
      expect(custom.message).toBe("custom detail");
    }

    // Dual GrpcException constructor signatures: NestJS (message, code?) AND Bunest (code, message, metadata?)
    const nestStyle = new GrpcException("missing item", GrpcStatus.NOT_FOUND);
    expect(nestStyle.getCode()).toBe(GrpcStatus.NOT_FOUND);
    expect(nestStyle.message).toBe("missing item");

    const defaultCode = new GrpcException("plain msg");
    expect(defaultCode.getCode()).toBe(GrpcStatus.UNKNOWN);

    const md = new GrpcMetadata({ "x-id": "1" });
    const bunestStyle = new GrpcException(GrpcStatus.PERMISSION_DENIED, "nope", md);
    expect(bunestStyle.getCode()).toBe(GrpcStatus.PERMISSION_DENIED);
    expect(bunestStyle.message).toBe("nope");
    expect(bunestStyle.metadata).toBe(md);
  });

  it("BaseRpcExceptionFilter handles RpcException, KafkaRetriableException, and unknown errors (Promise-based)", async () => {
    const filter = new BaseRpcExceptionFilter();

    await expect(
      filter.catch(new RpcException("bad input"), dummyHost),
    ).rejects.toEqual({ status: "error", message: "bad input" });

    await expect(
      filter.catch(new RpcException({ code: 400, reason: "invalid" }), dummyHost),
    ).rejects.toEqual({ code: 400, reason: "invalid" });

    // Wrapped Error inside RpcException should not leak internal Error fields
    await expect(
      filter.catch(new RpcException(new IntrinsicException("secret")), dummyHost),
    ).rejects.toEqual({ status: "error", message: "Internal server error" });

    // KafkaRetriableException returns itself from getError() so it keeps travelling
    const retriable = new KafkaRetriableException("retry-later");
    expect(retriable.getError()).toBe(retriable);
    expect(retriable.isRetryable).toBe(true);
    await expect(filter.catch(retriable, dummyHost)).rejects.toBe(retriable);

    // Unknown error
    await expect(
      filter.catch(new IntrinsicException("boom"), dummyHost),
    ).rejects.toEqual({ status: "error", message: "Internal server error" });

    expect(filter.isError(new Error("e"))).toBe(true);
    expect(filter.isError({ message: "ok" })).toBe(true);
    expect(filter.isError({})).toBe(false);
    expect(filter.isError("str")).toBe(false);

    // RpcException.initMessage()
    const rpcErr = new RpcException("initial");
    rpcErr.message = "mutated";
    rpcErr.initMessage();
    expect(rpcErr.message).toBe("initial");
  });

  it("GrpcExceptionFilter maps GrpcException, RpcException, and unknown errors to GrpcExceptionBody", async () => {
    const filter = new GrpcExceptionFilter();

    await expect(
      filter.catch(new GrpcNotFoundException("user missing"), dummyHost),
    ).rejects.toEqual({
      code: GrpcStatus.NOT_FOUND,
      message: "user missing",
    });

    await expect(
      filter.catch(
        new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: "bad arg" }),
        dummyHost,
      ),
    ).rejects.toEqual({
      code: GrpcStatus.INVALID_ARGUMENT,
      message: "bad arg",
    });

    await expect(
      filter.catch(new RpcException("plain rpc error"), dummyHost),
    ).rejects.toEqual({
      code: GrpcStatus.UNKNOWN,
      message: "plain rpc error",
    });

    await expect(
      filter.catch(new IntrinsicException("oops"), dummyHost),
    ).rejects.toEqual({
      code: GrpcStatus.UNKNOWN,
      message: "Internal server error",
    });
  });
});

describe("RPC Context Hosts (BaseRpcContext, Tcp/Redis/Nats/Rmq/Mqtt/Kafka/Grpc)", () => {
  it("supports NestJS methods and BaseRpcContext inheritance across all context hosts", () => {
    const base = new BaseRpcContext(["a", 42]);
    expect(base.getArgs()).toEqual(["a", 42]);
    expect(base.getArgByIndex(0)).toBe("a");
    expect(base.getArgByIndex(1)).toBe(42);

    const fakeSocket = { remoteAddress: "127.0.0.1" };
    const tcpCtx = new TcpContext([fakeSocket, "sum", { traceId: "t1" }]);
    expect(tcpCtx).toBeInstanceOf(BaseRpcContext);
    expect(tcpCtx.getSocketRef()).toBe(fakeSocket);
    expect(tcpCtx.getPattern()).toBe("sum");
    expect(tcpCtx.getMetadata()).toEqual({ traceId: "t1" });

    const redisCtx = new RedisContext(["orders.created", { tenant: "acme" }]);
    expect(redisCtx).toBeInstanceOf(BaseRpcContext);
    expect(redisCtx.getChannel()).toBe("orders.created");
    expect(redisCtx.getMetadata()).toEqual({ tenant: "acme" });

    // NATS headers with keys()/values() API (single string vs multi-value filtering)
    const natsHeaders = {
      keys: () => ["x-trace", "x-multi"],
      values: (k: string) => (k === "x-trace" ? ["abc"] : ["v1", "v2"]),
    };
    const natsCtx = new NatsContext(["jobs.run", natsHeaders]);
    expect(natsCtx).toBeInstanceOf(BaseRpcContext);
    expect(natsCtx.getSubject()).toBe("jobs.run");
    expect(natsCtx.getHeaders()).toBe(natsHeaders);
    expect(natsCtx.getMetadata()).toEqual({ "x-trace": "abc" });

    const fakeChannel = { ack: () => {} };
    const rmqMsg = {
      content: Buffer.from("{}"),
      properties: { headers: { "x-locale": "en-US", count: 5 } },
    };
    const rmqCtx = new RmqContext([rmqMsg, fakeChannel, "billing.charge"]);
    expect(rmqCtx).toBeInstanceOf(BaseRpcContext);
    expect(rmqCtx.getMessage()).toBe(rmqMsg);
    expect(rmqCtx.getChannelRef()).toBe(fakeChannel);
    expect(rmqCtx.getPattern()).toBe("billing.charge");
    expect(rmqCtx.getMetadata()).toEqual({ "x-locale": "en-US" });

    // MqttContext tuple constructor + MQTT 5 userProperties
    const mqttCtx = new MqttContext([
      "sensors/1",
      {
        topic: "sensors/1",
        payload: "{}",
        qos: 1,
        retain: true,
        properties: { userProperties: { "x-region": "ap-se", arr: ["a", "b"] } },
      },
    ]);
    expect(mqttCtx).toBeInstanceOf(BaseRpcContext);
    expect(mqttCtx.getTopic()).toBe("sensors/1");
    expect(mqttCtx.getQoS()).toBe(1);
    expect(mqttCtx.isRetained()).toBe(true);
    expect(mqttCtx.getMetadata()).toEqual({ "x-region": "ap-se" });

    // KafkaContext tuple constructor
    const hb = async () => {};
    const mockConsumer = {} as KafkaConsumerLike;
    const mockProducer = {} as KafkaProducerLike;
    const kafkaCtx = new KafkaContext([
      { value: "hello", headers: { "x-req": "r1" }, offset: "9" },
      3,
      "orders.topic",
      mockConsumer,
      hb,
      mockProducer,
      { "x-req": "r1" },
    ]);
    expect(kafkaCtx).toBeInstanceOf(BaseRpcContext);
    expect(kafkaCtx.getTopic()).toBe("orders.topic");
    expect(kafkaCtx.getPartition()).toBe(3);
    expect(kafkaCtx.getConsumer()).toBe(mockConsumer);
    expect(kafkaCtx.getProducer()).toBe(mockProducer);
    expect(kafkaCtx.getHeartbeat()).toBe(hb);
    expect(kafkaCtx.getMetadata()).toEqual({ "x-req": "r1" });
    expect(kafkaCtx.getArgByIndex(2)).toBe("orders.topic");

    // GrpcContext extends BaseRpcContext
    const gCtx = new GrpcContext({
      service: "Users",
      method: "Get",
      path: "/Users/Get",
      grpcMetadata: new GrpcMetadata({ "x-user": "u1" }),
      signal: new AbortController().signal,
    });
    expect(gCtx).toBeInstanceOf(BaseRpcContext);
    expect(gCtx.getArgByIndex(1)).toBe("/Users/Get");
  });
});

describe("NestJS v12 Lifecycle & Observability Hooks + Server/Client Helpers", () => {
  it("runs ClientProxy.setOnDispatchHook, Server.setOnProcessingStartHook (ALS), and setOnProcessingEndHook end-to-end over live TCP", async () => {
    const als = new AsyncLocalStorage<{ spanId: string }>();
    const events: string[] = [];
    const customTransportId = Symbol("CUSTOM_TCP_TRANSPORT");

    const server = new ServerTCP({ host: "127.0.0.1", port: 0 });
    server.setTransportId(customTransportId);

    server.setOnProcessingStartHook((tid, ctx, done) => {
      events.push(`start:${String(tid === customTransportId)}:${ctx instanceof TcpContext}`);
      return als.run({ spanId: "span-42" }, done);
    });
    server.setOnProcessingEndHook((tid, ctx) => {
      events.push(`end:${String(tid === customTransportId)}:${(ctx as TcpContext).getPattern()}`);
    });

    server.addHandler("trace.echo", (data) => {
      return { data, spanId: als.getStore()?.spanId };
    });
    expect(server.getHandlerByPattern("trace.echo")).not.toBeNull();
    expect(server.getHandlers().has("trace.echo")).toBe(true);
    expect(server.getOptionsProp({ host: "localhost" }, "host")).toBe("localhost");
    expect(server.getOptionsProp(undefined as { port?: number } | undefined, "port", 3000)).toBe(3000);

    // Server.send & transformToObservable
    const written: WritePacket[] = [];
    await server.send(Promise.resolve("ok-val"), (pkt) => {
      written.push(pkt);
    });
    expect(written).toEqual([{ response: "ok-val", isDisposed: true }]);
    expect(await server.transformToObservable(Promise.resolve(123))).toBe(123);

    let listenCbCalled = false;
    await server.listen(() => {
      listenCbCalled = true;
    });
    expect(listenCbCalled).toBe(true);
    expect(server.status).toBe(TcpStatus.CONNECTED);

    const client = new ClientTCP({ host: "127.0.0.1", port: server.port! });
    const dispatched: ReadPacket[] = [];
    let clientConnectedEvent = false;
    client.on("connect", () => {
      clientConnectedEvent = true;
    });
    client.setOnDispatchHook((packet) => {
      packet.metadata = { "x-trace": "tr-1" };
      dispatched.push(packet);
    });

    const result = await client.send("trace.echo", { hello: "world" });
    expect(result).toEqual({ data: { hello: "world" }, spanId: "span-42" });
    expect(clientConnectedEvent).toBe(true);
    expect(dispatched).toEqual([
      {
        pattern: "trace.echo",
        data: { hello: "world" },
        metadata: { "x-trace": "tr-1" },
      },
    ]);
    expect(events).toEqual(["start:true:true", "end:true:trace.echo"]);

    await client.close();
    await server.close();
    expect(server.status).toBe(TcpStatus.DISCONNECTED);
  });

  it("handles rejecting async onProcessingStartHook without unhandled rejections, invokes MqttServer event hooks, and clears pending maps immediately on timeout", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      // 1. Async onProcessingStartHook awaiting a rejecting done() produces zero unhandled rejections
      const broker = new InMemoryBroker();
      const inMemServer = new InMemoryServer({ channel: "hook-err", broker });
      let endCalls = 0;
      inMemServer.setOnProcessingStartHook(async (_tid, _ctx, done) => {
        await done();
      });
      inMemServer.setOnProcessingEndHook(() => {
        endCalls++;
      });
      inMemServer.addMessageHandler("boom", async () => {
        await Bun.sleep(2);
        throw new RpcException("expected-failure");
      });
      await inMemServer.listen();

      const inMemClient = new InMemoryClientProxy({ channel: "hook-err", broker });
      await expect(inMemClient.send("boom", {})).rejects.toThrow("expected-failure");
      await Bun.sleep(10);
      expect(endCalls).toBe(1);
      expect(unhandled).toHaveLength(0);
      await inMemClient.close();
      await inMemServer.close();

      // 2. MqttServer event handlers invoke processing start/end hooks
      let mqttListener:
        | ((topic: string, payload: Uint8Array | Buffer | string) => void)
        | undefined;
      const mqttEvents: string[] = [];
      const mqttServer = new ServerMqtt({
        client: {
          publish() {},
          subscribe() {},
          on(_event, listener) {
            mqttListener = listener;
          },
          off() {
            mqttListener = undefined;
          },
        },
      });
      mqttServer.setOnProcessingStartHook(async (_tid, ctx, done) => {
        mqttEvents.push(`start:${(ctx as MqttContext).getTopic()}`);
        await done();
      });
      mqttServer.setOnProcessingEndHook((_tid, ctx) => {
        mqttEvents.push(`end:${(ctx as MqttContext).getTopic()}`);
      });
      mqttServer.addEventHandler("alerts/+", (data) => {
        mqttEvents.push(`handled:${JSON.stringify(data)}`);
      });
      await mqttServer.listen();
      mqttListener!("alerts/cpu", JSON.stringify({ pct: 95 }));
      await Bun.sleep(15);
      expect(mqttEvents).toEqual([
        "start:alerts/cpu",
        'handled:{"pct":95}',
        "end:alerts/cpu",
      ]);
      await mqttServer.close();

      // 3. Timed-out TcpClientProxy request immediately clears pending map (0 leaked entries)
      const tcpServer = new ServerTCP({ host: "127.0.0.1", port: 0 });
      tcpServer.addMessageHandler("slow-op", async () => {
        await Bun.sleep(80);
        return "late";
      });
      await tcpServer.listen();
      const tcpClient = new ClientTCP({ host: "127.0.0.1", port: tcpServer.port! });
      await expect(
        tcpClient.send("slow-op", {}, { timeoutMs: 15 }),
      ).rejects.toThrow(/timed out/);
      expect(
        (tcpClient as unknown as { pending: Map<string, unknown> }).pending.size,
      ).toBe(0);
      await tcpClient.close();
      await tcpServer.close();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("supports @GrpcService, zero-arg @GrpcMethod, createGrpcMethodMetadata, getGrpcPackageDefinition, and ClientGrpc.getClientByServiceName", () => {
    @GrpcService()
    class HeroService {
      @GrpcMethod()
      findOne() {
        return {};
      }
    }

    const meta0 = createGrpcMethodMetadata(
      HeroService.prototype,
      "findOne",
      undefined,
      undefined,
    );
    expect(meta0).toEqual({
      service: "HeroService",
      rpc: "FindOne",
      streaming: GrpcMethodStreamingType.NO_STREAMING,
    });

    const meta1 = createGrpcMethodMetadata(
      HeroService.prototype,
      "streamAll",
      "CustomSvc",
      undefined,
      GrpcMethodStreamingType.RX_STREAMING,
    );
    expect(meta1).toEqual({
      service: "CustomSvc",
      rpc: "StreamAll",
      streaming: GrpcMethodStreamingType.RX_STREAMING,
    });

    const fakeLoader = {
      loadSync: (p: string | string[]) => ({ loaded: p }),
    };
    expect(
      getGrpcPackageDefinition({ protoPath: "hero.proto" }, fakeLoader),
    ).toEqual({ loaded: "hero.proto" });
    expect(
      getGrpcPackageDefinition({ packageDefinition: { pre: 1 } }, fakeLoader),
    ).toEqual({ pre: 1 });
    expect(() =>
      getGrpcPackageDefinition(
        { protoPath: "a.proto", packageDefinition: {} },
        fakeLoader,
      ),
    ).toThrow(/cannot be specified simultaneously/);
    expect(() => getGrpcPackageDefinition({}, fakeLoader)).toThrow(
      /must be specified/,
    );

    const grpcClient = new ClientGrpcProxy({ url: "127.0.0.1:50051" });
    const svcA = grpcClient.getClientByServiceName("HeroService");
    const svcB = grpcClient.getService("HeroService");
    expect(svcA).toBe(svcB);
  });

  it("supports ClientKafka commitOffsets, emitBatch, getConsumerAssignments, and consumer/producer getters", async () => {
    const committed: unknown[] = [];
    const sent: KafkaProducerRecord[] = [];

    const mockProducer: KafkaProducerLike = {
      async connect() {},
      async disconnect() {},
      async send(record) {
        sent.push(record);
      },
    };
    const mockConsumer: KafkaConsumerLike = {
      async connect() {},
      async disconnect() {},
      async subscribe() {},
      async run() {},
      async commitOffsets(tp) {
        committed.push(...tp);
      },
    };
    const mockKafka: KafkaClientLike = {
      producer: () => mockProducer,
      consumer: () => mockConsumer,
    };

    const client = new ClientKafka({
      client: mockKafka,
      producer: mockProducer,
      consumer: mockConsumer,
    });

    expect(client.producer).toBe(mockProducer);
    expect(client.consumer).toBe(mockConsumer);
    expect(client.getConsumerAssignments()).toEqual({});

    await client.commitOffsets([{ topic: "orders", partition: 0, offset: "42" }]);
    expect(committed).toEqual([{ topic: "orders", partition: 0, offset: "42" }]);

    await client.emitBatch("orders.batch", {
      messages: [{ value: { id: 1 }, key: "k1" }, { id: 2 }],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.topic).toBe("orders.batch");
    expect(sent[0]!.messages).toHaveLength(2);
    expect(sent[0]!.messages[0]!.key).toBe("k1");
    expect(sent[0]!.messages[0]!.value).toBe('{"id":1}');
    expect(sent[0]!.messages[1]!.value).toBe('{"id":2}');

    // KafkaRetriableException bubbles out of KafkaServer.handleMessage
    let eachMsg: ((p: KafkaEachMessagePayload) => Promise<void>) | undefined;
    const server = new ServerKafka({
      consumer: {
        async connect() {},
        async disconnect() {},
        async subscribe() {},
        async run(cfg) {
          eachMsg = cfg.eachMessage;
        },
      },
    });
    server.addEventHandler("retry.topic", () => {
      throw new KafkaRetriableException("transient-kafka-err");
    });
    await server.listen();
    await expect(
      eachMsg!({
        topic: "retry.topic",
        partition: 0,
        message: { value: JSON.stringify({ n: 1 }), offset: "0" },
      }),
    ).rejects.toBeInstanceOf(KafkaRetriableException);
    await server.close();
  });
});

describe("Deserializers, Serializers & Protocol Helpers (JsonSocket, KafkaParser, KafkaLogger, KafkaReplyPartitionAssigner)", () => {
  it("implements all 7 built-in deserializers and 2 serializers accurately", () => {
    const idDeser = new IdentityDeserializer();
    expect(idDeser.deserialize({ x: 1 })).toEqual({ x: 1 });

    const idSer = new IdentitySerializer();
    expect(idSer.serialize({ x: 1 })).toEqual({ x: 1 });

    const reqDeser = new IncomingRequestDeserializer();
    expect(reqDeser.deserialize({ pattern: "p", data: 1 })).toEqual({
      pattern: "p",
      data: 1,
    });
    expect(reqDeser.deserialize("raw-msg", { channel: "ch" })).toEqual({
      pattern: "ch",
      data: "raw-msg",
    });

    const resDeser = new IncomingResponseDeserializer();
    expect(resDeser.deserialize({ id: "1", response: "ok", isDisposed: true })).toEqual({
      id: "1",
      response: "ok",
      isDisposed: true,
    });
    expect(resDeser.deserialize({ id: "1", extraForeignKey: true })).toEqual({
      id: "1",
      response: { id: "1", extraForeignKey: true },
      isDisposed: true,
    });

    const kafkaReqDeser = new KafkaRequestDeserializer();
    expect(
      kafkaReqDeser.deserialize({ value: { a: 1 } }, { channel: "t1" }),
    ).toEqual({ pattern: "t1", data: { a: 1 } });

    const kafkaResDeser = new KafkaResponseDeserializer();
    expect(
      kafkaResDeser.deserialize({
        value: { ok: true },
        headers: {
          [KafkaHeaders.CORRELATION_ID]: Buffer.from("cid-1"),
          [KafkaHeaders.NEST_IS_DISPOSED]: "1",
        },
      }),
    ).toEqual({ id: "cid-1", response: { ok: true }, isDisposed: true });
    expect(
      kafkaResDeser.deserialize({
        value: null,
        headers: {
          [KafkaHeaders.CORRELATION_ID]: "cid-2",
          [KafkaHeaders.NEST_IS_DISPOSED]: "1",
          [KafkaHeaders.NEST_NO_RESPONSE]: "1",
        },
      }),
    ).toEqual({ id: "cid-2", isDisposed: true });
    expect(
      kafkaResDeser.deserialize({
        value: null,
        headers: {
          [KafkaHeaders.CORRELATION_ID]: "cid-3",
          [KafkaHeaders.NEST_ERR]: "boom",
        },
      }),
    ).toEqual({ id: "cid-3", err: "boom", isDisposed: true });

    const natsReqDeser = new NatsRequestJSONDeserializer();
    expect<unknown>(
      natsReqDeser.deserialize(
        { json: () => ({ id: "1", response: 42, isDisposed: true }) },
        { channel: "subj" },
      ),
    ).toEqual({ id: "1", response: 42, isDisposed: true });
    expect(
      natsReqDeser.deserialize({ json: () => ({ hello: "nats" }) }, { channel: "subj" }),
    ).toEqual({ pattern: "subj", data: { hello: "nats" } });

    const natsResDeser = new NatsResponseJSONDeserializer();
    expect(
      natsResDeser.deserialize({
        json: () => ({ id: "9", response: "pong", isDisposed: true }),
      }),
    ).toEqual({ id: "9", response: "pong", isDisposed: true });

    const kafkaSer = new KafkaRequestSerializer();
    expect(kafkaSer.serialize({ hello: "world" })).toEqual({
      value: '{"hello":"world"}',
      headers: {},
    });
    expect(
      kafkaSer.serialize({ key: { id: 1 }, value: [1, 2], headers: { a: "b" } }),
    ).toEqual({
      key: '{"id":1}',
      value: "[1,2]",
      headers: { a: "b" },
    });
  });

  it("JsonSocket frames <len>#<json> under fragmentation, pause/resume, and maxBufferSize enforcement", () => {
    const written: string[] = [];
    const fakeRawSocket = {
      write(data: string, _enc: string, cb?: () => void) {
        written.push(data);
        cb?.();
      },
      end() {},
    };

    const sock = new JsonSocket(fakeRawSocket, { maxBufferSize: 64 });
    const received: unknown[] = [];
    const errors: Error[] = [];
    sock.on("message", (m: unknown) => received.push(m));
    sock.on("error", (e: Error) => errors.push(e));

    sock.sendMessage({ ok: true });
    expect(written).toEqual(['11#{"ok":true}']);

    // Fragmented + coalesced frames
    const combined = '11#{"ok":true}12#{"n":123456}';
    for (let i = 0; i < combined.length; i++) {
      sock.feed(combined[i]!);
    }
    expect(received).toEqual([{ ok: true }, { n: 123456 }]);

    // Pause / resume messages
    sock.pauseMessages();
    sock.feed('11#{"ok":true}');
    expect(received).toHaveLength(2);
    sock.resumeMessages();
    expect(received).toHaveLength(3);

    // Exceeds maxBufferSize
    sock.feed(`100#${"x".repeat(100)}`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("maxBufferSize");
    expect(sock.isClosed).toBe(true);
  });

  it("KafkaParser decodes JSON, preserves binary schema-registry buffers, decodes transport headers as strings, and enforces maxMessageSize", () => {
    const parser = new KafkaParser({ maxMessageSize: 1024 });
    const parsed = parser.parse({
      key: Buffer.from("k1"),
      value: Buffer.from('{"a":1}'),
      headers: {
        [KafkaHeaders.CORRELATION_ID]: Buffer.from('{"notParsed":true}'),
        custom: Buffer.from('{"ok":true}'),
        multi: [Buffer.from("one"), Buffer.from('{"two":2}')],
      },
    });
    expect(parsed.key).toBe("k1");
    expect(parsed.value).toEqual({ a: 1 });
    expect(parsed.headers[KafkaHeaders.CORRELATION_ID]).toBe('{"notParsed":true}');
    expect(parsed.headers.custom).toEqual({ ok: true });
    expect(parsed.headers.multi).toEqual(["one", { two: 2 }]);

    // Leading-zero schema-registry binary payload stays untouched Buffer
    const binBuf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    expect(parser.decode(binBuf)).toBe(binBuf);

    // Oversized message throws
    const smallParser = new KafkaParser({ maxMessageSize: 10 });
    expect(() =>
      smallParser.parse({ value: Buffer.from("x".repeat(20)) }),
    ).toThrow(/exceeds maximum/);
  });

  it("KafkaLogger routes log levels and survives circular/BigInt payloads", () => {
    const entries: Array<[string, string]> = [];
    const logger = {
      error: (m: string) => entries.push(["error", m]),
      warn: (m: string) => entries.push(["warn", m]),
      log: (m: string) => entries.push(["log", m]),
      debug: (m: string) => entries.push(["debug", m]),
    };

    const handler = KafkaLogger(logger);
    const circular: Record<string, unknown> = { id: 1n };
    circular.self = circular;

    handler({ namespace: "Consumer", level: 1, label: "ERROR", log: { message: "err", circular } });
    handler({ namespace: "Consumer", level: 2, label: "WARN", log: { message: "warn" } });
    handler({ namespace: "Consumer", level: 4, label: "INFO", log: { message: "info" } });
    handler({ namespace: "Consumer", level: 5, label: "DEBUG", log: { message: "dbg" } });

    expect(entries.map(([lvl]) => lvl)).toEqual(["error", "warn", "log", "debug"]);
    expect(entries[0]![1]).toContain("[Consumer]");
  });

  it("KafkaReplyPartitionAssigner preserves previous reply partitions across rebalances", async () => {
    const assigner = new KafkaReplyPartitionAssigner(
      { getConsumerAssignments: () => ({ "orders.reply": 2 }) },
      {
        cluster: {
          findTopicPartitionMetadata: () => [
            { partitionId: 0 },
            { partitionId: 1 },
            { partitionId: 2 },
            { partitionId: 3 },
          ],
        },
      },
    );

    const subA = assigner.protocol({ topics: ["orders.reply"] });
    expect(subA.name).toBe("NestReplyPartitionAssigner");

    const assignments = await assigner.assign({
      topics: ["orders.reply"],
      members: [
        { memberId: "m-1", memberMetadata: subA.metadata },
        { memberId: "m-2", memberMetadata: Buffer.from("malformed-bytes") },
      ],
    });

    expect(assignments).toHaveLength(2);
    const decoded = Object.fromEntries(
      assignments.map((a) => [
        a.memberId,
        JSON.parse(a.memberAssignment.toString("utf8")).assignment[
          "orders.reply"
        ] as number[],
      ]),
    ) as Record<string, number[]>;
    // m-1 keeps its previous sticky partition 2; all 4 partitions assigned with no duplicates
    expect(decoded["m-1"]!).toContain(2);
    const allParts = [...decoded["m-1"]!, ...decoded["m-2"]!].sort();
    expect(allParts).toEqual([0, 1, 2, 3]);
  });
});
