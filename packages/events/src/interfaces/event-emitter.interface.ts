export type EventName = string | symbol;

export type OnEventType = string | symbol | Array<string | symbol>;

export type EventInput = EventName | readonly EventName[];

export type EventPayloadHost<T> = {
  payload: T;
};

export type EventListener = (...values: any[]) => unknown | Promise<unknown>;

export type EventAndListener = (
  event: EventName | string[],
  ...values: any[]
) => unknown | Promise<unknown>;

export type WaitForFilter = (...values: any[]) => boolean;

export interface WaitForOptions {
  /**
   * Maximum time in ms to wait before rejecting with a timeout error (`0` disables timeout).
   * @default 0
   */
  timeout?: number;
  /**
   * Optional predicate that must return true for the promise to resolve.
   */
  filter?: WaitForFilter | null;
  /**
   * When true, treats the first emitted argument as an error (error-first callback convention).
   * @default false
   */
  handleError?: boolean;
  /**
   * Custom Promise constructor.
   */
  Promise?: typeof Promise;
  /**
   * Compatibility flag matching `eventemitter2` `WaitForOptions`.
   * @default false
   */
  overload?: boolean;
}

export interface OnceOptions {
  /**
   * Maximum time in ms to wait before rejecting with a timeout error (`0` disables timeout).
   * @default 0
   */
  timeout?: number;
  /**
   * Custom Promise constructor.
   */
  Promise?: typeof Promise;
  /**
   * Compatibility flag matching `eventemitter2` `OnceOptions`.
   * @default false
   */
  overload?: boolean;
}

export interface CancelablePromise<T> extends Promise<T> {
  cancel(reason?: string): void;
}

export interface GeneralEventEmitter {
  addEventListener?(event: EventName, handler: EventListener): unknown;
  removeEventListener?(event: EventName, handler: EventListener): unknown;
  addListener?(event: EventName, handler: EventListener): unknown;
  removeListener?(event: EventName, handler: EventListener): unknown;
  on?(event: EventName, handler: EventListener): unknown;
  off?(event: EventName, handler: EventListener): unknown;
}

export interface ListenToOptions {
  on?: (event: EventInput, handler: EventListener) => void;
  off?: (event: EventInput, handler: EventListener) => void;
  reducers?: Function | Record<string, Function>;
}

export interface ListenerHandle {
  readonly emitter: unknown;
  readonly event: EventName;
  readonly listener: EventListener;
  off(): this;
}

export interface EventEmitterModuleOptions {
  /**
   * Registers EventEmitterModule globally across all modules.
   * @default true
   */
  global?: boolean;
  /**
   * Enables segment wildcard matching (`*` single segment, `**` multi-segment).
   * @default false
   */
  wildcard?: boolean;
  /**
   * Segment delimiter used when `wildcard` is enabled.
   * @default "."
   */
  delimiter?: string;
  /**
   * Emit `"newListener"` events when new listeners are added.
   * @default false
   */
  newListener?: boolean;
  /**
   * Emit `"removeListener"` events when listeners are removed.
   * @default false
   */
  removeListener?: boolean;
  /**
   * Soft warning threshold for max listeners per event (0 disables warnings).
   * @default 10
   */
  maxListeners?: number;
  /**
   * Include event name details in memory-leak warning messages.
   * @default false
   */
  verboseMemoryLeak?: boolean;
  /**
   * When true, listener errors are isolated and suppressed rather than thrown/rejected.
   * @default false
   */
  ignoreErrors?: boolean;
  /**
   * When true, request-scoped `@OnEvent()` listeners reuse the `ContextId`
   * associated with the emitted payload/request via `ContextIdFactory.getByRequest(payload)`
   * instead of wrapping it in `{ payload }`.
   * @default false
   */
  inheritRequestContextId?: boolean;
}

export type OnEventOptions = {
  /**
   * Marks listener as asynchronous; in sync `emit()`, rejected promises are handled safely.
   */
  async?: boolean;
  /**
   * Wraps listener return values in `Promise.resolve(...)`.
   */
  promisify?: boolean;
  /**
   * Defers listener invocation to the next microtask tick.
   */
  nextTick?: boolean;
  /**
   * When true, registration methods return a `ListenerHandle` with an `.off()` method.
   */
  objectify?: boolean;
  /**
   * Isolates and suppresses errors thrown/rejected by this specific listener.
   */
  suppressErrors?: boolean;
  /**
   * Registers this listener before previously registered listeners for the same event.
   */
  prependListener?: boolean;
  /**
   * Relative execution priority for `@OnEvent()` listeners (higher priority runs first; default 0).
   */
  priority?: number;
};

export interface OnEventMetadata {
  readonly event: OnEventType;
  readonly events: readonly EventName[];
  readonly methodName: string | symbol;
  readonly options?: OnEventOptions;
}
