import { StoreSchema } from "@bunest/orm/postgres";
import { WorkflowSchemaError } from "../../sql/workflow-schema.error";
import { initialMigration } from "./initial.migration";

/**
 * PostgresWorkflowStore's schema: every version of it, in order (a new one goes last, and none ever changes once
 * released), and what the store, its statics and `nest-workflows` do with them.
 */
export const workflowStoreSchema: StoreSchema = new StoreSchema({
  packageName: "@bunest/workflows",
  storeName: "PostgresWorkflowStore",
  command: "nest-workflows",
  defaultSchema: "nest_workflows",
  migrations: [initialMigration],
  createError: (message, details) => new WorkflowSchemaError(message, details),
});
