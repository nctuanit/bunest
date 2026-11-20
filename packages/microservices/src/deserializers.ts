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
  deserialize(value: any): any {
    return value;
  }
}

/**
 * Deserializes incoming request/event envelopes, wrapping external messages
 * without `{ pattern, data }` into `{ pattern: options.channel, data }`.
 */
export class IncomingRequestDeserializer implements ConsumerDeserializer {
  deserialize(
    value: any,
    options?: Record<string, any>,
  ): IncomingRequest | IncomingEvent {
    return this.isExternal(value) ? this.mapToSchema(value, options) : value;
  }

  isExternal(value: any): boolean {
    if (!value) {
      return true;
    }
    if (value.pattern !== undefined || value.data !== undefined) {
      return false;
    }
    return true;
  }

  mapToSchema(
    value: any,
    options?: Record<string, any>,
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
  deserialize(value: any, _options?: Record<string, any>): IncomingResponse {
    return this.isExternal(value) ? this.mapToSchema(value) : value;
  }

  isExternal(value: any): boolean {
    if (!value || typeof value !== "object") {
      return true;
    }
    const keys = Object.keys(value);
    if (keys.length === 0) {
      return true;
    }
    return keys.some((key) => !ENVELOPE_KEYS.has(key));
  }

  mapToSchema(value: any): IncomingResponse {
    return {
      id: value && value.id,
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
    data: any,
    options?: Record<string, any>,
  ): IncomingRequest | IncomingEvent {
    if (!options) {
      return {
        pattern: undefined,
        data: undefined,
      };
    }
    return {
      pattern: options.channel,
      data: data?.value !== undefined ? data.value : data,
    };
  }
}

/**
 * Deserializes Kafka reply messages using `KafkaHeaders` correlation/error/disposed headers.
 */
export class KafkaResponseDeserializer
  implements Deserializer<any, IncomingResponse>
{
  deserialize(message: any, _options?: Record<string, any>): IncomingResponse {
    const headers = message?.headers ?? {};
    const rawId = headers[KafkaHeaders.CORRELATION_ID];
    const id = rawId !== undefined && rawId !== null ? rawId.toString() : "";

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
        response: message.value,
        isDisposed: true,
      };
    }

    return {
      id,
      response: message.value,
      isDisposed: false,
    };
  }
}

const sharedResponseDeserializer = new IncomingResponseDeserializer();

function isNatsReplyPacket(value: any): boolean {
  return (
    !sharedResponseDeserializer.isExternal(value) &&
    value?.id !== undefined &&
    (value.response !== undefined ||
      value.err !== undefined ||
      value.isDisposed !== undefined)
  );
}

/**
 * Deserializes JSON-encoded NATS request messages (`msg.json()`).
 */
export class NatsRequestJSONDeserializer extends IncomingRequestDeserializer {
  override deserialize(
    value: any,
    options?: Record<string, any>,
  ): IncomingRequest | IncomingEvent {
    const decodedRequest =
      typeof value?.json === "function" ? value.json() : value;
    return super.deserialize(decodedRequest, options);
  }

  override isExternal(value: any): boolean {
    return super.isExternal(value) && !isNatsReplyPacket(value);
  }
}

/**
 * Deserializes JSON-encoded NATS response messages (`msg.json()`).
 */
export class NatsResponseJSONDeserializer extends IncomingResponseDeserializer {
  override deserialize(
    value: any,
    options?: Record<string, any>,
  ): IncomingResponse {
    const decodedResponse =
      typeof value?.json === "function" ? value.json() : value;
    return super.deserialize(decodedResponse, options);
  }
}
