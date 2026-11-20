import type { Duration } from '@bunest/workflows';
import type { AiToolChoice } from '../interfaces/ai-call-options.interface';
import type { AiBudget } from '../interfaces/ai-module-options.interface';
import type { AiTextResult } from '../interfaces/ai-result.interface';
import type { AiToolSelection } from '../interfaces/ai-tool.interface';
import type { ModelMessage } from '../interfaces/ai-types.interface';

/** Who a durable run acts for. */
export interface AiAgentCaller<TUser = unknown> {
  user?: TUser;
  scopes?: string[];
}

/** The options of `AiAgents.run()`. */
export interface AiAgentRunOptions {
  model?: string;
  instructions?: string;
  prompt?: string;
  messages?: ModelMessage[];
  tools?: AiToolSelection;
  approve?: string[];
  approvalTimeout?: Duration;
  caller?: AiAgentCaller;
  maxSteps?: number;
  stepsPerInstance?: number;
  budget?: AiBudget;
  label?: string;
  toolChoice?: AiToolChoice;
  fallback?: string | string[] | false;
  maxOutputTokens?: number;
  temperature?: number;
  providerOptions?: Record<string, Record<string, any>>;
}

/** What `AiAgents.run()` resolves with. */
export type AiAgentRunResult = AiTextResult;

/** A person's answer to a tool call that waits for approval. */
export interface AiToolApproval {
  approved: boolean;
  reason?: string;
  by?: unknown;
}

/** A tool call waiting for approval. */
export interface AiPendingApproval {
  key: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}
