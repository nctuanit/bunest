import { inListKind } from "../../utils/params.util";

/** A JSON document from its text, on MySQL and MariaDB alike. */
const JSON_DOCUMENT = "JSON_EXTRACT(?, '$')";

/**
 * A statement's parameters, as a MySQL store writes them: every value goes to the client as a string (or `null`)
 * for a `?` placeholder, cast in the statement where it isn't text (`CAST(? AS SIGNED)`).
 */
export class SqlParams {
  /** What the statement's placeholders take, in order: pass it as the statement's `params`. */
  readonly values: Array<string | null> = [];

  /** `?`: text, compared by the column's collation. */
  text(value: string | null): string {
    this.values.push(value);
    return "?";
  }

  /** `CAST(? AS SIGNED)`, for an INT column. Throws a `TypeError` for anything but a whole number or `null`. */
  int(value: number | null): string {
    return this.add(wholeNumber(value, "int"), "CAST(? AS SIGNED)");
  }

  /** `CAST(? AS SIGNED)`, for a BIGINT column. */
  bigint(value: number | null): string {
    return this.add(wholeNumber(value, "bigint"), "CAST(? AS SIGNED)");
  }

  /** `CAST(? AS UNSIGNED)` of `1` or `0`, for a BOOLEAN (TINYINT(1)) column. */
  bool(value: boolean): string {
    return this.add(value ? "1" : "0", "CAST(? AS UNSIGNED)");
  }

  /**
   * `JSON_EXTRACT(?, '$')`, for a JSON column (with `JSON_SET(..., ?, CAST(? AS DOUBLE))` for non-safe-integer
   * doubles to avoid MySQL 8's JSON text double rounding).
   */
  json(value: unknown): string {
    if (value === null || value === undefined) {
      return this.add(null, JSON_DOCUMENT);
    }
    const text = JSON.stringify(value);
    const doubles: Array<[string, number]> = [];
    const document =
      text === undefined
        ? undefined
        : zeroDoubles(JSON.parse(text), "$", doubles);
    if (doubles.length === 0) {
      return this.add(text ?? null, JSON_DOCUMENT);
    }
    this.values.push(JSON.stringify(document));
    for (const [path, double] of doubles) {
      this.values.push(path, String(double));
    }
    return `JSON_SET(${JSON_DOCUMENT}, ${doubles.map(() => "?, CAST(? AS DOUBLE)").join(", ")})`;
  }

  /**
   * `column = ?`, or `column IS NULL` for `null`.
   */
  equals(column: string, value: string | null): string {
    return value === null
      ? `${column} IS NULL`
      : `${column} = ${this.text(value)}`;
  }

  /**
   * `column IN (?, ...)` of the given values; `FALSE` for none.
   */
  in(column: string, values: readonly string[] | readonly number[]): string {
    if (values.length === 0) {
      return "FALSE";
    }
    const numbers = inListKind(values) === "number";
    return `${column} IN (${values
      .map((value) =>
        numbers
          ? this.add(String(value), "CAST(? AS SIGNED)")
          : this.text(value as string),
      )
      .join(", ")})`;
  }

  /**
   * A LIMIT or OFFSET count, written into the statement. Throws a `TypeError` for anything but a whole number from 0.
   */
  limit(value: number): string {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(
        `SqlParams.limit() takes a whole number from 0, not ${JSON.stringify(value)}.`,
      );
    }
    return String(value);
  }

  private add(value: string | null, placeholder: string): string {
    this.values.push(value);
    return placeholder;
  }
}

function zeroDoubles(
  value: unknown,
  path: string,
  doubles: Array<[string, number]>,
): unknown {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) {
      return value;
    }
    doubles.push([path, value]);
    return 0;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      value[index] = zeroDoubles(item, `${path}[${index}]`, doubles);
    });
  } else if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of Object.keys(object)) {
      object[key] = zeroDoubles(
        object[key],
        `${path}.${JSON.stringify(key)}`,
        doubles,
      );
    }
  }
  return value;
}

function wholeNumber(value: number | null, method: string): string | null {
  if (value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `SqlParams.${method}() takes a whole number (or null), not ${String(value)}: MySQL would round it, or wrap it past 2^63, without an error.`,
    );
  }
  return String(value);
}
