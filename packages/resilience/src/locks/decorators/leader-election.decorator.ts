import type {
  LeaderElectionDefinition,
  LeaderElectionOptions,
} from "../interfaces/leader-election.interface";
import { LEADER_ELECTION } from "../locks.constants";
import { ttlMs } from "../utils/ttl.util";

/**
 * Makes the provider take part in the election for `key`: one instance of the application
 * at a time leads, holding a lease it renews; the others try to take it every `ttl / 3`.
 * The provider implements `OnLeadershipAcquired` and `OnLeadershipLost`.
 */
export function LeaderElection(
  key: string,
  options: LeaderElectionOptions = {},
): ClassDecorator {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError(
      `@LeaderElection(): the election key must be a non-empty string, got ${JSON.stringify(key)}`,
    );
  }
  if (options === null || typeof options !== "object") {
    throw new TypeError(
      `@LeaderElection("${key}") takes an options object ({ ttl }), got ${JSON.stringify(options)}`,
    );
  }
  const ttl =
    options.ttl === undefined
      ? undefined
      : ttlMs(options.ttl, `@LeaderElection("${key}"): \`ttl\``);
  return (target) => {
    const definition: LeaderElectionDefinition = { key, ttl };
    Object.defineProperty(target, LEADER_ELECTION, {
      value: definition,
      configurable: true,
    });
  };
}
