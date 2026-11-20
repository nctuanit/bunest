import { ClientProxy } from "../client-proxy";
import { BaseRpcContext } from "../ctx-host";
import { MqttStatus } from "../enums";
import { RpcException, RpcTimeoutException } from "../exceptions";
import type {
  MessageHandler,
  MqttClientLike,
  MqttMessageListener,
  MqttPacketLike,
  MqttPublishOptions,
  MqttQoS,
  MqttTransportOptions,
  RpcContext,
  RpcEnvelope,
  RpcEventEnvelope,
  RpcRequestEnvelope,
  RpcResponseEnvelope,
} from "../interfaces";
import { toPacketMetadata, type PacketMetadata } from "../packets";
import { MicroserviceTransportServer } from "../server";
import { Transport } from "../tokens";

/**
 * Matches an MQTT topic name against an MQTT topic filter implementing the
 * MQTT 3.1.1 / 5.0 wildcard specification (Section 4.7):
 * - `+` matches exactly one topic level
 * - `#` matches zero or more remaining levels (must be the final level)
 * - Filters starting with `+` or `#` do NOT match `$`-prefixed system topics
 */
export function matchMqttTopic(filter: string, topic: string): boolean {
  if (!filter || !topic) {
    return false;
  }

  // MQTT spec 4.7.2: wildcards at root must not match $-prefixed system topics
  if (topic.startsWith("$") && (filter.startsWith("#") || filter.startsWith("+"))) {
    return false;
  }

  const filterLevels = filter.split("/");
  const topicLevels = topic.split("/");

  // Validate wildcard placement in filter
  for (let i = 0; i < filterLevels.length; i++) {
    const level = filterLevels[i]!;
    if (level.includes("#")) {
      if (level !== "#" || i !== filterLevels.length - 1) {
        return false;
      }
    }
    if (level.includes("+") && level !== "+") {
      return false;
    }
  }

  for (let i = 0; i < filterLevels.length; i++) {
    const fLevel = filterLevels[i]!;
    if (fLevel === "#") {
      return true;
    }
    if (i >= topicLevels.length) {
      return false;
    }
    const tLevel = topicLevels[i]!;
    if (fLevel !== "+" && fLevel !== tLevel) {
      return false;
    }
  }

  if (filterLevels.length === topicLevels.length) {
    return true;
  }

  // Parent-level `#` match: e.g. filter `sport/tennis/#` matches topic `sport/tennis`
  return (
    filterLevels.length === topicLevels.length + 1 &&
    filterLevels[filterLevels.length - 1] === "#"
  );
}

function mqttFilterSpecificity(filter: string): number {
  const levels = filter.split("/");
  let score = 0;
  for (const level of levels) {
    if (level === "#") {
      score += 1;
    } else if (level === "+") {
      score += 10;
    } else {
      score += 100;
    }
  }
  return score;
}

function decodeMqttMessage(raw: Uint8Array | Buffer | string): {
  envelope: RpcEnvelope | null;
  value: unknown;
} {
  const text =
    typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  try {
    const parsed = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === "object" &&
      "type" in parsed &&
      (parsed.type === "request" ||
        parsed.type === "response" ||
        parsed.type === "event")
    ) {
      return { envelope: parsed as RpcEnvelope, value: parsed };
    }
    return { envelope: null, value: parsed };
  } catch {
    return { envelope: null, value: text };
  }
}

function throwFromResponseError(
  error: NonNullable<RpcResponseEnvelope["error"]>,
): never {
  if (error.isRpcException) {
    throw RpcException.fromSerialized(error);
  }
  const err = new Error(error.message || "Remote MQTT RPC error");
  if (error.name) err.name = error.name;
  throw err;
}

export type MqttContextArgs = [string, MqttPacketLike];

export interface MqttContextParams {
  readonly pattern: string;
  readonly topic: string;
  readonly packet: MqttPacketLike;
}

/**
 * Execution context passed to `@Ctx()` in MQTT microservice handlers.
 * Supports both Bunest structured params and NestJS tuple `[topic, packet]` args.
 */
