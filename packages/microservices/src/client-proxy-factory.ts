import type {
  ClientKafkaProxy,
  ClientProvider,
  CustomClientOptions,
} from "./client-interfaces";
import type { ClientProxy } from "./client-proxy";
import type {
  ClientOptions,
  GrpcTransportOptions,
  InMemoryTransportOptions,
  KafkaTransportOptions,
  MqttTransportOptions,
  NatsTransportOptions,
  RabbitMqTransportOptions,
  RedisTransportOptions,
  TcpTransportOptions,
  TransportConfig,
} from "./interfaces";
import { Transport } from "./tokens";
import {
  NatsClientProxy,
  RabbitMqClientProxy,
  RedisClientProxy,
} from "./transports/broker.transports";
import { GrpcClientProxy } from "./transports/grpc.transport";
import { InMemoryClientProxy } from "./transports/in-memory.transport";
import { KafkaClientProxy } from "./transports/kafka.transport";
import { MqttClientProxy } from "./transports/mqtt.transport";
import { TcpClientProxy } from "./transports/tcp.transport";

export interface IClientProxyFactory {
  create(clientOptions: ClientOptions | TransportConfig): ClientProxy;
}

/**
 * Factory creating transport-specific `ClientProxy` instances (or custom client
 * proxy classes) matching `@nestjs/microservices` `ClientProxyFactory`.
 */
export class ClientProxyFactory {
  static create(
    clientOptions: { readonly transport: Transport.GRPC } & (
      | ClientOptions
      | TransportConfig
    ),
  ): GrpcClientProxy;
  static create(
    clientOptions: { readonly transport: Transport.KAFKA } & (
      | ClientOptions
      | TransportConfig
    ),
  ): ClientKafkaProxy & KafkaClientProxy;
  static create(clientOptions: ClientOptions | TransportConfig): ClientProxy;
  static create(clientOptions: CustomClientOptions): ClientProxy;
  static create(clientOptions: ClientProvider | TransportConfig): ClientProxy;
  static create(
    clientOptions: ClientProvider | TransportConfig,
  ): ClientProxy {
    if (this.isCustomClientOptions(clientOptions)) {
      const { customClass, options } = clientOptions;
      return new customClass(options);
    }

    const { transport, options } = (clientOptions ?? {
      options: {},
    }) as { transport?: Transport; options?: Record<string, unknown> };

    switch (transport) {
      case Transport.REDIS:
        return new RedisClientProxy(
          (options ?? {}) as unknown as RedisTransportOptions,
        );
      case Transport.NATS:
        return new NatsClientProxy(
          (options ?? {}) as unknown as NatsTransportOptions,
        );
      case Transport.MQTT:
        return new MqttClientProxy(
          (options ?? {}) as unknown as MqttTransportOptions,
        );
      case Transport.GRPC:
        return new GrpcClientProxy(
          (options ?? {}) as unknown as GrpcTransportOptions,
        );
      case Transport.RABBITMQ:
      case Transport.RMQ:
        return new RabbitMqClientProxy(
          (options ?? {}) as unknown as RabbitMqTransportOptions,
        );
      case Transport.KAFKA:
        return new KafkaClientProxy(
          (options ?? {}) as unknown as KafkaTransportOptions,
        );
      case Transport.IN_MEMORY:
        return new InMemoryClientProxy(
          (options ?? {}) as unknown as InMemoryTransportOptions,
        );
      case Transport.TCP:
      default:
        return new TcpClientProxy(
          (options ?? {}) as unknown as TcpTransportOptions,
        );
    }
  }

  private static isCustomClientOptions(
    options: ClientProvider | TransportConfig,
  ): options is CustomClientOptions {
    return Boolean(
      options &&
        typeof options === "object" &&
        "customClass" in options &&
        typeof options.customClass === "function",
    );
  }
}
