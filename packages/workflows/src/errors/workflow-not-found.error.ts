import { WorkflowError } from "./workflow.error";

/**
 * `cancel()` of an unknown instance id, or `start()` of a workflow this
 * application cannot resolve. `status` 404.
 */
export class WorkflowNotFoundError extends WorkflowError {
  override name = "WorkflowNotFoundError";
  readonly status = 404;
}