export class MqttContext
  extends BaseRpcContext<MqttContextArgs>
  implements RpcContext
{
  public readonly transport = Transport.MQTT;
  public readonly pattern: string;
  public readonly topic: string;
  public readonly packet: MqttPacketLike;
  public readonly qos: MqttQoS;
  public readonly retain: boolean;
  public readonly metadata: Readonly<Record<string, unknown>>;

  constructor(paramsOrArgs: MqttContextParams | MqttContextArgs) {
    if (Array.isArray(paramsOrArgs)) {
      const [topic, packet] = paramsOrArgs;
      super([topic, packet]);
      this.pattern = topic;
      this.topic = topic;
      this.packet = packet;
      this.qos = packet?.qos ?? 0;
      this.retain = packet?.retain ?? false;
      this.metadata = {
        topic,
        qos: this.qos,
        retain: this.retain,
        packet,
      };
      return;
    }

    super([paramsOrArgs.topic, paramsOrArgs.packet]);
    this.pattern = paramsOrArgs.pattern;
    this.topic = paramsOrArgs.topic;
    this.packet = paramsOrArgs.packet;
    this.qos = paramsOrArgs.packet.qos ?? 0;
    this.retain = paramsOrArgs.packet.retain ?? false;
    this.metadata = {
      topic: paramsOrArgs.topic,
      qos: this.qos,
      retain: this.retain,
      packet: paramsOrArgs.packet,
    };
  }

  getTopic(): string {
    return this.topic;
  }

  getPacket(): MqttPacketLike {
    return this.packet;
  }

  getQoS(): MqttQoS {
    return this.qos;
  }

  isRetained(): boolean {
    return this.retain;
  }

  /**
   * Returns MQTT 5 packet `userProperties` (single-string entries) as `PacketMetadata`.
   */
  getMetadata(): PacketMetadata | undefined {
    const userProperties = this.packet?.properties?.userProperties;
    if (
      userProperties &&
      typeof userProperties === "object" &&
      !Array.isArray(userProperties)
    ) {
      return toPacketMetadata(
        Object.entries(userProperties as Record<string, unknown>),
      );
    }
    return undefined;
  }
}

/**
 * First-class MQTT microservice server supporting full `+` single-level and
 * `#` multi-level wildcard routing, QoS options, per-client reply topics,
 * `MqttContext`, and graceful disconnect.
 */
export class MqttServer extends MicroserviceTransportServer {
  public readonly transport = Transport.MQTT;

  private readonly client: MqttClientLike;
  private readonly qos: MqttQoS;
  private readonly closeClientOnClose: boolean;
  private readonly subscribedTopics: string[] = [];
  private messageListener?: MqttMessageListener;

  constructor(options: MqttTransportOptions) {
    super();
    this.client = options.client;
    this.qos = options.qos ?? 0;
    this.closeClientOnClose = options.closeClientOnClose ?? false;
  }

  async listen(callback?: (...optionalParams: unknown[]) => any): Promise<void> {
    if (this.listening) {
      callback?.();
      return;
    }

    this.messageListener = (topic, payload, packet) => {
      void this.onMessage(topic, payload, packet);
    };
    this.client.on("message", this.messageListener);

    const patterns = new Set<string>([
      ...this.messageHandlers.keys(),
      ...this.eventHandlers.keys(),
    ]);

    for (const pattern of patterns) {
      this.subscribedTopics.push(pattern);
      await this.client.subscribe(pattern, { qos: this.qos });
    }

    this.listening = true;
    this.emitStatus(MqttStatus.CONNECTED);
    callback?.();
  }

  async close(): Promise<void> {
    this.listening = false;
    this.emitStatus(MqttStatus.CLOSED);
    if (this.messageListener) {
      if (typeof this.client.off === "function") {
        this.client.off("message", this.messageListener);
      } else if (typeof this.client.removeListener === "function") {
        this.client.removeListener("message", this.messageListener);
      }
      this.messageListener = undefined;
    }

    const topics = this.subscribedTopics.splice(0);
    for (const topic of topics) {
      await this.client.unsubscribe?.(topic);
    }

    if (this.closeClientOnClose) {
      if (typeof this.client.end === "function") {
        await this.client.end();
      } else if (typeof this.client.close === "function") {
        await this.client.close();
      }
    }
  }

  private findMessageHandler(
    topic: string,
  ): { filter: string; handler: MessageHandler } | undefined {
    const exact = this.messageHandlers.get(topic);
    if (exact) {
      return { filter: topic, handler: exact };
    }

    let best: { filter: string; handler: MessageHandler; score: number } | undefined;
    for (const [filter, handler] of this.messageHandlers.entries()) {
      if (matchMqttTopic(filter, topic)) {
        const score = mqttFilterSpecificity(filter);
        if (!best || score > best.score) {
          best = { filter, handler, score };
        }
      }
    }
    return best ? { filter: best.filter, handler: best.handler } : undefined;
  }

