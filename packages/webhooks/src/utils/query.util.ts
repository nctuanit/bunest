/**
 * `limit` and `offset` as a store hands them to SQL: whole numbers, or absent. A partner API
 * passes them from the query string; a `NaN` or a negative would fail in the store instead.
 */
export function checkPage<T extends { limit?: number; offset?: number }>(
  query: T,
  where: string,
): T {
  const { limit, offset } = query;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new TypeError(
      `${where}: limit must be a whole number of at least 1 (got ${limit})`,
    );
  }
  if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
    throw new TypeError(
      `${where}: offset must be a whole number of at least 0 (got ${offset})`,
    );
  }
  return query;
}

/**
 * `lastStatusCode` as a store compares it: an HTTP status, `null`, or absent. A partner API passes it from the query
 * string; a string would match nothing in memory and fail in a SQL store instead.
 */
export function checkStatusCode<T extends { lastStatusCode?: number | null }>(
  query: T,
  where: string,
): T {
  const { lastStatusCode } = query;
  if (
    lastStatusCode !== undefined &&
    lastStatusCode !== null &&
    (!Number.isInteger(lastStatusCode) ||
      lastStatusCode < 100 ||
      lastStatusCode > 599)
  ) {
    throw new TypeError(
      `${where}: lastStatusCode must be an HTTP status code (100-599) or null (got ${lastStatusCode})`,
    );
  }
  return query;
}
