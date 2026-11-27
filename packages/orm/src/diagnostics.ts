import { diagnosticsChannel, type DiagnosticChannel } from "@bunest/core";
import type {
  OrmDialect,
  OrmIsolationLevel,
  OrmTransactionPropagation,
} from "./types";

export const ORM_QUERY_CHANNEL = "bunest:orm:query";
export const ORM_TRANSACTION_CHANNEL = "bunest:orm:transaction";

export interface OrmQueryDiagnosticEvent {
  readonly sql: string;
  readonly dialect: OrmDialect;
  readonly durationMs: number;
  readonly rowCount?: number;
  readonly error?: Error;
  readonly dataSource?: string;
}

export interface OrmTransactionDiagnosticEvent {
  readonly phase: "begin" | "commit" | "rollback";
  readonly isolationLevel?: OrmIsolationLevel;
  readonly propagation?: OrmTransactionPropagation;
  readonly durationMs?: number;
  readonly error?: Error;
  readonly dataSource?: string;
}

const queryChannel: DiagnosticChannel = diagnosticsChannel(ORM_QUERY_CHANNEL);
const transactionChannel: DiagnosticChannel = diagnosticsChannel(
  ORM_TRANSACTION_CHANNEL,
);

/**
 * Returns `true` when at least one subscriber is attached to `"bunest:orm:query"`.
 * Guarding hot paths with this check keeps idle instrumentation overhead near zero.
 */
export function hasOrmQuerySubscribers(): boolean {
  return queryChannel.hasSubscribers;
}

/**
 * Returns `true` when at least one subscriber is attached to `"bunest:orm:transaction"`.
 */
export function hasOrmTransactionSubscribers(): boolean {
  return transactionChannel.hasSubscribers;
}

/**
 * Publishes a query telemetry event onto `"bunest:orm:query"` strictly when subscribed.
 */
export function emitOrmQueryDiagnostic(event: OrmQueryDiagnosticEvent): void {
  if (!queryChannel.hasSubscribers) {
    return;
  }
  queryChannel.publish(event);
}

/**
 * Publishes a transaction lifecycle event onto `"bunest:orm:transaction"` strictly when subscribed.
 */
export function emitOrmTransactionDiagnostic(
  event: OrmTransactionDiagnosticEvent,
): void {
  if (!transactionChannel.hasSubscribers) {
    return;
  }
  transactionChannel.publish(event);
}
