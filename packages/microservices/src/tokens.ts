import { REQUEST } from "@bunest/common";

export enum Transport {
  TCP = "TCP",
  IN_MEMORY = "IN_MEMORY",
  REDIS = "REDIS",
  NATS = "NATS",
  RABBITMQ = "RABBITMQ",
  RMQ = "RABBITMQ",
  GRPC = "GRPC",
  KAFKA = "KAFKA",
  MQTT = "MQTT",
}

/**
 * Request/context DI injection token (matches NestJS `@Inject(CONTEXT)`).
 */
export const CONTEXT = REQUEST;

export const MESSAGE_PATTERN_METADATA = Symbol.for(
  "bunest:microservices:message-pattern",
);
export const EVENT_PATTERN_METADATA = Symbol.for(
  "bunest:microservices:event-pattern",
);
export const GRPC_METHOD_METADATA = Symbol.for(
  "bunest:microservices:grpc-method",
);
export const RPC_PARAM_METADATA = Symbol.for("bunest:microservices:rpc-param");
export const MICROSERVICE_OPTIONS = Symbol.for("bunest:microservices:options");
export const MICROSERVICE_SERVER = Symbol.for("bunest:microservices:server");

export const PATTERN_METADATA = "microservices:pattern";
export const PATTERN_EXTRAS_METADATA = "microservices:pattern_extras";
export const TRANSPORT_METADATA = "microservices:transport";
export const CLIENT_CONFIGURATION_METADATA = "microservices:client";
export const PATTERN_HANDLER_METADATA = "microservices:handler_type";
export const CLIENT_METADATA = "microservices:is_client_instance";
