export type InterruptReason =
  | "suspend"
  | "halt"
  | "cancel"
  | "timeout"
  | "journal-limit"
  | "lease-lost"
  | "shutdown"
  | "store-error";

/**
 * Thrown by `ctx` operations to unwind the workflow function. It is control
 * flow, not a failure: code that catches errors inside `run()` must rethrow it
 * (`if (isWorkflowInterrupt(e)) throw e`).
 */
export class WorkflowInterrupt extends Error {
  readonly reason: InterruptReason;
  override name = "WorkflowInterrupt";

  constructor(reason: InterruptReason) {
    super(
      `Workflow execution interrupted (${reason}). Rethrow this error if you catch it.`,
    );
    this.reason = reason;
  }
}

export function isWorkflowInterrupt(
  error: unknown,
): error is WorkflowInterrupt {
  return error instanceof WorkflowInterrupt;
}
