import { WorkflowError } from "./workflow.error";

/**
 * `WorkflowClient.result()` (or `startAndWait()`) waited for its `timeout` and the instance
 * hadn't ended.
 */
export class WorkflowResultTimeoutError extends WorkflowError {
  readonly instanceId: string;
  readonly timeoutMs: number;
  override name = "WorkflowResultTimeoutError";

  constructor(instanceId: string, timeoutMs: number) {
    super(
      `Instance "${instanceId}" didn't end within ${timeoutMs}ms. It keeps running; wait for it again or read it with getStatus().`,
    );
    this.instanceId = instanceId;
    this.timeoutMs = timeoutMs;
  }
}
