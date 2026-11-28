import {
  Module,
  type DynamicModule,
  type ModuleExport,
  type ModuleImport,
  type Provider,
} from "@bunest/core";
import { isPromiseLike } from "@bunest/core/common";
import type {
  ClientProvider,
  ClientProviderOptions,
  ClientsModuleAsyncOptions,
  ClientsModuleOptions,
  ClientsModuleOptionsFactory,
  ClientsProviderAsyncOptions,
} from "./client-interfaces";
import type { ClientProxy } from "./client-proxy";
import { ClientProxyFactory } from "./client-proxy-factory";
import type {
  MicroserviceDeadLetterHandler,
  ServerResilienceOptions,
  TransportConfig,
} from "./interfaces";
import { MicroserviceHost } from "./microservice-host";
import {
  MicroserviceTransportServer,
  type CustomTransportStrategy,
} from "./server";
import { MICROSERVICE_OPTIONS, MICROSERVICE_SERVER, Transport } from "./tokens";
import {
  NatsTransportServer,
  RabbitMqTransportServer,
  RedisTransportServer,
} from "./transports/broker.transports";
import { GrpcServer } from "./transports/grpc.transport";
import { InMemoryServer } from "./transports/in-memory.transport";
import { KafkaServer } from "./transports/kafka.transport";
import { MqttServer } from "./transports/mqtt.transport";
import { TcpServer } from "./transports/tcp.transport";

export function createTransportServer(
  config: TransportConfig,
): MicroserviceTransportServer {
  switch (config.transport) {
    case Transport.TCP:
      return new TcpServer(config.options);
    case Transport.IN_MEMORY:
      return new InMemoryServer(config.options);
    case Transport.REDIS:
      return new RedisTransportServer(config.options);
    case Transport.NATS:
      return new NatsTransportServer(config.options);
    case Transport.RABBITMQ:
    case Transport.RMQ:
      return new RabbitMqTransportServer(config.options);
    case Transport.GRPC:
      return new GrpcServer(config.options);
    case Transport.KAFKA:
      return new KafkaServer(config.options);
    case Transport.MQTT:
      return new MqttServer(config.options);
  }
}

export function createClientProxy(
  config: TransportConfig | ClientProvider,
): ClientProxy {
  return ClientProxyFactory.create(config);
}

class CustomStrategyServerAdapter extends MicroserviceTransportServer {
  readonly transport = Transport.IN_MEMORY;

  constructor(private readonly strategy: CustomTransportStrategy) {
    super();
  }

  override unwrap<T = unknown>(): T {
    if (typeof this.strategy.unwrap === "function") {
      return this.strategy.unwrap<T>();
    }
    return this.strategy as unknown as T;
  }

