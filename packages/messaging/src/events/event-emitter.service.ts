import { Inject, Injectable, Logger, Optional } from "@bunest/core";
import { EVENT_EMITTER_OPTIONS } from "./constants";
import type {
  BunestEventRegistry,
  RegisteredEventArgs,
} from "./interfaces/event-registry.interface";
import type {
  CancelablePromise,
  EventAndListener,
  EventEmitterModuleOptions,
  EventInput,
  EventListener,
  EventName,
  GeneralEventEmitter,
  ListenToOptions,
  ListenerHandle,
  OnceOptions,
  OnEventOptions,
  WaitForFilter,
  WaitForOptions,
} from "./interfaces/event-emitter.interface";
import { matchEventName } from "./utils/wildcard.util";

interface ListenerEntry {
  readonly event: EventName;
  readonly listener: EventListener;
  remaining: number;
  readonly options: OnEventOptions;
}

interface ListenToRecord {
  readonly target: GeneralEventEmitter;
  readonly sourceEvent: EventName;
  readonly handler: EventListener;
  readonly offFn?: (event: EventInput, handler: EventListener) => void;
}

function normalizeOnOptions(
  options?: boolean | OnEventOptions,
): OnEventOptions {
  if (typeof options === "boolean") {
    return { objectify: options };
  }
  return options ?? {};
}

/**
 * Typed in-process event bus with full `EventEmitter2` API surface:
 * synchronous and asynchronous emission, segment wildcards (`*` / `**`),
 * `once`, `many`, `prepend*`, `*Any`, `waitFor`, `listenTo`/`stopListeningTo`,
 * `newListener`/`removeListener` lifecycle events, and per-listener or global
 * error isolation.
 */
@Injectable()
export class EventEmitterService {
  static defaultMaxListeners = 10;

  private readonly wildcard: boolean;
  private readonly delimiter: string;
  private readonly emitNewListener: boolean;
  private readonly emitRemoveListener: boolean;
  private readonly verboseMemoryLeak: boolean;
  private readonly ignoreErrors: boolean;
  private maxListeners: number;
  private readonly logger = new Logger("EventEmitterService");
  private readonly listenerMap = new Map<EventName, ListenerEntry[]>();
  private readonly anyListeners: EventAndListener[] = [];
  private readonly listeningTo: ListenToRecord[] = [];

  constructor(
    @Optional()
    @Inject(EVENT_EMITTER_OPTIONS)
    options: EventEmitterModuleOptions = {},
  ) {
    this.wildcard = options.wildcard ?? false;
    this.delimiter = options.delimiter ?? ".";
    this.emitNewListener = options.newListener ?? false;
    this.emitRemoveListener = options.removeListener ?? false;
    this.maxListeners =
      options.maxListeners ?? EventEmitterService.defaultMaxListeners;
    this.verboseMemoryLeak = options.verboseMemoryLeak ?? false;
    this.ignoreErrors = options.ignoreErrors ?? false;
  }

  static once(
    emitter: EventEmitterService,
    event: EventInput,
    options?: OnceOptions,
  ): CancelablePromise<unknown[]> {
    return emitter.waitFor(event, options);
  }

  on<K extends keyof BunestEventRegistry>(
    event: K,
    listener: (...args: RegisteredEventArgs<K>) => unknown | Promise<unknown>,
    options?: boolean | OnEventOptions,
  ): this | ListenerHandle;
  on<TEvent extends EventInput>(
    event: TEvent extends keyof BunestEventRegistry ? never : TEvent,
    listener: EventListener,
    options?: boolean | OnEventOptions,
  ): this | ListenerHandle;
  on(
    event: EventInput,
    listener: EventListener,
    options?: boolean | OnEventOptions,
  ): this | ListenerHandle {
    return this.addEntry(
      event,
      listener,
      Number.POSITIVE_INFINITY,
      normalizeOnOptions(options),
    );
  }

  addListener(
    event: EventInput,
    listener: EventListener,
  ): this | ListenerHandle {
    return this.on(event, listener);
  }

