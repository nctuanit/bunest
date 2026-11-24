import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@bunest/core";
import { DiscoveryService, type InstanceWrapper } from "@bunest/core";
import { LocksEvents } from "../events/locks-events.service";
import type {
  LeaderElectionDefinition,
  OnLeadershipAcquired,
  OnLeadershipLost,
} from "../interfaces/leader-election.interface";
import type { Lock } from "../lock/lock";
import { LEADER_ELECTION, LOCKS_INTERNALS } from "../locks.constants";
import { Locks, type LocksInternals } from "../locks.service";
import { LockKeys } from "./lock-keys.service";

type LeaderParticipant = Partial<OnLeadershipAcquired & OnLeadershipLost> & {
  constructor: { name: string };
};

function isWrapperStatic(wrapper: InstanceWrapper): boolean {
  const flag = wrapper.isDependencyTreeStatic as unknown;
  return typeof flag === "function"
    ? Boolean((flag as () => boolean)())
    : Boolean(flag);
}

/** One election in this application: the lease on `key`, and the providers that take part. */
class Election {
  private lock?: Lock;
  private timer: unknown = undefined;
  private campaigning = false;
  private stopped = false;
  /** Aborts at `stop()`: a campaign still waiting for the store stops waiting. */
  private readonly stopping = new AbortController();

  constructor(
    private readonly key: string,
    private readonly ttl: number,
    readonly participants: LeaderParticipant[],
    private readonly locks: LocksInternals,
    private readonly events: LocksEvents,
    private readonly logger: Logger,
  ) {}

  start(): void {
    void this.campaign();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopping.abort(
      new DOMException("The application is shutting down", "AbortError"),
    );
    if (this.timer !== undefined) {
      this.locks.clock.clearTimeout(this.timer);
    }
    this.timer = undefined;
    if (this.lock) {
      await this.stepDown(this.lock);
    }
  }

