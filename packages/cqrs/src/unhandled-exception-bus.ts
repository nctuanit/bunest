import { Inject, Injectable, Optional, type Type } from "@bunest/common";
import { DefaultUnhandledExceptionPubSub } from "./helpers/default-pubsubs";
import type {
  CqrsModuleOptions,
  ICommand,
  IEvent,
  IUnhandledExceptionPublisher,
  UnhandledExceptionInfo,
} from "./interfaces";
import { CQRS_MODULE_OPTIONS } from "./tokens";
import {
  SubscribableStream,
  type StreamListener,
  type Subscribable,
  type SubscriptionHandle,
} from "./utils/subscribable-stream";

/**
 * Zero-RxJS bus publishing unhandled exceptions raised during event handler
 * and saga execution. Supports `{ subscribe(...) }` callbacks, `subject$`,
 * `for await (const info of unhandledExceptionBus)`, and `UnhandledExceptionBus.ofType(...)`.
 */
@Injectable()
export class UnhandledExceptionBus<Cause = IEvent | ICommand>
  implements Subscribable<UnhandledExceptionInfo<Cause>>
{
  readonly subject$ = new SubscribableStream<UnhandledExceptionInfo<Cause>>();
  private _publisher!: IUnhandledExceptionPublisher<Cause>;

  constructor(
    @Optional()
    @Inject(CQRS_MODULE_OPTIONS)
    private readonly options?: CqrsModuleOptions,
  ) {
    if (this.options?.unhandledExceptionPublisher) {
      this._publisher = this.options
        .unhandledExceptionPublisher as IUnhandledExceptionPublisher<Cause>;
    } else {
      this.useDefaultPublisher();
    }
  }

  /**
   * Filters a stream of `UnhandledExceptionInfo` entries by exception class(es)
   * using native `instanceof` (zero-RxJS equivalent of NestJS `UnhandledExceptionBus.ofType`).
   */
  static ofType<
    TInput = any,
    TOutput = IEvent | ICommand,
  >(
    ...types: Type<any>[]
  ): (
    source: Subscribable<UnhandledExceptionInfo<TInput>>,
  ) => SubscribableStream<UnhandledExceptionInfo<TOutput>> {
    return (source) => {
      const filtered = new SubscribableStream<
        UnhandledExceptionInfo<TOutput>
      >();
      const unsub = source.subscribe({
        next: (info) => {
          if (types.some((cls) => info.exception instanceof cls)) {
            filtered.next(info as unknown as UnhandledExceptionInfo<TOutput>);
          }
        },
        complete: () => {
          filtered.complete();
        },
      });
      const origComplete = filtered.complete.bind(filtered);
      filtered.complete = () => {
        unsub();
        origComplete();
      };
      return filtered;
    };
  }

  get publisher(): IUnhandledExceptionPublisher<Cause> {
    return this._publisher;
  }

  set publisher(publisher: IUnhandledExceptionPublisher<Cause>) {
    this._publisher = publisher;
  }

  publish(info: UnhandledExceptionInfo<Cause>): any {
    return this._publisher.publish(info);
  }

  subscribe(
    listenerOrObserver: StreamListener<UnhandledExceptionInfo<Cause>>,
  ): SubscriptionHandle {
    return this.subject$.subscribe(listenerOrObserver);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<
    UnhandledExceptionInfo<Cause>
  > {
    return this.subject$[Symbol.asyncIterator]();
  }

  clear(): void {
    this.subject$.clear();
  }

  private useDefaultPublisher(): void {
    this._publisher = new DefaultUnhandledExceptionPubSub<Cause>(this.subject$);
  }
}
