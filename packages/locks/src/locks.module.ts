import {
  Module,
  type DynamicModule,
  type OnModuleInit,
} from "@bunest/common";
import { DiscoveryModule } from "@bunest/core";
import { LocksContext } from "./context/locks.context";
import { WithLockAspectHandler } from "./decorators/with-lock.decorator";
import { LocksEvents } from "./events/locks-events.service";
import type {
  LocksModuleAsyncOptions,
  LocksModuleForRootOptions,
} from "./interfaces/locks-module-options.interface";
import { LOCK_STORAGE } from "./locks.constants";
import { ConfigurableModuleClass } from "./locks.module-definition";
import { Locks } from "./locks.service";
import { LeaderElections } from "./services/leader-elections.service";
import { LockKeys } from "./services/lock-keys.service";
import { ScheduledJobs } from "./services/scheduled-jobs.service";
import { LocksStorage, storeOptionError } from "./storage/locks.storage";

/**
 * `LocksModule.forRoot({ ttl, clock, allowInMemoryStorage })`, or `forRootAsync({ imports,
 * inject, useFactory | useClass | useExisting })`, where the factory returns the options.
 * Global by default.
 *
 * Provides `Locks` (acquire, withLock), `LocksContext`, `LocksEvents` and `LocksStorage`,
 * where the app's store registers itself (without one, locks live in memory). It also runs
 * the application's `@OnOneInstance()` and `@WithoutOverlapping()` jobs, and its
 * `@LeaderElection()` providers.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [
    LocksStorage,
    LocksEvents,
    Locks,
    LocksContext,
    LockKeys,
    ScheduledJobs,
    LeaderElections,
    WithLockAspectHandler,
  ],
  exports: [
    LocksStorage,
    LocksEvents,
    Locks,
    LocksContext,
    WithLockAspectHandler,
  ],
})
export class LocksModule
  extends ConfigurableModuleClass
  implements OnModuleInit
{
  constructor(private readonly storage: LocksStorage) {
    super();
  }

  static override forRoot(
    options: LocksModuleForRootOptions = {},
  ): DynamicModule {
    if (options && "store" in options) {
      throw storeOptionError();
    }
    return super.forRoot(options);
  }

  /** Options from `useFactory` (with `inject`), or from a class that implements `LocksOptionsFactory`. */
  static override forRootAsync(options: LocksModuleAsyncOptions): DynamicModule {
    if (options && "store" in options) {
      throw storeOptionError();
    }
    return super.forRootAsync(options);
  }

  /**
   * Every provider constructor has run (so the store provider has registered), and no
   * scheduled job has run yet: the registry locks here, if a read in another module's
   * `onModuleInit` hasn't locked it already.
   */
  onModuleInit(): void {
    this.storage[LOCK_STORAGE]();
  }
}
