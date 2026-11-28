import {
  Inject,
  Injectable,
  Logger,
  METADATA_KEYS,
  MetadataRegistry,
  Optional,
  type InjectionToken,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@bunest/core";
import {
  ContextIdFactory,
  DiscoveryService,
  ExternalContextCreator,
  ModuleRef,
  type InstanceWrapper,
  type ParamsFactory,
} from "@bunest/core";
import { ensureError, isFunction, isObject } from "@bunest/core/common";
import {
  DEFAULT_LISTENER_PRIORITY,
  EVENT_EMITTER_OPTIONS,
  EVENT_PARAMS_METADATA,
} from "./constants";
import { getEventParamMetadata } from "./decorators/event-payload.decorator";
import { getOnEventMetadata } from "./decorators/on-event.decorator";
import { EventEmitterReadinessWatcher } from "./event-emitter-readiness.watcher";
import { EventEmitterService } from "./event-emitter.service";
import type {
  EventEmitterModuleOptions,
  EventListener,
  EventName,
  OnEventOptions,
} from "./interfaces/event-emitter.interface";

const EVENT_PARAMS_FACTORY: ParamsFactory = {
  exchangeKeyForValue(_type, data, args) {
    const payload = args[0];
    if (
      typeof data === "string" &&
      payload !== null &&
      payload !== undefined &&
      typeof payload === "object"
    ) {
      return (payload as Record<string, unknown>)[data];
    }
    return payload;
  },
};

function hasEventEnhancersOrParams(
  ctor: Function,
  method: Function,
  methodName: string | symbol,
): boolean {
  if (getEventParamMetadata(ctor, methodName) !== undefined) {
    return true;
  }
  const enhancerKeys = [
    METADATA_KEYS.GUARDS,
    METADATA_KEYS.PIPES,
    METADATA_KEYS.INTERCEPTORS,
    METADATA_KEYS.EXCEPTION_FILTERS,
  ] as const;

  for (let i = 0; i < enhancerKeys.length; i++) {
    const key = enhancerKeys[i]!;
    if (MetadataRegistry.has(key, method)) {
      return true;
    }
    if (MetadataRegistry.getMergedClassArray(key, ctor).length > 0) {
      return true;
    }
  }
  return false;
}

interface BoundRegistration {
  readonly event: EventName;
  readonly listener: EventListener;
}

interface PendingSubscription {
  readonly priority: number;
  readonly prepend: boolean;
  readonly order: number;
  readonly register: () => void;
}

/**
 * Automatically discovers `@OnEvent()` methods across singleton and
 * request-scoped providers and controllers in the DI container on
 * `onApplicationBootstrap()` and unregisters them cleanly on `onModuleDestroy()`.
 */
@Injectable()
export class EventEmitterExplorer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly registrations: BoundRegistration[] = [];
  private readonly logger = new Logger("EventEmitterExplorer");

  constructor(
    private readonly emitter: EventEmitterService,
    private readonly moduleRef: ModuleRef,
    @Optional()
    private readonly discoveryService?: DiscoveryService,
    @Optional()
    private readonly readinessWatcher?: EventEmitterReadinessWatcher,
    @Optional()
    @Inject(EVENT_EMITTER_OPTIONS)
    private readonly options: EventEmitterModuleOptions = {},
    @Optional()
    private readonly externalContextCreator?: ExternalContextCreator,
  ) {}

  onApplicationBootstrap(): void {
    try {
      this.loadEventListeners();
      this.readinessWatcher?.setReady();
    } catch (error) {
      this.readinessWatcher?.setErrored(ensureError(error));
    }
  }

  onModuleDestroy(): void {
    while (this.registrations.length > 0) {
      const reg = this.registrations.pop()!;
      this.emitter.off(reg.event, reg.listener);
    }
  }

  /**
   * Scans an instance for `@OnEvent()`-decorated methods and binds them to
   * `EventEmitterService`.
   */
  registerListenersFromInstance(instance: object): void {
    const subscriptions: PendingSubscription[] = [];
    this.collectSubscriptionsFromStaticInstance(instance, subscriptions);
    this.registerSubscriptions(subscriptions);
  }

  private loadEventListeners(): void {
    const discovery = this.resolveDiscoveryService();
    if (!discovery) {
      return;
    }

    const subscriptions: PendingSubscription[] = [];
    const seenStaticInstances = new Set<object>();
    const seenScopedTokens = new Map<string, Set<InjectionToken>>();
    const wrappers: InstanceWrapper[] = [
      ...discovery.getProviders(),
      ...discovery.getControllers(),
    ];

    for (const wrapper of wrappers) {
      if (wrapper.instance === this) {
        continue;
      }

      if (wrapper.isDependencyTreeStatic) {
        const instance = wrapper.instance;
        if (
          !instance ||
          typeof instance !== "object" ||
          seenStaticInstances.has(instance)
        ) {
          continue;
        }
        seenStaticInstances.add(instance);
        this.collectSubscriptionsFromStaticInstance(instance, subscriptions);
        continue;
      }

      let ctor: unknown = isFunction(wrapper.metatype)
        ? wrapper.metatype
        : undefined;
      if (!ctor && isObject(wrapper.instance)) {
        ctor = (wrapper.instance as { constructor?: unknown }).constructor;
      }
      if (!isFunction(ctor) || ctor === Object) {
        continue;
      }

      let moduleTokens = seenScopedTokens.get(wrapper.moduleId);
      if (!moduleTokens) {
        moduleTokens = new Set<InjectionToken>();
        seenScopedTokens.set(wrapper.moduleId, moduleTokens);
      }
      if (moduleTokens.has(wrapper.token)) {
        continue;
      }
      moduleTokens.add(wrapper.token);

      this.collectSubscriptionsFromRequestScopedWrapper(
        wrapper,
        ctor,
        subscriptions,
      );
    }

    this.registerSubscriptions(subscriptions);
  }

  private collectSubscriptionsFromStaticInstance(
    instance: object,
    subscriptions: PendingSubscription[],
  ): void {
    const ctor = instance.constructor;
    if (typeof ctor !== "function" || ctor === Object) {
      return;
    }

    const metadata = getOnEventMetadata(ctor);
    if (metadata.length === 0) {
      return;
    }

    const record = instance as Record<string | symbol, unknown>;
    for (const meta of metadata) {
      const method = record[meta.methodName];
      if (typeof method !== "function") {
        continue;
      }

      const listenerOptions: OnEventOptions = {
        ...meta.options,
        suppressErrors: meta.options?.suppressErrors ?? true,
      };
      const handlerFn = method as (...params: unknown[]) => unknown;
      const useExternalContext = hasEventEnhancersOrParams(
        ctor,
        handlerFn,
        meta.methodName,
      );
      const boundListener: EventListener = useExternalContext
        ? this.resolveExternalContextCreator().create(
            instance,
            handlerFn,
            meta.methodName,
            EVENT_PARAMS_METADATA,
            EVENT_PARAMS_FACTORY,
            undefined,
            undefined,
            { guards: true, interceptors: true, filters: true, pipes: true },
            "rpc",
          )
        : (...args: unknown[]) => handlerFn.apply(instance, args);

      for (const event of meta.events) {
        subscriptions.push({
          priority: this.resolvePriority(listenerOptions),
          prepend: listenerOptions.prependListener === true,
          order: subscriptions.length,
          register: () => {
            if (listenerOptions.prependListener) {
              this.emitter.prependListener(
                event,
                boundListener,
                listenerOptions,
              );
            } else {
              this.emitter.on(event, boundListener, listenerOptions);
            }
            this.registrations.push({ event, listener: boundListener });
          },
        });
      }
    }
  }

  private collectSubscriptionsFromRequestScopedWrapper(
    wrapper: InstanceWrapper,
    ctor: Function,
    subscriptions: PendingSubscription[],
  ): void {
    const metadata = getOnEventMetadata(ctor);
    if (metadata.length === 0) {
      return;
    }

    for (const meta of metadata) {
      const listenerOptions: OnEventOptions = {
        ...meta.options,
        suppressErrors: meta.options?.suppressErrors ?? true,
      };

      const scopedListener: EventListener = async (...args: unknown[]) => {
        const requestPayload = args.length > 1 ? args : args[0];
        const contextId = this.options.inheritRequestContextId
          ? ContextIdFactory.getByRequest(requestPayload as object)
          : ContextIdFactory.getByRequest({ payload: requestPayload });

        const targetModuleRef = wrapper.moduleRef ?? this.moduleRef;
        targetModuleRef.registerRequestByContextId(requestPayload, contextId);

        let contextInstance: unknown;
        try {
          contextInstance = await targetModuleRef.resolve(
            wrapper.token,
            contextId,
            { strict: false },
          );
        } catch (error) {
          const suppress =
            listenerOptions.suppressErrors ??
            this.options.ignoreErrors ??
            true;
          if (!suppress) {
            throw error;
          }
          this.logger.error(
            error instanceof Error ? error.message : String(error),
            error instanceof Error ? error.stack : undefined,
          );
          return undefined;
        }

        const record = contextInstance as Record<string | symbol, unknown>;
        const method = record?.[meta.methodName];
        if (typeof method !== "function") {
          return undefined;
        }
        const handlerFn = method as (...params: unknown[]) => unknown;
        if (hasEventEnhancersOrParams(ctor, handlerFn, meta.methodName)) {
          const wrapped = this.resolveExternalContextCreator().create(
            contextInstance as object,
            handlerFn,
            meta.methodName,
            EVENT_PARAMS_METADATA,
            EVENT_PARAMS_FACTORY,
            contextId,
            undefined,
            { guards: true, interceptors: true, filters: true, pipes: true },
            "rpc",
          );
          return await wrapped(...args);
        }
        return await handlerFn.apply(contextInstance, args);
      };

      for (const event of meta.events) {
        subscriptions.push({
          priority: this.resolvePriority(listenerOptions),
          prepend: listenerOptions.prependListener === true,
          order: subscriptions.length,
          register: () => {
            if (listenerOptions.prependListener) {
              this.emitter.prependListener(
                event,
                scopedListener,
                listenerOptions,
              );
            } else {
              this.emitter.on(event, scopedListener, listenerOptions);
            }
            this.registrations.push({ event, listener: scopedListener });
          },
        });
      }
    }
  }

  private registerSubscriptions(subscriptions: PendingSubscription[]): void {
    const prepended = subscriptions.filter((item) => item.prepend);
    const appended = subscriptions.filter((item) => !item.prepend);

    // Prepended listeners are added via unshift(), so sorting ascending by
    // priority leaves the highest-priority listener at the head of the list.
    prepended.sort(
      (left, right) =>
        this.comparePriorities(left.priority, right.priority) ||
        left.order - right.order,
    );
    appended.sort(
      (left, right) =>
        this.comparePriorities(right.priority, left.priority) ||
        left.order - right.order,
    );

    for (const sub of prepended) {
      sub.register();
    }
    for (const sub of appended) {
      sub.register();
    }
  }

  private resolvePriority(options?: OnEventOptions): number {
    const priority = options?.priority;
    if (typeof priority === "number" && !Number.isNaN(priority)) {
      return priority;
    }
    return DEFAULT_LISTENER_PRIORITY;
  }

  private comparePriorities(left: number, right: number): number {
    if (left === right) {
      return 0;
    }
    return left < right ? -1 : 1;
  }

  private resolveDiscoveryService(): DiscoveryService | undefined {
    let discovery = this.discoveryService;
    if (!discovery && this.moduleRef) {
      try {
        discovery = this.moduleRef.get(DiscoveryService, { strict: false });
      } catch {
        discovery = undefined;
      }
    }
    return discovery;
  }

  private resolveExternalContextCreator(): ExternalContextCreator {
    if (this.externalContextCreator) {
      return this.externalContextCreator;
    }
    if (this.moduleRef) {
      try {
        const resolved = this.moduleRef.get(ExternalContextCreator, {
          strict: false,
        });
        if (resolved) {
          return resolved;
        }
      } catch {
        // Fallback to standalone instance when not bound in DI
      }
    }
    return new ExternalContextCreator();
  }
}
