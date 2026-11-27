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
  WireFormat,
} from "../interfaces";
import {
  toPacketMetadata,
  type Deserializer,
  type PacketMetadata,
  type Serializer,
} from "../packets";
import { MqttRecord } from "../records";
import {
  decodeInboundMessage,
  decodeInboundResponse,
  encodeOutboundEvent,
  encodeOutboundRequest,
  encodeOutboundResponse,
  stringifyWirePayload,
} from "../serializers/wire-codec";
import { MicroserviceTransportServer } from "../server";
import { Transport } from "../tokens";

function assertValidMqttPublishTopic(topic: string): void {
  if (
    !topic ||
    topic.includes("+") ||
    topic.includes("#") ||
    topic.includes("\u0000")
  ) {
    throw new Error(
      `Invalid MQTT publish topic "${topic}": publish topics must not contain '+', '#', or null characters.`,
    );
  }
}

function stripMqttSharedPrefix(filter: string): string {
  if (!filter.startsWith("$share/")) {
    return filter;
  }
  const rest = filter.slice("$share/".length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx <= 0 || slashIdx === rest.length - 1) {
    return filter;
  }
  return rest.slice(slashIdx + 1);
}

/**
 * Matches an MQTT topic name against an MQTT topic filter implementing the
 * MQTT 3.1.1 / 5.0 wildcard specification (Section 4.7), including MQTT 5
 * shared subscription filters (`$share/<group>/<filter>`):
 * - `+` matches exactly one topic level
 * - `#` matches zero or more remaining levels (must be the final level)
 * - Filters starting with `+` or `#` do NOT match `$`-prefixed system topics
 */
export function matchMqttTopic(filter: string, topic: string): boolean {
  if (!filter || !topic) {
    return false;
  }

  const effectiveFilter = stripMqttSharedPrefix(filter);

  // MQTT spec 4.7.2: wildcards at root must not match $-prefixed system topics
  if (
    topic.startsWith("$") &&
    (effectiveFilter.startsWith("#") || effectiveFilter.startsWith("+"))
  ) {
    return false;
  }

  const filterLevels = effectiveFilter.split("/");
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
  readonly extraMetadata?: Readonly<Record<string, unknown>>;
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
      ...(paramsOrArgs.extraMetadata ?? {}),
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
    return toPacketMetadata(
      Object.entries(this.metadata).filter(
        ([k]) => k !== "topic" && k !== "qos" && k !== "retain" && k !== "packet",
      ),
    );
  }
}

