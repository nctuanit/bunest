import { inListKind } from "../../utils/params.util";

/**
 * A statement's parameters, as a PostgreSQL store writes them: every value goes to the driver as a string (or `null`),
 * cast in the statement (`$3::text::bigint`), and every column comes back cast to text (`columns()`).
 */
export class SqlParams {
  /** What the statement's placeholders take, in order: pass it as the statement's `params`. */
  readonly values: Array<string | null> = [];

  /** `$n::text`. */
  text(value: string | null): string {
    return this.add(value, "text");
  }

  /** `$n::text::integer`. Throws a `TypeError` for anything but a whole number or `null`. */
  int(value: number | null): string {
    return this.add(wholeNumber(value, "int"), "integer");
  }

  /** `$n::text::bigint`: epoch milliseconds, and any integer past `integer`'s range. */
  bigint(value: number | null): string {
    return this.add(wholeNumber(value, "bigint"), "bigint");
  }

  /** `$n::text::boolean`. */
  bool(value: boolean): string {
    return this.add(String(value), "boolean");
  }

  /** JSON, stored as `jsonb`; `null` and `undefined` as SQL `NULL`. */
  json(value: unknown): string {
    return this.add(
      value === null || value === undefined ? null : JSON.stringify(value),
      "jsonb",
    );
  }

  /**
   * `column = value`, or `column IS NULL` for `null`: keys match exactly, and `NULL = NULL` isn't true.
   */
  equals(column: string, value: string | null): string {
    return value === null
      ? `${column} IS NULL`
      : `${column} = ${this.text(value)}`;
  }

  /**
   * `column IN (...)` of the given values; `FALSE` for none. Strings as `text()`, whole numbers as `bigint()`.
   */
  in(column: string, values: readonly string[] | readonly number[]): string {
    if (values.length === 0) {
      return "FALSE";
    }
    const numbers = inListKind(values) === "number";
    return `${column} IN (${values
      .map((value) =>
        numbers
          ? this.add(String(value), "bigint")
          : this.text(value as string),
      )
      .join(", ")})`;
  }

  private add(value: string | null, type: string): string {
    this.values.push(value);
    return type === "text"
      ? `$${this.values.length}::text`
      : `$${this.values.length}::text::${type}`;
  }
}

function wholeNumber(value: number | null, method: string): string | null {
  if (value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `SqlParams.${method}() takes a whole number (or null), not ${String(value)}.`,
    );
  }
  return String(value);
}
