/** Where `@Objective` keeps what a handler declares. */
export const OBJECTIVES_METADATA = "observe:objectives";

export interface ObjectiveOptions {
  /** Percent of requests that must not fail with an unhandled error (90..99.999). */
  availability?: number;
  /** Percent of requests (`target`) that must finish under `underMs`. */
  latency?: {
    underMs: number;
    target: number;
  };
  /** The rolling window the promise is judged over, in days. Default 28. */
  windowDays?: 7 | 14 | 28 | 30;
  /** What the dashboard calls it. Defaults to the route and the promise. */
  name?: string;
}

const MIN_TARGET = 90;
const MAX_TARGET = 99.999;
const WINDOW_DAYS: readonly number[] = [7, 14, 28, 30];
const OBJECTIVE_FIELDS = new Set([
  "availability",
  "latency",
  "windowDays",
  "name",
]);
const LATENCY_FIELDS = new Set(["underMs", "target"]);

function isTarget(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_TARGET &&
    value <= MAX_TARGET
  );
}

/** Declares an SLO objective for this route handler. */
export function Objective(options: ObjectiveOptions): MethodDecorator {
  return (_target, _key, descriptor) => {
    const fn = descriptor.value as object;
    const declared =
      (Reflect.getMetadata(OBJECTIVES_METADATA, fn) as
        | ObjectiveOptions[]
        | undefined) ?? [];
    Reflect.defineMetadata(OBJECTIVES_METADATA, [options, ...declared], fn);
    return descriptor;
  };
}

/** Why a declaration cannot be sent, or empty array when valid. */
export function objectiveProblems(options: ObjectiveOptions): string[] {
  const problems: string[] = [];
  if (options.availability === undefined && options.latency === undefined) {
    problems.push("declares neither availability nor latency");
  }
  if (options.availability !== undefined && !isTarget(options.availability)) {
    problems.push(
      `availability must be a percentage from ${MIN_TARGET} to ${MAX_TARGET}`,
    );
  }
  if (options.latency !== undefined) {
    const { underMs, target } = options.latency;
    if (!Number.isInteger(underMs) || underMs < 1 || underMs > 600_000) {
      problems.push("latency.underMs must be whole milliseconds, up to 600000");
    }
    if (!isTarget(target)) {
      problems.push(
        `latency.target must be a percentage from ${MIN_TARGET} to ${MAX_TARGET}`,
      );
    }
  }
  if (
    options.windowDays !== undefined &&
    !WINDOW_DAYS.includes(options.windowDays)
  ) {
    problems.push(`windowDays must be one of ${WINDOW_DAYS.join(", ")}`);
  }
  if (options.name !== undefined && options.name.length > 120) {
    problems.push("name must be at most 120 characters");
  }
  return problems;
}

/** Fields an objective carries that the collector does not declare. */
export function unknownObjectiveFields(options: ObjectiveOptions): string[] {
  const unknown = Object.keys(options).filter(
    (field) => !OBJECTIVE_FIELDS.has(field),
  );
  if (options.latency && typeof options.latency === "object") {
    unknown.push(
      ...Object.keys(options.latency)
        .filter((field) => !LATENCY_FIELDS.has(field))
        .map((field) => `latency.${field}`),
    );
  }
  return unknown;
}

/** An objective as it is sent: the fields the collector declares, and no others. */
export function toDeclaredObjective(
  options: ObjectiveOptions,
): ObjectiveOptions {
  return {
    ...(options.availability === undefined
      ? {}
      : { availability: options.availability }),
    ...(options.latency === undefined
      ? {}
      : {
          latency: {
            underMs: options.latency.underMs,
            target: options.latency.target,
          },
        }),
    ...(options.windowDays === undefined
      ? {}
      : { windowDays: options.windowDays }),
    ...(options.name === undefined ? {} : { name: options.name }),
  };
}
