import { Injectable, MetadataRegistry, Scope, type Type } from "@bunest/core";
import { DiscoveryService } from "@bunest/core";
import { WorkflowNotFoundError } from "../errors/workflow-not-found.error";
import type {
  WorkflowDeclaredSchedule,
  WorkflowMetadata,
} from "../interfaces/workflow-decorator-options.interface";
import type { WorkflowRunner } from "../interfaces/workflow-runner.interface";
import type {
  WorkflowConcurrencyLimit,
  WorkflowRateLimitRule,
} from "../interfaces/workflow-store.interface";
import {
  WORKFLOW_EVENT_ROUTES_METADATA,
  WORKFLOW_METADATA,
} from "../workflows.constants";

export interface WorkflowDefinition extends WorkflowMetadata {
  key: string;
  instance: WorkflowRunner;
  type: Type<unknown>;
}

export const workflowKey = (name: string, version: number): string =>
  `${name}@${version}`;

/**
 * Internal: `WorkflowsCqrsModule` calls it from its publisher's constructor, before any
 * definition loads. Without it, a workflow mapped from CQRS events fails the startup check.
 */
export const ROUTE_EVENTS = Symbol("WorkflowRegistry.routeEvents");

/** Finds every `@Workflow()` provider, wherever it is registered. */
@Injectable()
export class WorkflowRegistry {
  private definitions?: Map<string, WorkflowDefinition>;
  private declared?: Map<
    string,
    WorkflowDeclaredSchedule & { workflow: string }
  >;
  private eventsRouted = false;

  constructor(private readonly discovery: DiscoveryService) {}

  /** `name@version` keys this process can run. */
  keys(): string[] {
    return [...this.load().keys()];
  }

  /** The workflow versions this process can run, for claims. */
  versions(): Array<{ name: string; version: number }> {
    return [...this.load().values()].map(({ name, version }) => ({
      name,
      version,
    }));
  }

  /** The concurrency limits of the workflows this process runs, for claims: each name's highest registered version's. */
  limits(): WorkflowConcurrencyLimit[] {
    return this.names().flatMap((name) => {
      const concurrency = this.latest(name)!.concurrency;
      return concurrency
        ? [
            {
              workflow: name,
              limit: concurrency.limit,
              perKey: concurrency.perKey,
            },
          ]
        : [];
    });
  }

  /** The rate limits of the workflows this process runs, for claims: each name's highest registered version's. */
  rateLimits(): WorkflowRateLimitRule[] {
    return this.names().flatMap((name) => {
      const rateLimit = this.latest(name)!.rateLimit;
      return rateLimit
        ? [{ workflow: name, limit: rateLimit.limit, perKey: rateLimit.perKey }]
        : [];
    });
  }

  /** The workflow names this process registers. */
  names(): string[] {
    return [...new Set([...this.load().values()].map((def) => def.name))];
  }

  /**
   * The schedules the workflows this process runs declare, by id: each name's highest registered version's.
   */
  schedules(): Map<string, WorkflowDeclaredSchedule & { workflow: string }> {
    if (this.declared) {
      return this.declared;
    }
    const declared = new Map<
      string,
      WorkflowDeclaredSchedule & { workflow: string }
    >();
    for (const name of this.names()) {
      for (const schedule of this.latest(name)!.schedules ?? []) {
        const other = declared.get(schedule.id);
        if (other) {
          throw new Error(
            `Schedule "${schedule.id}" is declared by two workflows ("${other.workflow}" and "${name}"). Give each schedule its own id.`,
          );
        }
        declared.set(schedule.id, { ...schedule, workflow: name });
      }
    }
    return (this.declared = declared);
  }

  [ROUTE_EVENTS](): void {
    this.eventsRouted = true;
  }

  get(name: string, version: number): WorkflowDefinition | undefined {
    return this.load().get(workflowKey(name, version));
  }

  /** Highest registered version of `name`. */
  latest(name: string): WorkflowDefinition | undefined {
    let latest: WorkflowDefinition | undefined;
    for (const def of this.load().values()) {
      if (def.name === name && (!latest || def.version > latest.version)) {
        latest = def;
      }
    }
    return latest;
  }