  private findEventHandlers(
    topic: string,
  ): Array<{ filter: string; handler: MessageHandler }> {
    const matches: Array<{ filter: string; handler: MessageHandler }> = [];
    for (const [filter, handlers] of this.eventHandlers.entries()) {
      if (filter === topic || matchMqttTopic(filter, topic)) {
        for (const handler of handlers) {
          matches.push({ filter, handler });
        }
      }
    }
    return matches;
  }

  private async onMessage(
    topic: string,
    payload: Uint8Array | Buffer | string,
    rawPacket?: MqttPacketLike,
  ): Promise<void> {
    const packet: MqttPacketLike = rawPacket ?? {
      topic,
      payload,
      qos: this.qos,
      retain: false,
    };

    const { envelope, value } = decodeMqttMessage(payload);

    if (envelope?.type === "response") {
      return;
    }

    if (envelope?.type === "request") {
      const matched = this.findMessageHandler(topic);
      const ctx = new MqttContext({
        pattern: matched?.filter ?? topic,
        topic,
        packet,
      });

      let outcome: { response?: unknown; error?: RpcResponseEnvelope["error"] };
      if (!matched) {
        outcome = {
          error: new RpcException({
            status: 404,
            message: `No MQTT @MessagePattern() handler found for topic "${topic}".`,
          }).toSerialized(),
        };
      } else {
        try {
          const response = await this.runWithProcessingHooks(ctx, async () =>
            matched.handler(envelope.data, ctx),
          );
          outcome = { response };
        } catch (err) {
          outcome = { error: this.serializeError(err) };
        }
      }

      if (envelope.replyTo) {
        const responseEnvelope: RpcResponseEnvelope = {
          type: "response",
          id: envelope.id,
          response: outcome.response,
          error: outcome.error,
          isDisposed: true,
        };
        await this.client.publish(
          envelope.replyTo,
          JSON.stringify(responseEnvelope),
          { qos: this.qos, retain: false },
        );
      }
      return;
    }

    const eventData = envelope?.type === "event" ? envelope.data : value;
    const matches = this.findEventHandlers(topic);
    const hasHooks =
      this.onProcessingStartHook !== undefined ||
      this.onProcessingEndHook !== undefined;
    for (const match of matches) {
      const ctx = new MqttContext({
        pattern: match.filter,
        topic,
        packet,
      });
      try {
        if (hasHooks) {
          await this.runWithProcessingHooks(ctx, async () => {
            await match.handler(eventData, ctx);
          });
        } else {
          await match.handler(eventData, ctx);
        }
      } catch {
        // Never allow event handler exceptions to disrupt MQTT listener
      }
    }
  }
}

/**
 * First-class MQTT client proxy using isolated per-client reply topics
 * (`${topic}/reply/${clientId}`), configurable QoS & retain options, and
 * clean graceful disconnect.
 */
export class MqttClientProxy extends ClientProxy {
  public readonly transport = Transport.MQTT;
  public readonly clientId: string;

  private readonly client: MqttClientLike;
  private readonly qos: MqttQoS;
  private readonly retain: boolean;
  private readonly closeClientOnClose: boolean;

  private listenerAttached = false;
  private messageListener?: MqttMessageListener;
  private readonly subscribedReplyTopics = new Set<string>();
  private readonly pendingSubscribes = new Map<string, Promise<void>>();
  private readonly pending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private seq = 0;

  constructor(options: MqttTransportOptions) {
    super(options.defaultTimeoutMs ?? 5000);
    this.client = options.client;
    this.qos = options.qos ?? 0;
    this.retain = options.retain ?? false;
    this.clientId = options.clientId ?? crypto.randomUUID().slice(0, 12);
    this.closeClientOnClose = options.closeClientOnClose ?? false;
  }

  getReplyTopic(topic: string): string {
    return `${topic}/reply/${this.clientId}`;
  }

  async connect(): Promise<void> {
    this.ensureListener();
  }

