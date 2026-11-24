import { Injectable } from "@bunest/core";

/**
 * Tracks initialization readiness of `@OnEvent()` listener discovery.
 * Resolves once `EventEmitterExplorer` finishes registering all listeners on
 * application bootstrap, or rejects if initialization fails.
 */
@Injectable()
export class EventEmitterReadinessWatcher {
  private readonly readyPromise: PromiseWithResolvers<void>;
  private settled = false;

  constructor() {
    this.readyPromise = Promise.withResolvers<void>();
  }

  waitUntilReady(): Promise<void> {
    return this.readyPromise.promise;
  }

  setReady(): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.readyPromise.resolve();
  }

  setErrored(error: Error): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.readyPromise.reject(error);
  }
}
