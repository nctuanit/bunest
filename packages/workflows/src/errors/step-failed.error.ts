import type { SerializedWorkflowError } from "../interfaces/serialized-workflow-error.interface";
import { WorkflowError } from "./workflow.error";

/**
 * A step gave up (retries exhausted, or a `NonRetryableStepError`). Built from the
 * journal on both the first run and every replay, so a workflow that catches it
 * and branches sees exactly the same error each time.
 */
export class StepFailedError extends WorkflowError {
  readonly step: string;
  readonly attempts: number;
  override readonly cause: SerializedWorkflowError;
  override name = "StepFailedError";

  constructor(step: string, attempts: number, cause: SerializedWorkflowError) {
    super(
      `Step "${step}" failed after ${attempts} attempt(s): ${cause.name}: ${cause.message}`,
    );
    this.step = step;
    this.attempts = attempts;
    this.cause = cause;
  }
}