  private async campaign(): Promise<void> {
    this.timer = undefined;
    if (this.stopped || this.lock || this.campaigning) {
      return;
    }
    this.campaigning = true;
    let lock: Lock | null = null;
    try {
      lock = await this.locks.tryAcquire(this.key, this.ttl, {
        onLost: (lost) => this.lost(lost),
        signal: this.stopping.signal,
      });
    } catch (error) {
      if (this.stopped) {
        return; // the campaign stopped waiting at shutdown, or failed after it: nothing to report
      }
      this.logger.error(
        `Leader election "${this.key}": the lock store failed`,
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.campaigning = false;
    }
    if (this.stopped) {
      await lock?.release().catch(() => undefined);
      return;
    }
    if (!lock) {
      this.schedule();
      return;
    }
    this.lock = lock;
    this.logger.log(
      `Leading "${this.key}" (fencing token ${lock.fencingToken})`,
    );
    this.events.emit({
      type: "leadership-acquired",
      key: this.key,
      fencingToken: lock.fencingToken,
    });
    for (const participant of this.participants) {
      this.call(participant, "onLeadershipAcquired", lock);
    }
  }

  /** The lease was lost: the hooks hear it, and the campaign resumes. */
  private lost(lock: Lock): void {
    if (this.lock !== lock) {
      return;
    }
    this.lock = undefined;
    this.events.emit({
      type: "leadership-lost",
      key: this.key,
      fencingToken: lock.fencingToken,
      reason: "lost",
    });
    for (const participant of this.participants) {
      this.call(participant, "onLeadershipLost", lock);
    }
    this.schedule();
  }

  /** Gives leadership back: at shutdown, or after a failed `onLeadershipAcquired()`. */
  private async stepDown(lock: Lock): Promise<void> {
    if (this.lock !== lock) {
      return;
    }
    this.lock = undefined;
    await lock.release().catch((error: unknown) => {
      this.logger.error(
        `Leader election "${this.key}": could not release the lease`,
        error instanceof Error ? error.stack : String(error),
      );
    });
    this.logger.log(`Stepped down from "${this.key}"`);
    this.events.emit({
      type: "leadership-lost",
      key: this.key,
      fencingToken: lock.fencingToken,
      reason: "released",
    });
    for (const participant of this.participants) {
      this.call(participant, "onLeadershipLost", lock);
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) {
      return;
    }
    if (this.timer !== undefined) {
      this.locks.clock.clearTimeout(this.timer);
    }
    this.timer = this.locks.clock.setTimeout(
      () => this.campaign(),
      Math.max(1, Math.floor(this.ttl / 3)),
    );
  }

  /** Calls a hook; a failed `onLeadershipAcquired()` steps down, so another instance can lead. */
  private call(
    participant: LeaderParticipant,
    hook: "onLeadershipAcquired" | "onLeadershipLost",
    lock: Lock,
  ): void {
    const fn = participant[hook];
    if (typeof fn !== "function") {
      return;
    }
    const failed = (error: unknown) => {
      this.logger.error(
        `${participant.constructor.name}.${hook}() failed for "${this.key}"` +
          (hook === "onLeadershipAcquired" ? ": stepping down" : ""),
        error instanceof Error ? error.stack : String(error),
      );
      if (hook === "onLeadershipAcquired") {
        void this.stepDown(lock);
      }
    };
    try {
      const result = fn.call(participant, lock) as
        | { then?: (onf?: unknown, onr?: (err: unknown) => void) => void }
        | undefined;
      if (result && typeof result.then === "function") {
        result.then(undefined, failed);
      }
    } catch (error) {
      Promise.reject(error).then(undefined, failed);
    }
  }
}

/**
 * Finds the `@LeaderElection()` providers, runs one election per key from
 * `onApplicationBootstrap` (when the application is ready to lead), and steps down at
 * shutdown.
 */
@Injectable()
export class LeaderElections
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger("Locks");
  private readonly elections = new Map<string, Election>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly locks: Locks,
    private readonly events: LocksEvents,
    private readonly keys: LockKeys,
  ) {}

  onModuleInit(): void {
    const internals = this.locks[LOCKS_INTERNALS];
    const ttls = new Map<string, number | undefined>();
    for (const wrapper of this.discovery.getProviders()) {
      const { instance } = wrapper;
      // The instance's class when present (for useFactory/useValue providers), falling back to
      // wrapper.metatype for request-scoped / transient providers that aren't pre-instantiated.
      const metatype =
        (instance && typeof instance === "object"
          ? instance.constructor
          : undefined) ??
        (typeof wrapper.metatype === "function" ? wrapper.metatype : undefined);
      const definition = (
        metatype as { [LEADER_ELECTION]?: LeaderElectionDefinition } | undefined
      )?.[LEADER_ELECTION];
      if (!definition) {
        continue;
      }
      const name = metatype?.name || "(anonymous)";
      if (!isWrapperStatic(wrapper)) {
        throw new Error(
          `@LeaderElection("${definition.key}") on ${name}: use it on a singleton provider (not request-scoped or transient)`,
        );
      }
      if (!instance || typeof instance !== "object") {
        continue;
      }
      const participant = instance as LeaderParticipant;
      if (
        typeof participant.onLeadershipAcquired !== "function" &&
        typeof participant.onLeadershipLost !== "function"
      ) {
        throw new Error(
          `@LeaderElection("${definition.key}") on ${name}: implement OnLeadershipAcquired (onLeadershipAcquired(lock)) ` +
            "and OnLeadershipLost (onLeadershipLost(lock)), or the election has nothing to call",
        );
      }
      if (
        ttls.has(definition.key) &&
        ttls.get(definition.key) !== definition.ttl
      ) {
        throw new Error(
          `@LeaderElection("${definition.key}") is used with different \`ttl\`s: one election has one lease`,
        );
      }
      ttls.set(definition.key, definition.ttl);
      this.keys.claim(definition.key, `@LeaderElection("${definition.key}")`);
      const election = this.elections.get(definition.key);
      if (election) {
        if (!election.participants.includes(participant)) {
          election.participants.push(participant);
        }
        continue;
      }
      this.elections.set(
        definition.key,
        new Election(
          definition.key,
          definition.ttl ?? internals.defaultTtl,
          [participant],
          internals,
          this.events,
          this.logger,
        ),
      );
    }
  }

  onApplicationBootstrap(): void {
    for (const election of this.elections.values()) {
      election.start();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      [...this.elections.values()].map((election) => election.stop()),
    );
  }
}