  /**
   * Name and version for a `start()` call.
   */
  resolve(
    workflow: Type<unknown> | string,
    version?: number,
  ): WorkflowMetadata {
    let name: string;
    let fallback: WorkflowMetadata | undefined;
    if (typeof workflow === "string") {
      name = workflow;
    } else {
      const meta = MetadataRegistry.get<WorkflowMetadata>(
        WORKFLOW_METADATA,
        workflow,
      );
      if (!meta) {
        throw new WorkflowNotFoundError(
          `${workflow.name} is not decorated with @Workflow().`,
        );
      }
      name = meta.name;
      fallback = meta;
    }
    if (version !== undefined) {
      if (!Number.isInteger(version) || version < 1) {
        throw new TypeError(
          `Invalid version ${version} for workflow "${name}". Use a positive integer.`,
        );
      }
      const known =
        this.get(name, version) ??
        (fallback?.version === version ? fallback : undefined);
      const latest = this.latest(name);
      return {
        name,
        version,
        timeout: known?.timeout,
        concurrency:
          latest?.concurrency ?? fallback?.concurrency ?? known?.concurrency,
        rateLimit: latest?.rateLimit ?? fallback?.rateLimit ?? known?.rateLimit,
      };
    }
    const def = this.latest(name);
    if (def) {
      return {
        name: def.name,
        version: def.version,
        timeout: def.timeout,
        concurrency: def.concurrency,
        rateLimit: def.rateLimit,
      };
    }
    if (fallback !== undefined) {
      return {
        name,
        version: fallback.version,
        timeout: fallback.timeout,
        concurrency: fallback.concurrency,
        rateLimit: fallback.rateLimit,
      };
    }
    throw new WorkflowNotFoundError(
      `Workflow "${name}" is not registered in this application. Register it, or pass { version } to start it from a process that does not run it.`,
    );
  }

  private load(): Map<string, WorkflowDefinition> {
    if (this.definitions) {
      return this.definitions;
    }
    const definitions = new Map<string, WorkflowDefinition>();
    for (const wrapper of this.discovery.getProviders()) {
      const rawWrapper = wrapper as unknown as {
        metatype?: Type<unknown> | Function;
        inject?: unknown;
        instance?: Record<string, unknown>;
        scope?: Scope;
        isDependencyTreeStatic?: boolean | (() => boolean);
        isTransient?: boolean;
      };
      const type = (
        !rawWrapper.metatype || rawWrapper.inject
          ? rawWrapper.instance?.constructor
          : rawWrapper.metatype
      ) as Type<unknown> | undefined;
      const meta =
        type && MetadataRegistry.get<WorkflowMetadata>(WORKFLOW_METADATA, type);
      if (!meta || !type) {
        continue;
      }
      const isStatic =
        typeof rawWrapper.isDependencyTreeStatic === "function"
          ? rawWrapper.isDependencyTreeStatic()
          : (rawWrapper.isDependencyTreeStatic ?? true);
      const isTransient =
        rawWrapper.scope === Scope.TRANSIENT || Boolean(rawWrapper.isTransient);
      if (!isStatic || isTransient) {
        throw new Error(
          `Workflow ${type.name} must be a singleton; request-scoped and transient workflows are not supported.`,
        );
      }
      const key = workflowKey(meta.name, meta.version);
      const existing = definitions.get(key);
      if (existing && existing.type !== type) {
        throw new Error(
          `Workflow "${key}" is defined twice (${existing.type.name} and ${type.name}). Bump the version of one of them.`,
        );
      }
      const instance = rawWrapper.instance as WorkflowRunner | undefined;
      if (typeof instance?.run !== "function") {
        throw new Error(
          `Workflow ${type.name} must have a run(ctx, input) method.`,
        );
      }
      if (
        !this.eventsRouted &&
        MetadataRegistry.getOwn(WORKFLOW_EVENT_ROUTES_METADATA, type)
      ) {
        throw new Error(
          `Workflow ${type.name} is started or signalled by CQRS events (@StartOn(), @SignalOn()), but ` +
            "WorkflowsCqrsModule is not imported, so publishing those events would start and signal nothing. " +
            "Import WorkflowsCqrsModule from '@bunest/workflows/cqrs' next to CqrsModule.forRoot().",
        );
      }
      definitions.set(key, { ...meta, key, instance, type });
    }
    return (this.definitions = definitions);
  }
}
