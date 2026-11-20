import type { SerializedWorkflowError } from "../interfaces/serialized-workflow-error.interface";
import {
  WorkflowFailedError,
  type WorkflowFailureStatus,
} from "./workflow-failed.error";

/**
 * A child workflow (`ctx.startChild()`) ended without completing: what its handle's `result()`
 * and `ctx.executeChild()` throw in the parent. `status` says how it ended, `cause` is its error.
 */
export class ChildWorkflowFailedError extends WorkflowFailedError {
  readonly workflow: string;
  override name = "ChildWorkflowFailedError";

  constructor(
    workflow: string,
    instanceId: string,
    status: WorkflowFailureStatus,
    cause: SerializedWorkflowError,
  ) {
    super(
      `Child workflow "${workflow}" ("${instanceId}") ${status.replace("_", " ")}: ${cause.name}: ${cause.message}`,
      { instanceId, status, cause },
    );
    this.workflow = workflow;
  }
}
