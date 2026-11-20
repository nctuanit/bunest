import type { OnApplicationShutdown } from "@bunest/common";
import type { QueueEventsLike } from "../interfaces";

/**
 * Lightweight zero-dependency Bun-native `QueueEvents` implementation
 * bridging queue lifecycle events for `@QueueEventsListener()` hosts.
 */
export class QueueEvents implements QueueEventsLike {
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  private readonly unbinders: Array<() => void> = [];
  private closed = false;

  constructor(public readonly name: string) {}

  on(event: string, listener: (...args: any[]) => void): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: any[]): boolean {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) {
      return false;
    }
    for (const listener of [...set]) {
      try {
        void listener(...args);
      } catch {
        // Isolate listener failures
      }
    }
    return true;
  }

  /** @internal */
  _trackUnbinder(unbind: () => void): void {
    this.unbinders.push(unbind);
  }

  async waitUntilReady(): Promise<void> {
    return;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const unbind of this.unbinders.splice(0)) {
      unbind();
    }
    this.listeners.clear();
  }
}

/**
 * Abstract base class for `@QueueEventsListener()` components that react to
 * queue-wide lifecycle events via `@OnQueueEvent()`.
 */
export abstract class QueueEventsHost<T extends QueueEventsLike = QueueEvents>
  implements OnApplicationShutdown
{
  private _queueEvents?: T;

  get queueEvents(): T {
    if (!this._queueEvents) {
      throw new Error(
        '"QueueEvents" class has not yet been initialized. Make sure to interact with queue events instances after the "onModuleInit" lifecycle hook is triggered, for example, in the "onApplicationBootstrap" hook, or if "manualRegistration" is set to true make sure to call "BullRegistrar.register()"',
      );
    }
    return this._queueEvents;
  }

  async onApplicationShutdown(_signal?: string): Promise<void> {
    if (this._queueEvents && typeof this._queueEvents.close === "function") {
      await this._queueEvents.close();
    }
  }
}
