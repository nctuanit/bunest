import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  Logger,
  type LoggerService,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@bunest/common";
import { NonRetryableMessageError } from "../errors/non-retryable-message.error";
import { OutboxPublishTimeoutError } from "../errors/outbox-publish-timeout.error";
import type { OutboxEvent } from "../events/outbox-events.interface";
import { OutboxEvents } from "../events/outbox-events.service";
import type { OutboxMessage } from "../interfaces/outbox-message.interface";
import type {
  OutboxRelayConfig,
  OutboxRelayRunResult,
  OutboxStats,
} from "../interfaces/outbox-relay.interface";
import type { OutboxStore } from "../interfaces/outbox-store.interface";
import { LOCAL_TRANSPORT } from "../outbox.constants";
import type { OutboxTransport } from "../transports/outbox.transport";
import {
  computeBackoff,
  describeValue,
  optionMs,
  type ResolvedRetry,
  resolveRetry,
} from "../utils/backoff.util";
import { describeError } from "../utils/describe-error.util";
import type { Duration } from "../utils/duration.util";

type DeliveryOutcome = "published" | "retried" | "dead-lettered" | "lost";

/**
 * Claims due messages with a lease, publishes them, and records the outcome.
 */
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly getStore: () => OutboxStore<any>;
  private readonly transports: Record<string, OutboxTransport>;
  private readonly route: (message: OutboxMessage) => string;
  private readonly logger: LoggerService;
  private readonly events: OutboxEvents;
  private readonly enabled: boolean;
  private readonly pollInterval: number;
  private readonly batchSize: number;
  private readonly lease: number;
  private readonly concurrency: number;
  private readonly publishTimeout: number;
  private readonly retry: ResolvedRetry;
  private started = false;
  private stopping = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private loop: Promise<void> | undefined;
  private again = false;
  private readonly runs = new Set<Promise<OutboxRelayRunResult>>();
  private inFlight = 0;
  private inRelayContext: <R>(fn: () => R) => R = (fn) => fn();

  constructor(config: OutboxRelayConfig) {
    const { store } = config;
    this.getStore = typeof store === "function" ? store : () => store;
    this.transports = config.transports;
    const fallback =
      Object.keys(config.transports).find((name) => name !== LOCAL_TRANSPORT) ??
      LOCAL_TRANSPORT;
    if (config.route !== undefined && typeof config.route !== "function") {
      throw new TypeError(
        `OutboxModule: route must be a function (got ${describeValue(config.route)})`,
      );
    }
    this.route = config.route ?? (() => fallback);
    this.logger = config.logger ?? new Logger(OutboxRelay.name);
    this.events = config.events ?? new OutboxEvents();

    const relay = config.relay ?? {};
    if (relay.enabled !== undefined && typeof relay.enabled !== "boolean") {
      throw new TypeError(
        `OutboxModule: relay.enabled must be a boolean (got ${describeValue(relay.enabled)})`,
      );
    }
    this.enabled = relay.enabled ?? true;
    this.pollInterval = positiveMs(
      relay.pollInterval ?? 1_000,
      "relay.pollInterval",
    );
    this.batchSize = wholeNumber(relay.batchSize ?? 100, "relay.batchSize");
    this.lease = positiveMs(relay.lease ?? 30_000, "relay.lease");
    this.concurrency = wholeNumber(
      relay.concurrency ?? 10,
      "relay.concurrency",
    );
    this.publishTimeout =
      relay.publishTimeout === undefined
        ? Math.max(1, Math.floor(this.lease / 3))
        : positiveMs(relay.publishTimeout, "relay.publishTimeout");
    if (this.publishTimeout >= this.lease) {
      throw new Error(
        "OutboxModule: relay.publishTimeout must be shorter than relay.lease",
      );
    }
    this.retry = resolveRetry(config.retry);
  }

  onApplicationBootstrap(): void {
    if (this.enabled) {
      this.start();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  get running(): boolean {
    return this.started && !this.stopping;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.stopping = false;
    this.inRelayContext = AsyncLocalStorage.snapshot() as <R>(fn: () => R) => R;
    this.schedule(0);
  }

  /** Poll now instead of waiting for the next tick. Call it after your transaction commits. */
  notify(): void {
    if (!this.running) {
      return;
    }
    if (this.loop) {
      this.again = true;
      return;
    }
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.loop;
    await Promise.allSettled(this.runs);
    this.started = false;
  }

  async stats(): Promise<OutboxStats> {
    const now = Date.now();
    const stats = await this.store.stats(now);
    return {
      ...stats,
      lagMs:
        stats.oldestDueAt === null ? 0 : Math.max(0, now - stats.oldestDueAt),
      inFlight: this.inFlight,
    };
  }

  runOnce(): Promise<OutboxRelayRunResult> {
    const run = this.claimAndProcess();
    this.runs.add(run);
    const forget = () => {
      this.runs.delete(run);
    };
    run.then(forget, forget);
    return run;
  }

  private get store(): OutboxStore<any> {
    return this.getStore();
  }

  private schedule(delay: number): void {
    if (!this.running) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.inRelayContext(() => this.poll()),
      delay,
    );
  }

  private poll(): void {
    this.timer = undefined;
    if (this.loop) {
      this.again = true;
      return;
    }
    this.loop = (async () => {
      do {
        this.again = false;
        const result = await this.runOnce();
        if (result.claimed >= this.batchSize) {
          this.again = true;
        }
      } while (this.again && this.running);
    })()
      .catch((error) =>
        this.logger.error(`Relay loop failed: ${describeError(error)}`),
      )
      .finally(() => {
        this.loop = undefined;
        this.schedule(this.pollInterval);
      });
  }

  private async claimAndProcess(): Promise<OutboxRelayRunResult> {
    const result: OutboxRelayRunResult = {
      claimed: 0,
      published: 0,
      retried: 0,
      deadLettered: 0,
      released: 0,
      leaseLost: 0,
    };
    if (this.stopping) {
      return result;
    }
    const owner = randomUUID();
    const claimedAt = Date.now();
    let messages: OutboxMessage[];
    try {
      messages = await this.store.claim({
        owner,
        now: claimedAt,
        leaseMs: this.lease,
        limit: this.batchSize,
      });
    } catch (error) {
      this.storeError("claim", error);
      return result;
    }
    if (messages.length === 0) {
      return result;
    }
    result.claimed = messages.length;
    const leaseUntil = claimedAt + this.lease;
    const groups = groupByKey(messages);
    await runPool(groups, this.concurrency, async (group) => {
      try {
        await this.processGroup(group, owner, leaseUntil, result);
      } catch (error) {
        this.logger.error(
          `Relay failed on ${group[0]!.topic} ${group[0]!.id}: ${describeError(error)}`,
        );
      }
    });
    return result;
  }

  private async processGroup(
    group: OutboxMessage[],
    owner: string,
    leaseUntil: number,
    result: OutboxRelayRunResult,
  ): Promise<void> {
    for (let i = 0; i < group.length; i++) {
      if (this.stopping) {
        return this.release(group.slice(i), owner, result);
      }
      if (Date.now() + this.publishTimeout > leaseUntil) {
        return this.release(group.slice(i), owner, result);
      }
      const outcome = await this.deliver(group[i]!, owner);
      switch (outcome) {
        case "published":
          result.published++;
          break;
        case "dead-lettered":
          result.deadLettered++;
          break;
        case "retried":
          result.retried++;
          return this.release(group.slice(i + 1), owner, result);
        case "lost":
          result.leaseLost++;
          return this.release(group.slice(i + 1), owner, result);
      }
    }
  }

  private async deliver(
    message: OutboxMessage,
    owner: string,
  ): Promise<DeliveryOutcome> {
    const startedAt = Date.now();
    let transportName: string | undefined;
    this.inFlight++;
    try {
      transportName = this.route(message);
      const transport = this.transports[transportName];
      if (!transport) {
        throw new NonRetryableMessageError(
          `No outbox transport named "${transportName}"`,
        );
      }
      await publishWithin(transport, message, this.publishTimeout);
    } catch (error) {
      this.inFlight--;
      return this.fail(message, owner, error, transportName);
    }
    this.inFlight--;
    let marked: boolean;
    try {
      marked = await this.store.markPublished(message.id, owner);
    } catch (error) {
      this.storeError("markPublished", error);
      return "lost";
    }
    if (!marked) {
      return this.leaseLost(message);
    }
    this.emit({
      type: "published",
      message,
      transport: transportName,
      durationMs: Date.now() - startedAt,
    });
    return "published";
  }

  private async fail(
    message: OutboxMessage,
    owner: string,
    error: unknown,
    transport: string | undefined,
  ): Promise<DeliveryOutcome> {
    const now = Date.now();
    const attempt = message.attempts + 1;
    const record = {
      attempt,
      at: now,
      error: describeError(error),
      transport,
    };
    const retryable =
      !(error instanceof NonRetryableMessageError) &&
      this.retryIf(error, attempt, message);
    try {
      if (!retryable || attempt >= this.retry.attempts) {
        const reason = retryable ? "exhausted" : "rejected";
        const moved = await this.store.deadLetter(message.id, owner, {
          attempts: attempt,
          reason,
          failedAt: now,
          error: record,
        });
        if (!moved) {
          return this.leaseLost(message);
        }
        this.logger.warn(
          `Dead-lettered ${message.topic} ${message.id} after ${attempt} attempt(s) (${reason}): ${record.error}`,
        );
        this.emit({
          type: "dead-lettered",
          message,
          transport,
          error,
          attempt,
          reason,
        });
        return "dead-lettered";
      }
      const delayMs = this.backoff(attempt, error, message);
      const rescheduled = await this.store.reschedule(message.id, owner, {
        attempts: attempt,
        availableAt: now + delayMs,
        error: record,
      });
      if (!rescheduled) {
        return this.leaseLost(message);
      }
      this.logger.warn(
        `Retrying ${message.topic} ${message.id} in ${delayMs}ms ` +
          `(attempt ${attempt} of ${this.retry.attempts} failed): ${record.error}`,
      );
      this.emit({
        type: "retry-scheduled",
        message,
        transport,
        error,
        attempt,
        delayMs,
      });
      return "retried";
    } catch (storeError) {
      this.storeError("fail", storeError);
      return "lost";
    }
  }

  private retryIf(
    error: unknown,
    attempt: number,
    message: OutboxMessage,
  ): boolean {
    if (!this.retry.retryIf) {
      return true;
    }
    try {
      return this.retry.retryIf(error, attempt, message);
    } catch (predicateError) {
      this.logger.error(
        `retry.retryIf threw, retrying: ${describeError(predicateError)}`,
      );
      return true;
    }
  }

  private backoff(
    attempt: number,
    error: unknown,
    message: OutboxMessage,
  ): number {
    try {
      return computeBackoff(this.retry.backoff, attempt, error, message);
    } catch (backoffError) {
      this.logger.error(
        `retry.backoff failed, using the default: ${describeError(backoffError)}`,
      );
      return computeBackoff(
        resolveRetry(undefined).backoff,
        attempt,
        error,
        message,
      );
    }
  }

  private async release(
    messages: OutboxMessage[],
    owner: string,
    result: OutboxRelayRunResult,
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    try {
      result.released += await this.store.release(
        messages.map((m) => m.id),
        owner,
      );
    } catch (error) {
      this.storeError("release", error);
    }
  }

  private leaseLost(message: OutboxMessage): "lost" {
    this.logger.warn(
      `Lease on ${message.topic} ${message.id} was taken over; it may be published more than once`,
    );
    this.emit({ type: "lease-lost", message });
    return "lost";
  }

  private storeError(operation: string, error: unknown): void {
    this.logger.error(
      `Outbox store ${operation} failed: ${describeError(error)}`,
    );
  }

  private emit(event: OutboxEvent): void {
    try {
      this.events.emit(event);
    } catch (error) {
      this.logger.error(
        `Outbox event subscriber threw: ${describeError(error)}`,
      );
    }
  }
}

