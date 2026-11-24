import type { Subscribable } from "@bunest/core";
import type { OutboxHeaders, OutboxMessage } from "./outbox-message.interface";

/**
 * What a remote consumer receives by default: enough to deduplicate (`id`) and to
 * keep per-key order downstream (`key`).
 */
export interface OutboxEnvelope<P = unknown> {
  id: string;
  topic: string;
  key: string | null;
  headers: OutboxHeaders;
  createdAt: number;
  payload: P;
}

/**
 * The part of `ClientProxy` this transport uses. Structural, so the package has no
 * runtime or type dependency on `@bunest/microservices`. Supports both Promise-based
 * `@bunest/microservices` `ClientProxy.emit()` and `Subscribable<unknown>` (ADR-008).
 */
export interface EventEmittingClient {
  emit(pattern: any, data: any): Subscribable<unknown> | Promise<unknown>;
}

export interface ClientProxyTransportOptions {
  /**
   * Maps a message to `emit(pattern, data)`. Default: the topic as the pattern and the
   * `OutboxEnvelope` (the second argument) as data (or `toKafkaRecord` for `ClientKafka`).
   */
  toPacket?: (
    message: OutboxMessage,
    envelope: OutboxEnvelope,
  ) => {
    pattern: unknown;
    data: unknown;
  };
}
