import { quoteIdentifier } from "./identifiers";

/**
 * A select list of `names`, each cast to text under its own name (`` CAST(`id` AS CHAR) AS `id`, ... ``),
 * prefixed with `alias` when given.
 */
export function columns(names: readonly string[], alias?: string): string {
  const prefix = alias === undefined ? "" : `${quoteIdentifier(alias)}.`;
  return names
    .map(
      (name) =>
        `CAST(${prefix}${quoteIdentifier(name)} AS CHAR) AS ${quoteIdentifier(name)}`,
    )
    .join(", ");
}

export { toBool, toInt, toJson, toText } from "../../sql/converters";
