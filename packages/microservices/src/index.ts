
// Tokens & Constants
export {
  CLIENT_CONFIGURATION_METADATA,
  CLIENT_METADATA,
  CONTEXT,
  EVENT_PATTERN_METADATA,
  GRPC_METHOD_METADATA,
  MESSAGE_PATTERN_METADATA,
  MICROSERVICE_OPTIONS,
  MICROSERVICE_SERVER,
  PATTERN_EXTRAS_METADATA,
  PATTERN_HANDLER_METADATA,
  PATTERN_METADATA,
  RPC_PARAM_METADATA,
  TRANSPORT_METADATA,
  Transport,
} from "./tokens";

// Enums & Transport Event Maps
export {
  GrpcMethodStreamingType,
  GrpcStatus,
  KafkaHeaders,
  KafkaStatus,
  MqttStatus,
  NatsStatus,
  RedisStatus,
  RmqStatus,
  TcpStatus,
  type MqttEvents,
  type NatsEvents,
  type RedisEvents,
  type RmqEvents,
  type ServersChangedEvent,
  type TcpEvents,
} from "./enums";

// Packets, Patterns, Serializer & Deserializer Interfaces
export {
  hasPacketMetadata,
  toPacketMetadata,
  type ConsumerDeserializer,
  type ConsumerSerializer,
  type Deserializer,
  type IncomingEvent,
  type IncomingRequest,
  type IncomingResponse,
  type MsFundamentalPattern,
  type MsObjectPattern,
  type MsPattern,
  type MsPatternMatch,
  type OutgoingEvent,
  type OutgoingRequest,
  type OutgoingResponse,
  type PacketId,
  type PacketMetadata,
  type PatternMetadata,
  type ProducerDeserializer,
  type ProducerSerializer,
  type ReadPacket,
  type Serializer,
  type WritePacket,
} from "./packets";

// RPC Context Hosts
export {
  BaseRpcContext,
  NatsContext,
  RedisContext,
  RmqContext,
  TcpContext,
  type NatsContextArgs,
  type RedisContextArgs,
  type RequestContext,
  type RmqContextArgs,
  type TcpContextArgs,
} from "./ctx-host";

// Exceptions & Exception Filters
export {
  BaseRpcExceptionFilter,
  GrpcAbortedException,
  GrpcAlreadyExistsException,
  GrpcCancelledException,
  GrpcDataLossException,
  GrpcDeadlineExceededException,
  GrpcException,
  GrpcExceptionFilter,
  GrpcFailedPreconditionException,
  GrpcInternalException,
  GrpcInvalidArgumentException,
  GrpcNotFoundException,
  GrpcOutOfRangeException,
  GrpcPermissionDeniedException,
  GrpcResourceExhaustedException,
  GrpcUnauthenticatedException,
  GrpcUnavailableException,
  GrpcUnimplementedException,
  GrpcUnknownException,
  KafkaRetriableException,
  RpcException,
  RpcTimeoutException,
  type GrpcExceptionBody,
  type SerializedRpcError,
} from "./exceptions";

// Deserializers & Serializers
export {
  IdentityDeserializer,
  IncomingRequestDeserializer,
  IncomingResponseDeserializer,
  KafkaRequestDeserializer,
  KafkaResponseDeserializer,
  NatsRequestJSONDeserializer,
  NatsResponseJSONDeserializer,
} from "./deserializers";
export { IdentitySerializer, KafkaRequestSerializer } from "./serializers";

// Protocol Helpers
export {
  JsonSocket,
  KafkaLogger,
  KafkaParser,
  KafkaReplyPartitionAssigner,
  getGrpcPackageDefinition,
  type JsonSocketOptions,
  type KafkaParserConfig,
  type KafkaReplyPartitionAssignerClientLike,
  type KafkaReplyPartitionAssignerCluster,
} from "./helpers";

// Module Augmentation Registries (populated by `bunest dev` / `bunest typegen`)
export type {
  BunestEventPatternRegistry,
  BunestMessagePatternRegistry,
  MessagePatternRequest,
  MessagePatternResponse,
  RegisteredEventPatternKey,
  RegisteredMessagePatternEntry,
  RegisteredMessagePatternKey,
} from "./pattern-registry.interface";