  prependListener(
    event: EventInput,
    listener: EventListener,
    options?: boolean | OnEventOptions,
  ): this | ListenerHandle {
    return this.addEntry(event, listener, Number.POSITIVE_INFINITY, {
      ...normalizeOnOptions(options),
      prependListener: true,
    });
  }

  once<K extends keyof BunestEventRegistry>(
    event: K,
    listener: (...args: RegisteredEventArgs<K>) => unknown | Promise<unknown>,
    options?: boolean | OnEventOptions,
  ): this | ListenerHandle;
  once<TEvent extends EventInput>(
    event: TEvent extends keyof BunestEventRegistry ? never : TEvent,
    listener: EventListener,
    options?: boolean | OnEventOptions,
  ): this | ListenerHandle;
  once(
    event: EventInput,
    listener: EventListener,
    options?: boolean | OnEventOptions,
  ): this | ListenerHandle {
    return this.addEntry(event, listener, 1, normalizeOnOptions(options));
  }

  prependOnceListener(
    event: EventInput,
    listener: EventListener,
    options?: boolean | OnEventOptions,
  ): this | ListenerHandle {
    return this.addEntry(event, listener, 1, {
      ...normalizeOnOptions(options),
      prependListener: true,
    });
  }

  many(
    event: EventInput,
    timesToListen: number,
    listener: EventListener,
    options?: boolean | OnEventOptions,
  ): this | ListenerHandle {
    return this.addEntry(
      event,
      listener,
      timesToListen,
      normalizeOnOptions(options),
    );
  }

  prependMany(
    event: EventInput,
    timesToListen: number,
    listener: EventListener,
    options?: boolean | OnEventOptions,
  ): this | ListenerHandle {
    return this.addEntry(event, listener, timesToListen, {
      ...normalizeOnOptions(options),
      prependListener: true,
    });
  }

  onAny(listener: EventAndListener): this {
    this.anyListeners.push(listener);
    return this;
  }

  prependAny(listener: EventAndListener): this {
    this.anyListeners.unshift(listener);
    return this;
  }

  offAny(listener: EventAndListener): this {
    const idx = this.anyListeners.indexOf(listener);
    if (idx !== -1) {
      this.anyListeners.splice(idx, 1);
    }
    return this;
  }

  listenersAny(): EventAndListener[] {
    return [...this.anyListeners];
  }

  off(event: EventInput, listener: EventListener): this {
    const normalized = this.normalizeEvent(event);
    const bucket = this.listenerMap.get(normalized);
    if (!bucket) {
      return this;
    }
    const idx = bucket.findIndex((entry) => entry.listener === listener);
    if (idx !== -1) {
      bucket.splice(idx, 1);
      if (bucket.length === 0) {
        this.listenerMap.delete(normalized);
      }
      if (this.emitRemoveListener && normalized !== "removeListener") {
        this.emit("removeListener", normalized, listener);
      }
    }
    return this;
  }

  removeListener(event: EventInput, listener: EventListener): this {
    return this.off(event, listener);
  }

  removeAllListeners(event?: EventInput): this {
    if (event !== undefined) {
      const normalized = this.normalizeEvent(event);
      const removed = this.listenerMap.get(normalized);
      this.listenerMap.delete(normalized);
      if (
        removed &&
        this.emitRemoveListener &&
        normalized !== "removeListener"
      ) {
        for (const entry of removed) {
          this.emit("removeListener", normalized, entry.listener);
        }
      }
    } else {
      const snapshot = this.emitRemoveListener
        ? [...this.listenerMap.entries()]
        : undefined;
      this.listenerMap.clear();
      this.anyListeners.length = 0;
      if (snapshot) {
        for (const [ev, entries] of snapshot) {
          if (ev === "removeListener") continue;
          for (const entry of entries) {
            this.emit("removeListener", ev, entry.listener);
          }
        }
      }
    }
    return this;
  }

  setMaxListeners(n: number): void {
    this.maxListeners = n;
  }

  getMaxListeners(): number {
    return this.maxListeners;
  }

