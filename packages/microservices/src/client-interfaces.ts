import type {
  FactoryDependency,
  InjectionToken,
  ModuleImport,
  Provider,
  Type,
} from "@bunest/common";
import type { ClientProxy } from "./client-proxy";
import type { KafkaStatus } from "./enums";
import type {
  ClientOptions,
  KafkaConsumerLike,
  KafkaProducerLike,
  TransportConfig,
} from "./interfaces";

export interface CustomClientOptions {
  customClass: Type<ClientProxy<any, any>>;
  options?: Record<string, any>;
}

export type ClientProvider = ClientOptions | CustomClientOptions;

export type ClientProviderOptions = (TransportConfig | ClientProvider) & {
  readonly name: InjectionToken;
};

export type ClientsModuleOptions =
  | ReadonlyArray<ClientProviderOptions>
  | {
      readonly clients: ReadonlyArray<ClientProviderOptions>;
      readonly isGlobal?: boolean;
    };

export interface ClientsModuleOptionsFactory {
  createClientOptions():
    | Promise<TransportConfig | ClientProvider>
    | TransportConfig
    | ClientProvider;
}

export type ClientsOptionsFactory = ClientsModuleOptionsFactory;

export interface ClientsProviderAsyncOptions {
  readonly name: InjectionToken;
  readonly imports?: ModuleImport[];
  readonly useFactory?: (
    ...args: any[]
  ) => Promise<TransportConfig | ClientProvider> | TransportConfig | ClientProvider;
  readonly inject?: FactoryDependency[];
  readonly useClass?: Type<ClientsModuleOptionsFactory>;
  readonly useExisting?: InjectionToken<ClientsModuleOptionsFactory>;
  readonly extraProviders?: Provider[];
}

export type ClientsModuleAsyncOptions =
  | ReadonlyArray<ClientsProviderAsyncOptions>
  | {
      readonly clients: ReadonlyArray<ClientsProviderAsyncOptions>;
      readonly isGlobal?: boolean;
    };

export interface ClientKafkaProxy
  extends Omit<ClientProxy<Record<string, Function>, KafkaStatus>, "on"> {
  readonly consumer: KafkaConsumerLike | null;
  readonly producer: KafkaProducerLike | null;
  subscribeToResponseOf(pattern: unknown): void;
  commitOffsets(
    topicPartitions: ReadonlyArray<{
      readonly topic: string;
      readonly partition: number;
      readonly offset: string;
      readonly metadata?: string | null;
    }>,
  ): Promise<void>;
}
