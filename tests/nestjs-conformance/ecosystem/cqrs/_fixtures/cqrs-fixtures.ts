import {
  Inject,
  Injectable,
  Logger,
  Module,
  REQUEST,
  Scope,
  type OnModuleInit,
} from "../../../../../packages/core/src/common";
import {
  AggregateRoot,
  AsyncContext,
  CommandHandler,
  CqrsModule,
  DefaultPubSub,
  EventBus,
  EventPublisher,
  EventsHandler,
  QueryHandler,
  Saga,
  WithAggregateRoot,
  type ICommand,
  type ICommandHandler,
  type IEvent,
  type IEventHandler,
  type IEventPublisher,
  type IQueryHandler,
} from "../../../../../packages/messaging/src/cqrs";

export const waitImmediate = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

export const sleepUnref = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

// ============================================================================
// Errors fixtures
// ============================================================================

export class UnhandledExceptionCommand {
  constructor(public readonly failAt: "command" | "event" | "saga") {}
}

export class UnhandledExceptionEvent {
  constructor(public readonly failAt: "command" | "event" | "saga") {}
}

@CommandHandler(UnhandledExceptionCommand)
export class UnhandledExceptionCommandHandler implements ICommandHandler<UnhandledExceptionCommand> {
  constructor(private readonly eventBus: EventBus) {}

  async execute(command: UnhandledExceptionCommand) {
    if (command.failAt === "command") {
      throw new Error(`Unhandled exception in ${command.failAt}`);
    } else {
      this.eventBus.publish(new UnhandledExceptionEvent(command.failAt));
    }
  }
}

@EventsHandler(UnhandledExceptionEvent)
export class UnhandledExceptionEventHandler implements IEventHandler<UnhandledExceptionEvent> {
  async handle(event: UnhandledExceptionEvent) {
    if (event.failAt === "event") {
      throw new Error(`Unhandled exception in ${event.failAt}`);
    }
  }
}

// ADR-008: Zero-RxJS @Saga() receives each published event directly
@Injectable()
export class ErrorsSagas {
  @Saga()
  onError = async (event: IEvent): Promise<undefined> => {
    if (event instanceof UnhandledExceptionEvent) {
      await sleepUnref(150);
      if (event.failAt === "saga") {
        throw new Error(`Unhandled exception in ${event.failAt}`);
      }
    }
    return undefined;
  };
}

// ============================================================================
// Heroes fixtures
// ============================================================================

export const DRAGON_ID = "4567";
export const HERO_ID = "1234";
export const ANCIENT_ITEM_ID = "12456789";

export class KillDragonCommand {
  constructor(
    public readonly heroId: string,
    public readonly dragonId: string,
  ) {}
}

export class DropAncientItemCommand {
  constructor(
    public readonly heroId: string,
    public readonly itemId: string,
  ) {}
}

export class DragonDiedEvent {
  constructor(public readonly dragonId: string) {}
}

export class HeroFoundItemEvent {
  constructor(
    public readonly heroId: string,
    public readonly itemId: string,
  ) {}
}

export class HeroKilledDragonEvent {
  constructor(
    public readonly heroId: string,
    public readonly dragonId: string,
  ) {}
}

export class GetHeroQuery {
  constructor(public readonly id: number) {}
}

export class GetHeroesQuery {}

export abstract class Enemy {
  constructor(protected readonly id: string) {}
  abstract die(): void;
}

export abstract class Monster extends Enemy {
  protected abstract roar(): void;
}

export class Dragon extends WithAggregateRoot(Monster) {
  roar(): void {
    Logger.debug("Roarrrr!");
  }
  die(): void {
    this.roar();
    this.apply(new DragonDiedEvent(this.id));
  }
}

export class Hero extends AggregateRoot {
  constructor(private readonly id: string) {
    super();
  }

  killEnemy(enemyId: string) {
    this.apply(new HeroKilledDragonEvent(this.id, enemyId));
  }

  addItem(itemId: string) {
    this.apply(new HeroFoundItemEvent(this.id, itemId));
  }
}

