# Durable Workflows

**`@bunest/workflows`** lets you write durable, crash-safe long-running business processes as plain TypeScript `async` code—with deterministic replay, durable timers, external signals, compensating sagas, child workflows, cron schedules, AES-256-GCM payload encryption (`AesGcmPayloadCodec`), and zero external runtime dependencies.

## Installation

```bash
bun add @bunest/workflows
```

## Subpath Exports

| Subpath | Purpose |
| --- | --- |
| `@bunest/workflows` | `@Workflow`, `WorkflowsModule`, `WorkflowClient`, `InMemoryWorkflowStore`, `AesGcmPayloadCodec`, `ManualWorkflowClock` |
| `@bunest/workflows/postgres` | PostgreSQL durable workflow store over `Bun.SQL` |
| `@bunest/workflows/mysql` | MySQL / MariaDB durable workflow store over `Bun.SQL` |
| `@bunest/workflows/cqrs` | `@StartOn` & `@SignalOn` bridge for [`@bunest/messaging/cqrs`](/distributed/cqrs) |
| `@bunest/workflows/testing` | Deterministic replay & time-travel test harness |
| `@bunest/workflows/core` | Framework-agnostic durable execution engine |

## Module Setup

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { WorkflowsModule } from "@bunest/workflows";
import { OrderFulfillmentWorkflow } from "./order-fulfillment.workflow";

@Module({
  imports: [
    WorkflowsModule.forRoot({}),
  ],
  providers: [OrderFulfillmentWorkflow],
})
export class AppModule {}
```

## Writing a Durable Workflow

Use `@Workflow("name")` to register a workflow class. Side effects run inside `ctx.step(name, fn)` so they are persisted once and **replayed from history** if the process restarts:

@@filename(order-fulfillment.workflow.ts)

```ts
import { Injectable } from "@bunest/core";
import { Workflow, type WorkflowContext } from "@bunest/workflows";

@Injectable()
@Workflow("order-fulfillment")
export class OrderFulfillmentWorkflow {
  async run(ctx: WorkflowContext, input: { orderId: string; email: string }) {
    // Step 1: Persisted — never re-executed on replay
    const reservation = await ctx.step("reserve-inventory", async () => {
      return { reserved: true, orderId: input.orderId };
    });

    // Durable timer — survives restarts & deployments
    await ctx.sleep("wait-grace-period", 60_000);

    // Step 2: Charge & send receipt
    await ctx.step("send-confirmation", async () => {
      return { sentTo: input.email, reservation };
    });

    return { status: "completed", orderId: input.orderId };
  }
}
```

## CQRS Triggers (`@StartOn`, `@SignalOn`)

Bridge domain events or commands directly into workflows using `@bunest/workflows/cqrs`:

- `@StartOn(OrderPlacedEvent)` — automatically starts a workflow instance when the event/command arrives.
- `@SignalOn(PaymentApprovedEvent)` — delivers an external signal to a waiting workflow instance.

## Payload Encryption & Deterministic Testing

- **Encryption at rest**: Pass `codec: new AesGcmPayloadCodec({ key })` in `WorkflowsModule.forRoot()` to encrypt step inputs/outputs before persisting to SQL.
- **Instant time-travel tests**: Use `ManualWorkflowClock` and `@bunest/workflows/testing` to advance durable timers (e.g., 30-day reminders) in milliseconds and assert deterministic replay behavior.

> info **Durable AI Agents** Pair `@bunest/workflows` with [`@bunest/ai/workflows`](/ai/ai-sdk) for multi-step AI agent loops with human-in-the-loop tool approval and crash-safe replay.
