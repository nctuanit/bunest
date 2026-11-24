import {
  Workflow,
  type WorkflowContext,
  type WorkflowRunner,
} from "@bunest/workflows";
import type { AiAgentRunResult } from "./ai-agent.interfaces";
import {
  AGENT_WORKFLOW,
  AiAgents,
  type AgentSettings,
  type AgentState,
} from "./ai-agents.service";

/** A run of `AiAgents.run()` going on in a child instance, from where its parent stopped. Internal. */
@Workflow(AGENT_WORKFLOW)
export class AiAgentSegment implements WorkflowRunner<
  { settings: AgentSettings; state: AgentState },
  AiAgentRunResult
> {
  constructor(private readonly agents: AiAgents) {}

  run(
    ctx: WorkflowContext,
    { settings, state }: { settings: AgentSettings; state: AgentState },
  ): Promise<AiAgentRunResult> {
    return this.agents.resume(ctx, settings, state);
  }
}
