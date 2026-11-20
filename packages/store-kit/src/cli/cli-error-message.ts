/** How deep the message is looked for in `errors` and `cause`. */
const MAX_DEPTH = 8;

/**
 * What the command line prints for a failure, never empty. A URL with a password in the text,
 * `url` above all, has the password masked.
 */
export function cliErrorMessage(error: unknown, url?: string): string {
  const messages = [...new Set(messagesOf(error, 0))];
  return redact(
    messages.length > 0
      ? messages.join("\n")
      : "The command failed with an error that has no message.",
    url,
  );
}

function messagesOf(error: unknown, depth: number): string[] {
  if (typeof error !== "object" || error === null) {
    const text = stringOf(error);
    return text ? [text] : [];
  }
  const { message, errors, cause, code, address, port } = error as {
    message?: unknown;
    errors?: unknown;
    cause?: unknown;
    code?: unknown;
    address?: unknown;
    port?: unknown;
  };
  if (typeof message === "string" && message.trim() !== "") {
    return [message];
  }
  if (depth < MAX_DEPTH && Array.isArray(errors)) {
    const nested = errors.flatMap((each) => messagesOf(each, depth + 1));
    if (nested.length > 0) {
      return nested;
    }
  }
  if (depth < MAX_DEPTH && cause !== undefined && cause !== error) {
    const nested = messagesOf(cause, depth + 1);
    if (nested.length > 0) {
      return nested;
    }
  }
  if (
    (typeof code === "string" && code !== "") ||
    typeof code === "number"
  ) {
    return [
      typeof address === "string" && address !== ""
        ? `${code} ${address}${typeof port === "number" ? `:${port}` : ""}`
        : String(code),
    ];
  }
  const text = stringOf(error);
  return text && text !== "[object Object]" ? [text] : [];
}

function stringOf(value: unknown): string {
  try {
    return String(value).trim();
  } catch {
    return "";
  }
}

function redact(text: string, url?: string): string {
  let redacted = text;
  if (url) {
    const masked = maskPassword(url);
    if (masked !== url) {
      redacted = redacted.replaceAll(url, masked);
    }
  }
  return redacted.replace(
    /\b([a-z][a-z\d+.-]*:\/\/[^\s/?#@:]*:)[^\s/?#@]+@/gi,
    "$1***@",
  );
}

function maskPassword(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.password) {
      return url;
    }
    parsed.password = "***";
    return parsed.href;
  } catch {
    return url;
  }
}
