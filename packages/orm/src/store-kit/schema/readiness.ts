import type {
  SqlDialect,
  SqlTransaction,
} from "../interfaces/sql-executor.interface";
import type {
  StoreReadiness,
  StoreReadinessOptions,
} from "../interfaces/store-readiness.interface";
import { IN_TRANSACTION_HINT } from "./schema-messages";

export interface ReadinessSteps {
  check(db: SqlTransaction): Promise<void>;
  assertMigrated(db: SqlTransaction, hint?: string): Promise<void>;
  migrate(): Promise<number[]>;
}

/**
 * A store's readiness, the same on every dialect: checked once and remembered; a failed preparation forgotten, so the
 * next call tries again (a migration applied meanwhile is picked up without a restart); calls that arrive while it
 * prepares wait for the same preparation.
 */
export class Readiness<
  D extends SqlDialect = SqlDialect,
> implements StoreReadiness {
  private prepared = false;
  private preparing: Promise<void> | undefined;

  constructor(
    private readonly storeName: string,
    private readonly options: StoreReadinessOptions<D>,
    private readonly steps: ReadinessSteps,
  ) {}

  ready(): Promise<void> {
    if (this.prepared) {
      return Promise.resolve();
    }
    this.preparing ??= this.prepare().then(
      () => {
        this.prepared = true;
      },
      (error) => {
        this.preparing = undefined;
        throw error;
      },
    );
    return this.preparing;
  }

  async readyIn(transaction: SqlTransaction): Promise<void> {
    if (this.prepared) {
      return;
    }
    await this.steps.check(transaction);
    await this.steps.assertMigrated(transaction, IN_TRANSACTION_HINT);
    this.prepared = true;
  }

  async migrate(): Promise<number[]> {
    const applied = await this.steps.migrate();
    if (applied.length > 0) {
      this.options.logger?.log(
        `${this.storeName}: migrated schema "${this.options.schema}" to version ${applied.at(-1)}.`,
      );
    }
    return applied;
  }

  private async prepare(): Promise<void> {
    await this.steps.check(this.options.executor);
    if (this.options.migrate) {
      await this.migrate();
    } else {
      await this.steps.assertMigrated(this.options.executor);
    }
  }
}
