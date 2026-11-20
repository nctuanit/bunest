/**
 * Dynamically loads an optional peer module (e.g. `pg`, `mysql2/promise`, `drizzle-orm`, `kysely`)
 * without creating a static compile-time or bundler dependency.
 */
export async function loadOptionalModule<T = Record<string, unknown>>(
  specifier: string,
): Promise<T> {
  return (await import(specifier)) as T;
}
