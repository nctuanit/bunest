import { Logger } from "@bunest/common";
import {
  isEncodedPayload as encoded,
  type PayloadCodecs,
} from "../core/codecs/payload-codecs";
import { andThen, toPromise } from "../core/utils/maybe.util";
import type { SerializedWorkflowError } from "../interfaces/serialized-workflow-error.interface";
import type {
  WorkflowInstance,
  WorkflowJournalEntry,
  WorkflowStatus,
} from "../interfaces/workflow-instance.interface";
import type { WorkflowPayloadContext } from "../interfaces/workflow-payload-codec.interface";
import type {
  NewWorkflowInstance,
  NewWorkflowSignal,
  WorkflowCancelRequest,
  WorkflowClaim,
  WorkflowClaimRequest,
  WorkflowInstanceDetails,
  WorkflowKeyKind,
  WorkflowListQuery,
  WorkflowPurgeQuery,
  WorkflowPurgeResult,
  WorkflowReopen,
  WorkflowSignalQuery,
  WorkflowSignalRecord,
  WorkflowSignalResult,
  WorkflowStore,
  WorkflowWrite,
} from "../interfaces/workflow-store.interface";
import type { WorkflowScheduleMethods } from "../utils/schedule-store.util";
import {
  storableText,
  type TextCheck,
  type TextPlace,
} from "../utils/storable-text.util";

/** @internal A `WorkflowStore` without its schedules, which the engine reaches through the core's `Scheduler`. */
export type WorkflowInstanceStore = Omit<
  WorkflowStore,
  WorkflowScheduleMethods
>;

/**
 * @internal The store as the engine sees it with a codec: payloads encoded on the way in, decoded on the way out.
 */
export class EncodedWorkflowStore implements WorkflowInstanceStore {
  private static readonly logger = new Logger("Workflows");
  private readonly unreadable = new Set<string>();

  readonly createInTransaction?: WorkflowStore["createInTransaction"];
  readonly signalInTransaction?: WorkflowStore["signalInTransaction"];
  readonly checkKey?: WorkflowStore["checkKey"];

  readonly textCheck: (place: TextPlace) => TextCheck | undefined = (place) => {
    const inner = this.inner;
    if (
      typeof inner.unstorableText !== "function" ||
      (this.encodes && (place === "payload" || place === "cancelReason"))
    ) {
      return undefined;
    }
    const column = place === "payload" || place === "name" ? "json" : "text";
    return (text) => inner.unstorableText!(text, column);
  };

  constructor(
    readonly inner: WorkflowStore,
    readonly codecs: PayloadCodecs<WorkflowPayloadContext>,
  ) {
    if (typeof inner.createInTransaction === "function") {
      this.createInTransaction = (transaction, instance) =>
        this.instanceOf(
          andThen(this.encodeNew(instance), (enc) =>
            inner.createInTransaction!(transaction, enc),
          ),
        );
    }
    if (typeof inner.signalInTransaction === "function") {
      this.signalInTransaction = (transaction, signal) =>
        toPromise(
          andThen(this.encodeSignal(signal), (enc) =>
            inner.signalInTransaction!(transaction, enc),
          ),
        );
    }
    if (typeof inner.checkKey === "function") {
      this.checkKey = (kind: WorkflowKeyKind, value: string) =>
        inner.checkKey!(kind, value);
    }
  }

  get encodes(): boolean {
    return this.codecs.encodes;
  }

  create(
    instance: NewWorkflowInstance,
  ): Promise<{ instance: WorkflowInstance; created: boolean }> {
    return this.instanceOf(
      andThen(this.encodeNew(instance), (enc) => this.inner.create(enc)),
    );
  }

  async get(
    id: string,
    options?: { journal?: boolean },
  ): Promise<WorkflowInstanceDetails | null> {
    const details = await this.inner.get(id, options);
    if (!details) {
      return null;
    }
    const decoded = await this.decodeInstance(details);
    if (details.journal?.some(entryEncoded)) {
      decoded.journal = await Promise.all(
        details.journal.map((entry) => this.decodeEntry(entry, id)),
      );
    }
    return decoded;
  }

  async list(query: WorkflowListQuery): Promise<WorkflowInstance[]> {
    return Promise.all(
      (await this.inner.list(query)).map((instance) =>
        this.decodeInstance(instance),
      ),
    );
  }

  async requestCancel(
    id: string,
    request: WorkflowCancelRequest,
  ): Promise<boolean> {
    const reason = (await this.codecs.encode(request.reason, {
      field: "cancelReason",
      instanceId: id,
    })) as string | null;
    return this.inner.requestCancel(id, { ...request, reason });
  }