// Core Interfaces & Transport Config Types
export {
  normalizePattern,
  type AsyncMicroserviceOptions,
  type AsyncOptions,
  type ClientGrpc,
  type ClientOptions,
  type CustomStrategy,
  type GrpcCodec,
  type GrpcMetadataLike,
  type GrpcMethodMetadata,
  type GrpcOptions,
  type GrpcTransportOptions,
  type InMemoryOptions,
  type InMemoryTransportOptions,
  type KafkaClientLike,
  type KafkaConsumerLike,
  type KafkaEachMessagePayload,
  type KafkaHeaderMap,
  type KafkaHeaderValue,
  type KafkaHeadersRecord,
  type KafkaMessageLike,
  type KafkaOptions,
  type KafkaProducerLike,
  type KafkaProducerRecord,
  type KafkaTransportOptions,
  type MessageHandler,
  type MicroserviceOptions,
  type MqttClientLike,
  type MqttMessageListener,
  type MqttOptions,
  type MqttPacketLike,
  type MqttPublishOptions,
  type MqttQoS,
  type MqttSubscribeOptions,
  type MqttTransportOptions,
  type NatsMessageLike,
  type NatsOptions,
  type NatsSubscriptionLike,
  type NatsTransportClientLike,
  type NatsTransportOptions,
  type PatternHandlerMetadata,
  type PatternInput,
  type RabbitMqChannelLike,
  type RabbitMqMessageLike,
  type RabbitMqTransportOptions,
  type RedisOptions,
  type RedisTransportClientLike,
  type RedisTransportOptions,
  type RmqOptions,
  type RpcContext,
  type RpcEnvelope,
  type RpcEventEnvelope,
  type RpcParamKind,
  type RpcParamMetadata,
  type RpcRequestEnvelope,
  type RpcResponseEnvelope,
  type SendOptions,
  type TcpClientOptions,
  type TcpOptions,
  type TcpTransportOptions,
  type TransportConfig,
  type TransportId,
} from "./interfaces";

// Client Module & Proxy Option Interfaces
export type {
  ClientKafkaProxy,
  ClientProvider,
  ClientProviderOptions,
  ClientsModuleAsyncOptions,
  ClientsModuleOptions,
  ClientsModuleOptionsFactory,
  ClientsOptionsFactory,
  ClientsProviderAsyncOptions,
  CustomClientOptions,
} from "./client-interfaces";

// Decorators
export {
  Client,
  Ctx,
  EventPattern,
  MessagePattern,
  Payload,
  type EventDataMethodDecorator,
} from "./decorators";
export {
  GrpcMethod,
  GrpcService,
  GrpcStreamCall,
  GrpcStreamMethod,
  createGrpcMethodMetadata,
} from "./decorators/grpc.decorators";

// Execution Context & Framing
export { RpcExecutionContext } from "./rpc-context";
export { FrameDecoder, encodeFrame } from "./framing";

// Base Server & ClientProxy
export {
  MicroserviceTransportServer,
  Server,
  type CustomTransportStrategy,
} from "./server";
export {
  ClientProxy,
  type ClientStatus,
  type ClientStatusListener,
} from "./client-proxy";
export {
  ClientProxyFactory,
  type IClientProxyFactory,
} from "./client-proxy-factory";

// Record Builders
export {
  MqttRecord,
  MqttRecordBuilder,
  NatsRecord,
  NatsRecordBuilder,
  RedisRecord,
  RedisRecordBuilder,
  RmqRecord,
  RmqRecordBuilder,
  type MqttRecordOptions,
  type RedisRecordOptions,
  type RmqRecordOptions,
} from "./records";

// Transports + NestJS Aliases
export {
  ClientTCP,
  ServerTCP,
  TcpClientProxy,
  TcpServer,
} from "./transports/tcp.transport";
export {
  InMemoryBroker,
  InMemoryClientProxy,
  InMemoryServer,
  defaultInMemoryBroker,
} from "./transports/in-memory.transport";
export {
  ClientNats,
  ClientRMQ,
  ClientRedis,
  NatsClientProxy,
  NatsServer,
  NatsTransportAdapter,
  NatsTransportServer,
  RabbitMqClientProxy,
  RabbitMqServer,
  RabbitMqTransportAdapter,
  RabbitMqTransportServer,
  RedisClientProxy,
  RedisServer,
  RedisTransportAdapter,
  RedisTransportServer,
  ServerNats,
  ServerRMQ,
  ServerRedis,
} from "./transports/broker.transports";
export {
  ClientGrpcProxy,
  GrpcClientProxy,
  GrpcContext,
  GrpcFrameDecoder,
  GrpcMetadata,
  GrpcServer,
  JsonGrpcCodec,
  ServerGrpc,
  decodeGrpcFrames,
  defaultGrpcCodec,
  encodeGrpcFrame,
  encodeGrpcTrailerFrame,
  formatGrpcTimeout,
  parseGrpcTimeout,
  parseGrpcTrailers,
  type GrpcCallOptions,
  type GrpcCallResult,
  type GrpcFrame,
} from "./transports/grpc.transport";
export {
  ClientKafka,
  KAFKA_CORRELATION_ID_HEADER,
  KAFKA_REPLY_PARTITION_HEADER,
  KAFKA_REPLY_TOPIC_HEADER,
  KafkaClientProxy,
  KafkaContext,
  KafkaServer,
  ServerKafka,
  type KafkaContextArgs,
  type KafkaContextParams,
  type KafkaMessageRecord,
} from "./transports/kafka.transport";
export {
  ClientMqtt,
  MqttClientProxy,
  MqttContext,
  MqttServer,
  ServerMqtt,
  matchMqttTopic,
  type MqttContextArgs,
  type MqttContextParams,
} from "./transports/mqtt.transport";

// Host & Modules
export { MicroserviceHost, NestMicroservice } from "./microservice-host";
export {
  ClientsModule,
  MicroserviceModule,
  createClientProxy,
  createTransportServer,
  type MicroserviceModuleOptions,
} from "./microservice.module";
