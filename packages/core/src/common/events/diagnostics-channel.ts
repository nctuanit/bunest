/**
 * Bunest Native Diagnostics Channel Bus (zero `node:diagnostics_channel` dependency).
 *
 * Stores named channels on `globalThis[Symbol.for("bunest:diagnostics:channels")]`
 * so every workspace package and bundle chunk shares one consistent single-realm bus.
 */

export const DIAGNOSTICS_CHANNELS_SYMBOL = Symbol.for(
  "bunest:diagnostics:channels",
);

export type DiagnosticChannelSubscriber = (
  message: unknown,
  name: string | symbol,
) => void;

export class DiagnosticChannel {
  readonly name: string | symbol;
  private subscribers: DiagnosticChannelSubscriber[] = [];

  constructor(name: string | symbol) {
    this.name = name;
  }

  get hasSubscribers(): boolean {
    return this.subscribers.length > 0;
  }

  publish(message: unknown): void {
    const subs = this.subscribers;
    if (subs.length === 0) {
      return;
    }
    // Snapshot so subscribe/unsubscribe during publish never skips subscribers
    const snapshot = subs.length === 1 ? [subs[0]!] : [...subs];
    for (let i = 0; i < snapshot.length; i++) {
      snapshot[i]!(message, this.name);
    }
  }

  subscribe(onMessage: DiagnosticChannelSubscriber): void {
    if (typeof onMessage !== "function") {
      throw new TypeError("DiagnosticChannel subscriber must be a function");
    }
    this.subscribers.push(onMessage);
  }

  unsubscribe(onMessage: DiagnosticChannelSubscriber): boolean {
    const idx = this.subscribers.indexOf(onMessage);
    if (idx === -1) {
      return false;
    }
    this.subscribers.splice(idx, 1);
    return true;
  }
}

function getChannelRegistry(): Map<string | symbol, DiagnosticChannel> {
  const g = globalThis as Record<PropertyKey, unknown>;
  let registry = g[DIAGNOSTICS_CHANNELS_SYMBOL] as
    | Map<string | symbol, DiagnosticChannel>
    | undefined;
  if (!registry) {
    registry = new Map<string | symbol, DiagnosticChannel>();
    g[DIAGNOSTICS_CHANNELS_SYMBOL] = registry;
  }
  return registry;
}

/**
 * Returns (or creates) the shared `DiagnosticChannel` registered under `name`.
 */
export function diagnosticsChannel(name: string | symbol): DiagnosticChannel {
  const registry = getChannelRegistry();
  let existing = registry.get(name);
  if (!existing) {
    existing = new DiagnosticChannel(name);
    registry.set(name, existing);
  }
  return existing;
}

/**
 * Drop-in alias for `diagnosticsChannel(name)` matching `node:diagnostics_channel`.
 */
export const channel = diagnosticsChannel;

/**
 * Returns `true` if the channel `name` currently has at least one active subscriber.
 */
export function hasSubscribers(name: string | symbol): boolean {
  return getChannelRegistry().get(name)?.hasSubscribers ?? false;
}

/**
 * Publishes `message` to all subscribers currently attached to channel `name`.
 */
export function publish(name: string | symbol, message: unknown): void {
  const ch = getChannelRegistry().get(name);
  if (ch?.hasSubscribers) {
    ch.publish(message);
  }
}

/**
 * Subscribes `onMessage` to channel `name` (creating the channel if needed).
 */
export function subscribe(
  name: string | symbol,
  onMessage: DiagnosticChannelSubscriber,
): void {
  diagnosticsChannel(name).subscribe(onMessage);
}

/**
 * Removes `onMessage` from channel `name`. Returns `true` if the listener was found.
 */
export function unsubscribe(
  name: string | symbol,
  onMessage: DiagnosticChannelSubscriber,
): boolean {
  const ch = getChannelRegistry().get(name);
  return ch ? ch.unsubscribe(onMessage) : false;
}