  async reopen(id: string, reopen: WorkflowReopen): Promise<boolean> {
    const [error, entries] = await Promise.all([
      this.codecs.encodeError(this.storableError(reopen.error), {
        field: "error",
        instanceId: id,
      }) as Promise<SerializedWorkflowError | null>,
      this.encodeEntries(reopen.entries, id),
    ]);
    return this.inner.reopen(id, { ...reopen, error, entries });
  }

  delete(id: string, statuses: WorkflowStatus[]): Promise<boolean> {
    return this.inner.delete(id, statuses);
  }

  signal(signal: NewWorkflowSignal): Promise<WorkflowSignalResult> {
    return toPromise(
      andThen(this.encodeSignal(signal), (enc) => this.inner.signal(enc)),
    );
  }

  async signals(query: WorkflowSignalQuery): Promise<WorkflowSignalRecord[]> {
    const records = await this.inner.signals(query);
    return Promise.all(
      records.map(async (record) =>
        encoded(record.payload)
          ? {
              ...record,
              payload: await this.codecs.decode(record.payload, {
                field: "payload",
                signal: record.name,
              }),
            }
          : record,
      ),
    );
  }

  purge(query: WorkflowPurgeQuery): Promise<WorkflowPurgeResult> {
    return this.inner.purge(query);
  }

  async claim(request: WorkflowClaimRequest): Promise<WorkflowClaim> {
    const claim = await this.inner.claim(request);
    const instances = await this.readable(
      claim.instances,
      (instance) => this.decodeInstance(instance),
      "Instance",
      (instance) =>
        this.handBack(instance.id, request.token, {
          now: request.now,
          leaseUntil: request.leaseUntil,
          signalCursor: claim.lastSignalId,
        }),
    );
    return { ...claim, instances };
  }

  async handBack(
    id: string,
    token: string,
    lease: { now: number; leaseUntil: number; signalCursor: number },
  ): Promise<void> {
    const waits = (await this.inner.get(id))?.waits ?? [];
    await this.inner.write(id, token, {
      now: lease.now,
      entries: [],
      release: {
        wakeAt: lease.leaseUntil,
        waits,
        signalCursor: lease.signalCursor,
      },
    });
  }

  renew(
    id: string,
    token: string,
    leaseUntil: number,
  ): Promise<{ cancelRequested: boolean; terminateRequested: boolean } | null> {
    return this.inner.renew(id, token, leaseUntil);
  }

  async write(
    id: string,
    token: string,
    write: WorkflowWrite,
  ): Promise<boolean> {
    const context = (
      field: WorkflowPayloadContext["field"],
    ): WorkflowPayloadContext => ({ field, instanceId: id });
    const [entries, output, error, customStatus, signal] = await Promise.all([
      this.encodeEntries(write.entries, id),
      this.codecs.encode(write.output, context("output")),
      this.codecs.encodeError(
        this.storableError(write.error),
        context("error"),
      ) as Promise<SerializedWorkflowError | null | undefined>,
      this.codecs.encode(write.customStatus, context("customStatus")),
      write.signal ? this.encodeSignal(write.signal) : undefined,
    ]);
    return this.inner.write(id, token, {
      ...write,
      entries,
      ...(write.output === undefined ? {} : { output }),
      ...(write.error === undefined ? {} : { error }),
      ...(write.customStatus === undefined ? {} : { customStatus }),
      ...(signal ? { signal } : {}),
    });
  }

  private storableError(
    error: SerializedWorkflowError | null | undefined,
  ): SerializedWorkflowError | null | undefined {
    const check = this.textCheck("name");
    if (!check || error === null || error === undefined) {
      return error;
    }
    const text = (value: string) =>
      typeof value !== "string" || this.encodes
        ? value
        : storableText(value, check);
    const { compensation } = error;
    return {
      ...error,
      name:
        typeof error.name === "string"
          ? storableText(error.name, check)
          : error.name,
      message: text(error.message),
      ...(error.stack === undefined ? {} : { stack: text(error.stack) }),
      ...(compensation === undefined
        ? {}
        : {
            compensation: this.storableError(
              compensation,
            ) as SerializedWorkflowError,
          }),
    };
  }

  private encodeNew(instance: NewWorkflowInstance) {
    return andThen(
      this.codecs.encode(instance.input, {
        field: "input",
        instanceId: instance.id,
      }),
      (input) => ({ ...instance, input }),
    );
  }

  private encodeSignal(signal: NewWorkflowSignal) {
    return andThen(
      this.codecs.encode(signal.payload, {
        field: "payload",
        signal: signal.name,
      }),
      (payload) => ({ ...signal, payload }),
    );
  }

