/** A schema name a store accepts: an unquoted-style identifier, so no quoting or `$` can surprise anyone. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** `schema` is a name `quoteSchema()` accepts. */
export function isSchemaName(schema: unknown): schema is string {
  return typeof schema === "string" && IDENTIFIER.test(schema);
}

/**
 * `"schema"`, after checking the name: letters, digits and underscores, not starting with a digit, at most 63
 * characters. Throws a `TypeError` that names `store` for any other.
 */
export function quoteSchema(schema: string, store: string): string {
  if (!isSchemaName(schema)) {
    throw new TypeError(
      `${store}: invalid schema ${JSON.stringify(schema)}. Use letters, digits and underscores, not starting with a digit, at most 63 characters.`,
    );
  }
  return `"${schema}"`;
}
