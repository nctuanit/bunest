# Lifecycle events

Bunest manages startup and graceful shutdown in **deterministic topological order** via `LifecycleManager` (`@bunest/core`, [ADR-007](/architecture/adrs)). Dependencies always initialize _before_ their dependents and shut down _after_ their dependents.

## Lifecycle Hooks Sequence

### Bootstrap Phase (Bottom-Up Topological Order)

1. Validate full module graph, exports, token visibility, dependency cycles, and scope leaks.
2. Instantiate singleton providers (awaiting async `useFactory`) and singleton controllers.
3. **`onModuleInit()`** — called on every provider, controller, and module implementing `OnModuleInit` once the host module's dependencies are resolved.
4. **`onApplicationBootstrap()`** — called on all instances implementing `OnApplicationBootstrap` once all modules are initialized, **before** `Bun.serve()` starts accepting traffic.

### Graceful Shutdown Phase (Reverse Topological Order)

1. Stop accepting new HTTP connections (`server.stop()`).
2. **`onModuleDestroy()`** — teardown resources belonging to each module (dependents first, dependencies last).
3. **`beforeApplicationShutdown(signal?)`** — flush buffers, drain in-flight jobs, emit shutdown telemetry.
4. **`onApplicationShutdown(signal?)`** — final cleanup (close SQLite/SQL pools, release file handles) once connections have drained.

### Per-Request Cleanup Hook

- **`onRequestDestroy()`** — called automatically on `Scope.REQUEST` providers in reverse instantiation order inside a `finally` block when an HTTP request completes, throws, or is aborted via `request.signal`.

## Implementing Lifecycle Interfaces

@@filename(database.service.ts)

```ts
import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@bunest/core";
import { Database } from "bun:sqlite";

@Injectable()
export class DatabaseService
  implements
    OnModuleInit,
    OnApplicationBootstrap,
    OnModuleDestroy,
    BeforeApplicationShutdown,
    OnApplicationShutdown
{
  private readonly logger = new Logger(DatabaseService.name);
  private db!: Database;

  async onModuleInit() {
    this.db = new Database(":memory:");
    this.db.run("CREATE TABLE IF NOT EXISTS health (ok INTEGER)");
    this.logger.log("SQLite schema initialized");
  }

  onApplicationBootstrap() {
    this.logger.log("Database ready before HTTP traffic starts");
  }

  onModuleDestroy() {
    this.logger.log("Draining module queries...");
  }

  beforeApplicationShutdown(signal?: string) {
    this.logger.warn(`Preparing shutdown (signal=${signal ?? "manual"})`);
  }

  onApplicationShutdown() {
    this.db.close();
    this.logger.log("SQLite connection closed cleanly");
  }
}
```

## Enabling OS Shutdown Hooks

Call `app.enableShutdownHooks()` during bootstrap to hook `SIGINT` and `SIGTERM` into `LifecycleManager` automatically:

@@filename(main.ts)

```ts
const app = await BunestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(3000);
```

> info **Request-Scoped Providers** Providers marked `Scope.REQUEST` are NOT instantiated at bootstrap and therefore do not trigger `onModuleInit` or `onApplicationBootstrap`. Implement `OnRequestDestroy` (or standard `Symbol.dispose` / `Symbol.asyncDispose`) for per-request cleanup.
