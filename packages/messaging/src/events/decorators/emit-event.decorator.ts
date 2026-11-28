import {
  Injectable,
  createMethodAspectDecorator,
  type MethodAspectContext,
  type MethodAspectHandler,
} from "@bunest/core";
import { isFunction, isPromiseLike } from "@bunest/core/common";
import { isAppEvent, type AppEvent } from "../app-event";
import { EventEmitterService } from "../event-emitter.service";
import type { EventNameInput } from "../interfaces/event-registry.interface";

export type EmitEventName =
  | EventNameInput
  | AppEvent<string, any>
  | ((args: unknown[], result: unknown) => EventNameInput | AppEvent<string, any>);

export interface EmitEventOptions<TPayload = unknown> {
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
  readonly payload?: (result: unknown, args: unknown[]) => TPayload;
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

/**
 * Service-layer method aspect handler powering `@EmitEvent(...)`.
 * Automatically emits an event via `EventEmitter2` (`EventEmitterService`)
 * after the decorated method succeeds (never emits if the method throws/rejects).
 */
@Injectable()
export class EmitEventAspect implements MethodAspectHandler<EmitEventAspectMetadata> {
  constructor(private readonly emitter: EventEmitterService) {}

  intercept(ctx: MethodAspectContext<EmitEventAspectMetadata>): unknown {
    const { event, options } = ctx.options;

    const emitAfter = (result: unknown): unknown => {
      if (options?.when && !options.when(result, ctx.args)) {
        return result;
      }

      const resolvedEvent = isFunction(event) ? event(ctx.args, result) : event;
      const eventName: EventNameInput = isAppEvent(resolvedEvent)
        ? resolvedEvent.name
        : (resolvedEvent as EventNameInput);
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
    if (isPromiseLike(raw)) {
      return Promise.resolve(raw).then(emitAfter);
    }
    return emitAfter(raw);
  }
}

/**
 * Declaratively emits an event via `EventEmitter2` after the decorated method
 * resolves, powered by Bunest's Core Method Aspect engine.
 */
export function EmitEvent<TPayload>(
  event: AppEvent<string, TPayload>,
  options?: EmitEventOptions<TPayload>,
): MethodDecorator;
export function EmitEvent(
  event: EmitEventName,
  options?: EmitEventOptions,
): MethodDecorator;
export function EmitEvent(
  event: EmitEventName,
  options?: EmitEventOptions,
): MethodDecorator {
  return createMethodAspectDecorator<EmitEventAspectMetadata>(EmitEventAspect, {
    event,
    options,
  });
}
