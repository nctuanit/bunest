/** A MySQL identifier a store writes: no quoting or escaping needed, at most 64 characters (MySQL's limit). */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** A store's schema name on MySQL, the start of its table names: lowercase, at most 40 chars. */
const SCHEMA = /^[a-z_][a-z0-9_]{0,39}$/;

/** A table's own name, after the schema's. */
const TABLE = /^[a-z][a-z0-9_]*$/;

/** The kit's tables, in every store's schema. */
const KIT_TABLES = ["migrations", "locks"];

/**
 * `` `name` ``, after checking it: letters, digits and underscores, not starting with a digit, at most 64 characters.
 */
export function quoteIdentifier(name: string): string {
  if (typeof name !== "string" || !IDENTIFIER.test(name)) {
    throw new TypeError(
      `Invalid MySQL identifier ${JSON.stringify(name)}: use letters, digits and underscores, not starting with a digit, at most 64 characters.`,
    );
  }
  return `\`${name}\``;
}

/** `schema` is a schema name a MySQL store accepts. */
export function isSchemaName(schema: unknown): schema is string {
  return typeof schema === "string" && SCHEMA.test(schema);
}

/** Throws a `TypeError` that names `store` unless `schema` is a schema name a MySQL store accepts. */
export function checkSchema(schema: string, store: string): void {
  if (!isSchemaName(schema)) {
    throw new TypeError(
      `${store}: invalid schema ${JSON.stringify(schema)}. Use lowercase letters, digits and underscores, not starting with a digit, at most 40 characters: ` +
        "the store's tables are named <schema>_<table> in the connection's database.",
    );
  }
}

/**
 * `` `<schema>_<table>` ``: a store's table on MySQL, in the connection's database.
 */
export function quoteTable(
  schema: string,
  table: string,
  store: string,
): string {
  if (KIT_TABLES.includes(table)) {
    throw new TypeError(
      `${store}: the table name "${table}" is taken: every store's schema has the kit's own ${KIT_TABLES.join(" and ")} tables.`,
    );
  }
  return tableName(schema, table, store);
}

/** `quoteTable()` without the kit's reserved names: the kit's own tables. */
export function tableName(
  schema: string,
  table: string,
  store: string,
): string {
  checkSchema(schema, store);
  if (typeof table !== "string" || !TABLE.test(table)) {
    throw new TypeError(
      `${store}: invalid table name ${JSON.stringify(table)}. Use lowercase letters, digits and underscores, starting with a letter.`,
    );
  }
  const name = `${schema}_${table}`;
  if (name.length > 64) {
    throw new TypeError(
      `${store}: the table name "${name}" is ${name.length} characters long, and MySQL allows 64: use a shorter schema.`,
    );
  }
  return `\`${name}\``;
}

/**
 * The type of a key column (an id, a key, a name a store looks rows up by):
 * `varchar(<length>) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`.
 */
export function keyColumn(length: number): string {
  if (!Number.isInteger(length) || length < 1 || length > 768) {
    throw new RangeError(
      `keyColumn() takes a length from 1 to 768 characters (InnoDB's 3,072-byte index keys hold 768 four-byte characters), not ${JSON.stringify(length)}.`,
    );
  }
  return `varchar(${length}) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`;
}