export const dragonMonster = new Dragon(DRAGON_ID);
export const userHero = new Hero(HERO_ID);

@Injectable()
export class EnemyRepository {
  async findOneById(_id: string): Promise<Enemy> {
    return dragonMonster;
  }

  async findAll(): Promise<Enemy[]> {
    return [dragonMonster];
  }
}

@Injectable()
export class HeroRepository {
  async findOneById(_id: number): Promise<Hero> {
    return userHero;
  }

  async findAll(): Promise<Hero[]> {
    return [userHero];
  }
}

@CommandHandler(KillDragonCommand)
export class KillDragonHandler implements ICommandHandler<KillDragonCommand> {
  constructor(
    private readonly repository: HeroRepository,
    private readonly publisher: EventPublisher,
  ) {}

  async execute(command: KillDragonCommand) {
    const { heroId, dragonId } = command;
    const hero = this.publisher.mergeObjectContext(
      await this.repository.findOneById(+heroId),
    );
    hero.killEnemy(dragonId);
    hero.commit();
  }
}

@CommandHandler(DropAncientItemCommand)
export class DropAncientItemHandler implements ICommandHandler<DropAncientItemCommand> {
  constructor(
    private readonly repository: HeroRepository,
    private readonly publisher: EventPublisher,
  ) {}

  async execute(command: DropAncientItemCommand) {
    const { heroId, itemId } = command;
    const hero = this.publisher.mergeObjectContext(
      await this.repository.findOneById(+heroId),
    );
    hero.addItem(itemId);
    hero.commit();
  }
}

@EventsHandler(HeroKilledDragonEvent)
export class HeroKilledDragonHandler implements IEventHandler<HeroKilledDragonEvent> {
  constructor(
    private readonly repository: EnemyRepository,
    private readonly publisher: EventPublisher,
  ) {}

  async handle(event: HeroKilledDragonEvent) {
    const dragon = this.publisher.mergeObjectContext(
      (await this.repository.findOneById(event.dragonId)) as Dragon,
    );
    dragon.die();
    dragon.commit();
  }
}

@EventsHandler(HeroFoundItemEvent)
export class HeroFoundItemHandler implements IEventHandler<HeroFoundItemEvent> {
  handle(_event: HeroFoundItemEvent) {}
}

@EventsHandler(DragonDiedEvent)
export class DragonDiedHandler implements IEventHandler<DragonDiedEvent> {
  handle(_event: DragonDiedEvent) {}
}

@QueryHandler(GetHeroesQuery)
export class GetHeroesHandler implements IQueryHandler<GetHeroesQuery> {
  constructor(private readonly repository: HeroRepository) {}

  async execute(_query: GetHeroesQuery) {
    return this.repository.findAll();
  }
}

@QueryHandler(GetHeroQuery)
export class GetHeroHandler implements IQueryHandler<GetHeroQuery> {
  constructor(private readonly repository: HeroRepository) {}

  async execute(query: GetHeroQuery) {
    return this.repository.findOneById(query.id);
  }
}

// ADR-008: Zero-RxJS @Saga()
@Injectable()
export class HeroesGameSagas {
  @Saga()
  dragonKilled = async (event: IEvent): Promise<ICommand | undefined> => {
    if (event instanceof HeroKilledDragonEvent) {
      await sleepUnref(150);
      return new DropAncientItemCommand(event.heroId, ANCIENT_ITEM_ID);
    }
    return undefined;
  };
}

@Module({
  providers: [
    HeroRepository,
    EnemyRepository,
    KillDragonHandler,
    {
      provide: DropAncientItemHandler,
      inject: [HeroRepository, EventPublisher],
      useFactory: (repository: HeroRepository, publisher: EventPublisher) =>
        new DropAncientItemHandler(repository, publisher),
    },
    HeroKilledDragonHandler,
    HeroFoundItemHandler,
    DragonDiedHandler,
    GetHeroesHandler,
    {
      provide: GetHeroHandler,
      inject: [HeroRepository],
      useFactory: (repository: HeroRepository) =>
        new GetHeroHandler(repository),
    },
    HeroesGameSagas,
  ],
})
export class HeroesGameModule {}