  async close(): Promise<void> {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new Error("MqttClientProxy closed."));
    }

    if (this.listenerAttached && this.messageListener) {
      if (typeof this.client.off === "function") {
        this.client.off("message", this.messageListener);
      } else if (typeof this.client.removeListener === "function") {
        this.client.removeListener("message", this.messageListener);
      }
      this.listenerAttached = false;
      this.messageListener = undefined;
    }

    for (const replyTopic of [...this.subscribedReplyTopics]) {
      await this.client.unsubscribe?.(replyTopic);
    }
    this.subscribedReplyTopics.clear();
    this.pendingSubscribes.clear();

    if (this.closeClientOnClose) {
      if (typeof this.client.end === "function") {
        await this.client.end();
      } else if (typeof this.client.close === "function") {
        await this.client.close();
      }
    }
  }

  /**
   * Publishes an event with explicit per-message QoS / retain options.
   */
  async emitWithOptions<TReq = any>(
    topic: string,
    data: TReq,
    options?: MqttPublishOptions,
  ): Promise<void> {
    const envelope: RpcEventEnvelope = {
      type: "event",
      pattern: topic,
      data,
    };
    await this.client.publish(topic, JSON.stringify(envelope), {
      qos: options?.qos ?? this.qos,
      retain: options?.retain ?? this.retain,
      dup: options?.dup,
      properties: options?.properties,
    });
  }

  private async ensureReplySubscribed(replyTopic: string): Promise<void> {
    if (this.subscribedReplyTopics.has(replyTopic)) {
      return;
    }
    const existing = this.pendingSubscribes.get(replyTopic);
    if (existing) {
      await existing;
      return;
    }
    const subPromise = Promise.resolve(
      this.client.subscribe(replyTopic, { qos: this.qos }),
    )
      .then(() => {
        this.subscribedReplyTopics.add(replyTopic);
      })
      .finally(() => {
        this.pendingSubscribes.delete(replyTopic);
      });
    this.pendingSubscribes.set(replyTopic, subPromise);
    await subPromise;
  }

  protected override async sendOnce<TRes = any, TReq = any>(
    pattern: string,
    data: TReq,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<TRes> {
    if (signal?.aborted) {
      throw new RpcTimeoutException(pattern, timeoutMs);
    }
    this.ensureListener();

    const replyTopic = this.getReplyTopic(pattern);
    await this.ensureReplySubscribed(replyTopic);
    if (signal?.aborted) {
      throw new RpcTimeoutException(pattern, timeoutMs);
    }

    const id = `mqtt_${++this.seq}_${crypto.randomUUID().slice(0, 8)}`;
    const req: RpcRequestEnvelope = {
      type: "request",
      id,
      pattern,
      data,
      replyTo: replyTopic,
    };

    return await new Promise<TRes>((resolve, reject) => {
      const onAbort = () => {
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          reject(new RpcTimeoutException(pattern, timeoutMs));
        }
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          cleanup();
          reject(new RpcTimeoutException(pattern, timeoutMs));
        }
      }, timeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }

      this.pending.set(id, {
        resolve: (v: unknown) => {
          cleanup();
          resolve(v as TRes);
        },
        reject: (e: unknown) => {
          cleanup();
          reject(e);
        },
        timer,
      });

      signal?.addEventListener("abort", onAbort, { once: true });

      Promise.resolve(
        this.client.publish(pattern, JSON.stringify(req), {
          qos: this.qos,
          retain: false,
        }),
      ).catch((err) => {
        clearTimeout(timer);
        cleanup();
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  protected override async dispatchEvent<TReq = any>(
    pattern: string,
    data: TReq,
  ): Promise<void> {
    await this.emitWithOptions(pattern, data);
  }

  private ensureListener(): void {
    if (this.listenerAttached) {
      return;
    }
    this.listenerAttached = true;
    this.messageListener = (topic, payload) => {
      if (!this.subscribedReplyTopics.has(topic)) {
        return;
      }
      const { envelope } = decodeMqttMessage(payload);
      if (!envelope || envelope.type !== "response") {
        return;
      }
      const entry = this.pending.get(envelope.id);
      if (!entry) {
        return;
      }
      clearTimeout(entry.timer);
      this.pending.delete(envelope.id);

      if (envelope.error) {
        try {
          throwFromResponseError(envelope.error);
        } catch (err) {
          entry.reject(err);
        }
      } else {
        entry.resolve(envelope.response);
      }
    };
    this.client.on("message", this.messageListener);
  }
}

export { MqttServer as ServerMqtt, MqttClientProxy as ClientMqtt };
