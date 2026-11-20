import { Logger } from "@bunest/common";
import { DEFAULT_DB_CONNECTION } from "../mongoose.constants";

export function getModelToken(model: string, connectionName?: string): string {
  if (connectionName === undefined) {
    return `${model}Model`;
  }
  return `${getConnectionToken(connectionName)}/${model}Model`;
}

export function getConnectionToken(name?: string): string {
  return name && name !== DEFAULT_DB_CONNECTION
    ? `${name}Connection`
    : DEFAULT_DB_CONNECTION;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  });
}

/**
 * Promise-based retry helper (zero RxJS per Bunest ADR-008).
 * Retries an async factory function up to `retryAttempts` times with `retryDelay` ms
 * between attempts.
 */
export function handleRetry(
  retryAttempts = 9,
  retryDelay = 3000,
  verboseRetryLog = false,
): <T>(operation: () => Promise<T>) => Promise<T> {
  const logger = new Logger("MongooseModule");
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    let errorCount = 0;
    while (true) {
      try {
        return await operation();
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        const verboseMessage = verboseRetryLog
          ? ` Message: ${err.message}.`
          : "";
        const retryMessage =
          retryAttempts > 0 ? ` Retrying (${errorCount + 1})...` : "";
        logger.error(
          [
            "Unable to connect to the database.",
            verboseMessage,
            retryMessage,
          ].join(""),
          err.stack,
        );
        if (errorCount + 1 >= retryAttempts) {
          throw error;
        }
        errorCount += 1;
        await sleep(retryDelay);
      }
    }
  };
}
