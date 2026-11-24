// The `@bunest/workflows/mysql` entry: the first-party MySQL store. Nothing here imports a driver or an ORM: the
// executors (from @bunest/orm/store, which every first-party store builds on) reach the client the application
// passes them.

// The store, and the error it fails startup with while its schema is behind (the same class as /postgres's)
export { MySqlWorkflowStore } from "./mysql-workflow.store";
export { WorkflowSchemaError } from "../sql/workflow-schema.error";
export type { MySqlWorkflowStoreOptions } from "./interfaces/index";

// Executors: the store's SQL through the application's pool or ORM, and its transactions
export {
  fromDrizzle,
  fromKysely,
  fromMysql2,
  fromPrisma,
  fromTypeOrm,
  type PrismaExecutorOptions,
} from "@bunest/orm/mysql";
export type {
  SqlExecutor,
  SqlIsolationLevel,
  SqlTransaction,
  SqlTransactionOptions,
} from "@bunest/orm/mysql";