// ============================================================================
// Noop fixtures
// ============================================================================

export class NoopEvent {}

@EventsHandler(NoopEvent)
export class NoopHandler implements IEventHandler<NoopEvent> {
  handle(_event: NoopEvent) {}
}

@Module({
  providers: [NoopHandler],
})
export class NoopModule {}

// ============================================================================
// Request-scoped fixtures
// ============================================================================

export class ScopedKillDragonCommand {
  constructor(
    public readonly heroId: string,
    public readonly dragonId: string,
  ) {}
}

export class ScopedDropAncientItemCommand {
  constructor(
    public readonly heroId: string,
    public readonly itemId: string,
  ) {}
}

export class ScopedHeroKilledDragonEvent {
  constructor(
    public readonly heroId: string,
    public readonly dragonId: string,
  ) {}
}

export class ScopedHeroFoundItemEvent {
  constructor(
    public readonly heroId: string,
    public readonly itemId: string,
  ) {}
}

export class ScopedGetHeroesQuery {}

export class ScopedHero extends AggregateRoot {
  constructor(private readonly id: string) {
    super();
  }

  killEnemy(enemyId: string) {
    this.apply(new ScopedHeroKilledDragonEvent(this.id, enemyId));
  }

  addItem(itemId: string) {
    this.apply(new ScopedHeroFoundItemEvent(this.id, itemId));
  }
}

export const scopedUserHero = new ScopedHero(HERO_ID);

@Injectable()
export class ScopedHeroRepository {
  async findOneById(_id: number): Promise<ScopedHero> {
    return scopedUserHero;
  }

  async findAll(): Promise<ScopedHero[]> {
    return [scopedUserHero];
  }
}

@CommandHandler(ScopedKillDragonCommand, { scope: Scope.REQUEST })
export class ScopedKillDragonHandler implements ICommandHandler<ScopedKillDragonCommand> {
  constructor(
    private readonly repository: ScopedHeroRepository,
    private readonly publisher: EventPublisher,
    @Inject(REQUEST) public readonly context: AsyncContext,
  ) {}

  async execute(command: ScopedKillDragonCommand) {
    const { heroId, dragonId } = command;
    const hero = this.publisher.mergeObjectContext(
      await this.repository.findOneById(+heroId),
      this.context,
    );
    hero.killEnemy(dragonId);
    hero.commit();

    return { heroId, dragonId };
  }
}

@CommandHandler(ScopedDropAncientItemCommand, { scope: Scope.REQUEST })
export class ScopedDropAncientItemHandler implements ICommandHandler<ScopedDropAncientItemCommand> {
  constructor(
    private readonly repository: ScopedHeroRepository,
    private readonly publisher: EventPublisher,
    @Inject(REQUEST) public readonly context: AsyncContext,
  ) {}

  async execute(command: ScopedDropAncientItemCommand) {
    const { heroId, itemId } = command;
    const hero = this.publisher.mergeObjectContext(
      await this.repository.findOneById(+heroId),
      this.context,
    );
    hero.addItem(itemId);
    hero.commit();
  }
}

@EventsHandler(ScopedHeroKilledDragonEvent, { scope: Scope.REQUEST })
export class ScopedHeroKilledDragonHandler implements IEventHandler<ScopedHeroKilledDragonEvent> {
  constructor(@Inject(REQUEST) public readonly context: AsyncContext) {}

  handle(_event: ScopedHeroKilledDragonEvent) {}
}

@EventsHandler(ScopedHeroFoundItemEvent, { scope: Scope.REQUEST })
export class ScopedHeroFoundItemHandler implements IEventHandler<ScopedHeroFoundItemEvent> {
  constructor(@Inject(REQUEST) public readonly context: AsyncContext) {}

  handle(_event: ScopedHeroFoundItemEvent) {}
}

