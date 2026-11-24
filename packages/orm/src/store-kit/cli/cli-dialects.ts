import type {
  SqlDialect,
  SqlExecutor,
} from "../interfaces/sql-executor.interface";

/** The dialects of the URL schemes the command line knows. */
export const URL_SCHEMES: Record<string, SqlDialect> = {
  "postgres:": "postgres",
  "postgresql:": "postgres",
  "mysql:": "mysql",
};

export interface CliDialectDriver {
  readonly driver: string;
  open(
    url: string,
  ): Promise<{ executor: SqlExecutor; close(): Promise<void> } | null>;
}

/** The dialects the kit supports, each loaded when a command needs it. */
export const CLI_DIALECTS: Record<SqlDialect, CliDialectDriver> = {
  postgres: {
    driver: "Bun.SQL",
    open: async (url) =>
      (await import("../postgres/schema/cli-connection")).openPostgres(url),
  },
  mysql: {
    driver: "Bun.SQL",
    open: async (url) =>
      (await import("../mysql/schema/cli-connection")).openMysql(url),
  },
};
