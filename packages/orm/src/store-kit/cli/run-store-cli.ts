import type { CliStoreSchema } from "../interfaces/cli-store-schema.interface";
import type { SqlDialect } from "../interfaces/sql-executor.interface";
import type { StoreCliIo } from "../interfaces/store-cli-io.interface";
import { DIALECT_NAMES } from "../schema/dialect";
import { CLI_DIALECTS, URL_SCHEMES } from "./cli-dialects";
import { cliErrorMessage } from "./cli-error-message";

/**
 * A package's command for its stores' schemas (`npx <package> migrate|status|sql`), from a shell or a CI step:
 * resolves to the process's exit code.
 */
export async function runStoreCli(
  schemas: readonly CliStoreSchema[],
  argv: readonly string[],
  io: StoreCliIo = processIo(),
): Promise<number> {
  const [first] = schemas;
  const dialects = new Set(schemas.map((schema) => schema.dialect));
  if (
    !first ||
    dialects.size !== schemas.length ||
    schemas.some(
      (schema) =>
        schema.command !== first.command ||
        schema.packageName !== first.packageName,
    )
  ) {
    throw new TypeError(
      "runStoreCli() takes the schemas of one package's stores: at least one, one per dialect, with the same command.",
    );
  }
  const command = `npx ${first.packageName}`;
  const usage = usageOf(schemas);
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${usage}`);
    return 1;
  }
  const { positionals, values } = parsed;
  const [name] = positionals;
  if (values.help || name === undefined || name === "help") {
    (name === undefined && !values.help ? io.err : io.out)(usage);
    return name === undefined && !values.help ? 1 : 0;
  }
  const url = values.url ?? io.env.DATABASE_URL;
  try {
    if (name === "sql") {
      const schema = pick(schemas, dialectOption(values.dialect, schemas));
      io.out(
        schema.sql({
          schema: values.schema ?? schema.defaultSchema,
          from: version(values.from, "--from"),
          to: version(values.to, "--to"),
          statementBreakpoints: values["statement-breakpoints"],
        }),
      );
      return 0;
    }
    if (name !== "migrate" && name !== "status") {
      io.err(`Unknown command "${name}".\n\n${usage}`);
      return 1;
    }
    if (!url) {
      io.err(
        `${command} ${name} needs the database: pass --url, or set DATABASE_URL.\n`,
      );
      return 1;
    }
    const schema = pick(
      schemas,
      dialectOfUrl(url, `${command} ${name}`, schemas),
    );
    const dialect = CLI_DIALECTS[schema.dialect];
    const database = await dialect.open(url);
    if (!database) {
      io.err(
        `${command} needs the ${dialect.driver} package to reach the database (npm i ${dialect.driver}), or print the SQL with \`${command} sql\` and apply it with your own tool.\n`,
      );
      return 1;
    }
    const target = values.schema ?? schema.defaultSchema;
    try {
      if (name === "status") {
        const current = await schema.version(database.executor, target);
        io.out(
          `Schema "${target}" is at version ${current}; this version of ${schema.packageName} needs version ${schema.latest}.\n`,
        );
        return current >= schema.latest ? 0 : 1;
      }
      const applied = await schema.migrate(database.executor, target);
      io.out(
        applied.length > 0
          ? `Migrated schema "${target}" to version ${applied.at(-1)} (applied ${applied.join(", ")}).\n`
          : `Schema "${target}" is up to date (version ${await schema.version(database.executor, target)}).\n`,
      );
      return 0;
    } finally {
      await database.close();
    }
  } catch (error) {
    io.err(`${cliErrorMessage(error, url)}\n`);
    return 1;
  }
}

function usageOf(schemas: readonly CliStoreSchema[]): string {
  const [first] = schemas;
  const packageName = first!.packageName;
  const defaultSchema = first!.defaultSchema;
  const named = schemas.map(
    (schema, i) =>
      `${schema.storeName}'s${i === 0 ? " schema" : ""} (${schema.packageName}/${schema.dialect})`,
  );
  const stores = `${named.length > 1 ? `${named.slice(0, -1).join(", ")} or ${named.at(-1)}` : named[0]}:`;
  const mysql = schemas.some((schema) => schema.dialect === "mysql");
  const postgres = schemas.some((schema) => schema.dialect === "postgres");
  const migrate = !mysql
    ? "Apply the migrations the schema hasn't had yet (one transaction, under an advisory lock)"
    : `Apply the migrations the schema hasn't had yet${postgres ? " (PostgreSQL: one transaction, under an advisory lock;\n            MySQL: " : " ("}one statement at a time, under GET_LOCK(), resuming where a failed run stopped)`;
  const urls = [
    ...(postgres ? ["postgres://..."] : []),
    ...(mysql ? ["mysql://..."] : []),
  ].join(" or ");
  return `Usage: npx ${packageName} <command> [options]

${stores}

  migrate   ${migrate}
  status    Print the schema's version and the one this version of ${packageName} needs;
            exit with 1 while it is behind
  sql       Print the migrations' SQL, for your own migration tool (no database needed)

Options:
  --url <url>        The database (${urls}). Default: $DATABASE_URL
  --schema <name>    The store's schema. Default: ${defaultSchema}
  --from <version>   sql: the version to start from. Default: 0 (a new database)
  --to <version>     sql: the version to end at. Default: the latest
  --dialect <name>   sql: the database it's for (${schemas.map((schema) => schema.dialect).join(", ")}). Default: ${defaultDialect(schemas)}
  --statement-breakpoints
                     sql: separate the statements with drizzle-kit's "--> statement-breakpoint",
                     for a custom drizzle-kit migration (drizzle-kit generate --custom)
`;
}

