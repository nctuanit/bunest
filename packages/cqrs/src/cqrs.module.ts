import {
  Injectable,
  MetadataRegistry,
  Module,
  Optional,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type Provider,
} from "@bunest/common";
import {
  DiscoveryService,
  ModuleRef,
  type InstanceWrapper,
} from "@bunest/core";
import { CommandBus } from "./command-bus";
import { EventBus } from "./event-bus";
import { EventPublisher } from "./event-publisher";
import type {
  CommandType,
  CqrsModuleAsyncOptions,
  CqrsModuleOptions,
  CqrsModuleOptionsFactory,
  EventType,
  ICommandHandler,
  IEvent,
  IEventHandler,
  IQueryHandler,
  QueryType,
  SagaMethodMetadata,
} from "./interfaces";
import { QueryBus } from "./query-bus";
import { AggregateRootStorage } from "./storages/aggregate-root.storage";
import {
  COMMAND_HANDLER_METADATA,
  CQRS_MODULE_OPTIONS,
  EVENTS_HANDLER_METADATA,
  QUERY_HANDLER_METADATA,
  SAGA_METADATA,
} from "./tokens";
import { UnhandledExceptionBus } from "./unhandled-exception-bus";

function collectMergedClassArray<T>(key: symbol, target: Function): T[] {
  const chain: Function[] = [];
  let cursor: Function | null = target;
  while (cursor && cursor !== Function.prototype && cursor !== Object) {
    chain.push(cursor);
    const parent = Object.getPrototypeOf(cursor);
    cursor = typeof parent === "function" ? parent : null;
  }
  chain.reverse();

  const merged: T[] = [];
  for (const ctor of chain) {
    const own = MetadataRegistry.getOwn<readonly T[]>(key, ctor);
    if (own) {
      merged.push(...own);
    }
  }
  return merged;
}

function resolveDiscoveryService(
  discoveryService: DiscoveryService | undefined,
  moduleRef: ModuleRef | undefined,
): DiscoveryService | undefined {
  if (discoveryService) {
    return discoveryService;
  }
  if (!moduleRef) {
    return undefined;
  }
  try {
    return moduleRef.get(DiscoveryService, { strict: false });
  } catch {
    return undefined;
  }
}

function getAllLoadedWrappers(
  discoveryService: DiscoveryService | undefined,
  moduleRef: ModuleRef | undefined,
): InstanceWrapper[] {
  const discovery = resolveDiscoveryService(discoveryService, moduleRef);
  if (!discovery) {
    return [];
  }
  const seen = new Set<InstanceWrapper>();
  const wrappers: InstanceWrapper[] = [];
  for (const wrapper of [
    ...discovery.getProviders(),
    ...discovery.getControllers(),
  ]) {
    if (!seen.has(wrapper)) {
      seen.add(wrapper);
      wrappers.push(wrapper);
    }
  }
  return wrappers;
}

function resolveWrapperMetatype(wrapper: InstanceWrapper): Function | undefined {
  if (wrapper.instance && typeof wrapper.instance === "object") {
    const ctor = (wrapper.instance as { constructor?: Function }).constructor;
    if (typeof ctor === "function") {
      return ctor;
    }
  }
  return typeof wrapper.metatype === "function" ? wrapper.metatype : undefined;
}

/**
 * Discovers all `@CommandHandler`, `@QueryHandler`, `@EventsHandler`, `@Saga`,
 * and `@Publishable` providers across loaded modules on `onApplicationBootstrap`
 * and cleans up on `onModuleDestroy`.
 */