  private encodeEntries(
    entries: WorkflowJournalEntry[],
    instanceId: string,
  ): Promise<WorkflowJournalEntry[]> {
    return Promise.all(
      entries.map(async (entry) => {
        const context = (
          field: WorkflowPayloadContext["field"],
        ): WorkflowPayloadContext => ({ field, instanceId, entry: entry.name });
        const [result, progress, data, error] = await Promise.all([
          this.codecs.encode(entry.result, context("result")),
          this.codecs.encode(entry.progress, context("progress")),
          this.codecs.encode(entry.data, context("data")),
          this.codecs.encodeError(
            this.storableError(entry.error),
            context("error"),
          ) as Promise<SerializedWorkflowError | undefined>,
        ]);
        return { ...entry, result, progress, data, error };
      }),
    );
  }

  private async decodeEntry(
    entry: WorkflowJournalEntry,
    instanceId: string,
  ): Promise<WorkflowJournalEntry> {
    if (!entryEncoded(entry)) {
      return entry;
    }
    const context = (
      field: WorkflowPayloadContext["field"],
    ): WorkflowPayloadContext => ({ field, instanceId, entry: entry.name });
    const [result, progress, data, error] = await Promise.all([
      this.codecs.decode(entry.result, context("result")),
      this.codecs.decode(entry.progress, context("progress")),
      this.codecs.decode(entry.data, context("data")),
      this.codecs.decodeError(entry.error, context("error")) as Promise<
        SerializedWorkflowError | undefined
      >,
    ]);
    return {
      ...entry,
      ...("result" in entry ? { result } : {}),
      ...("progress" in entry ? { progress } : {}),
      ...("data" in entry ? { data } : {}),
      ...("error" in entry ? { error } : {}),
    };
  }

  async readableInstance<T extends WorkflowInstance>(instance: T): Promise<T> {
    try {
      return await this.decodeInstance(instance);
    } catch (error) {
      if (!this.unreadable.has(instance.id)) {
        this.unreadable.add(instance.id);
        EncodedWorkflowStore.logger.warn(
          `Instance "${instance.id}" is listed without its payloads, which can't be read: ${(error as Error).message}`,
        );
      }
      const { name } = instance.error ?? {};
      return {
        ...instance,
        input: undefined,
        output: undefined,
        customStatus: null,
        cancelReason: null,
        error: name === undefined ? null : { name, message: "(unreadable)" },
      };
    }
  }

  private async decodeInstance<T extends WorkflowInstance>(
    instance: T,
  ): Promise<T> {
    if (
      ![
        instance.input,
        instance.output,
        instance.error?.message,
        instance.customStatus,
        instance.cancelReason,
      ].some(encoded)
    ) {
      return instance;
    }
    const context = (
      field: WorkflowPayloadContext["field"],
    ): WorkflowPayloadContext => ({ field, instanceId: instance.id });
    const [input, output, error, customStatus, cancelReason] =
      await Promise.all([
        this.codecs.decode(instance.input, context("input")),
        this.codecs.decode(instance.output, context("output")),
        this.codecs.decodeError(instance.error, context("error")) as Promise<
          SerializedWorkflowError | null | undefined
        >,
        this.codecs.decode(instance.customStatus, context("customStatus")),
        this.codecs.decode(instance.cancelReason, context("cancelReason")),
      ]);
    return {
      ...instance,
      input,
      ...("output" in instance ? { output } : {}),
      error,
      customStatus,
      cancelReason: cancelReason as string | null,
    };
  }

  private async instanceOf(
    stored:
      | { instance: WorkflowInstance; created: boolean }
      | Promise<{ instance: WorkflowInstance; created: boolean }>,
  ): Promise<{ instance: WorkflowInstance; created: boolean }> {
    const { instance, created } = await stored;
    return { instance: await this.decodeInstance(instance), created };
  }

  private async readable<T extends { id: string }>(
    claimed: T[],
    decode: (item: T) => Promise<T>,
    kind: string,
    handBack: (item: T) => Promise<void>,
  ): Promise<T[]> {
    const decoded: T[] = [];
    for (const item of claimed) {
      try {
        decoded.push(await decode(item));
      } catch (error) {
        EncodedWorkflowStore.logger.error(
          `${kind} "${item.id}" can't be read, so it isn't run; it is claimed again later. ${(error as Error).message}`,
        );
        await handBack(item).catch(() => undefined);
      }
    }
    return decoded;
  }
}

function entryEncoded(entry: WorkflowJournalEntry): boolean {
  return (
    encoded(entry.result) ||
    encoded(entry.progress) ||
    encoded(entry.data) ||
    encoded(entry.error?.message)
  );
}
