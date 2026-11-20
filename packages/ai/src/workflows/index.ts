/**
 * `@bunest/ai/workflows`: the agent loop as a durable workflow, on `@bunest/workflows`.
 */
export { AiWorkflowsModule } from './ai-workflows.module';
export { AiAgents, TOOL_APPROVAL } from './ai-agents.service';
export type {
  AiAgentCaller,
  AiAgentRunOptions,
  AiAgentRunResult,
  AiPendingApproval,
  AiToolApproval,
} from './ai-agent.interfaces';
