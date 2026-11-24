/**
 * A select list of `names`, each cast to text under its own name (`id::text AS id, ...`), prefixed with `alias` when
 * given: read the values with `toText()`, `toInt()`, `toBool()` and `toJson()`.
 */
export function columns(names: readonly string[], alias?: string): string {
  return names
    .map((name) => `${alias ? `${alias}.` : ""}${name}::text AS ${name}`)
    .join(", ");
}

export { toBool, toInt, toJson, toText } from "../../sql/converters";
