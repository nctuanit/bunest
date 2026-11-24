import type {
  SqlDialect,
  SqlExecutor,
} from "../interfaces/sql-executor.interface";
import type {
  ResolvedStoreOptions,
  StoreOptions,
} from "../interfaces/store-options.interface";
import { hasMethod } from "../utils/executor.util";
import { DIALECT_NAMES, type SchemaDialect } from "./dialect";

export interface StoreIdentity {
  readonly packageName: string;
  readonly storeName: string;
  readonly defaultSchema: string;
}

/**
 * A store's `executor`, `schema` and `migrate` options, checked (a `TypeError` that names the store) and defaulted.
 */
export function resolveStoreOptions<D extends SqlDialect>(
  store: StoreIdentity,
  dialect: SchemaDialect<D>,
  options: StoreOptions,
): ResolvedStoreOptions<D> {
  const { packageName, storeName } = store;
  const executor = options?.executor;
  if (
    !hasMethod(executor, "query") ||
    !hasMethod(executor, "transaction") ||
    !hasMethod(executor, "wrapTransaction")
  ) {
    throw new TypeError(
      `${storeName}: \`executor\` must be a SqlExecutor, such as ${dialect.executors}.`,
    );
  }
  const executorDialect = (executor as { dialect?: SqlDialect }).dialect;
  if (executorDialect !== dialect.dialect) {
    throw new TypeError(
      executorDialect === undefined
        ? `${storeName}: \`executor\` doesn't say which database it runs on: a SqlExecutor has a \`dialect\` ('${dialect.dialect}' for ${DIALECT_NAMES[dialect.dialect]}).`
        : `${storeName} runs on ${DIALECT_NAMES[dialect.dialect]}, and \`executor\` is a ${DIALECT_NAMES[executorDialect] ?? String(executorDialect)} executor: ` +
            `import the executor from '${packageName}/${dialect.dialect}' (${dialect.executorNames}).`,
    );
  }
  if (options.migrate !== undefined && typeof options.migrate !== "boolean") {
    throw new TypeError(
      `${storeName}: \`migrate\` must be true or false, not ${JSON.stringify(options.migrate)}.`,
    );
  }
  const schema = options.schema ?? store.defaultSchema;
  dialect.checkSchema(schema, storeName);
  return {
    executor: executor as SqlExecutor<D>,
    schema,
    migrate: options.migrate ?? process.env.NODE_ENV !== "production",
  };
}
