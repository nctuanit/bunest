/**
 * Base error class for all `@bunest/orm` errors.
 */
export class OrmError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

function describeEntityTarget(target: unknown): string {
  if (typeof target === "function") {
    return target.name || "AnonymousClass";
  }
  if (typeof target === "string") {
    return `"${target}"`;
  }
  if (
    typeof target === "object" &&
    target !== null &&
    "name" in target &&
    typeof (target as { name?: unknown }).name === "string"
  ) {
    return `EntityRef("${(target as { name: string }).name}")`;
  }
  return String(target);
}

/**
 * Thrown when an entity class, string name, or `EntityRef` cannot be resolved
 * during metadata graph compilation or repository lookup.
 */
export class EntityMetadataNotFoundError extends OrmError {
  constructor(target: unknown, hint?: string) {
    const label = describeEntityTarget(target);
    const suffix = hint ? ` ${hint}` : "";
    super(
      `No metadata found for entity ${label}. Ensure it is decorated with @Entity() (or registered via defineEntity()) and included in DataSource.entities or autoLoadEntities: true.${suffix}`,
    );
  }
}

/**
 * Thrown by `findOneOrFail()` / `findOneByOrFail()` / `getOneOrFail()` when no matching row exists.
 */
export class EntityNotFoundError extends OrmError {
  constructor(entityName: string, criteria?: unknown) {
    const detail =
      criteria !== undefined ? ` matching ${safeStringify(criteria)}` : "";
    super(`Could not find any entity of type "${entityName}"${detail}.`);
  }
}

/**
 * Thrown when an `@Embedded` class explicitly configured with `mode: "flat"` forms
 * an unbounded cycle (instead of using `mode: "auto"` or `mode: "json"`).
 */
export class CircularEmbeddedError extends OrmError {
  constructor(cyclePath: readonly string[]) {
    super(
      `Circular embedded class cycle detected in flat mode: ${cyclePath.join(" -> ")}. ` +
        `Use mode: "auto" (default) or mode: "json" on @Embedded()/@Nested(), or specify an explicit maxDepth.`,
    );
  }
}

/**
 * Thrown when a relation target thunk, string name, or `inverseSide` property cannot be resolved.
 */
export class RelationMetadataError extends OrmError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown when optimistic locking (`@VersionColumn`) detects a concurrent modification conflict.
 */
export class OptimisticLockError extends OrmError {
  constructor(
    entityName: string,
    expectedVersion: number,
    actualVersion?: number,
  ) {
    const actualPart =
      actualVersion !== undefined ? `, actual version ${actualVersion}` : "";
    super(
      `Optimistic lock version mismatch on "${entityName}": expected version ${expectedVersion}${actualPart}.`,
    );
  }
}

/**
 * Thrown when a SQL query fails against the underlying driver.
 */
export class QueryFailedError extends OrmError {
  readonly query: string;
  readonly parameters: readonly unknown[];

  constructor(
    message: string,
    query: string,
    parameters: readonly unknown[] = [],
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.query = query;
    this.parameters = parameters;
  }
}

/**
 * Thrown when a DataSource is used before `initialize()` has completed.
 */
export class DataSourceNotInitializedError extends OrmError {
  constructor(name: string) {
    super(
      `DataSource "${name}" is not initialized. Call await dataSource.initialize() before executing queries.`,
    );
  }
}

/**
 * Thrown when a transaction propagation invariant is violated (e.g. `"MANDATORY"`
 * without an active transaction, or `"NEVER"` inside an active transaction).
 */
export class TransactionPropagationError extends OrmError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown when a tenant schema or RLS GUC identifier fails strict SQL-injection validation.
 */
export class InvalidTenantIdentifierError extends OrmError {
  constructor(message: string) {
    super(message);
  }
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      if (typeof val === "bigint") return val.toString();
      return val;
    });
  } catch {
    return String(value);
  }
}