interface StoreCliValues {
  url?: string;
  schema?: string;
  from?: string;
  to?: string;
  dialect?: string;
  "statement-breakpoints"?: boolean;
  help?: boolean;
}

const STRING_OPTIONS = new Set(["url", "schema", "from", "to", "dialect"]);
const BOOLEAN_OPTIONS = new Set(["statement-breakpoints", "help"]);

function parse(argv: readonly string[]): {
  values: StoreCliValues;
  positionals: string[];
} {
  const values: StoreCliValues = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      for (let j = i + 1; j < argv.length; j++) {
        positionals.push(argv[j]!);
      }
      break;
    }

    if (arg === "-h") {
      values.help = true;
      continue;
    }

    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      const name = eqIdx === -1 ? arg.slice(2) : arg.slice(2, eqIdx);
      const inlineValue = eqIdx === -1 ? undefined : arg.slice(eqIdx + 1);

      if (BOOLEAN_OPTIONS.has(name)) {
        if (inlineValue !== undefined) {
          throw new TypeError(
            `Option '--${name}' does not take an argument.`,
          );
        }
        (values as Record<string, unknown>)[name] = true;
        continue;
      }

      if (STRING_OPTIONS.has(name)) {
        if (inlineValue !== undefined) {
          (values as Record<string, unknown>)[name] = inlineValue;
        } else {
          const next = argv[i + 1];
          if (next === undefined || next.startsWith("-")) {
            throw new TypeError(`Option '--${name}' argument missing.`);
          }
          (values as Record<string, unknown>)[name] = next;
          i++;
        }
        continue;
      }

      throw new TypeError(`Unknown option '--${name}'.`);
    }

    if (arg.startsWith("-") && arg.length > 1) {
      throw new TypeError(`Unknown option '${arg}'.`);
    }

    positionals.push(arg);
  }

  return { values, positionals };
}

function version(
  value: string | undefined,
  option: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new TypeError(`${option} takes a version number, not "${value}".`);
  }
  return Number(value);
}

function defaultDialect(schemas: readonly CliStoreSchema[]): SqlDialect {
  return schemas.length === 1 ? schemas[0]!.dialect : "postgres";
}

function dialectOption(
  value: string | undefined,
  schemas: readonly CliStoreSchema[],
): SqlDialect {
  if (value === undefined) {
    return defaultDialect(schemas);
  }
  if (!Object.hasOwn(DIALECT_NAMES, value)) {
    throw new TypeError(
      `--dialect takes ${Object.keys(DIALECT_NAMES).join(" or ")}, not "${value}".`,
    );
  }
  return value as SqlDialect;
}

function dialectOfUrl(
  url: string,
  what: string,
  schemas: readonly CliStoreSchema[],
): SqlDialect {
  let scheme: string | undefined;
  try {
    scheme = new URL(url).protocol;
  } catch {
    scheme = undefined;
  }
  const dialect =
    scheme === undefined || !Object.hasOwn(URL_SCHEMES, scheme)
      ? undefined
      : URL_SCHEMES[scheme];
  if (dialect === undefined) {
    const schemes = Object.keys(URL_SCHEMES).filter((known) =>
      schemas.some((schema) => schema.dialect === URL_SCHEMES[known]),
    );
    throw new TypeError(
      `${what} takes a database URL that starts with ${schemes.map((known) => `${known}//`).join(" or ")}.`,
    );
  }
  return dialect;
}

function pick(
  schemas: readonly CliStoreSchema[],
  dialect: SqlDialect,
): CliStoreSchema {
  const schema = schemas.find((candidate) => candidate.dialect === dialect);
  if (schema) {
    return schema;
  }
  const [first] = schemas;
  const supported = schemas
    .map((candidate) => DIALECT_NAMES[candidate.dialect])
    .join(" and ");
  throw new Error(
    `npx ${first!.packageName}: ${DIALECT_NAMES[dialect]} isn't supported yet: the stores of ${first!.packageName} run on ${supported}.`,
  );
}

function processIo(): StoreCliIo {
  return {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    env: process.env,
  };
}
