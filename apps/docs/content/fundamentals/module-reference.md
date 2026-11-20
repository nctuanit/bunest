# Module reference

Bunest exposes `ModuleRef` from `@bunest/core` so services can programmatically look up existing singleton providers, resolve transient/request-scoped instances, or dynamically instantiate classes with full constructor DI.

## Injecting `ModuleRef`

`ModuleRef` is automatically available inside every module without extra registration:

@@filename(plugin-runner.service.ts)
```ts
import { Injectable, ModuleRef, type OnModuleInit } from "@bunest/core";
import { EmailNotifier } from "./email-notifier.service";
import { TransientJobHandler } from "./transient-job.handler";

@Injectable()
export class PluginRunnerService implements OnModuleInit {
  private notifier!: EmailNotifier;

  constructor(private readonly moduleRef: ModuleRef) {}

  onModuleInit() {
    // Synchronous lookup for an existing singleton visible to this module
    this.notifier = this.moduleRef.get(EmailNotifier);
  }

  async runDynamicJob() {
    // Async resolution for TRANSIENT or REQUEST-scoped providers
    const job = await this.moduleRef.resolve(TransientJobHandler);
    await job.execute();
    this.notifier.notify("Job complete");
  }
}
```

## `ModuleRef` Methods

| Method | Sync / Async | Behavior |
|---|---|---|
| `get(token, { strict? })` | Sync | Retrieves an already-instantiated singleton. With `strict: true` *(default)*, respects the owning module's visibility rules. With `strict: false`, searches across the entire application graph. |
| `resolve(token, requestContainer?, { strict? })` | Async | Resolves `SINGLETON`, `TRANSIENT` (fresh instance per call), or `REQUEST` (bound to the given `RequestContainer`) providers. |
| `create(ClassType, requestContainer?)` | Async | Instantiates a class that was **not** registered in `providers`, injecting all of its constructor dependencies from the container. |

## Strict vs Global Lookup

@@filename(global-lookup.service.ts)
```ts
// Respects module encapsulation (default: strict = true)
const localService = this.moduleRef.get(LocalService);

// Cross-module lookup (strict = false)
const analytics = this.moduleRef.get(AnalyticsService, { strict: false });
```

> info **Hint** Prefer standard constructor injection whenever dependencies are known statically—it participates in bootstrap validation (missing token, cycle, and scope-leak checks). Reserve `ModuleRef` for plugin registries, dynamic strategies, and lazy orchestration.
