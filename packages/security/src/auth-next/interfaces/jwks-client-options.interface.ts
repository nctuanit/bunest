import type { Duration } from "./duration.interface";

export interface JwksClientOptions {
  /** How long a fetched key set is trusted. Default `'10m'`. */
  cacheTtl?: Duration;
  /** Minimum gap between refetches triggered by an unknown `kid`. Default `'30s'`. */
  cooldown?: Duration;
  /** Request timeout. Default `'5s'`. */
  timeout?: Duration;
  fetch?: typeof fetch;
  /** Clock in epoch milliseconds, for tests. */
  now?: () => number;
}