@Injectable()
export class CqrsExplorer implements OnApplicationBootstrap, OnModuleDestroy {
  private explored = false;

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly eventBus: EventBus,
    @Optional()
    private readonly discoveryService?: DiscoveryService,
  ) {}

  explore(): void {
    if (this.explored) {
      return;
    }
    this.explored = true;

    const wrappers = getAllLoadedWrappers(
      this.discoveryService,
      this.moduleRef,
    );

    const commandWrappers: InstanceWrapper<ICommandHandler>[] = [];
    const queryWrappers: InstanceWrapper<IQueryHandler>[] = [];
    const eventWrappers: InstanceWrapper<IEventHandler>[] = [];
    const sagaWrappers: InstanceWrapper<object>[] = [];

    for (const wrapper of wrappers) {
      const ctor = resolveWrapperMetatype(wrapper);
      if (!ctor) continue;

      const commandType = MetadataRegistry.get<CommandType>(
        COMMAND_HANDLER_METADATA,
        ctor,
      );
      if (commandType) {
        commandWrappers.push(wrapper as InstanceWrapper<ICommandHandler>);
      }

      const queryType = MetadataRegistry.get<QueryType>(
        QUERY_HANDLER_METADATA,
        ctor,
      );
      if (queryType) {
        queryWrappers.push(wrapper as InstanceWrapper<IQueryHandler>);
      }

      const eventTypes = MetadataRegistry.get<readonly EventType[]>(
        EVENTS_HANDLER_METADATA,
        ctor,
      );
      if (eventTypes && eventTypes.length > 0) {
        eventWrappers.push(wrapper as InstanceWrapper<IEventHandler>);
      }

      const sagaMetas = collectMergedClassArray<SagaMethodMetadata>(
        SAGA_METADATA,
        ctor,
      );
      if (sagaMetas.length > 0) {
        sagaWrappers.push(wrapper as InstanceWrapper<object>);
      }
    }

    this.commandBus.register(commandWrappers);
    this.queryBus.register(queryWrappers);
    this.eventBus.register(eventWrappers);
    this.eventBus.registerSagas(sagaWrappers);
    AggregateRootStorage.mergeContext(this.eventBus);
  }

  onApplicationBootstrap(): void {
    this.explore();
  }

  async onModuleDestroy(): Promise<void> {
    await this.eventBus.waitForSagas();
    this.eventBus.clear();
    this.commandBus.clear();
    this.queryBus.clear();
    this.explored = false;
  }
}

/**
 * Bunest CQRS module registering `CommandBus`, `QueryBus`, `EventBus`,
 * `UnhandledExceptionBus`, `EventPublisher`, and automatic decorator discovery.
 */
@Module({
  providers: [
    CommandBus,
    QueryBus,
    EventBus,
    UnhandledExceptionBus,
    EventPublisher,
    CqrsExplorer,
  ],
  exports: [
    CommandBus,
    QueryBus,
    EventBus,
    UnhandledExceptionBus,
    EventPublisher,
  ],
})
export class CqrsModule<EventBase extends IEvent = IEvent>
  implements OnApplicationBootstrap
{
  constructor(
    private readonly explorer: CqrsExplorer,
    private readonly eventBus: EventBus<EventBase>,
  ) {}

  static forRoot(options: CqrsModuleOptions = {}): DynamicModule {
    return {
      module: CqrsModule,
      global: options.global ?? true,
      providers: [
        {
          provide: CQRS_MODULE_OPTIONS,
          useValue: options,
        },
      ],
    };
  }

  static forRootAsync(options: CqrsModuleAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(options);
    return {
      module: CqrsModule,
      global: options.global ?? true,
      imports: options.imports ?? [],
      providers: [...asyncProviders, ...(options.extraProviders ?? [])],
      exports: [CQRS_MODULE_OPTIONS],
    };
  }

  private static createAsyncProviders(
    options: CqrsModuleAsyncOptions,
  ): Provider[] {
    if (options.useValue !== undefined) {
      return [
        {
          provide: CQRS_MODULE_OPTIONS,
          useValue: options.useValue,
        },
      ];
    }
    if (options.useFactory) {
      return [
        {
          provide: CQRS_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ];
    }
    if (options.useClass) {
      return [
        {
          provide: options.useClass,
          useClass: options.useClass,
        },
        {
          provide: CQRS_MODULE_OPTIONS,
          useFactory: async (factory: CqrsModuleOptionsFactory) =>
            await factory.createCqrsOptions(),
          inject: [options.useClass],
        },
      ];
    }
    if (options.useExisting) {
      return [
        {
          provide: CQRS_MODULE_OPTIONS,
          useFactory: async (factory: CqrsModuleOptionsFactory) =>
            await factory.createCqrsOptions(),
          inject: [options.useExisting],
        },
      ];
    }
    throw new Error(
      "Invalid CqrsModuleAsyncOptions configuration. Provide useValue, useFactory, useClass, or useExisting.",
    );
  }

  onApplicationBootstrap(): void {
    this.explorer.explore();
    AggregateRootStorage.mergeContext(this.eventBus);
  }
}
