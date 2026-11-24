import { Module } from "@bunest/core";
import { AiAgentSegment } from "./ai-agent.workflow";
import { AiAgents } from "./ai-agents.service";

/**
 * Durable agent runs on `@bunest/workflows`: import it next to `AiModule` and `WorkflowsModule`,
 * and inject `AiAgents` into your `@Workflow()` classes.
 */
@Module({
  providers: [AiAgents, AiAgentSegment],
  exports: [AiAgents],
})
export class AiWorkflowsModule {}