  listenerCount(event?: EventInput): number {
    if (event !== undefined) {
      return this.getMatchingEntries(this.normalizeEvent(event)).length;
    }
    let total = 0;
    for (const bucket of this.listenerMap.values()) {
      total += bucket.length;
    }
    return total;
  }

  listeners(event?: EventInput): EventListener[] {
    if (event !== undefined) {
      return this.getMatchingEntries(this.normalizeEvent(event)).map(
        (entry) => entry.listener,
      );
    }
    const all: EventListener[] = [];
    for (const bucket of this.listenerMap.values()) {
      for (const entry of bucket) {
        all.push(entry.listener);
      }
    }
    return all;
  }

  hasListeners(event?: EventInput): boolean {
    if (event !== undefined) {
      return (
        this.getMatchingEntries(this.normalizeEvent(event)).length > 0 ||
        this.anyListeners.length > 0
      );
    }
    return this.listenerMap.size > 0 || this.anyListeners.length > 0;
  }

  eventNames(nsAsArray = false): Array<EventName | string[]> {
    const keys = [...this.listenerMap.keys()];
    if (!nsAsArray) {
      return keys;
    }
    return keys.map((key) =>
      typeof key === "string" && key.includes(this.delimiter)
        ? key.split(this.delimiter)
        : key,
    );
  }

  waitFor<K extends keyof BunestEventRegistry>(
    event: K,
    timeout?: number,
  ): CancelablePromise<RegisteredEventArgs<K>>;
  waitFor<K extends keyof BunestEventRegistry>(
    event: K,
    filter?: (...args: RegisteredEventArgs<K>) => boolean,
  ): CancelablePromise<RegisteredEventArgs<K>>;
  waitFor<K extends keyof BunestEventRegistry>(
    event: K,
    options?: WaitForOptions,
  ): CancelablePromise<RegisteredEventArgs<K>>;
  waitFor(event: EventInput, timeout?: number): CancelablePromise<unknown[]>;
  waitFor(
    event: EventInput,
    filter?: WaitForFilter,
  ): CancelablePromise<unknown[]>;
  waitFor(
    event: EventInput,
    options?: WaitForOptions,
  ): CancelablePromise<unknown[]>;
  waitFor(
    event: EventInput,
    timeoutOrFilterOrOptions?: number | WaitForFilter | WaitForOptions,
  ): CancelablePromise<unknown[]> {
    let timeout = 0;
    let filter: WaitForFilter | undefined;
    let handleError = false;
    let PromiseCtor: typeof Promise = Promise;

    if (typeof timeoutOrFilterOrOptions === "number") {
      timeout = timeoutOrFilterOrOptions;
    } else if (typeof timeoutOrFilterOrOptions === "function") {
      filter = timeoutOrFilterOrOptions;
    } else if (
      timeoutOrFilterOrOptions !== undefined &&
      timeoutOrFilterOrOptions !== null
    ) {
      timeout = timeoutOrFilterOrOptions.timeout ?? 0;
      filter = timeoutOrFilterOrOptions.filter ?? undefined;
      handleError = timeoutOrFilterOrOptions.handleError ?? false;
      PromiseCtor = timeoutOrFilterOrOptions.Promise ?? Promise;
    }

    const normalized = this.normalizeEvent(event);
    let cancelFn: (reason?: string) => void = () => {};

    const promise = new PromiseCtor<unknown[]>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      const cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        this.off(normalized, handler);
      };

      const handler: EventListener = (...values: unknown[]) => {
        if (settled) {
          return;
        }
        if (filter) {
          try {
            if (!filter(...values)) {
              return;
            }
          } catch (err) {
            settled = true;
            cleanup();
            reject(err);
            return;
          }
        }

        settled = true;
        cleanup();

        if (handleError) {
          const [first, ...rest] = values;
          if (first) {
            reject(first);
          } else {
            resolve(rest);
          }
          return;
        }

        resolve(values);
      };

