import { randomUUID } from "node:crypto";
import type { SqlDialect } from "../interfaces/sql-executor.interface";
import { show } from "./assertions";
import {
  CONTRACT_CASES,
  type ContractCaseKey,
  type DialectCases,
  type SqlExecutorContractCase,
  type SqlExecutorContractOptions,
  type SqlExecutorContractTarget,
} from "./contract.types";
import { MYSQL_CASES } from "./mysql-executor.cases";
import { POSTGRES_CASES } from "./postgres-executor.cases";

export type {
  ContractCaseKey,
  DialectCases,
  SqlExecutorContractCase,
  SqlExecutorContractOptions,
  SqlExecutorContractTarget,
} from "./contract.types";

const DIALECTS: Record<SqlDialect, DialectCases> = {
  postgres: POSTGRES_CASES,
  mysql: MYSQL_CASES,
};

/**
 * The `SqlExecutor` contract as test cases, for any test runner: what an executor for a client the kit doesn't cover
 * must do.
 */
export function sqlExecutorContract(
  createTarget: () =>
    | SqlExecutorContractTarget
    | Promise<SqlExecutorContractTarget>,
  options: SqlExecutorContractOptions = {},
): SqlExecutorContractCase[] {
  return (Object.keys(CONTRACT_CASES) as ContractCaseKey[]).map((key) => ({
    name: CONTRACT_CASES[key],
    run: async () => {
      const target = await createTarget();
      try {
        const dialect = DIALECTS[target.executor?.dialect];
        if (!dialect) {
          throw new Error(
            `sqlExecutorContract() covers ${Object.keys(DIALECTS).join(" and ")} executors; this one's dialect is ${show(target.executor?.dialect)}.`,
          );
        }
        const table = `sql_executor_contract_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        await target.executor.query(dialect.createTable(table));
        try {
          await dialect.cases[key](target, table);
        } finally {
          await target.executor
            .query(dialect.dropTable(table))
            .catch(() => undefined);
        }
      } finally {
        await options.dispose?.(target);
      }
    },
  }));
}
