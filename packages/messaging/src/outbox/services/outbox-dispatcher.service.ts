import {
  DiscoveryService,
  Inject,
  Injectable,
  MetadataRegistry,
  MetadataScanner,
  MultiMap,
  type OnModuleInit,
  type Subscribable,
} from "@bunest/core";
import { NonRetryableMessageError } from "../errors/non-retryable-message.error";
import { OutboxNoHandlerError } from "../errors/outbox-no-handler.error";
import type {
  OutboxHandlerContext,
  OutboxHandlerMetadata,
} from "../interfaces/outbox-handler.interface";
import type { OutboxMessage } from "../interfaces/outbox-message.interface";
import type { OutboxModuleOptions } from "../interfaces/outbox-module-options.interface";
import type { OutboxStorageUsage } from "../interfaces/outbox-storage.interface";
import { LOCAL_TRANSPORT, OUTBOX_HANDLER_METADATA } from "../outbox.constants";
import {
  OUTBOX_MODULE_OPTIONS,
  OUTBOX_TRANSPORTS,
} from "../outbox.module-definition";
import { OutboxTransport } from "../transports/outbox.transport";
import { describeError } from "../utils/describe-error.util";
import { OutboxInbox } from "./outbox-inbox.service";

interface HandlerEntry {
  consumer: string;
  inbox: boolean;
  invoke: (payload: unknown, context: OutboxHandlerContext) => unknown;
}

const NEVER_ABORTED = new AbortController().signal;

/**
 * The in-process (`local`) transport: publishing a message runs every
 * `@OnOutboxMessage()` handler for its topic, each behind its own inbox entry.
 */
