import { Inject, Injectable, Logger, Optional } from "@bunest/core";
import { PayloadCodecs } from "../core/codecs/payload-codecs";
import type {
  WorkflowPayloadCodec,
  WorkflowPayloadContext,
} from "../interfaces/workflow-payload-codec.interface";
import type { WorkflowStorageRegisterOptions } from "../interfaces/workflow-storage.interface";
import type { WorkflowStore } from "../interfaces/workflow-store.interface";
import type { WorkflowsModuleOptions } from "../interfaces/workflows-module-options.interface";
import { InMemoryWorkflowStore } from "../stores/in-memory-workflow.store";
import { WORKFLOW_PAYLOAD_CODECS } from "../workflows.constants";
import { WORKFLOWS_MODULE_OPTIONS } from "../workflows.module-definition";
import { EncodedWorkflowStore } from "./encoded-workflow.store";

/** Internal: locks the registry. `WorkflowsModule.onModuleInit()` and the first read call it. */
export const LOCK_STORAGE = Symbol("WorkflowStorage.lock");
/** Internal: the store the engine uses, `source` with the module's codecs applied to the payloads. */
export const ENGINE_STORE = Symbol("WorkflowStorage.engineStore");
/** Internal: the module's codecs, for the schedules, which the engine encodes apart from the instances. */
export const PAYLOAD_CODECS = Symbol("WorkflowStorage.payloadCodecs");

const REQUIRED = [
  "create",
  "get",
  "list",
  "requestCancel",
  "reopen",
  "delete",
  "signal",
  "signals",
  "purge",
  "saveSchedule",
  "getSchedule",
  "listSchedules",
  "deleteSchedule",
  "claimSchedules",
  "writeSchedule",
  "claim",
  "renew",
  "write",
] as const;

const OPTIONAL = ["createInTransaction", "signalInTransaction"] as const;

const DEFAULT =
  "InMemoryWorkflowStore (the default: state is lost on restart and not shared between instances)";

/**
 * Where the application tells the package which `WorkflowStore` to use.
 */
@Injectable()
export class WorkflowStorage {
  private readonly logger = new Logger("WorkflowsModule");
  private registered?: WorkflowStore;
  private active?: WorkflowStore;
  private engine?: EncodedWorkflowStore;
  private readonly codecs: PayloadCodecs<WorkflowPayloadContext>;

  constructor(
    @Optional()
    @Inject(WORKFLOWS_MODULE_OPTIONS)
    private readonly options?: WorkflowsModuleOptions,
    @Optional()
    @Inject(WORKFLOW_PAYLOAD_CODECS)
    codecs?: WorkflowPayloadCodec[],
  ) {
    this.codecs = new PayloadCodecs(codecs ?? [], {
      name: "WorkflowsModule's codec",
      type: "WorkflowPayloadCodec",
    });
  }

  registerSource(
    source: WorkflowStore,
    options: WorkflowStorageRegisterOptions = {},
  ): void {
    validate(source);
    if (this.active) {
      throw new Error(
        `WorkflowStorage.registerSource(): ${nameOf(source)} registered after WorkflowsModule initialized (or after ` +
          `its storage was first read), which already uses ${this.registered ? nameOf(this.active) : DEFAULT}. ` +
          "Register from the constructor of a singleton provider: providers of lazy-loaded modules, request-scoped " +
          "and transient providers, and lifecycle hooks run too late.",
      );
    }
    if (this.registered && !options.replace) {
      throw new Error(
        `WorkflowStorage.registerSource(): ${nameOf(source)} can't register, ` +
          `${this.registered === source ? "it already did (the same instance, twice)" : `${nameOf(this.registered)} already did`}. ` +
          "Register one store, or pass { replace: true } to replace it on purpose (tests, wrappers).",
      );
    }
    this.registered = source;
  }

  get source(): WorkflowStore {
    if (!this.active) {
      this[LOCK_STORAGE]();
    }
    return this.active!;
  }

  get [PAYLOAD_CODECS](): PayloadCodecs<WorkflowPayloadContext> {
    return this.codecs;
  }

  get [ENGINE_STORE](): EncodedWorkflowStore {
    return (this.engine ??= new EncodedWorkflowStore(this.source, this.codecs));
  }

  [LOCK_STORAGE](): void {
    if (this.active) {
      return;
    }
    if (
      !this.registered &&
      process.env.NODE_ENV === "production" &&
      !this.options?.allowInMemoryStorage
    ) {
      throw new Error(
        'WorkflowStorage: no WorkflowStore is registered, and NODE_ENV is "production": in memory, running workflows ' +
          "would be lost on restart and not shared between instances. Register a store on your database: " +
          "PostgresWorkflowStore (@bunest/workflows/postgres), MySqlWorkflowStore (@bunest/workflows/mysql), or your own " +
          "WorkflowStore in a provider that injects WorkflowStorage and calls `storage.registerSource(this)` in its " +
          "constructor. Or set `allowInMemoryStorage: true` in the WorkflowsModule options to run in memory anyway.",
      );
    }
    this.active = this.registered ?? new InMemoryWorkflowStore();
    this.logger.log(
      `WorkflowStorage: ${this.registered ? nameOf(this.registered) : DEFAULT}`,
    );
  }
}

function validate(source: unknown): asserts source is WorkflowStore {
  if (source === null || typeof source !== "object") {
    throw new TypeError(
      `WorkflowStorage.registerSource(): expected an object implementing WorkflowStore, got ${nameOf(source)}.`,
    );
  }
  const candidate = source as Record<string, unknown>;
  const missing = REQUIRED.filter(
    (method) => typeof candidate[method] !== "function",
  );
  const invalid = OPTIONAL.filter(
    (method) =>
      candidate[method] !== undefined &&
      typeof candidate[method] !== "function",
  );
  if (missing.length > 0 || invalid.length > 0) {
    const problems = [
      ...(missing.length
        ? [
            `${missing.map((m) => `${m}()`).join(", ")} ${missing.length === 1 ? "is" : "are"} missing`,
          ]
        : []),
      ...(invalid.length
        ? [
            `${invalid.join(", ")} ${invalid.length === 1 ? "is" : "are"} set but not a method`,
          ]
        : []),
    ];
    throw new TypeError(
      `WorkflowStorage.registerSource(): ${nameOf(source)} doesn't implement WorkflowStore: ${problems.join("; ")}.`,
    );
  }
}

function nameOf(value: unknown): string {
  if (typeof value === "function") {
    return `the class ${value.name || "(anonymous)"} (pass an instance)`;
  }
  if (value === null || typeof value !== "object") {
    return String(value);
  }
  const name = (value as { constructor?: { name?: string } }).constructor?.name;
  return name && name !== "Object" ? name : "an object";
}
