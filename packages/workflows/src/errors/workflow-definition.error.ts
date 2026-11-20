import { WorkflowError } from "./workflow.error";

/**
 * The workflow code cannot run against this instance's journal.
 */
export class WorkflowDefinitionError extends WorkflowError {
  override name = "WorkflowDefinitionError";
}