/**
 * First-class MQTT microservice server supporting full `+` single-level and
 * `#` multi-level wildcard routing, QoS options, per-client reply topics,
 * `MqttContext`, and graceful disconnect.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
}

export class MqttServer extends MicroserviceTransportServer {
  public readonly transport = Transport.MQTT;

  private readonly client: MqttClientLike;
  private readonly qos: MqttQoS;
  private readonly closeClientOnClose: boolean;
  private readonly gracefulShutdown: boolean;
  private readonly gracePeriod: number;
  private readonly wireFormat: WireFormat;
  private readonly serializer?: Serializer;
  private readonly deserializer?: Deserializer;
  private readonly subscribedTopics: string[] = [];
  private messageListener?: MqttMessageListener;
  private closing = false;
  private inFlight = 0;
  private drainWaiters: Array<() => void> = [];

  constructor(options: MqttTransportOptions) {
    super();
    this.configureServerOptions(options);
    this.client = options.client;
    this.qos = options.qos ?? 0;
    this.closeClientOnClose = options.closeClientOnClose ?? false;
    this.gracefulShutdown = options.gracefulShutdown ?? false;
    this.gracePeriod = options.gracePeriod ?? 5000;
    this.wireFormat = options.wireFormat ?? "bunest";
    this.serializer = options.serializer;
    this.deserializer = options.deserializer;
  }

  override get server(): MqttClientLike {
    return this.client;
  }

  async listen(
    callback?: (...optionalParams: unknown[]) => any,
  ): Promise<void> {
    if (this.listening) {
      callback?.();
      return;
    }

    this.closing = false;
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
      const handler =
        this.messageHandlers.get(pattern) ??
        this.eventHandlers
          .get(pattern)
          ?.find((h) => h.extras?.qos !== undefined) ??
        this.eventHandlers.get(pattern)?.[0];
      const qos = (handler?.extras?.qos as MqttQoS | undefined) ?? this.qos;
      await this.client.subscribe(pattern, { qos });
    }

    this.listening = true;
    this.emitStatus(MqttStatus.CONNECTED);
    callback?.();
  }

  async close(): Promise<void> {
    this.listening = false;
    this.closing = true;
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
      try {
        await this.client.unsubscribe?.(topic);
      } catch {
        // Continue teardown even if broker is already disconnected
      }
    }

    if (this.gracefulShutdown && this.inFlight > 0) {
      await new Promise<void>((resolve) => {
        let settled = false;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;

        const finish = () => {
          if (settled) return;
          settled = true;
          if (graceTimer !== undefined) {
            clearTimeout(graceTimer);
            graceTimer = undefined;
          }
          resolve();
        };

        this.drainWaiters.push(() => {
          if (this.inFlight <= 0) {
            finish();
          }
        });

        if (
          Number.isFinite(this.gracePeriod) &&
          this.gracePeriod >= 0 &&
          this.gracePeriod <= MAX_TIMEOUT_MS
        ) {
          graceTimer = setTimeout(finish, this.gracePeriod);
          unrefTimer(graceTimer);
        }
      });
      this.drainWaiters = [];
    }

    if (this.closeClientOnClose || this.gracefulShutdown) {
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

    let best:
      { filter: string; handler: MessageHandler; score: number } | undefined;
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
    if (this.closing) return;
    this.inFlight++;
    try {
      const packet: MqttPacketLike = rawPacket ?? {
        topic,
        payload,
        qos: this.qos,
        retain: false,
      };

      const responseTopic =
        typeof packet.properties?.responseTopic === "string"
          ? packet.properties.responseTopic
          : undefined;
      const userProperties =
        packet.properties?.userProperties &&
        typeof packet.properties.userProperties === "object"
          ? (packet.properties.userProperties as Record<string, unknown>)
          : undefined;

      const decoded = await decodeInboundMessage({
        raw: payload,
        wireFormat: this.wireFormat,
        deserializer: this.deserializer,
        channel: topic,
        replyTo: responseTopic,
        headers: userProperties,
        allowNonJsonText: this.wireFormat === "bunest" && !this.deserializer,
        hasMessageHandler: (p) => this.findMessageHandler(p) !== undefined,
        hasEventHandler: (p) => this.findEventHandlers(p).length > 0,
      });

      if (!decoded || decoded.kind === "response") {
        return;
      }

      if (decoded.kind === "request") {
        const matched = this.findMessageHandler(decoded.pattern);
        const ctx = new MqttContext({
          pattern: matched?.filter ?? decoded.pattern,
          topic,
          packet,
          extraMetadata: decoded.metadata,
        });

        let outcome: { response?: unknown; error?: RpcResponseEnvelope["error"] };
        if (!matched) {
          outcome = {
            error: new RpcException({
              status: 404,
              message: `No MQTT @MessagePattern() handler found for topic "${decoded.pattern}".`,
            }).toSerialized(),
          };
        } else {
          try {
            const response = await this.executeWithServerContext(
              "request",
              matched.filter,
              ctx,
              () =>
                this.runWithProcessingHooks(ctx, async () => {
                  if (this.preRequestHook) {
                    await this.preRequestHook({
                      pattern: matched.filter,
                      data: decoded.data,
                      ctx,
                    });
                  }
                  return matched.handler(decoded.data, ctx);
                }),
            );
            outcome = { response };
          } catch (err) {
            outcome = { error: this.serializeError(err) };
          }
        }

        const replyTarget =
          decoded.replyTo ??
          (this.wireFormat === "raw-json" ? `${topic}/reply` : undefined);
        if (replyTarget) {
          const isRecord = outcome.response instanceof MqttRecord;
          const unwrappedResponse = isRecord
            ? (outcome.response as MqttRecord).data
            : outcome.response;
          const recordOpts = isRecord
            ? (outcome.response as MqttRecord).options
            : undefined;
          const encodedReply = await encodeOutboundResponse({
            id: decoded.id,
            pattern: decoded.pattern,
            response: unwrappedResponse,
            error: outcome.error,
            isDisposed: true,
            wireFormat: this.wireFormat,
            responseWireStyle: decoded.responseWireStyle,
            serializer: this.serializer,
          });
          const publishOpts: MqttPublishOptions = {
            qos: recordOpts?.qos ?? this.qos,
            retain: recordOpts?.retain ?? false,
            ...(recordOpts?.dup !== undefined ? { dup: recordOpts.dup } : {}),
            ...(recordOpts?.properties !== undefined
              ? { properties: recordOpts.properties }
              : {}),
          };
          await this.client.publish(
            replyTarget,
            stringifyWirePayload(encodedReply),
            publishOpts,
          );
        }
        return;
      }

      const matches = this.findEventHandlers(decoded.pattern);
      const hasHooks =
        this.onProcessingStartHook !== undefined ||
        this.onProcessingEndHook !== undefined;
      for (const match of matches) {
        const ctx = new MqttContext({
          pattern: match.filter,
          topic,
          packet,
          extraMetadata: decoded.metadata,
        });
        try {
          await this.executeWithServerContext(
            "event",
            match.filter,
            ctx,
            async () => {
              if (hasHooks) {
                await this.runWithProcessingHooks(ctx, async () => {
                  await match.handler(decoded.data, ctx);
                });
              } else {
                await match.handler(decoded.data, ctx);
              }
            },
          );
        } catch (err) {
          await this.invokeDeadLetterHandlerSafe(
            match.filter,
            decoded.data,
            ctx,
            err,
          );
          // Never allow event handler exceptions to disrupt MQTT listener
        }
      }
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
      if (this.inFlight === 0 && this.drainWaiters.length > 0) {
        const waiters = this.drainWaiters.splice(0);
        for (const fn of waiters) {
          fn();
        }
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
  private readonly wireFormat: WireFormat;
  private readonly serializer?: Serializer;
  private readonly deserializer?: Deserializer;

  private listenerAttached = false;
  private messageListener?: MqttMessageListener;
  private readonly subscribedReplyTopics = new Set<string>();
  private readonly pendingSubscribes = new Map<string, Promise<void>>();
  private readonly rawPendingByTopic = new Map<string, string[]>();
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
    super(options.requestTimeout ?? options.defaultTimeoutMs ?? 5000, {
      requestTimeout: options.requestTimeout,
      maxPendingRequests: options.maxPendingRequests,
      retry: options.retry,
      circuitBreaker: options.circuitBreaker,
      clsPropagation: options.clsPropagation,
      cls: options.cls,
    });
    this.client = options.client;
    this.qos = options.qos ?? 0;
    this.retain = options.retain ?? false;
    this.clientId = options.clientId ?? crypto.randomUUID().slice(0, 12);
    this.closeClientOnClose = options.closeClientOnClose ?? false;
    this.wireFormat = options.wireFormat ?? "bunest";
    this.serializer = options.serializer;
    this.deserializer = options.deserializer;
  }

  getReplyTopic(topic: string): string {
    return `${topic}/reply/${this.clientId}`;
  }

  async connect(): Promise<void> {
    this.ensureListener();
    this.emitStatus("connected");
  }

  async close(): Promise<void> {
    const closeErr = new Error("MqttClientProxy closed.");
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(closeErr);
    }
    this.rawPendingByTopic.clear();
    this.cancelActiveRequests(closeErr);

    this.emitStatus("disconnected");

    if (this.listenerAttached && this.messageListener) {
      if (typeof this.client.off === "function") {
        this.client.off("message", this.messageListener);
      } else if (typeof this.client.removeListener === "function") {
        this.client.removeListener("message", this.messageListener);
      }
      this.listenerAttached = false;
      this.messageListener = undefined;
    }

    const replyTopics = [...this.subscribedReplyTopics];
    this.subscribedReplyTopics.clear();
    this.pendingSubscribes.clear();

    try {
      for (const replyTopic of replyTopics) {
        await this.client.unsubscribe?.(replyTopic);
      }
    } finally {
      if (this.closeClientOnClose) {
        if (typeof this.client.end === "function") {
          await this.client.end();
        } else if (typeof this.client.close === "function") {
          await this.client.close();
        }
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
    if (this.preRequestHook) {
      await this.preRequestHook({
        pattern: topic,
        data,
        transport: this.transport,
      });
    }
    await this.publishEventInternal(topic, data, options);
  }

  private async publishEventInternal<TReq = any>(
    topic: string,
    data: TReq,
    options?: MqttPublishOptions,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    assertValidMqttPublishTopic(topic);
    const isRecord = data instanceof MqttRecord;
    const unwrappedData = isRecord ? data.data : data;
    const recordOpts = isRecord ? data.options : undefined;
    const encoded = await encodeOutboundEvent({
      pattern: topic,
      data: unwrappedData,
      metadata,
      wireFormat: this.wireFormat,
      serializer: this.serializer,
    });
    await this.client.publish(topic, stringifyWirePayload(encoded), {
      qos: options?.qos ?? recordOpts?.qos ?? this.qos,
      retain: options?.retain ?? recordOpts?.retain ?? this.retain,
      dup: options?.dup ?? recordOpts?.dup,
      properties: options?.properties ?? recordOpts?.properties,
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
    metadata?: Record<string, unknown>,
  ): Promise<TRes> {
    assertValidMqttPublishTopic(pattern);
    if (signal?.aborted) {
      throw new RpcTimeoutException(pattern, timeoutMs);
    }
    this.ensureListener();

    const replyTopic = this.getReplyTopic(pattern);
    const fallbackRawReplyTopic =
      this.wireFormat === "raw-json" ? `${pattern}/reply` : undefined;
    await this.ensureReplySubscribed(replyTopic);
    if (fallbackRawReplyTopic) {
      await this.ensureReplySubscribed(fallbackRawReplyTopic);
    }
    if (signal?.aborted) {
      throw new RpcTimeoutException(pattern, timeoutMs);
    }

    const isRecord = data instanceof MqttRecord;
    const unwrappedData = isRecord ? data.data : data;
    const recordOpts = isRecord ? data.options : undefined;

    const id = `mqtt_${++this.seq}_${crypto.randomUUID().slice(0, 8)}`;
    const encodedReq = await encodeOutboundRequest({
      id,
      pattern,
      data: unwrappedData,
      replyTo: replyTopic,
      metadata,
      wireFormat: this.wireFormat,
      serializer: this.serializer,
    });
    const payloadStr = stringifyWirePayload(encodedReq);

    const properties =
      this.wireFormat !== "bunest"
        ? {
            ...(recordOpts?.properties ?? {}),
            responseTopic: replyTopic,
          }
        : recordOpts?.properties;

    const publishOpts: MqttPublishOptions = {
      qos: recordOpts?.qos ?? this.qos,
      retain: recordOpts?.retain ?? false,
      ...(recordOpts?.dup !== undefined ? { dup: recordOpts.dup } : {}),
      ...(properties !== undefined ? { properties } : {}),
    };

    return await new Promise<TRes>((resolve, reject) => {
      const trackedRawTopics = fallbackRawReplyTopic
        ? [replyTopic, fallbackRawReplyTopic]
        : [];
      const removeFromRawQueues = () => {
        for (const t of trackedRawTopics) {
          const q = this.rawPendingByTopic.get(t);
          if (q) {
            const idx = q.indexOf(id);
            if (idx !== -1) q.splice(idx, 1);
          }
        }
      };
      const onAbort = () => {
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          removeFromRawQueues();
          reject(new RpcTimeoutException(pattern, timeoutMs));
        }
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        removeFromRawQueues();
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

      for (const t of trackedRawTopics) {
        let q = this.rawPendingByTopic.get(t);
        if (!q) {
          q = [];
          this.rawPendingByTopic.set(t, q);
        }
        q.push(id);
      }

      signal?.addEventListener("abort", onAbort, { once: true });

      Promise.resolve(
        this.client.publish(pattern, payloadStr, publishOpts),
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
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.publishEventInternal(pattern, data, undefined, metadata);
  }

  private resolvePendingMqttReply(
    topic: string,
    id: string | undefined,
    response: unknown,
    error: RpcResponseEnvelope["error"],
  ): void {
    let targetId = id;
    if (!targetId || !this.pending.has(targetId)) {
      const q = this.rawPendingByTopic.get(topic);
      while (q && q.length > 0) {
        const candidate = q.shift()!;
        if (this.pending.has(candidate)) {
          targetId = candidate;
          break;
        }
      }
    }
    if (!targetId) return;
    const entry = this.pending.get(targetId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(targetId);

    if (error) {
      try {
        throwFromResponseError(error);
      } catch (err) {
        entry.reject(err);
      }
    } else {
      entry.resolve(response);
    }
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
      if (this.wireFormat === "bunest" && !this.deserializer) {
        const { envelope } = decodeMqttMessage(payload);
        if (!envelope || envelope.type !== "response") {
          return;
        }
        this.resolvePendingMqttReply(
          topic,
          envelope.id,
          envelope.response,
          envelope.error,
        );
        return;
      }

      void decodeInboundResponse({
        raw: payload,
        wireFormat: this.wireFormat,
        deserializer: this.deserializer,
      }).then((decoded) => {
        if (!decoded) return;
        this.resolvePendingMqttReply(
          topic,
          decoded.id,
          decoded.response,
          decoded.error,
        );
      });
    };
    this.client.on("message", this.messageListener);
  }
}

export { MqttServer as ServerMqtt, MqttClientProxy as ClientMqtt };
