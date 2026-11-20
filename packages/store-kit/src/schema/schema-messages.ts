/**
 * What a store that isn't ready says when it's first called in the application's transaction: it doesn't migrate
 * there, as that would put its DDL in the application's transaction.
 */
export const IN_TRANSACTION_HINT =
  "The store applies its migrations when the application starts (onModuleInit), or at its first call outside a transaction: it can't apply them in yours.";

/** A schema behind the store's migrations, and the three ways to migrate it (or `hint`). */
export function schemaBehindMessage(
  identity: { readonly packageName: string; readonly storeName: string },
  schema: string,
  version: number,
  latest: number,
  hint?: string,
): string {
  const { packageName, storeName } = identity;
  return (
    `${storeName}: schema "${schema}" is at version ${version}, and this version of ${packageName} needs version ${latest}. ` +
    (hint ??
      `Apply its migrations: set \`migrate: true\` to apply them at startup, run \`npx ${packageName} migrate --url <database url> --schema ${schema}\`, ` +
        `or apply \`${storeName}.migrationSql({ schema: '${schema}', from: ${version} })\` with your migration tool.`)
  );
}
