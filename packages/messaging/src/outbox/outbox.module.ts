import { type DynamicModule, Module, type OnModuleInit } from "@bunest/core";
import { DiscoveryModule } from "@bunest/core";
import { OutboxEvents } from "./events/outbox-events.service";
import type { OutboxModuleOptions } from "./interfaces/outbox-module-options.interface";
import { LOCAL_TRANSPORT } from "./outbox.constants";
import {
  ConfigurableModuleClass,
  OUTBOX_MODULE_OPTIONS,
  OUTBOX_TRANSPORTS,
  type OutboxModuleAsyncOptions,
  type OutboxModuleRootOptions,
  storeOptionError,
} from "./outbox.module-definition";
import { Outbox } from "./outbox.service";
import { OutboxDeadLetters } from "./services/outbox-dead-letters.service";
import { OutboxDispatcher } from "./services/outbox-dispatcher.service";
import { OutboxInbox } from "./services/outbox-inbox.service";
import { OutboxRelay } from "./services/outbox-relay.service";
import {
  LOCK_STORAGE,
  OutboxStorage,
  STORAGE_USAGE,
} from "./storage/outbox.storage";
import type { OutboxTransport } from "./transports/outbox.transport";

/**
 * `OutboxModule.forRoot({ transports, route, relay, retry })`, or
 * `forRootAsync({ transports, imports, inject, useFactory })`. Global by default.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [
    OutboxStorage,
    OutboxInbox,
    OutboxEvents,
    OutboxDispatcher,
    {
      provide: OutboxRelay,
      inject: [
        OUTBOX_MODULE_OPTIONS,
        OutboxStorage,
        OUTBOX_TRANSPORTS,
        OutboxDispatcher,
        OutboxEvents,
      ],
      useFactory: (
        options: OutboxModuleOptions,
        storage: OutboxStorage,
        transports: Record<string, OutboxTransport>,
        dispatcher: OutboxDispatcher,
        events: OutboxEvents,
      ) =>
        new OutboxRelay({
          ...options,
          store: () => storage.messages,
          transports: { ...transports, [LOCAL_TRANSPORT]: dispatcher },
          events,
        }),
    },
    Outbox,
    OutboxDeadLetters,
  ],
  exports: [
    OutboxStorage,
    Outbox,
    OutboxRelay,
    OutboxDeadLetters,
    OutboxInbox,
    OutboxEvents,
  ],
})
export class OutboxModule
  extends ConfigurableModuleClass
  implements OnModuleInit
{
  constructor(
    private readonly storage: OutboxStorage,
    dispatcher: OutboxDispatcher,
  ) {
    super();
    storage[STORAGE_USAGE] = () => dispatcher.storageUsage();
  }

  static override forRoot(
    options: OutboxModuleRootOptions = {},
  ): DynamicModule {
    if (options && "store" in options) {
      throw storeOptionError();
    }
    return super.forRoot(options as unknown as OutboxModuleOptions);
  }

  static override forRootAsync(
    options: OutboxModuleAsyncOptions,
  ): DynamicModule {
    if (options && "store" in options) {
      throw storeOptionError();
    }
    return super.forRootAsync(options);
  }

  onModuleInit(): void {
    this.storage[LOCK_STORAGE]();
  }
}
