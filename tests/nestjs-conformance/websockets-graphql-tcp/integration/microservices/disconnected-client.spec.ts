import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Body,
  Controller,
  InternalServerErrorException,
  Post,
  RequestTimeoutException,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Transport,
  createClientProxy,
  type MqttClientLike,
  type NatsTransportClientLike,
  type RabbitMqChannelLike,
  type RedisTransportClientLike,
  type TransportConfig,
} from "../../../../../packages/microservices/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
  type TestingModule,
} from "../../../_helpers";

function makeConnRefusedError(code = "ECONNREFUSED"): Error & { code: string } {
  const err = new Error(`connect ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

function createDisconnectedTransportConfig(
  transport: Transport,
  unusedTcpPort: number,
): TransportConfig {
  switch (transport) {
    case Transport.TCP:
      return {
        transport: Transport.TCP,
        options: {
          host: "127.0.0.1",
          port: unusedTcpPort,
          defaultTimeoutMs: 500,
        },
      };
    case Transport.REDIS: {
      const disconnectedRedis: RedisTransportClientLike = {
        async subscribe() {
          throw makeConnRefusedError("ECONNREFUSED");
        },
        async publish() {
          throw makeConnRefusedError("ECONNREFUSED");
        },
      };
      return {
        transport: Transport.REDIS,
        options: {
          pubClient: disconnectedRedis,
          subClient: disconnectedRedis,
          defaultTimeoutMs: 500,
        },
      };
    }
    case Transport.NATS: {
      const disconnectedNats: NatsTransportClientLike = {
        async subscribe() {
          throw makeConnRefusedError("CONNECTION_REFUSED");
        },
        async publish() {
          throw makeConnRefusedError("CONNECTION_REFUSED");
        },
        async request() {
          throw makeConnRefusedError("CONNECTION_REFUSED");
        },
      };
      return {
        transport: Transport.NATS,
        options: {
          client: disconnectedNats,
          defaultTimeoutMs: 500,
        },
      };
    }
    case Transport.MQTT: {
      const disconnectedMqtt: MqttClientLike = {
        async publish() {
          throw new Error("Connection is closed.");
        },
        async subscribe() {
          throw new Error("Connection is closed.");
        },
        on() {
          return this;
        },
      };
      return {
        transport: Transport.MQTT,
        options: {
          client: disconnectedMqtt,
          defaultTimeoutMs: 500,
        },
      };
    }
    case Transport.RABBITMQ: {
      const disconnectedRmq: RabbitMqChannelLike = {
        async assertQueue() {
          throw makeConnRefusedError("ECONNREFUSED");
        },
        async consume() {
          throw makeConnRefusedError("ECONNREFUSED");
        },
        async sendToQueue() {
          throw makeConnRefusedError("ECONNREFUSED");
        },
      };
      return {
        transport: Transport.RABBITMQ,
        options: {
          channel: disconnectedRmq,
          queue: "test",
          defaultTimeoutMs: 500,
        },
      };
    }
    default:
      throw new Error(`Unsupported transport in test: ${String(transport)}`);
  }
}

function getUnusedEphemeralPort(): number {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data() {},
    },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}

let unusedPort = 0;

@Controller()
class DisconnectedClientController {
  @Post()
  async call(@Body() body: { transport: Transport }): Promise<number> {
    const config = createDisconnectedTransportConfig(
      body.transport,
      unusedPort,
    );
    const client = createClientProxy(config);
    try {
      return await client.send<number, number[]>({ cmd: "none" }, [1, 2, 3]);
    } catch (error: unknown) {
      const errObj = error as {
        err?: { code?: string };
        code?: string;
        message?: string;
      };
      const code = errObj?.err?.code ?? errObj?.code ?? "CONN_ERR";
      const message = (errObj?.message ?? "").toLowerCase();
      if (
        code === "ECONNREFUSED" ||
        code === "ConnectionRefused" ||
        code === "CONN_ERR" ||
        code === "ENOTFOUND" ||
        code === "CONNECTION_REFUSED" ||
        message.includes("connection is closed.") ||
        message.includes("connection refused") ||
        message.includes("unable to connect")
      ) {
        throw new RequestTimeoutException("ECONNREFUSED");
      }
      throw new InternalServerErrorException();
    } finally {
      await client.close();
    }
  }
}

describeConformance(
  "Disconnected client",
  {
    upstreamPath: "integration/microservices/e2e/disconnected-client.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Native Bun TCP connection refusal on an ephemeral unused port + client-injected disconnected broker clients (Redis/NATS/MQTT/RabbitMQ) with Promise-based error handling instead of RxJS catchError.",
  },
  () => {
    let moduleRef: TestingModule | undefined;
    let app: BunestApplication | undefined;

    beforeEach(async () => {
      unusedPort = getUnusedEphemeralPort();
      moduleRef = await Test.createTestingModule({
        controllers: [DisconnectedClientController],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app?.close();
      await moduleRef?.close();
      app = undefined;
      moduleRef = undefined;
    });

    it("TCP", async () => {
      const res = await request(app!)
        .post("/")
        .send({ transport: Transport.TCP })
        .expect(408);
      expect(res.status).toBe(408);
    });

    itAdapted(
      "ADR-001",
      "REDIS",
      async () => {
        const res = await request(app!)
          .post("/")
          .send({ transport: Transport.REDIS })
          .expect(408);
        expect(res.status).toBe(408);
      },
      "client-injected disconnected Redis client",
    );

    itAdapted(
      "ADR-001",
      "NATS",
      async () => {
        const res = await request(app!)
          .post("/")
          .send({ transport: Transport.NATS })
          .expect(408);
        expect(res.status).toBe(408);
      },
      "client-injected disconnected NATS client",
    );

    itAdapted(
      "ADR-001",
      "MQTT",
      async () => {
        const res = await request(app!)
          .post("/")
          .send({ transport: Transport.MQTT })
          .expect(408);
        expect(res.status).toBe(408);
      },
      "client-injected disconnected MQTT client",
    );

    itAdapted(
      "ADR-001",
      "RMQ",
      async () => {
        const res = await request(app!)
          .post("/")
          .send({ transport: Transport.RABBITMQ })
          .expect(408);
        expect(res.status).toBe(408);
      },
      "client-injected disconnected RabbitMQ channel",
    );
  },
);
