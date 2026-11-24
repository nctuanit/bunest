import {
  registerQueryOperator,
  type CustomQueryOperator,
} from "@bunest/orm";

/**
 * Custom derived query operator (`IContains`):
 * Enables derived finders such as `findAllByOrderCodeIContains("ORD")` across
 * SQLite, PostgreSQL, and MySQL AND surfaces in VS Code autocomplete & SQL Hover!
 */
export const iContainsOperator: CustomQueryOperator = {
  suffix: "IContains",
  arity: 1,
  description: "Case-insensitive substring match (LOWER(col) LIKE LOWER(?))",
  toSql(ctx) {
    const p = ctx.nextPlaceholder();
    const raw = String(ctx.args[0] ?? "");
    return {
      sql: `LOWER(${ctx.quotedColumn}) LIKE LOWER(${p})`,
      params: [`%${raw}%`],
    };
  },
};

export function registerShowcaseQueryOperators(): CustomQueryOperator {
  return registerQueryOperator(iContainsOperator);
}

// Register on module load so both runtime ORM queries and CLI/VS Code discovery see `IContains`.
registerShowcaseQueryOperators();
