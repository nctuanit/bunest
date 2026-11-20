import { DecoratorRegistry, Injectable, type HttpServer } from "@bunest/common";
import type { AbstractHttpAdapter, BunHttpAdapter } from "@bunest/http";
import type {
  Subscribable,
  SubscribableObserver,
  Unsubscribable,
} from "../interfaces/core-types.interface";

function createReplayVoidSubscribable(
  isReady: () => boolean,
  register: (cb: () => void) => () => void,
): Subscribable<void> {
  return {
    subscribe(
      observerOrNext?: SubscribableObserver<void> | ((value: void) => void),
      _error?: (err: unknown) => void,
      complete?: () => void,
    ): Unsubscribable {
      const nextFn =
        typeof observerOrNext === "function"
          ? observerOrNext
          : observerOrNext?.next?.bind(observerOrNext);
      const completeFn =
        typeof observerOrNext === "function"
          ? complete
          : (observerOrNext?.complete?.bind(observerOrNext) ?? complete);

      if (isReady()) {
        nextFn?.();
        completeFn?.();
        return { unsubscribe() {} };
      }

      let active = true;
      let dispose = () => {};
      dispose = register(() => {
        if (!active) return;
        active = false;
        dispose();
        nextFn?.();
        completeFn?.();
      });

      return {
        unsubscribe() {
          if (!active) return;
          active = false;
          dispose();
        },
      };
    },
  };
}

/**
 * Injectable host exposing the active HTTP adapter (`BunHttpAdapter` / `AbstractHttpAdapter`),
 * matching NestJS v12 `HttpAdapterHost` including zero-RxJS `init$` & `listen$` subscribables
 * (ADR-008).
 */
@Injectable()
export class HttpAdapterHost<
  T extends HttpServer | AbstractHttpAdapter | BunHttpAdapter = BunHttpAdapter,
> {
  private _httpAdapter?: T;
  private _listening = false;
  private _initialized = false;
  private readonly listenListeners = new Set<() => void>();
  private readonly initListeners = new Set<() => void>();
  private readonly _init$: Subscribable<void>;
  private readonly _listen$: Subscribable<void>;

  constructor() {
    this._init$ = createReplayVoidSubscribable(
      () => this._initialized,
      (cb) => this.onInit(cb),
    );
    this._listen$ = createReplayVoidSubscribable(
      () => this._listening,
      (cb) => this.onListen(cb),
    );
  }

  set httpAdapter(httpAdapter: T) {
    this._httpAdapter = httpAdapter;
  }

  get httpAdapter(): T {
    return this._httpAdapter as T;
  }

  set listening(listening: boolean) {
    this._listening = listening;
    if (listening) {
      for (const cb of [...this.listenListeners]) {
        cb();
      }
    }
  }

  get listening(): boolean {
    return this._listening;
  }

  /**
   * Zero-RxJS replay subscribable emitting when the application finishes initializing
   * (ADR-008 compliant equivalent of NestJS `HttpAdapterHost.init$`).
   */
  get init$(): Subscribable<void> {
    return this._init$;
  }

  /**
   * Zero-RxJS replay subscribable emitting when the HTTP server starts listening
   * (ADR-008 compliant equivalent of NestJS `HttpAdapterHost.listen$`).
   */
  get listen$(): Subscribable<void> {
    return this._listen$;
  }

  markInitialized(): void {
    if (this._initialized) return;
    this._initialized = true;
    const listeners = [...this.initListeners];
    this.initListeners.clear();
    for (const cb of listeners) {
      cb();
    }
  }

  /**
   * Registers a callback invoked when the HTTP server starts listening
   * (or immediately if already listening). Returns an unsubscribe function.
   */
  onListen(callback: () => void): () => void {
    if (this._listening) {
      callback();
      return () => {};
    }
    this.listenListeners.add(callback);
    return () => {
      this.listenListeners.delete(callback);
    };
  }

  /**
   * Registers a callback invoked when the application finishes initializing
   * (or immediately if already initialized). Returns an unsubscribe function.
   */
  onInit(callback: () => void): () => void {
    if (this._initialized) {
      callback();
      return () => {};
    }
    this.initListeners.add(callback);
    return () => {
      this.initListeners.delete(callback);
    };
  }
}

DecoratorRegistry.markInternal(HttpAdapterHost);