@QueryHandler(ScopedGetHeroesQuery, { scope: Scope.REQUEST })
export class ScopedGetHeroesHandler implements IQueryHandler<ScopedGetHeroesQuery> {
  constructor(
    private readonly repository: ScopedHeroRepository,
    @Inject(REQUEST) public readonly context: AsyncContext,
  ) {}

  async execute(_query: ScopedGetHeroesQuery) {
    return this.repository.findAll();
  }
}

// ADR-008: Zero-RxJS @Saga() preserving AsyncContext.merge(event, command)
@Injectable()
export class ScopedHeroesGameSagas {
  @Saga()
  dragonKilled = async (event: IEvent): Promise<ICommand | undefined> => {
    if (event instanceof ScopedHeroKilledDragonEvent) {
      await sleepUnref(150);
      const command = new ScopedDropAncientItemCommand(
        event.heroId,
        ANCIENT_ITEM_ID,
      );
      AsyncContext.merge(event, command);
      return command;
    }
    return undefined;
  };
}

@Module({
  providers: [
    ScopedHeroRepository,
    ScopedKillDragonHandler,
    ScopedDropAncientItemHandler,
    ScopedHeroKilledDragonHandler,
    ScopedHeroFoundItemHandler,
    ScopedGetHeroesHandler,
    ScopedHeroesGameSagas,
  ],
})
export class ScopedModule {}

@Module({
  imports: [HeroesGameModule, CqrsModule.forRoot(), ScopedModule, NoopModule],
  providers: [
    UnhandledExceptionCommandHandler,
    UnhandledExceptionEventHandler,
    ErrorsSagas,
  ],
})
export class CqrsAppModule {}

// ============================================================================
// Sync / Async slow event handler fixtures
// ============================================================================

@EventsHandler(HeroFoundItemEvent)
export class HeroFoundItemSlowHandler implements IEventHandler<HeroFoundItemEvent> {
  async handle(_event: HeroFoundItemEvent) {
    await waitImmediate();
    this.end();
  }

  end() {}
}

@EventsHandler(HeroKilledDragonEvent)
export class HeroKilledDragonSlowHandler implements IEventHandler<HeroKilledDragonEvent> {
  async handle(_event: HeroKilledDragonEvent) {
    await waitImmediate();
    this.end();
  }

  end() {}
}

@EventsHandler(HeroKilledDragonEvent)
export class HeroKilledDragon2SlowHandler implements IEventHandler<HeroKilledDragonEvent> {
  async handle(_event: HeroKilledDragonEvent) {
    await waitImmediate();
    this.end();
  }

  end() {}
}

const SlowEventHandlers = [
  HeroKilledDragonSlowHandler,
  HeroKilledDragon2SlowHandler,
  HeroFoundItemSlowHandler,
];

/**
 * Fire-and-forget publisher bridging to EventBus.subject$ without awaiting
 * async event handlers (mirrors upstream NestJS default Subject push behavior).
 */
export class FireAndForgetPublisher<
  EventBase extends IEvent = IEvent,
> implements IEventPublisher<EventBase> {
  private inner?: DefaultPubSub<EventBase>;

  bindTo(eventBus: EventBus<EventBase>): void {
    this.inner = new DefaultPubSub<EventBase>(eventBus.subject$);
  }

  publish<T extends EventBase>(event: T): void {
    this.inner?.publish(event);
  }
}

@Module({
  imports: [
    CqrsModule.forRoot({
      eventPublisher: new FireAndForgetPublisher(),
    }),
  ],
  providers: [...SlowEventHandlers],
})
export class AsyncHandlersAppModule implements OnModuleInit {
  constructor(private readonly eventBus: EventBus) {}

  onModuleInit() {
    (this.eventBus.publisher as FireAndForgetPublisher).bindTo(this.eventBus);
  }
}

// Under ADR-008, Bunest's default EventBus awaits all async event handlers natively!
@Module({
  imports: [CqrsModule.forRoot()],
  providers: [...SlowEventHandlers],
})
export class SyncHandlersAppModule {}
