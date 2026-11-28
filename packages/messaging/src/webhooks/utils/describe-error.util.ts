import {
  describeError as coreDescribeError,
  isError,
  isString,
} from "@bunest/core/common";

/** `https://hooks.example.com/…`: an error message never carries a URL's path or query (tokens live there). */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" && !parsed.search ? "/" : "/…"}`;
  } catch {
    return "(an invalid URL)";
  }
}

const MAX_ERROR_LENGTH = 1_000;

/** A compact, storable description of whatever was thrown. Never throws. */
export function describeError(error: unknown): string {
  if (isError(error)) {
    const code = (error as NodeJS.ErrnoException).code;
    if (isString(code) && !error.message.includes(code)) {
      return coreDescribeError(
        `${error.name}: ${error.message} (${code})`,
        MAX_ERROR_LENGTH,
      );
    }
  }
  return coreDescribeError(error, MAX_ERROR_LENGTH);
}
