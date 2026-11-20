import { WorkflowError } from "./workflow.error";

/**
 * An operator action that the instance's status rules out. `status` 409.
 */
export class WorkflowStateError extends WorkflowError {
  override name = "WorkflowStateError";
  readonly status = 409;
}
