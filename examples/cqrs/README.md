# CQRS — Heroes & Dragons (`cqrs`)

Bunest counterpart of NestJS's official **CQRS** recipe (`CommandBus`, `QueryBus`, `EventBus`, `AggregateRoot`, `EventPublisher`, and `@Saga()`), powered by `@bunest/messaging/cqrs` with native `async`/`await` (no RxJS):

- **Commands**: `KillDragonCommand` & `DropAncientItemCommand` handled by `@CommandHandler`
- **Queries**: `GetHeroesQuery` handled by `@QueryHandler`
- **AggregateRoot & Events**: `Hero` applies `HeroKilledDragonEvent` & `HeroFoundItemEvent` and commits via `EventPublisher`
- **Saga**: `HeroesGameSagas` (`@Saga()`) reacts to `HeroKilledDragonEvent` and dispatches `DropAncientItemCommand` automatically

## Run

```bash
bun run --cwd examples/cqrs dev
bun run --cwd examples/cqrs test
```
