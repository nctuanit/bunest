import { assertPriority } from "../core/limits/limits";
import type { Duration } from "../core/time/duration";
import { canonical } from "../core/utils/canonical.util";
import { WorkflowIdConflictError } from "../errors/workflow-id-conflict.error";
import type { WorkflowMetadata } from "../interfaces/workflow-decorator-options.interface";
import type {
  WorkflowInstance,
  WorkflowParentClose,
} from "../interfaces/workflow-instance.interface";
import type { NewWorkflowInstance } from "../interfaces/workflow-store.interface";
import { normalize } from "./normalize.util";
import { runTimeoutMs } from "./run-timeout.util";
import {
  assertStorableJson,
  assertStorableText,
  type TextChecks,
} from "./storable-text.util";

export interface NewInstanceOptions {
  now: number;
  caller: string;
  text: TextChecks;
  timeout?: Duration;
  parentId?: string | null;
  parentClose?: WorkflowParentClose | null;
  concurrencyKey?: string;
  rateLimitKey?: string;
  priority?: number;
  scheduleId?: string | null;
  scheduledAt?: number | null;
}

/** What `WorkflowClient.start()` and `ctx.startChild()` ask the store to create. */
export function newInstance(
  workflow: WorkflowMetadata,
  id: string,
  input: unknown,
  options: NewInstanceOptions,
): NewWorkflowInstance {
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError(
      `Invalid workflow instance id ${JSON.stringify(id)}. Use a non-empty string, such as \`order-\${orderId}\`.`,
    );
  }
  assertStorableText("An instance id", id, options.text("key"));
  if (options.priority !== undefined) {
    assertPriority(options.priority, options.caller);
  }
  const json = normalize(input);
  assertStorableJson("Input", json, options.text("payload"));
  const timeoutMs =
    options.timeout === undefined
      ? workflow.timeout
      : runTimeoutMs(options.timeout, options.caller);
  const concurrencyKey = keyOf(
    workflow,
    json,
    options.caller,
    "concurrency",
    options.concurrencyKey,
  );
  assertStorableText("A concurrency key", concurrencyKey, options.text("key"));
  const rateLimitKey = keyOf(
    workflow,
    json,
    options.caller,
    "rateLimit",
    options.rateLimitKey,
  );
  assertStorableText("A rate-limit key", rateLimitKey, options.text("key"));
  return {
    id,
    workflow: workflow.name,
    version: workflow.version,
    input: json,
    deadline: timeoutMs === undefined ? null : options.now + timeoutMs,
    parentId: options.parentId ?? null,
    parentClose: options.parentClose ?? null,
    concurrencyKey,
    rateLimitKey,
    priority: options.priority ?? 0,
    scheduleId: options.scheduleId ?? null,
    scheduledAt: options.scheduledAt ?? null,
    now: options.now,
  };
}

const LIMITS = {
  concurrency: {
    option: "concurrencyKey",
    limit: "concurrency limit",
    key: "concurrency key",
    declare: "{ concurrency: { limit, key } }",
  },
  rateLimit: {
    option: "rateLimitKey",
    limit: "rate limit",
    key: "rate limit key",
    declare: "{ rateLimit: { max, duration, key } }",
  },
} as const;

function keyOf(
  workflow: WorkflowMetadata,
  input: unknown,
  caller: string,
  kind: "concurrency" | "rateLimit",
  given: string | undefined,
): string | null {
  const limit = workflow[kind];
  const { option, limit: what, key: named, declare } = LIMITS[kind];
  if (given !== undefined) {
    if (typeof given !== "string" || given.length === 0) {
      throw new TypeError(
        `${caller}: invalid ${option} ${JSON.stringify(given)}. Use a non-empty string.`,
      );
    }
    if (limit !== undefined && limit?.perKey == null) {
      throw new TypeError(
        `${caller}: workflow "${workflow.name}" has no ${what} per key, so ${option} would count for nothing. Declare one with @Workflow(name, ${declare}).`,
      );
    }
    return given;
  }
  if (!limit?.key) {
    return null;
  }
  let key: string | null | undefined;
  try {
    key = limit.key(input);
  } catch (error) {
    throw new TypeError(
      `The ${named} of workflow "${workflow.name}" threw: ${(error as Error)?.message ?? String(error)}`,
    );
  }
  if (key === null || key === undefined) {
    return null;
  }
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError(
      `The ${named} of workflow "${workflow.name}" returned ${JSON.stringify(key)}. Return a non-empty string, or null for none.`,
    );
  }
  return key;
}

/**
 * Throws `WorkflowIdConflictError` when the instance `create()` found under the id isn't the one
 * asked for.
 */
export function assertSameInstance(
  existing: WorkflowInstance,
  wanted: Pick<NewWorkflowInstance, "id" | "workflow" | "parentId" | "input">,
  compare: { parent?: boolean; input?: boolean },
): void {
  if (existing.workflow !== wanted.workflow) {
    throw new WorkflowIdConflictError(
      `Instance "${wanted.id}" already exists for workflow "${existing.workflow}", not "${wanted.workflow}".`,
    );
  }
  if (compare.parent && existing.parentId !== (wanted.parentId ?? null)) {
    const parent =
      existing.parentId === null
        ? "no parent"
        : `parent "${existing.parentId}"`;
    throw new WorkflowIdConflictError(
      `Instance "${wanted.id}" of "${wanted.workflow}" already exists with ${parent}.`,
    );
  }
  if (
    compare.input &&
    canonical(existing.input ?? null) !== canonical(wanted.input ?? null)
  ) {
    throw new WorkflowIdConflictError(
      `Instance "${wanted.id}" of "${wanted.workflow}" already exists with a different input.`,
    );
  }
}
