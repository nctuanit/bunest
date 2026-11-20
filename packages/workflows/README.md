# @bunest/workflows

Durable workflows for **Bunest** with zero external workflow server required and zero external runtime dependencies. Write long-running business processes as plain async TypeScript code that survives restarts with deterministic replay, signals, timers, sagas, schedules, CQRS integration, and SQL stores.

## Features

- **Deterministic Replay Engine**: Memoized `ctx.step()` execution, deterministic `ctx.now()`, `ctx.random()`, `ctx.uuid()`, non-determinism detection (`WorkflowNonDeterminismError`), and bounded journal limits.
- **Durable Timers & Signals**: `ctx.sleep()`, typed `WorkflowSignal<T>`, `ctx.waitForSignal()` (with correlation keys, payload filters, timeouts, and deduplication), and `ctx.waitForAny()` racing signals, timers, and child workflows.
- **Saga Compensation**: Per-step `compensate` handlers executed in reverse order on failure or cancellation, with `ctx.commit()` point-of-no-return checkpoints and operator `WorkflowClient.retry()`.
- **Retries, Timeouts & Heartbeats**: Configurable exponential backoff, `NonRetryableStepError`, step/heartbeat timeouts, progress checkpoints (`heartbeat(progress)`), and run deadlines.
- **Child Workflows, Limits & Schedules**: `ctx.startChild()` / `ctx.executeChild()` with `parentClose` policies, global/per-key concurrency and rate limits, plus declarative `@Workflow(name, { schedules })` and programmatic `WorkflowSchedules` (cron, intervals, RFC 5545 `rrule`, IANA time zones).
- **Payload Encryption & Lifecycle Events**: Built-in `AesGcmPayloadCodec` (AES-256-GCM + optional deflate + key rotation) and zero-RxJS `WorkflowEvents.events$` (`Subscribable & AsyncIterable` + `node:diagnostics_channel`).

## Installation

```bash
bun add @bunest/workflows
```

## Quick Start

```ts
import { Module } from "@bunest/common";
import {
  Workflow,
  WorkflowClient,
  WorkflowsModule,
  type WorkflowContext,
  type WorkflowRunner,
} from "@bunest/workflows";

@Workflow("order-fulfillment")
export class OrderWorkflow implements WorkflowRunner<{ orderId: string }, string> {
  async run(ctx: WorkflowContext, input: { orderId: string }) {
    const paymentId = await ctx.step("charge", () => `pay_${input.orderId}`, {
      compensate: async (_id) => {
        // refund payment if a later step fails
      },
    });
    await ctx.sleep("wait-window", "5m");
    return `fulfilled:${paymentId}`;
  }
}

@Module({
  imports: [WorkflowsModule.forRoot()],
  providers: [OrderWorkflow],
})
export class AppModule {
  constructor(readonly workflows: WorkflowClient) {}
}
```

## Key Exports

- **Module & Services**: `WorkflowsModule` (`forRoot`, `forRootAsync`), `WorkflowClient`, `WorkflowWorker`, `WorkflowSchedules`, `WorkflowStorage`, `WorkflowEvents`, `WORKFLOWS_MODULE_OPTIONS`
- **Decorators, Signals & Codecs**: `Workflow`, `WorkflowSignal`, `AesGcmPayloadCodec`, `InMemoryWorkflowStore`, `ManualWorkflowClock`
- **Errors & Interrupts**: `WorkflowError`, `WorkflowDefinitionError`, `WorkflowFailedError`, `WorkflowIdConflictError`, `WorkflowNonDeterminismError`, `WorkflowNotFoundError`, `WorkflowResultTimeoutError`, `WorkflowStateError`, `StepFailedError`, `StepTimeoutError`, `NonRetryableStepError`, `ChildWorkflowFailedError`, `WorkflowInterrupt`, `isWorkflowInterrupt`

## Subpath Exports

- `@bunest/workflows/core` — Reusable clock, duration, retries, codecs, limits, result waiter, scheduler, and leased worker primitives.
- `@bunest/workflows/cqrs` — `WorkflowsCqrsModule`, `@StartOn()`, and `@SignalOn()` bridge for `@bunest/cqrs`.
- `@bunest/workflows/postgres` — `PostgresWorkflowStore` over `@bunest/store-kit/postgres`.
- `@bunest/workflows/mysql` — `MySqlWorkflowStore` over `@bunest/store-kit/mysql`.
- `@bunest/workflows/testing` — `workflowStoreContract()` and `scheduleStoreContract()` compliance test suites.

## CLI

`@bunest/workflows` ships the `nest-workflows` migration CLI powered by `@bunest/store-kit`:

```bash
bunx nest-workflows migrate --url postgres://localhost:5432/app
bunx nest-workflows status --url postgres://localhost:5432/app
bunx nest-workflows sql --dialect postgres
```

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
