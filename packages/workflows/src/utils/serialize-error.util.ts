import { inspect } from "node:util";
import type { SerializedWorkflowError } from "../interfaces/serialized-workflow-error.interface";

/**
 * Never throws: a thrown value the engine can't serialize (a circular object, a
 * BigInt, `undefined`) is described by `util.inspect()` instead, so the instance
 * still records an outcome.
 */
export function serializeError(error: unknown): SerializedWorkflowError {
  if (error instanceof Error) {
    const stack = stackOf(error);
    return {
      name: text(error.name || "Error"),
      message: text(error.message),
      ...(stack === undefined ? {} : { stack }),
    };
  }
  if (typeof error === "string") {
    return { name: "Error", message: error };
  }
  let message: string | undefined;
  try {
    message = JSON.stringify(error);
  } catch {
    // circular, or a BigInt: described below
  }
  return {
    name: "Error",
    message: message ?? inspect(error, { depth: 3, breakLength: Infinity }),
  };
}

function text(value: unknown): string {
  try {
    return String(value);
  } catch {
    return inspect(value, { depth: 3, breakLength: Infinity });
  }
}

function stackOf(error: Error): string | undefined {
  try {
    return error.stack === undefined ? undefined : text(error.stack);
  } catch {
    return undefined;
  }
}
