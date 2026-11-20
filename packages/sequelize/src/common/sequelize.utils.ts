import { randomUUID } from "node:crypto";
import { Logger, type Type } from "@bunest/common";
import type {
  Subscribable,
  SubscribableObserver,
  Unsubscribable,
} from "@bunest/core";
import { CircularDependencyException } from "../exceptions/circular-dependency.exception";
import type { SequelizeModuleOptions } from "../interfaces/sequelize-options.interface";
import { Sequelize } from "../runtime/sequelize-runtime";
import { DEFAULT_CONNECTION_NAME } from "../sequelize.constants";

const logger = new Logger("SequelizeModule");

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSubscribable<T>(value: unknown): value is Subscribable<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Subscribable<T>).subscribe === "function"
  );
}

export function getModelToken(
  entity: Function,
  connection: SequelizeModuleOptions | string = DEFAULT_CONNECTION_NAME,
): string {
  if (entity === null || entity === undefined) {
    throw new CircularDependencyException("@InjectModel()");
  }
  const connectionPrefix = getConnectionPrefix(connection);
  return `${connectionPrefix}${entity.name}Repository`;
}

export function getConnectionToken(
  connection: SequelizeModuleOptions | string = DEFAULT_CONNECTION_NAME,
): string | Function | Type<Sequelize> {
  return DEFAULT_CONNECTION_NAME === connection
    ? Sequelize
    : typeof connection === "string"
      ? `${connection}Connection`
      : DEFAULT_CONNECTION_NAME === connection.name || !connection.name
        ? Sequelize
        : `${connection.name}Connection`;
}

export function getConnectionPrefix(
  connection: SequelizeModuleOptions | string = DEFAULT_CONNECTION_NAME,
): string {
  if (connection === DEFAULT_CONNECTION_NAME) {
    return "";
  }
  if (typeof connection === "string") {
    return `${connection}_`;
  }
  if (connection.name === DEFAULT_CONNECTION_NAME || !connection.name) {
    return "";
  }
  return `${connection.name}_`;
}

export interface SequelizeRetryHandler {
  <T>(factory: () => Promise<T> | T): Promise<T>;
  <T>(source: Subscribable<T>): Subscribable<T>;
}

/**
 * Zero-RxJS retry/backoff handler (ADR-008) supporting both Promise factories
 * and `Subscribable<T>`.
 */
export function handleRetry(
  retryAttempts = 9,
  retryDelay = 3000,
): SequelizeRetryHandler {
  const logRetry = (errorCount: number, error: unknown): void => {
    const errObj = error instanceof Error ? error : new Error(String(error));
    logger.error(
      `Unable to connect to the database. Retrying (${errorCount + 1})...`,
      errObj.stack,
    );
  };

  function runRetry<T>(factory: () => Promise<T> | T): Promise<T>;
  function runRetry<T>(source: Subscribable<T>): Subscribable<T>;
  function runRetry<T>(
    sourceOrFactory: (() => Promise<T> | T) | Subscribable<T>,
  ): Promise<T> | Subscribable<T> {
    if (isSubscribable<T>(sourceOrFactory)) {
      const source = sourceOrFactory;
      return {
        subscribe(
          observerOrNext?:
            | Partial<SubscribableObserver<T>>
            | ((value: T) => void),
          errorCb?: (err: unknown) => void,
          completeCb?: () => void,
        ): Unsubscribable {
          const observer: Partial<SubscribableObserver<T>> =
            typeof observerOrNext === "function"
              ? { next: observerOrNext, error: errorCb, complete: completeCb }
              : (observerOrNext ?? {});
          let errorCount = 0;
          let unsubscribed = false;
          let activeSub: Unsubscribable | undefined;
          let timer: ReturnType<typeof setTimeout> | undefined;

          const attempt = () => {
            if (unsubscribed) return;
            activeSub = source.subscribe({
              next: (val) => observer.next?.(val),
              complete: () => observer.complete?.(),
              error: (error) => {
                if (unsubscribed) return;
                logRetry(errorCount, error);
                errorCount++;
                if (errorCount >= retryAttempts) {
                  observer.error?.(error);
                  return;
                }
                timer = setTimeout(attempt, retryDelay);
              },
            });
          };
          attempt();

          return {
            unsubscribe() {
              unsubscribed = true;
              if (timer !== undefined) clearTimeout(timer);
              activeSub?.unsubscribe();
            },
          };
        },
      };
    }

    const factory = sourceOrFactory;
    return (async () => {
      let errorCount = 0;
      while (true) {
        try {
          return await factory();
        } catch (error) {
          logRetry(errorCount, error);
          errorCount++;
          if (errorCount >= retryAttempts) {
            throw error;
          }
          await sleep(retryDelay);
        }
      }
    })();
  }

  return runRetry;
}

export function getConnectionName(options: SequelizeModuleOptions): string {
  return options && options.name ? options.name : DEFAULT_CONNECTION_NAME;
}

export const generateString = (): `${string}-${string}-${string}-${string}-${string}` =>
  randomUUID();
