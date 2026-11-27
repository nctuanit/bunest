// The three HTTP-date forms (RFC 9110 §5.6.7): IMF-fixdate, RFC 850, asctime.
const IMF_FIXDATE =
  /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const RFC850_DATE =
  /^[A-Z][a-z]+, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
const ASCTIME_DATE =
  /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;

/**
 * Browser-pure RFC 9110 `Retry-After` parser (delay-seconds or HTTP-date -> ms).
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1_000;
    return Number.isFinite(ms) ? ms : undefined;
  }
  let date = Number.NaN;
  if (IMF_FIXDATE.test(trimmed) || RFC850_DATE.test(trimmed)) {
    date = Date.parse(trimmed);
  } else if (ASCTIME_DATE.test(trimmed)) {
    date = Date.parse(`${trimmed} GMT`);
  }
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
