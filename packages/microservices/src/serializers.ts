import type { Serializer } from "./packets";
import { MqttRecord, NatsRecord, RmqRecord } from "./records";

const MAX_KAFKA_HEADER_VALUES = 10_000;
const KAFKA_MESSAGE_FIELDS = new Set([
  "key",
  "value",
  "headers",
  "partition",
  "timestamp",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

export type EncodedKafkaValue = string | Buffer | Uint8Array | null;

export interface SerializedKafkaMessage {
  key?: EncodedKafkaValue;
  value: EncodedKafkaValue;
  headers: Record<string, unknown>;
  partition?: number;
  timestamp?: string;
  [key: string]: unknown;
}

/**
 * Pass-through serializer returning outgoing values unchanged.
 */
export class IdentitySerializer implements Serializer {
  serialize<T = unknown>(value: T): T {
    return value;
  }
}

/**
 * Serializes outgoing Kafka payloads into `{ key?, value, headers, partition?, timestamp? }`
 * records compatible with KafkaJS / `KafkaProducerRecord`.
 */
export class KafkaRequestSerializer implements Serializer<
  unknown,
  SerializedKafkaMessage
> {
  serialize(value: unknown): SerializedKafkaMessage {
    const isNotKafkaMessage =
      value === null ||
      value === undefined ||
      typeof value !== "object" ||
      (!("key" in value) && !("value" in value)) ||
      Object.keys(value).some((field) => !KAFKA_MESSAGE_FIELDS.has(field));

    const record: Record<string, unknown> = isNotKafkaMessage
      ? { value }
      : (value as Record<string, unknown>);
    const headers =
      record.headers &&
      typeof record.headers === "object" &&
      !Array.isArray(record.headers)
        ? (record.headers as Record<string, unknown>)
        : {};

    let headerValues = 0;
    for (const headerValue of Object.values(headers)) {
      headerValues += Array.isArray(headerValue) ? headerValue.length : 1;
    }
    if (headerValues > MAX_KAFKA_HEADER_VALUES) {
      throw new Error(
        `Kafka message headers count (${headerValues}) exceeds maximum allowed (${MAX_KAFKA_HEADER_VALUES}).`,
      );
    }

    const request: SerializedKafkaMessage = {
      ...record,
      headers: { ...headers },
      value: this.encode(record.value),
    };
    if (record.key !== null && record.key !== undefined) {
      request.key = this.encode(record.key);
    }
    return request;
  }

  encode(value: unknown): EncodedKafkaValue {
    const isObjectOrArray =
      value !== null &&
      value !== undefined &&
      typeof value !== "string" &&
      !Buffer.isBuffer(value) &&
      !(value instanceof Uint8Array);

    if (isObjectOrArray) {
      return isPlainObject(value) ||
        Array.isArray(value) ||
        (value as { toString?: unknown }).toString === Object.prototype.toString
        ? JSON.stringify(value)
        : String(value);
    }
    if (value === undefined) {
      return null;
    }
    return value;
  }
}

/**
 * Unwraps `RmqRecord` instances from outgoing request/reply packets into
 * `{ ...packet, data/response, options }` without mutating the source record.
 */
export class RmqRecordSerializer implements Serializer {
  serialize(packet: unknown): unknown {
    if (packet === null || packet === undefined || typeof packet !== "object") {
      return packet;
    }
    const rec = packet as Record<string, unknown>;
    if (rec.data instanceof RmqRecord) {
      return {
        ...rec,
        data: rec.data.data,
        ...(rec.data.options !== undefined ? { options: rec.data.options } : {}),
      };
    }
    if (rec.response instanceof RmqRecord) {
      return {
        ...rec,
        response: rec.response.data,
        ...(rec.response.options !== undefined
          ? { options: rec.response.options }
          : {}),
      };
    }
    return packet;
  }
}

/**
 * Unwraps `NatsRecord` instances from outgoing request/reply packets into
 * `{ headers, data: JSON.stringify(unwrappedPacket) }`.
 */
export class NatsRecordSerializer implements Serializer<
  unknown,
  { headers: unknown; data: string }
> {
  serialize(packet: unknown): { headers: unknown; data: string } {
    if (packet === undefined) {
      return { headers: undefined, data: JSON.stringify({}) };
    }
    if (packet === null) {
      return { headers: undefined, data: JSON.stringify({ data: undefined }) };
    }
    if (typeof packet === "object") {
      const rec = packet as Record<string, unknown>;
      if (rec.data instanceof NatsRecord) {
        return {
          headers: rec.data.headers,
          data: JSON.stringify({ ...rec, data: rec.data.data }),
        };
      }
      if (rec.response instanceof NatsRecord) {
        return {
          headers: rec.response.headers,
          data: JSON.stringify({ ...rec, response: rec.response.data }),
        };
      }
    }
    return { headers: undefined, data: JSON.stringify(packet) };
  }
}

/**
 * Unwraps `MqttRecord` instances from outgoing request/reply packets and
 * serializes the resulting packet as JSON.
 */
export class MqttRecordSerializer implements Serializer {
  serialize(packet: unknown): unknown {
    if (packet === undefined) {
      return undefined;
    }
    if (packet === null) {
      return "null";
    }
    if (typeof packet === "object") {
      const rec = packet as Record<string, unknown>;
      if (rec.data instanceof MqttRecord) {
        return JSON.stringify({ ...rec, data: rec.data.data });
      }
      if (rec.response instanceof MqttRecord) {
        return JSON.stringify({ ...rec, response: rec.response.data });
      }
    }
    return JSON.stringify(packet);
  }
}