      cancelFn = (reason?: string) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new Error(reason ?? "canceled"));
      };

      this.on(normalized, handler);

      if (timeout > 0) {
        timer = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(new Error("timeout"));
        }, timeout);
        timer.unref?.();
      }
    }) as CancelablePromise<unknown[]>;

    promise.cancel = (reason?: string) => {
      cancelFn(reason);
    };

    return promise;
  }

  listenTo(
    target: GeneralEventEmitter,
    events: EventInput | Record<string, EventName>,
    options?: ListenToOptions,
  ): this {
    const entries: Array<[EventName, EventName]> = [];

    if (
      typeof events === "object" &&
      events !== null &&
      !Array.isArray(events)
    ) {
      for (const [src, dest] of Object.entries(events)) {
        entries.push([src, dest]);
      }
    } else if (Array.isArray(events)) {
      for (const ev of events) {
        entries.push([ev, ev]);
      }
    } else {
      const normalized = this.normalizeEvent(events);
      entries.push([normalized, normalized]);
    }

    const subscribe = (sourceEvent: EventName, handler: EventListener) => {
      if (typeof options?.on === "function") {
        options.on(sourceEvent, handler);
      } else if (typeof target.on === "function") {
        target.on(sourceEvent, handler);
      } else if (typeof target.addListener === "function") {
        target.addListener(sourceEvent, handler);
      } else if (typeof target.addEventListener === "function") {
        target.addEventListener(sourceEvent, handler);
      } else {
        throw new TypeError(
          "Target emitter does not implement on, addListener, or addEventListener.",
        );
      }
    };

    const reducers = options?.reducers;

    for (const [sourceEvent, destEvent] of entries) {
      const handler: EventListener = (...args: unknown[]) => {
        if (typeof reducers === "function") {
          const reduced = reducers({ name: destEvent, data: args });
          if (reduced !== false) {
            this.emit(destEvent, ...args);
          }
          return;
        }
        if (
          reducers &&
          typeof reducers === "object" &&
          typeof (reducers as Record<string, unknown>)[String(sourceEvent)] ===
            "function"
        ) {
          const reducer = (reducers as Record<string, Function>)[
            String(sourceEvent)
          ]!;
          const reduced = reducer({ name: destEvent, data: args });
          if (reduced !== false) {
            this.emit(destEvent, ...args);
          }
          return;
        }
        this.emit(destEvent, ...args);
      };

      subscribe(sourceEvent, handler);
      this.listeningTo.push({
        target,
        sourceEvent,
        handler,
        offFn: options?.off,
      });
    }

    return this;
  }

  stopListeningTo(target?: GeneralEventEmitter, event?: EventInput): boolean {
    const normalizedEvent =
      event !== undefined ? this.normalizeEvent(event) : undefined;
    let removedAny = false;

    for (let i = this.listeningTo.length - 1; i >= 0; i -= 1) {
      const rec = this.listeningTo[i]!;
      const targetMatches = target === undefined || rec.target === target;
      const eventMatches =
        normalizedEvent === undefined || rec.sourceEvent === normalizedEvent;

      if (!targetMatches || !eventMatches) {
        continue;
      }

      if (typeof rec.offFn === "function") {
        rec.offFn(rec.sourceEvent, rec.handler);
      } else if (typeof rec.target.off === "function") {
        rec.target.off(rec.sourceEvent, rec.handler);
      } else if (typeof rec.target.removeListener === "function") {
        rec.target.removeListener(rec.sourceEvent, rec.handler);
      } else if (typeof rec.target.removeEventListener === "function") {
        rec.target.removeEventListener(rec.sourceEvent, rec.handler);
      }

      this.listeningTo.splice(i, 1);
      removedAny = true;
    }

    return removedAny;
  }

  /**
   * Emits an event to all matching listeners synchronously (respecting `nextTick`,
   * `async`, and error suppression flags). Returns `true` if any listener matched.
   */
  emit<K extends keyof BunestEventRegistry>(
    event: K,
    ...values: RegisteredEventArgs<K>
  ): boolean;
  emit<TEvent extends EventInput>(
    event: TEvent extends keyof BunestEventRegistry ? never : TEvent,
    ...values: unknown[]
  ): boolean;
  emit(event: EventInput, ...values: unknown[]): boolean {
    const normalized = this.normalizeEvent(event);
    const matched = this.getMatchingEntries(normalized);
    const anySnapshot =
      this.anyListeners.length > 0 ? [...this.anyListeners] : [];

    if (matched.length === 0 && anySnapshot.length === 0) {
      if (normalized === "error" && !this.ignoreErrors) {
        const err = values[0];
        if (err instanceof Error) {
          throw err;
        }
        throw new Error(
          `Uncaught, unspecified "error" event${err !== undefined ? ` (${String(err)})` : ""}.`,
        );
      }
      return false;
    }

    for (const entry of matched) {
      this.consumeEntry(entry);

      const suppress = entry.options.suppressErrors ?? this.ignoreErrors;

      const invoke = () => {
        try {
          const result = entry.listener(...values);
          if (
            result !== null &&
            (typeof result === "object" || typeof result === "function") &&
            typeof (result as PromiseLike<unknown>).then === "function"
          ) {
            Promise.resolve(result).catch((err) => {
              if (!suppress) {
                this.logger.error(
                  `Unhandled async error in listener for "${String(normalized)}": ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            });
          }
        } catch (err) {
          if (!suppress) {
            throw err;
          }
        }
      };

      if (entry.options.nextTick || entry.options.async) {
        queueMicrotask(() => {
          try {
            invoke();
          } catch (err) {
            if (!suppress) {
              this.logger.error(
                `Unhandled async error in listener for "${String(normalized)}": ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        });
      } else {
        invoke();
      }
    }

    for (const anyListener of anySnapshot) {
      try {
        const result = anyListener(normalized, ...values);
        if (
          result !== null &&
          (typeof result === "object" || typeof result === "function") &&
          typeof (result as PromiseLike<unknown>).then === "function"
        ) {
          Promise.resolve(result).catch((err) => {
            if (!this.ignoreErrors) {
              this.logger.error(
                `Unhandled async error in onAny listener for "${String(normalized)}": ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          });
        }
      } catch (err) {
        if (!this.ignoreErrors) {
          throw err;
        }
      }
    }

    return true;
  }

  /**
   * Emits an event and awaits all matching listeners, returning an array of
   * resolved listener outputs. Isolates errors when `suppressErrors` or
   * `ignoreErrors` is enabled.
   */
  emitAsync<K extends keyof BunestEventRegistry>(
    event: K,
    ...values: RegisteredEventArgs<K>
  ): Promise<unknown[]>;
  emitAsync<TEvent extends EventInput>(
    event: TEvent extends keyof BunestEventRegistry ? never : TEvent,
    ...values: unknown[]
  ): Promise<unknown[]>;
  async emitAsync(event: EventInput, ...values: unknown[]): Promise<unknown[]> {
    const normalized = this.normalizeEvent(event);
    const matched = this.getMatchingEntries(normalized);
    const anySnapshot =
      this.anyListeners.length > 0 ? [...this.anyListeners] : [];

    if (matched.length === 0 && anySnapshot.length === 0) {
      return [];
    }

    const executions = matched.map((entry) => {
      this.consumeEntry(entry);

      const suppress = entry.options.suppressErrors ?? this.ignoreErrors;

      const run = async (): Promise<{
        ok: boolean;
        value?: unknown;
        error?: unknown;
        suppressed: boolean;
      }> => {
        try {
          if (entry.options.nextTick) {
            await Promise.resolve();
          }
          const raw = entry.listener(...values);
          const value = entry.options.promisify
            ? await Promise.resolve(raw)
            : await raw;
          return { ok: true, value, suppressed: false };
        } catch (error) {
          if (suppress) {
            return { ok: true, value: undefined, suppressed: true };
          }
          return { ok: false, error, suppressed: false };
        }
      };

      return run();
    });

    for (const anyListener of anySnapshot) {
      executions.push(
        (async () => {
          try {
            const value = await anyListener(normalized, ...values);
            return { ok: true, value, suppressed: false };
          } catch (error) {
            if (this.ignoreErrors) {
              return { ok: true, value: undefined, suppressed: true };
            }
            return { ok: false, error, suppressed: false };
          }
        })(),
      );
    }

    const settled = await Promise.all(executions);
    const firstFailure = settled.find((item) => !item.ok);
    if (firstFailure) {
      throw firstFailure.error;
    }

    return settled.map((item) => item.value);
  }

  private normalizeEvent(event: EventInput): EventName {
    if (Array.isArray(event)) {
      if (event.length === 1 && typeof event[0] === "symbol") {
        return event[0];
      }
      return event.map((part) => String(part)).join(this.delimiter);
    }
    return event as EventName;
  }

  private addEntry(
    event: EventInput,
    listener: EventListener,
    remaining: number,
    options: OnEventOptions,
  ): this | ListenerHandle {
    const normalized = this.normalizeEvent(event);

    if (remaining <= 0) {
      if (options.objectify) {
        const handle: ListenerHandle = {
          emitter: this,
          event: normalized,
          listener,
          off() {
            return this;
          },
        };
        return handle;
      }
      return this;
    }

    if (this.emitNewListener && normalized !== "newListener") {
      this.emit("newListener", normalized, listener);
    }

    let bucket = this.listenerMap.get(normalized);
    if (!bucket) {
      bucket = [];
      this.listenerMap.set(normalized, bucket);
    }

    const entry: ListenerEntry = {
      event: normalized,
      listener,
      remaining,
      options: { ...options },
    };

    if (options.prependListener) {
      bucket.unshift(entry);
    } else {
      bucket.push(entry);
    }

    if (this.maxListeners > 0 && bucket.length > this.maxListeners) {
      if (this.verboseMemoryLeak) {
        this.logger.warn(
          `Possible EventEmitter memory leak detected: ${bucket.length} listeners registered for event "${String(normalized)}" (maxListeners=${this.maxListeners}).`,
        );
      } else {
        this.logger.warn(
          `Possible EventEmitter memory leak detected: ${bucket.length} listeners registered (maxListeners=${this.maxListeners}).`,
        );
      }
    }

    if (options.objectify) {
      const emitter = this;
      const handle: ListenerHandle = {
        emitter,
        event: normalized,
        listener,
        off() {
          emitter.off(normalized, listener);
          return this;
        },
      };
      return handle;
    }

    return this;
  }

  private consumeEntry(entry: ListenerEntry): void {
    if (!Number.isFinite(entry.remaining)) {
      return;
    }
    entry.remaining -= 1;
    if (entry.remaining <= 0) {
      this.removeEntry(entry);
    }
  }

  private removeEntry(target: ListenerEntry): void {
    const bucket = this.listenerMap.get(target.event);
    if (!bucket) {
      return;
    }
    const idx = bucket.indexOf(target);
    if (idx !== -1) {
      bucket.splice(idx, 1);
      if (bucket.length === 0) {
        this.listenerMap.delete(target.event);
      }
      if (this.emitRemoveListener && target.event !== "removeListener") {
        this.emit("removeListener", target.event, target.listener);
      }
    }
  }

  private getMatchingEntries(event: EventName): ListenerEntry[] {
    if (!this.wildcard || typeof event === "symbol") {
      const exact = this.listenerMap.get(event);
      return exact ? [...exact] : [];
    }

    const matched: ListenerEntry[] = [];
    const exact = this.listenerMap.get(event);
    if (exact) {
      matched.push(...exact);
    }
    for (const [pattern, bucket] of this.listenerMap.entries()) {
      if (pattern === event) {
        continue;
      }
      if (matchEventName(pattern, event, true, this.delimiter)) {
        matched.push(...bucket);
      }
    }
    return matched;
  }
}

export const EventEmitter2: typeof EventEmitterService = EventEmitterService;
export type EventEmitter2 = EventEmitterService;
