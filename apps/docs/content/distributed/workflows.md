# Durable Workflows

**`@bunest/workflows`** lets you write durable, fault-tolerant long-running workflows as plain TypeScript `async` functions—with deterministic replay, crash recovery, durable timers, external signals, compensating sagas, child workflows, cron schedules, AES-256-GCM payload encryption (`AesGcmPayloadCodec`), and zero external runtime dependencies.

## Installation

```bash
bun add @bunest/workflows
```

## Subpath Exports

| Subpath | Purpose |
|---|---|
| `@bunest/workflows` | Core decorators, `WorkflowsModule`, `WorkflowClient`, `InMemoryWorkflowStore`, `AesGcmPayloadCodec`, `ManualWorkflowClock` |
| `@bunest/workflows/postgres` | PostgreSQL durable workflow store over `Bun.SQL` |
| `@bunest/workflows/mysql` | MySQL / MariaDB durable workflow store over `Bun.SQL` |
| `@bunest/workflows/cqrs` | Integration bridge with [`@bunest/cqrs`](/distributed/cqrs) commands and events |
| `@bunest/workflows/testing` | Deterministic workflow replay & time-travel test harness |
| `@bunest/workflows/core` | Framework-agnostic durable execution engine |

## Quick Start

@@filename(onboarding.workflow.ts)
```ts
import { Module } from "@bunest/core";
import { InMemoryWorkflowStore, WorkflowsModule } from "@bunest/workflows";

@Module({
  imports: [
    WorkflowsModule.forRoot({
      store: new InMemoryWorkflowStore(),
    }),
  ],
})
export class AppModule {}
```

Write workflow steps as deterministic durable operations—if the process restarts mid-workflow, completed steps replay from persisted history instead of re-executing side effects.

> info **Durable AI Agents** Pair `@bunest/workflows` with [`@bunest/ai/workflows`](/ai/ai-sdk) for multi-step AI agent loops with human-in-the-loop tool approval and crash-safe replay.
