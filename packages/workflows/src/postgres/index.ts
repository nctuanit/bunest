// The `@bunest/workflows/postgres` entry: the first-party PostgreSQL store. Nothing here imports a driver or an ORM:
// the executors (from @bunest/store-kit, which every first-party store builds on) reach the client the application
// passes them.

// The store, and the error it fails startup with while its schema is behind
export { PostgresWorkflowStore } from "./postgres-workflow.store";
export { WorkflowSchemaError } from "./errors/index";
export type { PostgresWorkflowStoreOptions } from "./interfaces/index";

// Executors: the store's SQL through the application's pool or ORM, and its transactions
export {
  fromDrizzle,
  fromKysely,
  fromPg,
  fromPrisma,
  fromTypeOrm,
  type PrismaExecutorOptions,
} from "@bunest/store-kit/postgres";
export type {
  SqlExecutor,
  SqlIsolationLevel,
  SqlTransaction,
  SqlTransactionOptions,
} from "@bunest/store-kit/postgres";
