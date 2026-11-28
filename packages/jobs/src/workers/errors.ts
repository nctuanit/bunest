/**
 * Stable error hierarchy for `@bunest/jobs/workers`.
 *
 * Every pool/runtime error carries a stable `BUNEST_E2*` code registered in
 * `@bunest/core`'s `BUNEST_ERROR_CATALOG` so agents and operators can diagnose
 * worker failures reliably.
 */

export class WorkerPoolError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    code: string,
    options?: {
      readonly cause?: unknown;
      readonly details?: Readonly<Record<string, unknown>>;
    },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = new.target.name;
    this.code = code;
    this.details = options?.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WorkerSpawnException extends WorkerPoolError {
  constructor(
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly details?: Readonly<Record<string, unknown>>;
    },
  ) {
    super(message, "BUNEST_E201", options);
  }
}

export class WorkerTimeoutException extends WorkerPoolError {
  readonly timeoutMs: number;
  readonly taskName: string;

  constructor(
    taskName: string,
    timeoutMs: number,
    poolName?: string,
    options?: { readonly cause?: unknown },
  ) {
    const scope = poolName ? ` in pool "${poolName}"` : "";
    super(
      `Worker task "${taskName}"${scope} timed out after ${timeoutMs}ms.`,
      "BUNEST_E202",
      {
        cause: options?.cause,
        details: { taskName, timeoutMs, ...(poolName ? { poolName } : {}) },
      },
    );
    this.timeoutMs = timeoutMs;
    this.taskName = taskName;
  }
}

export class WorkerPoolSaturatedException extends WorkerPoolError {
  readonly maxQueueSize: number;
  readonly poolName: string;

  constructor(poolName: string, maxQueueSize: number) {
    super(
      `Worker pool "${poolName}" queue is saturated (maxQueueSize=${maxQueueSize}).`,
      "BUNEST_E203",
      {
        details: { poolName, maxQueueSize },
      },
    );
    this.poolName = poolName;
    this.maxQueueSize = maxQueueSize;
  }
}

export class WorkerTerminatedException extends WorkerPoolError {
  readonly exitCode?: number;

  constructor(
    message: string,
    options?: {
      readonly exitCode?: number;
      readonly cause?: unknown;
      readonly details?: Readonly<Record<string, unknown>>;
    },
  ) {
    super(message, "BUNEST_E204", {
      cause: options?.cause,
      details: {
        ...(options?.details ?? {}),
        ...(options?.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
      },
    });
    this.exitCode = options?.exitCode;
  }
}

export class WorkerTaskNotFoundException extends WorkerPoolError {
  readonly taskName: string;
  readonly availableTasks?: readonly string[];

  constructor(taskName: string, availableTasks?: readonly string[]) {
    const hint =
      availableTasks && availableTasks.length > 0
        ? ` Available tasks: ${availableTasks.join(", ")}.`
        : "";
    super(
      `Worker task "${taskName}" is not registered in this worker.${hint}`,
      "BUNEST_E205",
      {
        details: {
          taskName,
          ...(availableTasks ? { availableTasks: [...availableTasks] } : {}),
        },
      },
    );
    this.taskName = taskName;
    this.availableTasks = availableTasks;
  }
}

export class WorkerAbortedException extends Error {
  readonly reason?: unknown;

  constructor(reason?: unknown) {
    const message =
      reason instanceof Error
        ? `Worker task aborted: ${reason.message}`
        : typeof reason === "string" && reason.length > 0
          ? `Worker task aborted: ${reason}`
          : "Worker task aborted.";
    super(message, reason !== undefined ? { cause: reason } : undefined);
    this.name = "WorkerAbortedException";
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WorkerValidationException extends Error {
  readonly issues: readonly {
    readonly message: string;
    readonly path?: readonly PropertyKey[];
  }[];

  constructor(
    taskName: string,
    issues: readonly {
      readonly message: string;
      readonly path?: readonly PropertyKey[];
    }[],
  ) {
    const summary = issues
      .map((i) =>
        i.path && i.path.length > 0
          ? `${i.path.map(String).join(".")}: ${i.message}`
          : i.message,
      )
      .join("; ");
    super(`Validation failed for worker task "${taskName}": ${summary}`);
    this.name = "WorkerValidationException";
    this.issues = issues;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
