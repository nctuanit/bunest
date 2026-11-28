import { KafkaHeaders } from "./enums";
import type {
  ConsumerDeserializer,
  Deserializer,
  IncomingEvent,
  IncomingRequest,
  IncomingResponse,
  ProducerDeserializer,
} from "./packets";

const ENVELOPE_KEYS = new Set([
  "id",
  "err",
  "response",
  "isDisposed",
  "status",
]);

/**
 * Pass-through deserializer returning incoming values unchanged.
 */
export class IdentityDeserializer implements Deserializer {
  deserialize<T = unknown>(value: T): T {
    return value;
  }
}

/**
 * Deserializes incoming request/event envelopes, wrapping external messages
 * without `{ pattern, data }` into `{ pattern: options.channel, data }`.
 */
export class IncomingRequestDeserializer implements ConsumerDeserializer {
  deserialize(
    value: unknown,
    options?: Record<string, unknown>,
  ): IncomingRequest | IncomingEvent {
    return this.isExternal(value)
      ? this.mapToSchema(value, options)
      : (value as IncomingRequest | IncomingEvent);
  }

  isExternal(value: unknown): boolean {
    if (!value || typeof value !== "object") {
      return true;
    }
    const record = value as Record<string, unknown>;
    if (record.pattern !== undefined || record.data !== undefined) {
      return false;
    }
    return true;
  }

  mapToSchema(
    value: unknown,
    options?: Record<string, unknown>,
  ): IncomingRequest | IncomingEvent {
    if (!options) {
      return {
        pattern: undefined,
        data: undefined,
      };
    }
    return {
      pattern: options.channel,
      data: value,
    };
  }
}

/**
 * Deserializes incoming response packets, wrapping external payloads into
 * `{ id, response, isDisposed: true }`.
 */
export class IncomingResponseDeserializer implements ProducerDeserializer {
  deserialize(
    value: unknown,
    _options?: Record<string, unknown>,
  ): IncomingResponse {
    return this.isExternal(value)
      ? this.mapToSchema(value)
      : (value as IncomingResponse);
  }

  isExternal(value: unknown): boolean {
    if (!value || typeof value !== "object") {
      return true;
    }
    const keys = Object.keys(value);
    if (keys.length === 0) {
      return true;
    }
    return keys.some((key) => !ENVELOPE_KEYS.has(key));
  }

  mapToSchema(value: unknown): IncomingResponse {
    let id: string | undefined;
    if (value && typeof value === "object") {
      id = (value as { id?: string }).id;
    } else if (!value) {
      id = value as string;
    }
    return {
      id: id as string,
      response: value,
      isDisposed: true,
    };
  }
}

/**
 * Deserializes Kafka consumer messages into NestJS `IncomingRequest` / `IncomingEvent`.
 */
export class KafkaRequestDeserializer extends IncomingRequestDeserializer {
  override mapToSchema(
    data: unknown,
    options?: Record<string, unknown>,
  ): IncomingRequest | IncomingEvent {
    if (!options) {
      return {
        pattern: undefined,
        data: undefined,
      };
    }
    const rawValue =
      data !== null && typeof data === "object" && "value" in data
        ? (data as { value?: unknown }).value
        : undefined;
    return {
      pattern: options.channel,
      data: rawValue !== undefined ? rawValue : data,
    };
  }
}

/**
 * Deserializes Kafka reply messages using `KafkaHeaders` correlation/error/disposed headers.
 */
export class KafkaResponseDeserializer implements Deserializer<
  unknown,
  IncomingResponse
> {
  deserialize(
    message: unknown,
    _options?: Record<string, unknown>,
  ): IncomingResponse {
    const msg =
      message !== null && typeof message === "object"
        ? (message as { headers?: Record<string, unknown>; value?: unknown })
        : undefined;
    const headers = msg?.headers ?? {};
    const rawId = headers[KafkaHeaders.CORRELATION_ID];
    const id = rawId !== undefined && rawId !== null ? String(rawId) : "";

    if (headers[KafkaHeaders.NEST_ERR] !== undefined) {
      return {
        id,
        err: headers[KafkaHeaders.NEST_ERR],
        isDisposed: true,
      };
    }

    if (headers[KafkaHeaders.NEST_IS_DISPOSED] !== undefined) {
      if (headers[KafkaHeaders.NEST_NO_RESPONSE] !== undefined) {
        return { id, isDisposed: true };
      }
      return {
        id,
        response: msg?.value,
        isDisposed: true,
      };
    }

    return {
      id,
      response: msg?.value,
      isDisposed: false,
    };
  }
}

const sharedResponseDeserializer = new IncomingResponseDeserializer();

function isNatsReplyPacket(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const packet = value as Record<string, unknown>;
  return (
    !sharedResponseDeserializer.isExternal(value) &&
    packet.id !== undefined &&
    (packet.response !== undefined ||
      packet.err !== undefined ||
      packet.isDisposed !== undefined)
  );
}

/**
 * Deserializes JSON-encoded NATS request messages (`msg.json()`).
 */
export class NatsRequestJSONDeserializer extends IncomingRequestDeserializer {
  override deserialize(
    value: unknown,
    options?: Record<string, unknown>,
  ): IncomingRequest | IncomingEvent {
    const hasJson =
      value !== null &&
      typeof value === "object" &&
      "json" in value &&
      typeof (value as { json?: unknown }).json === "function";
    const decodedRequest = hasJson
      ? (value as { json: () => unknown }).json()
      : value;
    return super.deserialize(decodedRequest, options);
  }

  override isExternal(value: unknown): boolean {
    return super.isExternal(value) && !isNatsReplyPacket(value);
  }
}

/**
 * Deserializes JSON-encoded NATS response messages (`msg.json()`).
 */
export class NatsResponseJSONDeserializer extends IncomingResponseDeserializer {
  override deserialize(
    value: unknown,
    options?: Record<string, unknown>,
  ): IncomingResponse {
    const hasJson =
      value !== null &&
      typeof value === "object" &&
      "json" in value &&
      typeof (value as { json?: unknown }).json === "function";
    const decodedResponse = hasJson
      ? (value as { json: () => unknown }).json()
      : value;
    return super.deserialize(decodedResponse, options);
  }
}
