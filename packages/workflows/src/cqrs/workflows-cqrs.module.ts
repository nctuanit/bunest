import { Module } from "@bunest/core";
import { DiscoveryModule } from "@bunest/core";
import { WorkflowEventPublisher } from "./workflow-event.publisher";
import { WorkflowEventsExplorer } from "./workflow-events.explorer";

/**
 * Makes CQRS events start and signal workflows. Import it next to `CqrsModule.forRoot()` and
 * `WorkflowsModule.forRoot()` (both global): it wraps the `EventBus` publisher, so an event a
 * workflow maps with `@StartOn()` or `@SignalOn()` starts or signals it before `publish()`
 * resolves, in the transaction passed as the dispatcher context
 * (`eventBus.publish(event, { transaction: tx })`), and then reaches the event handlers and
 * sagas as before.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [WorkflowEventsExplorer, WorkflowEventPublisher],
})
export class WorkflowsCqrsModule {}
