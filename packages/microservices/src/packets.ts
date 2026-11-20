export interface PacketId {
  id: string;
}

/**
 * Out-of-band string key/value metadata attached to a packet via
 * `ClientProxy#setOnDispatchHook` and read on the server from the RPC context.
 */
export type PacketMetadata = Record<string, string>;

export interface ReadPacket<T = any> {
  pattern: any;
  data: T;
  metadata?: PacketMetadata;
}

export interface WritePacket<T = any> {
  err?: any;
  response?: T;
  isDisposed?: boolean;
  status?: string;
}

export type OutgoingRequest = ReadPacket & PacketId;
export type IncomingRequest = ReadPacket & PacketId;
export type OutgoingEvent = ReadPacket;
export type IncomingEvent = ReadPacket;
export type IncomingResponse = WritePacket & PacketId;
export type OutgoingResponse = WritePacket & PacketId;

export type MsFundamentalPattern = string | number;
export type MsPatternMatch = RegExp;
export interface MsObjectPattern {
  [key: string]: MsFundamentalPattern | MsObjectPattern;
}
export type MsPattern = MsObjectPattern | MsFundamentalPattern | MsPatternMatch;
export type PatternMetadata = Record<string, any> | string;

export interface Serializer<TInput = any, TOutput = any> {
  serialize(
    value: TInput,
    options?: Record<string, any>,
  ): TOutput | Promise<TOutput>;
}

export type ProducerSerializer = Serializer<
  OutgoingEvent | OutgoingRequest,
  any
>;
export type ConsumerSerializer = Serializer<OutgoingResponse, any>;

export interface Deserializer<TInput = any, TOutput = any> {
  deserialize(
    value: TInput,
    options?: Record<string, any>,
  ): TOutput | Promise<TOutput>;
}

export type ProducerDeserializer = Deserializer<any, IncomingResponse>;
export type ConsumerDeserializer = Deserializer<
  any,
  IncomingRequest | IncomingEvent
>;

/**
 * Extracts single-string entries from transport headers into `PacketMetadata`,
 * returning `undefined` when no string entry is present.
 */
export function toPacketMetadata(
  entries: Iterable<readonly [string, unknown]>,
): PacketMetadata | undefined {
  let metadata: PacketMetadata | undefined;
  for (const [key, value] of entries) {
    if (typeof value === "string") {
      metadata ??= {};
      metadata[key] = value;
    }
  }
  return metadata;
}

/**
 * Returns true if `metadata` has at least one entry.
 */
export function hasPacketMetadata(
  metadata: PacketMetadata | undefined,
): metadata is PacketMetadata {
  return Boolean(metadata && Object.keys(metadata).length > 0);
}
