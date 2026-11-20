import { WorkflowDefinitionError } from "./workflow-definition.error";

export class WorkflowNonDeterminismError extends WorkflowDefinitionError {
  override name = "WorkflowNonDeterminismError";
}
