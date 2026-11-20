import type { Serializer } from "./packets";

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

/**
 * Pass-through serializer returning outgoing values unchanged.
 */
export class IdentitySerializer implements Serializer {
  serialize(value: any): any {
    return value;
  }
}

/**
 * Serializes outgoing Kafka payloads into `{ key?, value, headers, partition?, timestamp? }`
 * records compatible with KafkaJS / `KafkaProducerRecord`.
 */
export class KafkaRequestSerializer implements Serializer<any, any> {
  serialize(value: any): any {
    const isNotKafkaMessage =
      value === null ||
      value === undefined ||
      typeof value !== "object" ||
      (!("key" in value) && !("value" in value)) ||
      Object.keys(value).some((field) => !KAFKA_MESSAGE_FIELDS.has(field));

    const record = isNotKafkaMessage ? { value } : value;
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

    const request = { ...record, headers: { ...headers } };
    request.value = this.encode(request.value);
    if (request.key !== null && request.key !== undefined) {
      request.key = this.encode(request.key);
    }
    return request;
  }

  encode(value: any): any {
    const isObjectOrArray =
      value !== null &&
      value !== undefined &&
      typeof value !== "string" &&
      !Buffer.isBuffer(value) &&
      !(value instanceof Uint8Array);

    if (isObjectOrArray) {
      return isPlainObject(value) ||
        Array.isArray(value) ||
        value.toString === Object.prototype.toString
        ? JSON.stringify(value)
        : String(value);
    }
    if (value === undefined) {
      return null;
    }
    return value;
  }
}
