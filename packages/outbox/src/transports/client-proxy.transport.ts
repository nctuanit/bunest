import {
  Inject,
  Injectable,
  type InjectionToken,
  type Type,
} from "@bunest/common";
import type { Subscribable } from "@bunest/core";
import type {
  ClientProxyTransportOptions,
  EventEmittingClient,
  OutboxEnvelope,
} from "../interfaces/client-proxy-transport.interface";
import type {
  OutboxHeaders,
  OutboxMessage,
} from "../interfaces/outbox-message.interface";
import { OutboxTransport } from "./outbox.transport";

/**
 * A transport that publishes through the `ClientProxy` registered under `client` (the
 * `name` you gave `ClientsModule`), with `emit()`. Bunest instantiates it inside
 * `OutboxModule`, so the client must be visible there: import its `ClientsModule` in
 * `imports`, or register it with `isGlobal`.
 *
 * Supports both zero-RxJS Promise-returning `ClientProxy.emit()` and `Subscribable<unknown>`
 * (ADR-008).
 */
export function ClientProxyTransport(
  client: InjectionToken,
  options: ClientProxyTransportOptions = {},
): Type<OutboxTransport> {
  @Injectable()
  class ClientProxyTransportHost extends OutboxTransport {
    private readonly toPacket: NonNullable<
      ClientProxyTransportOptions["toPacket"]
    >;

    constructor(
      @Inject(client) private readonly clientInstance: EventEmittingClient,
    ) {
      super();
      this.toPacket =
        options.toPacket ??
        (isKafkaClient(clientInstance) ? toKafkaRecord : envelopePacket);
    }

    async publish(message: OutboxMessage): Promise<void> {
      // A plain call, not a method call: a user's toPacket must not see the transport as `this`.
      const { toPacket } = this;
      const { pattern, data } = toPacket(message, toEnvelope(message));
      await settleEmit(this.clientInstance.emit(pattern, data));
    }
  }

  Object.defineProperty(ClientProxyTransportHost, "name", {
    value: `ClientProxyTransport(${describeToken(client)})`,
  });
  return ClientProxyTransportHost;
}

function settleEmit(
  result: Subscribable<unknown> | Promise<unknown> | unknown,
): Promise<unknown> {
  if (
    result !== null &&
    typeof result === "object" &&
    typeof (result as Subscribable<unknown>).subscribe === "function"
  ) {
    return new Promise<unknown>((resolve, reject) => {
      let last: unknown;
      (result as Subscribable<unknown>).subscribe({
        next: (value) => {
          last = value;
        },
        error: (error) => reject(error),
        complete: () => resolve(last),
      });
    });
  }
  return Promise.resolve(result);
}

function envelopePacket(
  message: OutboxMessage,
  envelope: OutboxEnvelope,
): { pattern: string; data: OutboxEnvelope } {
  return { pattern: message.topic, data: envelope };
}

/**
 * The default `toPacket` through a `ClientKafka`: a Kafka record under the message's key
 * and headers, with the envelope as its value.
 */
export function toKafkaRecord(
  message: OutboxMessage,
  envelope: OutboxEnvelope,
): {
  pattern: string;
  data: {
    key: string | null;
    value: OutboxEnvelope;
    headers: OutboxHeaders;
  };
} {
  return {
    pattern: message.topic,
    data: { key: message.key, value: envelope, headers: message.headers },
  };
}

/**
 * `ClientKafka`, recognized by a method of `ClientKafkaProxy` that no other client has.
 * Structural, so the package has no runtime dependency on `@bunest/microservices`.
 */
function isKafkaClient(client: unknown): boolean {
  return (
    client !== null &&
    typeof client === "object" &&
    "subscribeToResponseOf" in client &&
    typeof (client as { subscribeToResponseOf?: unknown })
      .subscribeToResponseOf === "function"
  );
}

function toEnvelope(message: OutboxMessage): OutboxEnvelope {
  return {
    id: message.id,
    topic: message.topic,
    key: message.key,
    headers: message.headers,
    createdAt: message.createdAt,
    payload: message.payload,
  };
}

function describeToken(token: InjectionToken): string {
  if (typeof token === "function") {
    return token.name;
  }
  if (typeof token === "symbol") {
    return token.description ?? token.toString();
  }
  return String(token);
}