@Injectable()
export class OutboxDispatcher extends OutboxTransport implements OnModuleInit {
  private readonly handlers = new MultiMap<string, HandlerEntry>();
  private scanned = false;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly inbox: OutboxInbox,
    @Inject(OUTBOX_MODULE_OPTIONS)
    private readonly options: OutboxModuleOptions,
    @Inject(OUTBOX_TRANSPORTS)
    private readonly transports: Record<string, OutboxTransport>,
  ) {
    super();
  }

  onModuleInit(): void {
    this.scan();
    this.assertRouteIsUnambiguous();
  }

  storageUsage(): OutboxStorageUsage {
    this.scan();
    const entries = [...this.handlers.values()].flat();
    const publishes =
      entries.length > 0 || Object.keys(this.transports).length > 0;
    return {
      messages: publishes || this.options.relay?.enabled !== false,
      inbox: !publishes || entries.some((entry) => entry.inbox),
    };
  }

  private scan(): void {
    if (this.scanned) {
      return;
    }
    this.handlers.clear();
    const seen = new Set<object>();
    const wrappers = [
      ...this.discovery.getProviders(),
      ...this.discovery.getControllers(),
    ];
    for (const wrapper of wrappers) {
      const instance = wrapper.instance;
      const isStatic =
        typeof (wrapper as { isDependencyTreeStatic?: unknown })
          .isDependencyTreeStatic === "function"
          ? (
              wrapper as unknown as { isDependencyTreeStatic: () => boolean }
            ).isDependencyTreeStatic()
          : wrapper.isDependencyTreeStatic !== false;

      const prototype: Record<string, unknown> | undefined =
        instance && typeof instance === "object"
          ? (Object.getPrototypeOf(instance) as Record<string, unknown>)
          : typeof wrapper.metatype === "function"
            ? (wrapper.metatype.prototype as Record<string, unknown>)
            : undefined;

      if (!prototype) {
        continue;
      }

      if (instance && typeof instance === "object") {
        if (seen.has(instance)) {
          continue;
        }
        seen.add(instance);
      } else if (isStatic) {
        continue;
      }

      const wrapperName =
        (wrapper as { name?: string }).name ??
        (typeof wrapper.metatype === "function"
          ? wrapper.metatype.name
          : String(wrapper.token));

      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const fn = prototype[method];
        if (typeof fn !== "function") {
          continue;
        }
        const metadata = MetadataRegistry.get<OutboxHandlerMetadata[]>(
          OUTBOX_HANDLER_METADATA,
          fn,
        );
        if (!metadata) {
          continue;
        }
        if (!isStatic) {
          throw new Error(
            `${wrapperName}.${method}: @OnOutboxMessage() handlers must be on singleton providers, ` +
              "and this one is request-scoped (or depends on a request-scoped provider)",
          );
        }
        if (!instance || typeof instance !== "object") {
          continue;
        }
        const targetObj = instance as Record<
          string,
          (payload: unknown, context: OutboxHandlerContext) => unknown
        >;
        for (const meta of metadata) {
          const entry: HandlerEntry = {
            consumer: meta.consumer,
            inbox: meta.inbox ?? true,
            invoke: (payload, context) => targetObj[method]!(payload, context),
          };
          for (const topic of meta.topics) {
            const list = this.handlers.get(topic);
            if (list.some((e) => e.consumer === entry.consumer)) {
              throw new Error(
                `Duplicate outbox consumer "${entry.consumer}" for topic "${topic}"`,
              );
            }
            this.handlers.add(topic, entry);
          }
        }
      }
    }
    this.scanned = true;
  }

  /** Topics with at least one handler in this process. */
  get topics(): string[] {
    return [...this.handlers.keys()];
  }

  async publish(
    message: OutboxMessage,
    { signal }: { signal: AbortSignal } = { signal: NEVER_ABORTED },
  ): Promise<void> {
    const entries = this.handlers.get(message.topic);
    if (!entries?.length) {
      throw new OutboxNoHandlerError(message.topic);
    }
    const results = await Promise.allSettled(
      entries.map((entry) => this.run(entry, message, signal)),
    );
    const errors = results.flatMap((r) =>
      r.status === "rejected" ? [r.reason] : [],
    );
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      const aggregate = new AggregateError(
        errors,
        `${errors.length} handlers failed for "${message.topic}"`,
      );
      if (errors.every((error) => error instanceof NonRetryableMessageError)) {
        throw new NonRetryableMessageError(describeError(aggregate), {
          cause: aggregate,
        });
      }
      throw aggregate;
    }
  }

  private async run(
    entry: HandlerEntry,
    message: OutboxMessage,
    signal: AbortSignal,
  ): Promise<void> {
    const context: OutboxHandlerContext = {
      message,
      consumer: entry.consumer,
      attempt: message.attempts + 1,
      signal,
      processInTransaction: (tx, work) =>
        this.inbox.processInTransaction(tx, entry.consumer, message.id, work),
    };
    const invoke = async (): Promise<unknown> => {
      signal.throwIfAborted();
      const result = entry.invoke(message.payload, context);
      return isSubscribable(result) ? lastValue(result, signal) : result;
    };
    if (entry.inbox) {
      await this.inbox.process(entry.consumer, message.id, invoke, { signal });
      return;
    }
    await invoke();
  }

  private assertRouteIsUnambiguous(): void {
    if (this.options.route) {
      return;
    }
    const names = Object.keys(this.transports);
    if (names.length > 1 || (names.length === 1 && this.handlers.size > 0)) {
      const destinations = [
        ...(this.handlers.size > 0 ? [LOCAL_TRANSPORT] : []),
        ...names,
      ];
      throw new Error(
        `OutboxModule: set \`route\` to choose a transport for each message. This app can publish to ` +
          `${destinations.map((name) => `"${name}"`).join(", ")}` +
          (this.handlers.size > 0
            ? ` ("${LOCAL_TRANSPORT}" runs the @OnOutboxMessage() handlers).`
            : "."),
      );
    }
  }
}

function isSubscribable(value: unknown): value is Subscribable<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Subscribable<unknown>).subscribe === "function"
  );
}

/**
 * The Subscribable's last value. On abort it unsubscribes and rejects with the signal's reason.
 */
function lastValue(
  source: Subscribable<unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<unknown>((resolve, reject) => {
    let last: unknown;
    let settled = false;
    const abort = () => {
      if (settled) {
        return;
      }
      settled = true;
      subscription.unsubscribe();
      reject(signal.reason);
    };
    const subscription = source.subscribe({
      next: (value) => {
        last = value;
      },
      error: (error) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", abort);
        reject(error);
      },
      complete: () => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", abort);
        resolve(last);
      },
    });
    if (!settled && !(subscription as { closed?: boolean }).closed) {
      signal.addEventListener("abort", abort, { once: true });
    }
  });
}
