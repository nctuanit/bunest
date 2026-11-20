import {
  Injectable,
  createMethodAspectDecorator,
  type MethodAspectContext,
  type MethodAspectHandler,
} from "@bunest/common";
import { EventEmitterService } from "../event-emitter.service";
import type { EventName } from "../interfaces/event-emitter.interface";

export type EmitEventName =
  | EventName
  | ((args: unknown[], result: unknown) => EventName);

export interface EmitEventOptions {
  /**
   * When true, awaits `EventEmitter2.emitAsync(...)` before resolving the
   * decorated method's return value. When false (default), calls `emit(...)`.
   * @default false
   */
  readonly async?: boolean;
  /**
   * Optional mapper deriving the emitted event payload from `(result, args)`.
   * Defaults to emitting `result`.
   */
  readonly payload?: (result: unknown, args: unknown[]) => unknown;
  /**
   * Optional predicate controlling whether the event should be emitted.
   * Receives `(result, args)`. Emission is skipped when it returns `false`.
   */
  readonly when?: (result: unknown, args: unknown[]) => boolean;
}

export interface EmitEventAspectMetadata {
  readonly event: EmitEventName;
  readonly options?: EmitEventOptions;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/**
 * Service-layer method aspect handler powering `@EmitEvent(...)`.
 * Automatically emits an event via `EventEmitter2` (`EventEmitterService`)
 * after the decorated method succeeds (never emits if the method throws/rejects).
 */
@Injectable()
export class EmitEventAspect
  implements MethodAspectHandler<EmitEventAspectMetadata>
{
  constructor(private readonly emitter: EventEmitterService) {}

  intercept(ctx: MethodAspectContext<EmitEventAspectMetadata>): unknown {
    const { event, options } = ctx.options;

    const emitAfter = (result: unknown): unknown => {
      if (options?.when && !options.when(result, ctx.args)) {
        return result;
      }

      const eventName =
        typeof event === "function" ? event(ctx.args, result) : event;
      const payload = options?.payload
        ? options.payload(result, ctx.args)
        : result;

      if (options?.async) {
        return this.emitter.emitAsync(eventName, payload).then(() => result);
      }

      this.emitter.emit(eventName, payload);
      return result;
    };

    const raw = ctx.proceed();
    if (isThenable(raw)) {
      return Promise.resolve(raw).then(emitAfter);
    }
    return emitAfter(raw);
  }
}

/**
 * Declaratively emits an event via `EventEmitter2` after the decorated method
 * resolves, powered by Bunest's Core Method Aspect engine.
 */
export function EmitEvent(
  event: EmitEventName,
  options?: EmitEventOptions,
): MethodDecorator {
  return createMethodAspectDecorator<EmitEventAspectMetadata>(EmitEventAspect, {
    event,
    options,
  });
}