/** Keyed messages grouped per key (in claim order); keyless messages are groups of one. */
export function groupByKey(messages: OutboxMessage[]): OutboxMessage[][] {
  const groups: OutboxMessage[][] = [];
  const byKey = new Map<string, OutboxMessage[]>();
  for (const message of messages) {
    if (message.key === null) {
      groups.push([message]);
      continue;
    }
    let group = byKey.get(message.key);
    if (!group) {
      group = [];
      byKey.set(message.key, group);
      groups.push(group);
    }
    group.push(message);
  }
  return groups;
}

async function runPool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      await fn(items[next++]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

async function publishWithin(
  transport: OutboxTransport,
  message: OutboxMessage,
  ms: number,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() =>
        transport.publish(message, { signal: controller.signal }),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(abortOnTimeout, ms, controller, reject, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function abortOnTimeout(
  controller: AbortController,
  reject: (reason?: unknown) => void,
  ms: number,
): void {
  const error = new OutboxPublishTimeoutError(ms);
  controller.abort(error);
  reject(error);
}

function positiveMs(value: Duration, option: string): number {
  const ms = optionMs(value, option);
  if (ms <= 0) {
    throw new TypeError(
      `OutboxModule: ${option} must be longer than 0 (got ${String(value)})`,
    );
  }
  return ms;
}

function wholeNumber(value: number, option: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(
      `OutboxModule: ${option} must be a whole number of at least 1 (got ${value})`,
    );
  }
  return value;
}