  async listen(
    callback?: (...optionalParams: unknown[]) => any,
  ): Promise<void> {
    if (this.listening) {
      callback?.();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      try {
        let settled = false;
        const done = () => {
          if (!settled) {
            settled = true;
            this.listening = true;
            this.emitStatus("connected");
            callback?.();
            resolve();
          }
        };
        const result = this.strategy.listen(done);
        if (isPromiseLike(result)) {
          result.then(done, reject);
        } else if (this.strategy.listen.length === 0) {
          done();
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  async close(): Promise<void> {
    if (!this.listening) return;
    await this.strategy.close();
    this.listening = false;
    this.emitStatus("disconnected");
  }
}

export type MicroserviceModuleOptions =
  | (TransportConfig &
      ServerResilienceOptions & { readonly global?: boolean })
  | ({
      readonly server: MicroserviceTransportServer;
      readonly global?: boolean;
    } & ServerResilienceOptions)
  | ({
      readonly strategy: CustomTransportStrategy;
      readonly global?: boolean;
    } & ServerResilienceOptions);

function resolveMicroserviceServer(
  options: MicroserviceModuleOptions,
): MicroserviceTransportServer {
  if ("server" in options) {
    return options.server;
  }
  if ("strategy" in options) {
    return options.strategy instanceof MicroserviceTransportServer
      ? options.strategy
      : new CustomStrategyServerAdapter(options.strategy);
  }
  return createTransportServer(options);
}

/**
 * Registers a `MicroserviceTransportServer` and `MicroserviceHost` that auto-discovers
 * `@MessagePattern()` and `@EventPattern()` handlers on bootstrap and shuts down gracefully.
 */
@Module({})
export class MicroserviceModule {
  static forRoot(options: MicroserviceModuleOptions): DynamicModule {
    const server = resolveMicroserviceServer(options);

    const dlqHandler: MicroserviceDeadLetterHandler | undefined =
      options.deadLetterHandler;
    if (dlqHandler !== undefined) {
      server.setDeadLetterHandler(dlqHandler);
    }
    if (options.cls !== undefined) {
      server.setClsService(options.cls);
    }
    if (options.clsPropagation !== undefined) {
      server.setClsPropagation(options.clsPropagation);
    }

    return {
      module: MicroserviceModule,
      global: options.global ?? false,
      providers: [
        {
          provide: MICROSERVICE_OPTIONS,
          useValue: options,
        },
        {
          provide: MICROSERVICE_SERVER,
          useValue: server,
        },
        MicroserviceHost,
      ],
      exports: [MICROSERVICE_SERVER, MicroserviceHost],
    };
  }
}

/**
 * Dynamic module registering named `ClientProxy` instances for dependency injection
 * (`ClientsModule.register` and `ClientsModule.registerAsync`).
 *
 * Accepts both array form `ClientsModule.register([...], { global? })` and
 * NestJS v12 object form `ClientsModule.register({ clients: [...], isGlobal?: boolean })`.
 */
@Module({})
export class ClientsModule {
  static register(
    options: ClientsModuleOptions,
    legacyOptions?: { readonly global?: boolean },
  ): DynamicModule {
    const clients: readonly ClientProviderOptions[] =
      "clients" in options ? options.clients : options;
    const isGlobal =
      "clients" in options
        ? (options.isGlobal ?? legacyOptions?.global ?? false)
        : (legacyOptions?.global ?? false);

    const providers: Provider[] = [];
    const exportsList: ModuleExport[] = [];

    for (const client of clients) {
      providers.push({
        provide: client.name,
        useFactory: () => createClientProxy(client),
      });
      exportsList.push(client.name);
    }

    return {
      module: ClientsModule,
      global: isGlobal,
      providers,
      exports: exportsList,
    };
  }

  static registerAsync(
    options: ClientsModuleAsyncOptions,
    legacyOptions?: { readonly global?: boolean },
  ): DynamicModule {
    const clients: readonly ClientsProviderAsyncOptions[] =
      "clients" in options ? options.clients : options;
    const isGlobal =
      "clients" in options
        ? (options.isGlobal ?? legacyOptions?.global ?? false)
        : (legacyOptions?.global ?? false);

    const providers: Provider[] = [];
    const exportsList: ModuleExport[] = [];
    const imports: ModuleImport[] = [];

    for (const client of clients) {
      if (client.imports) {
        imports.push(...client.imports);
      }
      if (client.extraProviders) {
        providers.push(...client.extraProviders);
      }

      if (client.useFactory) {
        providers.push({
          provide: client.name,
          useFactory: async (...args: unknown[]) => {
            const config = await client.useFactory!(...args);
            return createClientProxy(config);
          },
          inject: client.inject ?? [],
        });
      } else if (client.useClass) {
        const factoryCls = client.useClass;
        providers.push(
          {
            provide: factoryCls,
            useClass: factoryCls,
          },
          {
            provide: client.name,
            useFactory: async (factory: ClientsModuleOptionsFactory) => {
              const config = await factory.createClientOptions();
              return createClientProxy(config);
            },
            inject: [factoryCls],
          },
        );
      } else if (client.useExisting) {
        providers.push({
          provide: client.name,
          useFactory: async (factory: ClientsModuleOptionsFactory) => {
            const config = await factory.createClientOptions();
            return createClientProxy(config);
          },
          inject: [client.useExisting],
        });
      } else {
        throw new Error(
          `ClientsModule.registerAsync("${String(client.name)}") requires "useFactory", "useClass", or "useExisting".`,
        );
      }

      exportsList.push(client.name);
    }

    return {
      module: ClientsModule,
      global: isGlobal,
      imports,
      providers,
      exports: exportsList,
    };
  }
}
